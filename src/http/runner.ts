/**
 * Running requests: everything between "the user pressed Send" and "here is
 * what came back". A Session lives as long as the app (or one CLI run) and
 * holds what requests share: globals, cookies, named responses, tokens,
 * prompt answers and rate limits.
 */
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { applyAuth, tokenVariable, type AuthContext } from "./auth.ts";
import { curlToHttp } from "./convert.ts";
import { CookieJar } from "./cookies.ts";
import { loadEnvironment, tlsFor, type Environment } from "./env.ts";
import { addMetadata, parseHttpFile } from "./parse.ts";
import { runStream, streamKind } from "./protocols.ts";
import { jsonPathFirst, stringify } from "./query.ts";
import { runAssertions, runScript, type ScriptRun, type TestResult } from "./scripts.ts";
import { transmit, type TransportOptions } from "./transport.ts";
import type { HttpFile, HttpRequest, HttpResponse, Interaction, Metadata, PreparedRequest, RunDirective, Script } from "./types.ts";
import { Resolver, parseBody, type Exchanged, type Scope } from "./variables.ts";

export const VERSION = "0.2.0";

export interface RunResult {
  file: string;
  request: HttpRequest;
  prepared?: PreparedRequest;
  response?: HttpResponse;
  tests: TestResult[];
  logs: string[];
  error?: string;
  /** Set when the request was not sent: @disabled, cancelled @note, client.exit(). */
  skipped?: string;
  savedTo?: string;
  comparison?: { path: string; equal: boolean; detail?: string };
  /** Streaming messages (WebSocket, SSE, gRPC streams, MQTT, AMQP). */
  messages?: string[];
  /** `@loop` runs one result per iteration. */
  iterations?: RunResult[];
}

export interface SessionOptions {
  root: string;
  environments?: string[];
  interaction: Interaction;
  /** Persist cookies here (JetBrains keeps them between runs); in memory when absent. */
  cookieFile?: string;
  /** Default read timeout. JetBrains uses 60 s. */
  timeoutMs?: number;
  openUrl?(url: string): void;
  /** Live streaming messages and log lines, for the UI. */
  onEvent?(event: { kind: "log" | "message"; text: string }): void;
}

const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000 };
function duration(text: string | undefined, fallbackUnit = "ms"): number | undefined {
  if (!text) return undefined;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m)?$/.exec(text.trim());
  if (!m) return undefined;
  return Number(m[1]) * UNIT_MS[m[2] ?? fallbackUnit]!;
}

const last = (meta: Metadata, key: string): string | undefined => meta.get(key)?.at(-1);
const flag = (meta: Metadata, key: string): boolean => meta.has(key);

/** Percent-encode what is not allowed in a URL, without double-encoding `%XX`. */
export function encodeUrl(url: string): string {
  return url.replace(/%(?![0-9A-Fa-f]{2})|[^A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]/gu, (c) => encodeURIComponent(c));
}

/** The query and variables of a GraphQL body: the last blank-line-separated chunk that is a JSON object is variables. */
export function graphqlEnvelope(body: string, operationName?: string): string {
  const chunks = body.split(/\n\s*\n/);
  let variables: unknown;
  if (chunks.length > 1) {
    const tail = chunks[chunks.length - 1]!.trim();
    if (tail.startsWith("{")) {
      try { variables = JSON.parse(tail); chunks.pop(); } catch { /* part of the query */ }
    }
  }
  const query = chunks.join("\n\n").trim();
  const op = operationName ?? /^\s*(?:query|mutation|subscription)\s+(\w+)/m.exec(query)?.[1];
  return JSON.stringify({ query, ...(op ? { operationName: op } : {}), ...(variables !== undefined ? { variables } : {}) });
}

const GRAPHQL_START = /^\s*(query|mutation|subscription|fragment)\b|^\s*\{\s*\w+[\s({]/;
const TEXT_EXT = /\.(json|xml|txt|graphql|gql|html?|csv|ya?ml|md|js|ts|sql|soap|svg|ndjson|jsonl|form|env|properties|ini)$/i;

export class Session {
  readonly options: SessionOptions;
  readonly globals = new Map<string, unknown>();
  readonly globalHeaders = new Map<string, string>();
  readonly responses = new Map<string, Exchanged>();
  readonly cache = new Map<string, string>();
  readonly authCache = new Map<string, unknown>();
  readonly cookies: CookieJar;
  environments: string[];
  private readonly files = new Map<string, { mtime: number; file: HttpFile }>();
  private readonly envs = new Map<string, Environment>();
  private readonly rate = new Map<string, number[]>();
  private readonly running = new Set<string>();
  private controller = new AbortController();

  constructor(options: SessionOptions) {
    this.options = options;
    this.environments = options.environments ?? [];
    this.cookies = new CookieJar(options.cookieFile);
  }

  /** Stop whatever is running (streams, polling, sleeps). */
  abort(): void { this.controller.abort(); this.controller = new AbortController(); }

  setEnvironments(names: string[]): void { this.environments = names; this.envs.clear(); }

  async environment(dir: string): Promise<Environment> {
    const key = `${dir}\0${this.environments.join(",")}`;
    let env = this.envs.get(key);
    if (!env) { env = await loadEnvironment(this.options.root, dir, this.environments); this.envs.set(key, env); }
    return env;
  }

  /** Environment names available anywhere in the collection root. */
  async environmentNames(dir = this.options.root): Promise<string[]> { return (await this.environment(dir)).names; }

  async load(path: string): Promise<HttpFile> {
    const full = resolve(path);
    const mtime = statSync(full).mtimeMs;
    const cached = this.files.get(full);
    if (cached && cached.mtime === mtime) return cached.file;
    const file = parseHttpFile(await readFile(full, "utf8"), full);
    this.files.set(full, { mtime, file });
    return file;
  }

  /** The file plus everything it imports, transitively. */
  private async withImports(file: HttpFile, seen = new Set<string>()): Promise<HttpFile[]> {
    if (seen.has(file.path)) return [];
    seen.add(file.path);
    const out = [file];
    for (const spec of file.imports) {
      const path = resolve(dirname(file.path), spec.trim());
      if (!existsSync(path)) continue;
      out.push(...await this.withImports(await this.load(path), seen));
    }
    return out;
  }

  /** Run every request in a file in order (and its `run` directives), skipping `@disabled`. */
  async runAll(file: HttpFile, onResult?: (r: RunResult) => void): Promise<RunResult[]> {
    const items: ({ line: number; request: HttpRequest } | { line: number; run: RunDirective })[] = [
      ...file.requests.map((request) => ({ line: request.line, request })),
      ...file.runs.map((run) => ({ line: run.line, run })),
    ].sort((a, b) => a.line - b.line);
    const out: RunResult[] = [];
    for (const item of items) {
      const results = "request" in item ? [await this.run(file, item.request, { batch: true })] : await this.runDirective(file, item.run);
      for (const r of results) { out.push(r); onResult?.(r); }
    }
    return out;
  }

  /** JetBrains `run ./file.http#name (@var=value)`. */
  async runDirective(from: HttpFile, run: RunDirective): Promise<RunResult[]> {
    const path = resolve(dirname(from.path), run.path);
    const file = path === from.path ? from : await this.load(path);
    const targets = run.name ? file.requests.filter((r) => r.name === run.name || r.title === run.name) : file.requests;
    if (run.name && targets.length === 0) throw new Error(`run ${run.path}#${run.name}: no request with that name`);
    const out: RunResult[] = [];
    for (const request of targets) out.push(await this.run(file, request, { overrides: run.overrides, batch: !run.name }));
    return out;
  }

  /** Run one request, with its dependencies, loops and scripts. */
  async run(file: HttpFile, request: HttpRequest, opts: { overrides?: Record<string, string>; batch?: boolean } = {}): Promise<RunResult> {
    const metadata: Metadata = new Map(file.metadata);
    for (const [k, v] of request.metadata) metadata.set(k, [...(metadata.get(k) ?? []), ...v]);
    const result: RunResult = { file: file.path, request, tests: [], logs: [] };
    if (request.error) { result.error = request.error; return result; }
    if (opts.batch && flag(metadata, "disabled")) {
      const condition = last(metadata, "disabled");
      if (!condition || condition === "true") { result.skipped = "@disabled"; return result; }
    }
    const loop = last(metadata, "loop");
    if (loop) return this.loop(file, request, metadata, loop, opts.overrides ?? {});
    return this.execute(file, request, metadata, new Map(Object.entries(opts.overrides ?? {})), result);
  }

  private async loop(file: HttpFile, request: HttpRequest, metadata: Metadata, spec: string, overrides: Record<string, string>): Promise<RunResult> {
    const iterations: RunResult[] = [];
    const scope = await this.scopeFor(file, request, new Map(Object.entries(overrides)));
    const resolver = new Resolver(scope);
    const evaluate = async (code: string): Promise<unknown> => {
      const vm = await import("node:vm");
      return vm.runInContext(`(async () => (${code}))()`, vm.createContext(await resolver.jsScope()), { timeout: 5000 });
    };
    const forOf = /^for\s+(?:const\s+|let\s+)?(\w+)\s+of\s+(.+)$/.exec(spec.trim());
    const forN = /^for\s+(\d+)$/.exec(spec.trim());
    const whileExpr = /^while\s+(.+)$/.exec(spec.trim());
    const one = async (vars: Record<string, unknown>): Promise<void> => {
      const meta = new Map(metadata);
      meta.delete("loop");
      const v = new Map<string, unknown>(Object.entries(overrides));
      for (const [k, val] of Object.entries(vars)) v.set(k, val);
      iterations.push(await this.execute(file, request, meta, v, { file: file.path, request, tests: [], logs: [] }));
    };
    if (forOf) {
      const items = await evaluate(forOf[2]!);
      let index = 0;
      for (const item of (items ?? []) as Iterable<unknown>) await one({ [forOf[1]!]: item, $index: index++ });
    } else if (forN) {
      for (let i = 0; i < Number(forN[1]); i++) await one({ $index: i });
    } else if (whileExpr) {
      for (let i = 0; i < 10_000 && await evaluate(whileExpr[1]!); i++) await one({ $index: i });
    } else throw new Error(`@loop: expected "for x of items", "for N" or "while expr", got "${spec}"`);
    const lastRun = iterations[iterations.length - 1];
    return {
      file: file.path, request, iterations, tests: iterations.flatMap((r) => r.tests), logs: iterations.flatMap((r) => r.logs),
      prepared: lastRun?.prepared, response: lastRun?.response, error: iterations.find((r) => r.error)?.error,
    };
  }

  private async scopeFor(file: HttpFile, request: HttpRequest, requestVars: Map<string, unknown>): Promise<Scope> {
    const baseDir = dirname(file.path);
    const env = await this.environment(baseDir);
    const related = await this.withImports(file);
    const named = new Set<string>();
    for (const f of related) for (const r of f.requests) if (r.name) named.add(r.name);
    // Variables: imported files first, then this file's, in order; later definitions only fill gaps.
    const before = file.variables.filter((v) => v.line <= request.line);
    const after = file.variables.filter((v) => v.line > request.line && !before.some((b) => b.name === v.name));
    const imported = related.slice(1).flatMap((f) => f.variables);
    const scope: Scope = {
      root: this.options.root, baseDir, request: requestVars,
      file: [...imported, ...after, ...before, ...request.variables],
      globals: this.globals, env: env.variables, dotenv: env.dotenv, responses: this.responses,
      interaction: this.options.interaction, cache: this.cache, named,
      ensure: async (name, force) => {
        if (this.running.has(name)) return;
        if (!force && this.responses.has(name)) return;
        for (const f of related) {
          const target = f.requests.find((r) => r.name === name);
          if (target) { await this.run(f, target); return; }
        }
      },
      token: (name, args) => tokenVariable(name as "$aadToken", args, this.authContext(scope)),
    };
    return scope;
  }

  private authContext(scope: Scope): AuthContext {
    return {
      variable: (name) => {
        const v = scope.request.get(name) ?? scope.file.slice().reverse().find((f) => f.name === name)?.value ?? scope.globals.get(name) ?? scope.env[name] ?? scope.dotenv[name] ?? process.env[name];
        return v === undefined ? undefined : stringify(v);
      },
      interaction: this.options.interaction,
      send: (req) => transmit(req, { timeoutMs: this.options.timeoutMs ?? 60_000, signal: this.controller.signal }),
      cache: this.authCache,
      openUrl: this.options.openUrl,
    };
  }

  private log(result: RunResult, text: string): void {
    result.logs.push(text);
    this.options.onEvent?.({ kind: "log", text });
  }

  private async execute(file: HttpFile, request: HttpRequest, metadata: Metadata, requestVars: Map<string, unknown>, result: RunResult): Promise<RunResult> {
    const name = request.name;
    if (name) this.running.add(name);
    try {
      return await this.executeInner(file, request, metadata, requestVars, result);
    } catch (error) {
      result.error = (error as Error).message;
      return result;
    } finally {
      if (name) this.running.delete(name);
    }
  }

  private async executeInner(file: HttpFile, request: HttpRequest, metadata: Metadata, requestVars: Map<string, unknown>, result: RunResult): Promise<RunResult> {
    const interaction = this.options.interaction;
    const baseDir = dirname(file.path);
    const scope = await this.scopeFor(file, request, requestVars);
    const resolver = new Resolver(scope);
    const sub = (text: string): Promise<string> => resolver.text(text);
    const env = await this.environment(baseDir);

    // A pasted curl command becomes a request block first.
    if (request.fromCurl) {
      const parsed = parseHttpFile(curlToHttp(request.url, false), file.path).requests[0];
      if (!parsed) throw new Error("could not read the curl command");
      for (const [k, v] of request.metadata) for (const one of v) addMetadata(parsed.metadata, k, one);
      request = { ...parsed, name: request.name, title: request.title, line: request.line, span: request.span, index: request.index };
      result.request = request;
    }

    if (flag(metadata, "use-os-credentials")) throw new Error("@use-os-credentials (NTLM/Kerberos) needs the operating system's SSPI/GSSAPI, which r3q cannot reach; use Basic, Digest or a bearer token for this server.");

    // Dependencies first.
    for (const ref of metadata.get("ref") ?? []) for (const n of ref.split(/[\s,]+/).filter(Boolean)) await scope.ensure!(n, false);
    for (const ref of metadata.get("forceRef") ?? metadata.get("forceref") ?? []) for (const n of ref.split(/[\s,]+/).filter(Boolean)) await scope.ensure!(n, true);

    // Prompts: VS Code `@prompt name [description]`, kulala `@prompt name text`, `@secret name text`.
    for (const kind of ["prompt", "secret"] as const) {
      for (const spec of metadata.get(kind) ?? []) {
        const m = /^(\S+)\s*(.*)$/.exec(spec.trim());
        if (!m || requestVars.has(m[1]!)) continue;
        const answer = await interaction.prompt(m[2] || m[1]!, { secret: kind === "secret" || /password|secret|token|passwd/i.test(m[1]!) });
        if (answer === undefined) { result.skipped = "cancelled"; return result; }
        requestVars.set(m[1]!, answer);
      }
    }

    const note = metadata.get("note");
    if (note) {
      const ok = await interaction.confirm(`${note.filter(Boolean).join(" ") || "Send this request?"} (${request.method} ${request.url.split("\n")[0]})`);
      if (!ok) { result.skipped = "not confirmed (@note)"; return result; }
    }

    await this.rateLimit(metadata);
    const sleep = duration(last(metadata, "sleep")) ?? duration(last(metadata, "delay"));
    if (sleep) await new Promise((r) => setTimeout(r, sleep));

    // Pre-request scripts: global ones, then this request's.
    const scriptRun: ScriptRun = {
      session: { globals: this.globals, globalHeaders: this.globalHeaders },
      variables: requestVars, scope: await resolver.jsScope(), baseDir, environment: env.variables,
      raw: { method: request.method, url: request.url, body: request.body.map((p) => p.kind === "text" ? p.text : `< ${p.path}`).join("\n"), headers: request.headers.flatMap((h) => "name" in h ? [[h.name, h.value] as [string, string]] : []) },
      cookies: (n) => this.cookies.byName(n), substitute: sub,
      log: (line) => this.log(result, line),
    };
    const globalBefore = file.globalScripts.filter((s) => !s.event || s.event === "request");
    const globalAfter = file.globalScripts.filter((s) => s.event === "response" || s.event === "after" || s.event === "responseLogging");
    for (const script of [...globalBefore, ...request.preScripts.filter((s) => s.event !== "streaming")]) {
      const outcome = await runScript(script, scriptRun);
      result.tests.push(...outcome.tests);
      if (outcome.exited) { result.skipped = "client.exit()"; return result; }
      scriptRun.scope = await resolver.jsScope();
    }

    const prepared = await this.prepare(request, metadata, resolver, baseDir, env);
    result.prepared = prepared;
    scriptRun.prepared = prepared;

    // Protocols other than plain HTTP.
    const kind = streamKind(request.method === "GRAPHQL" && /^wss?:/i.test(prepared.url) ? "WEBSOCKET" : request.method);
    let response: HttpResponse;
    if (request.method === "GRAPHQL" && /^wss?:/i.test(prepared.url)) {
      response = await this.graphqlWs(prepared, metadata, result);
    } else if (kind) {
      const messages: string[] = [];
      const streamingScript = request.preScripts.find((s) => s.event === "streaming") ?? request.postScripts.find((s) => s.event === "streaming");
      const resolvedMessages = request.messages ? await Promise.all(request.messages.map(async (m) => ({ ...m, text: await sub(m.text) }))) : undefined;
      const protoMeta = new Map(metadata);
      response = await runStream(kind, prepared, resolvedMessages, {
        interaction, signal: this.controller.signal,
        onMessage: (text) => { messages.push(text); this.options.onEvent?.({ kind: "message", text }); },
        keepStreaming: flag(metadata, "keepStreaming") || flag(metadata, "keepstreaming"),
        timeoutMs: duration(last(metadata, "timeout"), "ms") ?? 10_000,
        baseDir, tls: this.tlsOptions(prepared.url, metadata, env), metadata: protoMeta,
        streaming: streamingScript ? async (api) => {
          await runScript(streamingScript, { ...scriptRun, scope: { ...scriptRun.scope, ...api, ws: api.ws ?? api } });
        } : undefined,
      });
      result.messages = messages;
      scriptRun.messages = messages;
    } else {
      response = await this.send(prepared, metadata, env, scope, result);
    }
    result.response = response;
    scriptRun.response = response;

    if (request.name) this.responses.set(request.name, { request: prepared, response });

    // kulala: copy values out of the response into variables.
    for (const spec of metadata.get("env-json-key") ?? []) {
      const [key, path] = spec.trim().split(/\s+/);
      if (!key) continue;
      try { this.globals.set(key, jsonPathFirst(JSON.parse(response.text), `$.${(path ?? key).replace(/^\$\.?/, "")}`)); } catch { /* not JSON */ }
    }
    for (const spec of metadata.get("env-header-key") ?? []) {
      const [key, header] = spec.trim().split(/\s+/);
      const value = response.headers.find(([k]) => k.toLowerCase() === (header ?? key ?? "").toLowerCase())?.[1];
      if (key && value !== undefined) this.globals.set(key, value);
    }

    // @jwt: decode JWT properties so scripts and the UI can read the claims.
    for (const prop of (metadata.get("jwt") ?? []).flatMap((s) => s.split(/[\s,]+/)).filter(Boolean)) {
      const body = parseBody(response);
      const token = typeof body === "object" ? jsonPathFirst(body, `$.${prop}`) : undefined;
      if (typeof token === "string" && token.split(".").length === 3) {
        try {
          const [h, p] = token.split(".").map((part) => JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as unknown);
          this.log(result, `${prop}: ${JSON.stringify({ header: h, payload: p })}`);
          requestVars.set(`${prop}_parsed`, p);
        } catch { /* not a JWT */ }
      }
    }

    // Response handlers.
    scriptRun.scope = await resolver.jsScope();
    for (const script of [...request.postScripts.filter((s) => s.event !== "streaming"), ...globalAfter]) {
      const outcome = await runScript(script, scriptRun);
      result.tests.push(...outcome.tests);
      if (outcome.exited) break;
    }
    // httpyac exports from response scripts become variables of the named response.
    if (request.name) for (const [k, v] of requestVars) this.globals.set(`${request.name}.${k}`, v);
    result.tests.push(...await runAssertions(request.assertions, response, await resolver.jsScope(), sub));

    if (request.save) result.savedTo = await this.save(response, resolve(baseDir, await sub(request.save.path)), request.save.overwrite);
    const saveMeta = metadata.get("save");
    if (saveMeta) {
      const target = saveMeta.at(-1)?.trim() || join("responses", `${request.name ?? basename(file.path, extname(file.path))}${extensionFor(response.contentType)}`);
      result.savedTo = await this.save(response, resolve(baseDir, await sub(target)), false);
    }
    if (request.compareWith) {
      const path = resolve(baseDir, await sub(request.compareWith));
      result.comparison = await compareResponse(response, path);
      result.tests.push({ name: `<> ${request.compareWith}`, passed: result.comparison.equal, message: result.comparison.detail });
    }

    const jq = last(metadata, "jq");
    if (jq) {
      const filtered = runJq(jq, response.text);
      if (filtered !== undefined) result.response = { ...response, text: filtered, contentType: "application/json" };
    }
    return result;
  }

  private async rateLimit(metadata: Metadata): Promise<void> {
    for (const spec of metadata.get("ratelimit") ?? []) {
      const key = /slot:\s*(\S+)/.exec(spec)?.[1] ?? "default";
      const times = this.rate.get(key) ?? [];
      const minIdle = /minIdleTime\s*:?\s*(\d+)/i.exec(spec);
      const max = /max\s*:?\s*(\d+)/i.exec(spec);
      const expire = /expire\s*:?\s*(\d+)/i.exec(spec);
      const now = Date.now();
      if (minIdle && times.length) {
        const wait = times[times.length - 1]! + Number(minIdle[1]) - now;
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
      if (max) {
        const window = Number(expire?.[1] ?? 1000);
        const recent = times.filter((t) => t > Date.now() - window);
        if (recent.length >= Number(max[1])) {
          const wait = recent[0]! + window - Date.now();
          if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        }
      }
      times.push(Date.now());
      this.rate.set(key, times.slice(-1000));
    }
  }

  private tlsOptions(url: string, metadata: Metadata, env: Environment) {
    if (flag(metadata, "no-client-cert")) return undefined;
    try { const u = new URL(url); return tlsFor(env, u.hostname, u.port || (u.protocol === "https:" || u.protocol === "wss:" ? "443" : "80")); }
    catch { return undefined; }
  }

  /** Build the wire request: variables, URL encoding, headers, body. */
  async prepare(request: HttpRequest, metadata: Metadata, resolver: Resolver, baseDir: string, env: Environment): Promise<PreparedRequest> {
    const sub = (text: string): Promise<string> => resolver.text(text);
    let url = (await sub(request.url)).trim();
    if (!flag(metadata, "no-auto-encoding")) url = encodeUrl(url);
    if (!/^[a-z][\w+.-]*:\/\//i.test(url)) {
      const host = request.headers.find((h): h is { name: string; value: string } => "name" in h && h.name.toLowerCase() === "host");
      if (url.startsWith("/") && host) url = `http://${await sub(host.value)}${url}`;
      else if (!streamKind(request.method)) url = `http://${url}`;
    }

    const headers: [string, string][] = [];
    for (const h of request.headers) {
      if ("spread" in h) {
        const value = await resolver.value(h.spread);
        const obj = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown; } catch { return undefined; } })() : value;
        if (obj && typeof obj === "object") for (const [k, v] of Object.entries(obj)) headers.push([k, stringify(v)]);
        else throw new Error(`...${h.spread}: not an object variable`);
        continue;
      }
      headers.push([await sub(h.name), await sub(h.value)]);
    }
    const has = (n: string): boolean => headers.some(([k]) => k.toLowerCase() === n);
    for (const [k, v] of this.globalHeaders) if (!has(k.toLowerCase())) headers.push([k, await sub(v)]);
    for (const [k, v] of Object.entries(env.defaultHeaders ?? {})) if (!has(k.toLowerCase())) headers.push([k, await sub(v)]);
    if (!has("user-agent")) headers.push(["User-Agent", `r3q/${VERSION}`]);

    // Body: text parts substituted; file parts read (and substituted when `<@`, or text that has {{ }}).
    const contentType = headers.find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "";
    const multipart = /multipart\//i.test(contentType);
    const charset = /charset\s*=\s*"?([\w-]+)/i.exec(contentType)?.[1]?.toLowerCase();
    const encode = (text: string): Buffer => {
      const enc = charset === "iso-8859-1" || charset === "latin1" ? "latin1" : charset === "utf-16le" || charset === "utf-16" ? "utf16le" : charset === "us-ascii" || charset === "ascii" ? "ascii" : "utf8";
      return Buffer.from(text, enc);
    };
    const inject = flag(metadata, "injectVariables") || flag(metadata, "injectvariables");
    const parts: Buffer[] = [];
    let textual = true;
    let text = "";
    for (const part of request.body) {
      if (parts.length) { parts.push(Buffer.from(multipart ? "\r\n" : "\n")); text += "\n"; }
      if (part.kind === "text") {
        let t = await sub(part.text);
        if (multipart) t = t.replace(/\r?\n/g, "\r\n");
        parts.push(encode(t));
        text += t;
      } else {
        const path = await sub(part.path);
        const full = isAbsolute(path) ? path : path.startsWith("~/") ? join(process.env.HOME ?? "", path.slice(2)) : resolve(baseDir, path);
        let bytes: Buffer = await readFile(full).catch(() => { throw new Error(`body file not found: ${full}`); });
        const isText = TEXT_EXT.test(full) || part.encoding !== undefined;
        if (part.substitute || inject || (isText && !multipart && bytes.includes("{{"))) {
          const decoded = bytes.toString(part.encoding ?? "utf8");
          const substituted = await sub(decoded);
          bytes = part.encoding ? Buffer.from(substituted, part.encoding) : encode(substituted);
        } else if (part.encoding) bytes = encode(bytes.toString(part.encoding));
        parts.push(bytes);
        if (isText) text += bytes.toString("utf8"); else { textual = false; text += `<${bytes.length} bytes from ${basename(full)}>`; }
      }
    }
    let body: Buffer | undefined = parts.length ? Buffer.concat(parts) : undefined;
    let bodyText: string | undefined = parts.length ? text : undefined;

    // Multi-line urlencoded forms: `&` continuation lines join.
    if (body && /application\/x-www-form-urlencoded/i.test(contentType) && textual) {
      bodyText = bodyText!.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join("");
      body = encode(bodyText);
    }

    // GraphQL: JetBrains GRAPHQL method, VS Code X-REQUEST-TYPE header, httpyac gql files and auto-detection.
    const requestType = headers.findIndex(([k, v]) => k.toLowerCase() === "x-request-type" && v.toLowerCase() === "graphql");
    let method = request.method;
    const graphqlFile = request.graphqlFile ? await readFile(resolve(baseDir, await sub(request.graphqlFile)), "utf8") : undefined;
    const autoDetect = method === "POST" && bodyText !== undefined && GRAPHQL_START.test(bodyText) && !/^\s*\{\s*"/.test(bodyText) && (!contentType || /json|graphql/i.test(contentType));
    if (method === "GRAPHQL" || requestType !== -1 || graphqlFile !== undefined || autoDetect) {
      if (requestType !== -1) headers.splice(requestType, 1);
      const source = graphqlFile !== undefined ? `${await sub(graphqlFile)}${bodyText ? `\n\n${bodyText}` : ""}` : bodyText ?? "";
      bodyText = graphqlEnvelope(source);
      body = Buffer.from(bodyText);
      if (method === "GRAPHQL" && !/^wss?:/i.test(url)) method = "POST";
      if (!has("content-type")) headers.push(["Content-Type", "application/json"]);
      else for (const h of headers) if (h[0].toLowerCase() === "content-type" && !/json/i.test(h[1])) h[1] = "application/json";
    }

    return { method, url, httpVersion: request.httpVersion, headers, body, bodyText: textual ? bodyText : bodyText };
  }

  private transportOptions(prepared: PreparedRequest, metadata: Metadata, env: Environment): TransportOptions {
    const opts: TransportOptions = {
      followRedirects: !flag(metadata, "no-redirect"),
      timeoutMs: duration(last(metadata, "timeout"), "s") ?? this.options.timeoutMs ?? 60_000,
      connectTimeoutMs: duration(last(metadata, "connection-timeout"), "s"),
      cookies: flag(metadata, "no-cookie-jar") || !env.cookieJar ? undefined : this.cookies,
      proxy: last(metadata, "proxy") || env.proxy,
      noProxy: env.noProxy,
      rejectUnauthorized: flag(metadata, "no-reject-unauthorized") ? false : undefined,
      noClientCert: flag(metadata, "no-client-cert"),
      tls: (host, port) => tlsFor(env, host, port),
      signal: this.controller.signal,
    };
    // kulala @curl-* flags: the ones that mean something without curl.
    for (const [key, values] of metadata) {
      if (!key.startsWith("curl-")) continue;
      const flagName = key.slice(5);
      const value = values.at(-1) ?? "";
      if (flagName === "insecure" || flagName === "k") opts.rejectUnauthorized = false;
      else if (flagName === "proxy" || flagName === "x") opts.proxy = value;
      else if (flagName === "max-time" || flagName === "m") opts.timeoutMs = Number(value) * 1000;
      else if (flagName === "connect-timeout") opts.connectTimeoutMs = Number(value) * 1000;
      else if (flagName === "location" || flagName === "L") opts.followRedirects = true;
      else if (flagName === "max-redirs") opts.maxRedirects = Number(value);
      else if (flagName === "http2") prepared.httpVersion = "HTTP/2";
      else if (flagName === "http1.1") prepared.httpVersion = "HTTP/1.1";
      else if (flagName === "global-" || flagName.startsWith("global-")) continue;
    }
    if (flag(metadata, "debug") || flag(metadata, "verbose")) opts.log = (line) => this.options.onEvent?.({ kind: "log", text: line });
    return opts;
  }

  private async send(prepared: PreparedRequest, metadata: Metadata, env: Environment, scope: Scope, result: RunResult): Promise<HttpResponse> {
    // httpyac `ClientCert: pfx: ./x.p12 passphrase: y` per request.
    const clientCert = prepared.headers.findIndex(([k]) => k.toLowerCase() === "clientcert");
    const opts = this.transportOptions(prepared, metadata, env);
    if (clientCert !== -1) {
      const spec = prepared.headers[clientCert]![1];
      prepared.headers.splice(clientCert, 1);
      const field = (k: string): string | undefined => new RegExp(`${k}:\\s*(\\S+)`).exec(spec)?.[1];
      const read = async (p?: string): Promise<Buffer | undefined> => p ? readFile(resolve(scope.baseDir, p)) : undefined;
      const material = { cert: await read(field("cert")), key: await read(field("key")), pfx: await read(field("pfx")), passphrase: field("passphrase") };
      opts.tls = () => material;
    }
    const auth = await applyAuth(prepared, this.authContext(scope));
    let response = await transmit(auth.request, opts);
    if (response.status === 401 && auth.onChallenge) {
      const retry = await auth.onChallenge(response);
      if (retry) response = await transmit(retry, opts);
    }
    result.prepared = auth.request;
    return response;
  }

  /** GraphQL subscriptions over WebSocket (graphql-transport-ws, falling back to graphql-ws). */
  private async graphqlWs(prepared: PreparedRequest, metadata: Metadata, result: RunResult): Promise<HttpResponse> {
    const started = performance.now();
    const messages: string[] = [];
    const timeout = duration(last(metadata, "timeout"), "ms") ?? 30_000;
    const keep = flag(metadata, "keepStreaming");
    const Ws = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    if (!Ws) throw new Error("this runtime has no WebSocket; use Node 22+ or Bun");
    const ws = new Ws(prepared.url, ["graphql-transport-ws", "graphql-ws"]);
    const payload = JSON.parse(prepared.bodyText ?? "{}") as unknown;
    await new Promise<void>((resolveDone) => {
      let timer = setTimeout(() => ws.close(), timeout);
      const signal = this.controller.signal;
      signal.addEventListener("abort", () => ws.close(), { once: true });
      ws.onopen = () => ws.send(JSON.stringify({ type: "connection_init", payload: {} }));
      ws.onmessage = (event) => {
        const msg = JSON.parse(String(event.data)) as { type: string; payload?: unknown };
        if (msg.type === "connection_ack") {
          ws.send(JSON.stringify({ id: "1", type: ws.protocol === "graphql-ws" ? "start" : "subscribe", payload }));
        } else if (msg.type === "next" || msg.type === "data") {
          const text = JSON.stringify(msg.payload);
          messages.push(text);
          this.options.onEvent?.({ kind: "message", text });
          if (!keep) { clearTimeout(timer); timer = setTimeout(() => ws.close(), timeout); }
        } else if (msg.type === "error") { messages.push(`error: ${JSON.stringify(msg.payload)}`); ws.close(); }
        else if (msg.type === "complete") ws.close();
        else if (msg.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
      };
      ws.onerror = () => { messages.push("error: connection failed"); };
      ws.onclose = () => { clearTimeout(timer); resolveDone(); };
    });
    result.messages = messages;
    const text = messages.join("\n");
    return { status: messages.some((m) => m.startsWith("error:")) ? 0 : 101, statusText: "WebSocket", httpVersion: "HTTP/1.1", headers: [], body: Buffer.from(text), text, contentType: "application/json", duration: performance.now() - started, url: prepared.url, redirects: [] };
  }

  /** `>>` picks a free name (`file-1.json`); `>>!` overwrites. */
  private async save(response: HttpResponse, path: string, overwrite: boolean): Promise<string> {
    await mkdir(dirname(path), { recursive: true });
    let target = path;
    if (!overwrite) {
      const ext = extname(path);
      const stem = path.slice(0, path.length - ext.length);
      for (let n = 1; existsSync(target); n++) target = `${stem}-${n}${ext}`;
    }
    await writeFile(target, response.body);
    return target;
  }
}

function extensionFor(contentType: string): string {
  if (/json/i.test(contentType)) return ".json";
  if (/xml/i.test(contentType)) return ".xml";
  if (/html/i.test(contentType)) return ".html";
  if (/png/i.test(contentType)) return ".png";
  if (/jpe?g/i.test(contentType)) return ".jpg";
  if (/pdf/i.test(contentType)) return ".pdf";
  if (/text\//i.test(contentType)) return ".txt";
  return ".bin";
}

/** JetBrains `<>`: equal when the bodies match (JSON compared structurally). */
export async function compareResponse(response: HttpResponse, path: string): Promise<{ path: string; equal: boolean; detail?: string }> {
  let expected: Buffer;
  try { expected = await readFile(path); } catch { return { path, equal: false, detail: `no saved response at ${path}` }; }
  try {
    const a = JSON.parse(response.text) as unknown;
    const b = JSON.parse(expected.toString("utf8")) as unknown;
    const equal = JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
    return { path, equal, detail: equal ? undefined : "JSON differs from the saved response" };
  } catch {
    const equal = Buffer.compare(response.body, expected) === 0 || response.text.trim() === expected.toString("utf8").trim();
    if (equal) return { path, equal };
    const got = response.text.split("\n");
    const want = expected.toString("utf8").split("\n");
    const line = got.findIndex((l, i) => l !== want[i]);
    return { path, equal, detail: `first difference at line ${line + 1}: got ${JSON.stringify(got[line] ?? "")}, saved ${JSON.stringify(want[line] ?? "")}` };
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]));
  return value;
}

/** kulala `@jq`: the jq binary when installed, otherwise simple `.a.b[0]` paths. */
export function runJq(expression: string, text: string): string | undefined {
  const run = spawnSync("jq", [expression], { input: text, encoding: "utf8", timeout: 10_000 });
  if (run.status === 0 && !run.error) return run.stdout.trimEnd();
  if (/^\.[\w.[\]]*$/.test(expression)) {
    try {
      const v = jsonPathFirst(JSON.parse(text), `$${expression === "." ? "" : expression}`);
      return JSON.stringify(v, null, 2);
    } catch { return undefined; }
  }
  return undefined;
}

export type { Script };
