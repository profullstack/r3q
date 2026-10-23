/**
 * `{{...}}` substitution. One resolver per request execution; it sees, from
 * highest precedence to lowest:
 *
 *   request-scoped variables (pre-request scripts, httpyac exports, prompts)
 *   file variables (`@name = value`, `@name := value`)
 *   global variables (`client.global.set`)
 *   the selected environment(s), then `.env`, then the process environment
 *
 * Request variables (`{{login.response.body.$.token}}`, httpyac
 * `{{login.token}}`) read the stored responses of named requests and run them
 * first when they have not run yet.
 */
import { createRequire } from "node:module";
import vm from "node:vm";
import { dynamicValue, splitArgs } from "./dynamic.ts";
import { dotPath, jsonPathFirst, stringify, xpathText } from "./query.ts";
import type { FileVariable, HttpResponse, Interaction, PreparedRequest } from "./types.ts";

export interface Exchanged { request: PreparedRequest; response: HttpResponse }

export interface Scope {
  root: string;
  baseDir: string;
  /** Request-scoped values; scripts and prompts write here. */
  request: Map<string, unknown>;
  /** File variables in effect for this request, in definition order. */
  file: FileVariable[];
  /** `client.global` values, shared across requests in a session. */
  globals: Map<string, unknown>;
  env: Record<string, unknown>;
  dotenv: Record<string, string>;
  /** Responses of named requests (this file and imports). */
  responses: Map<string, Exchanged>;
  interaction: Interaction;
  /** Run a named request that has not run yet (or again, when forced). */
  ensure?(name: string, force?: boolean): Promise<void>;
  /** Names of requests that can be ensured, so `{{x.y}}` only triggers a run for real names. */
  named?: Set<string>;
  /** `$aadToken`, `$aadV2Token`, `$oidcAccessToken`. */
  token?(name: string, args: string): Promise<string>;
  /** Cache for `$input-askonce`, eager variables and `@prompt` answers, shared per session. */
  cache: Map<string, string>;
  now?: Date;
}

const MAX_DEPTH = 32;
const SIMPLE = /^[\w$-]+$/;

export class Resolver {
  private readonly scope: Scope;
  private readonly fileValues = new Map<string, string>();

  constructor(scope: Scope) { this.scope = scope; }

  /** Substitute every `{{...}}` in `text`. Unknown names are left as written. */
  async text(text: string, depth = 0): Promise<string> {
    if (!text.includes("{{") || depth > MAX_DEPTH) return text;
    let out = "";
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf("{{", i);
      if (open === -1) { out += text.slice(i); break; }
      const close = text.indexOf("}}", open + 2);
      if (close === -1) { out += text.slice(i); break; }
      out += text.slice(i, open);
      const expr = text.slice(open + 2, close);
      const value = await this.expression(expr, depth);
      out += value ?? text.slice(open, close + 2);
      i = close + 2;
    }
    return out;
  }

  /** One `{{expr}}`; undefined when it names nothing. */
  async expression(raw: string, depth = 0): Promise<string | undefined> {
    const expr = raw.trim();
    if (expr === "") return undefined;
    if (expr.startsWith("%")) {
      const inner = await this.expression(expr.slice(1), depth);
      return inner === undefined ? undefined : encodeURIComponent(inner);
    }
    if (expr.startsWith("$")) return this.dynamic(expr, depth);
    const value = await this.value(expr, depth);
    if (value !== undefined) return stringify(value);
    if (!SIMPLE.test(expr) && !/^[\w$-]+(\.[\w$-]+)+$/.test(expr)) return this.javascript(expr);
    return undefined;
  }

  /** A variable's value (not stringified): objects stay objects for dot access and spreads. */
  async value(path: string, depth = 0): Promise<unknown> {
    const s = this.scope;
    if (s.request.has(path)) return this.deep(s.request.get(path), depth);
    const file = this.fileVariable(path);
    if (file) return this.fileValue(file, depth);
    if (s.globals.has(path)) return this.deep(s.globals.get(path), depth);
    if (path in s.env) return this.deep(s.env[path], depth);
    if (path in s.dotenv) return s.dotenv[path];
    if (process.env[path] !== undefined) return process.env[path];

    // name.response.body.$.x, name.response.headers.X, name.request.body.*
    const request = /^([\w-]+)\.(request|response)\.(body|headers)(?:\.(.*))?$/.exec(path);
    if (request) return this.requestVariable(request[1]!, request[2] as "request" | "response", request[3] as "body" | "headers", request[4] ?? "*");

    // Dotted access into an object variable, a JSON string, or (httpyac) a named response body.
    const dot = path.indexOf(".");
    if (dot > 0) {
      const head = path.slice(0, dot);
      const tail = path.slice(dot + 1);
      let base = await this.value(head, depth + 1);
      if (base === undefined && (s.responses.has(head) || s.named?.has(head))) {
        await s.ensure?.(head);
        const exchanged = s.responses.get(head);
        if (exchanged) base = parseBody(exchanged.response);
      }
      if (typeof base === "string") { try { base = JSON.parse(base); } catch { /* not JSON */ } }
      if (base !== undefined && typeof base === "object") return dotPath(base, tail);
    }
    if (s.responses.has(path) || s.named?.has(path)) {
      await s.ensure?.(path);
      const exchanged = s.responses.get(path);
      if (exchanged) return parseBody(exchanged.response);
    }
    return undefined;
  }

  private fileVariable(name: string): FileVariable | undefined {
    for (let i = this.scope.file.length - 1; i >= 0; i--) if (this.scope.file[i]!.name === name) return this.scope.file[i];
    return undefined;
  }

  /** `=` values are resolved once (so `{{$timestamp}}` stays fixed); `:=` every time. */
  private async fileValue(variable: FileVariable, depth: number): Promise<string> {
    if (!variable.lazy) {
      const key = `${variable.line}:${variable.name}`;
      const cached = this.fileValues.get(key) ?? this.scope.cache.get(`file:${key}:${variable.value}`);
      if (cached !== undefined) return cached;
      const value = await this.text(variable.value, depth + 1);
      this.fileValues.set(key, value);
      if (/\{\{\s*\$/.test(variable.value)) this.scope.cache.set(`file:${key}:${variable.value}`, value);
      return value;
    }
    return this.text(variable.value, depth + 1);
  }

  /** Strings from env files and globals may themselves contain `{{...}}`. */
  private async deep(value: unknown, depth: number): Promise<unknown> {
    if (typeof value === "string") return this.text(value, depth + 1);
    return value;
  }

  private async requestVariable(name: string, which: "request" | "response", part: "body" | "headers", selector: string): Promise<unknown> {
    await this.scope.ensure?.(name);
    const exchanged = this.scope.responses.get(name);
    if (!exchanged) return undefined;
    if (part === "headers") {
      const headers = which === "response" ? exchanged.response.headers : exchanged.request.headers;
      const found = headers.filter(([k]) => k.toLowerCase() === selector.toLowerCase()).map(([, v]) => v);
      return found.length ? found.join(", ") : undefined;
    }
    const text = which === "response" ? exchanged.response.text : exchanged.request.bodyText ?? exchanged.request.body?.toString("utf8") ?? "";
    if (selector === "*" || selector === "") return text;
    if (selector.startsWith("$")) {
      try { return jsonPathFirst(JSON.parse(text), selector); } catch { return undefined; }
    }
    if (selector.startsWith("/")) return xpathText(text, selector);
    return undefined;
  }

  private async dynamic(expr: string, depth: number): Promise<string | undefined> {
    const s = this.scope;
    // VS Code `{{$shared name}}` inside environment values.
    const shared = /^\$shared\s+(\S+)$/.exec(expr);
    if (shared) return stringify(await this.value(shared[1]!, depth));
    const sync = dynamicValue(expr, {
      now: s.now,
      env: (n) => process.env[n],
      dotenv: (n) => s.dotenv[n],
      lookup: (n) => { const v = s.request.get(n) ?? this.fileVariable(n)?.value ?? s.env[n]; return v === undefined ? undefined : stringify(v); },
      root: s.root,
    });
    if (sync !== undefined) return sync;
    const name = /^\$[\w.-]+/.exec(expr)?.[0] ?? "";
    const rest = expr.slice(name.length).trim();
    switch (name) {
      case "$input": case "$password": case "$input-askonce": {
        const [message, fallback] = splitValue(rest);
        const key = `askonce:${message}`;
        if (name === "$input-askonce" && s.cache.has(key)) return s.cache.get(key);
        const answer = await s.interaction.prompt(message || "Value", { default: fallback, secret: name === "$password" });
        if (answer === undefined) throw new Error("cancelled");
        if (name === "$input-askonce") s.cache.set(key, answer);
        return answer;
      }
      case "$pick": {
        const [message, options] = splitValue(rest);
        const answer = await s.interaction.pick(message || "Pick", (options ?? "").split(",").map((o) => o.trim()).filter(Boolean));
        if (answer === undefined) throw new Error("cancelled");
        return answer;
      }
      case "$aadToken": case "$aadV2Token": case "$oidcAccessToken":
        if (!s.token) throw new Error(`${name} needs the auth module`);
        return s.token(name, rest);
    }
    // httpyac: anything else is JavaScript.
    return this.javascript(expr);
  }

  /** httpyac evaluates `{{ expression }}` as JavaScript with variables in scope. */
  async javascript(code: string): Promise<string | undefined> {
    try {
      const context = vm.createContext(await this.jsScope());
      const result = await vm.runInContext(code, context, { timeout: 5000 });
      return result === undefined ? undefined : stringify(result);
    } catch {
      return undefined;
    }
  }

  /** Every variable visible to scripts, as plain values. */
  async jsScope(): Promise<Record<string, unknown>> {
    const s = this.scope;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(s.dotenv)) out[k] = v;
    for (const [k, v] of Object.entries(s.env)) out[k] = v;
    for (const [k, v] of s.globals) out[k] = v;
    for (const v of s.file) { try { out[v.name] = jsonish(await this.fileValue(v, 1)); } catch { /* unresolvable */ } }
    for (const [name, ex] of s.responses) out[name] = parseBody(ex.response);
    for (const [k, v] of s.request) out[k] = v;
    out.require = createRequire(`${s.baseDir}/`);
    out.process = process;
    out.Buffer = Buffer;
    out.console = console;
    out.URL = URL;
    out.URLSearchParams = URLSearchParams;
    out.TextEncoder = TextEncoder;
    out.TextDecoder = TextDecoder;
    out.fetch = fetch;
    return out;
  }
}

/** File variables are text; JSON-shaped ones are objects to scripts. */
function jsonish(value: string): unknown {
  if (!/^\s*[[{]/.test(value)) return value;
  try { return JSON.parse(value); } catch { return value; }
}

/** `prompt text $value: default` → ["prompt text", "default"]. */
function splitValue(rest: string): [string, string | undefined] {
  const at = rest.indexOf("$value:");
  if (at === -1) return [unquote(rest.trim()), undefined];
  return [unquote(rest.slice(0, at).trim()), rest.slice(at + 7).trim()];
}

function unquote(text: string): string {
  const args = splitArgs(text);
  return args.length === 1 && /^["']/.test(text) ? args[0]! : text;
}

/** JSON body as an object, XML/text as a string. */
export function parseBody(response: HttpResponse): unknown {
  if (/json/i.test(response.contentType) || /^\s*[[{]/.test(response.text)) {
    try { return JSON.parse(response.text); } catch { /* not JSON after all */ }
  }
  return response.text;
}
