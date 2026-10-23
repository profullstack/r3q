/**
 * Scripts and assertions. JetBrains scripts (`< {% %}`, `> {% %}`, external
 * `.js`) get the `client`, `request`, `response` and `crypto` objects;
 * httpyac blocks (`{{ }}`) get every variable as a global, `exports`,
 * `require`, `test`, `sleep`, and `request`/`response`. `??` lines are the
 * httpyac assertion shorthand.
 *
 * Scripts are the user's own code from their own files, run on Send, like
 * every client that supports them. node:vm gives them their API, not a sandbox.
 */
import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import vm from "node:vm";
import { jsonPath, jsonPathFirst, parseXml, stringify, textContent, xpath, xpathText } from "./query.ts";
import type { Assertion, HttpResponse, PreparedRequest, Script } from "./types.ts";

export interface TestResult { name: string; passed: boolean; message?: string }

export interface ScriptSession {
  globals: Map<string, unknown>;
  /** `client.global.headers.set`: added to every later request. */
  globalHeaders: Map<string, string>;
}

export interface ScriptRun {
  session: ScriptSession;
  /** Request-scoped variables (`request.variables.set`, httpyac exports). */
  variables: Map<string, unknown>;
  /** Variables visible as globals to httpyac scripts. */
  scope: Record<string, unknown>;
  baseDir: string;
  environment: Record<string, unknown>;
  /** Raw (unsubstituted) and substituted request parts, for the JetBrains request object. */
  raw: { method: string; url: string; body?: string; headers: [string, string][] };
  prepared?: PreparedRequest;
  response?: HttpResponse;
  /** Streaming messages for `response.body.onEachMessage`. */
  messages?: string[];
  cookies?: (name: string) => { name: string; value: string }[];
  substitute?: (text: string) => Promise<string>;
  log(line: string): void;
}

export interface ScriptOutcome { tests: TestResult[]; exited: boolean }

class Exit extends Error {}

const ALGORITHMS = { md5: "md5", sha1: "sha1", sha256: "sha256", sha384: "sha384", sha512: "sha512" } as const;

/** JetBrains' Crypto API: crypto.sha256().updateWithText(t).digest().toHex(), crypto.hmac.sha256().withTextSecret(k)... */
function cryptoApi(): Record<string, unknown> {
  const digest = (bytes: Buffer) => ({ toHex: () => bytes.toString("hex"), toBase64: () => bytes.toString("base64"), toBase64Url: () => bytes.toString("base64url") });
  const builder = (make: () => { update(b: Buffer): void; digest(): Buffer }) => () => {
    const h = make();
    const api = {
      updateWithText(text: string, encoding: BufferEncoding = "utf8") { h.update(Buffer.from(text, encoding)); return api; },
      updateWithHex(hex: string) { h.update(Buffer.from(hex, "hex")); return api; },
      updateWithBase64(b64: string) { h.update(Buffer.from(b64, "base64")); return api; },
      digest: () => digest(h.digest()),
    };
    return api;
  };
  const out: Record<string, unknown> = {};
  const hmac: Record<string, unknown> = {};
  for (const [name, alg] of Object.entries(ALGORITHMS)) {
    out[name] = builder(() => { const h = createHash(alg); return { update: (b) => h.update(b), digest: () => h.digest() }; });
    hmac[name] = () => {
      const withSecret = (key: Buffer) => builder(() => { const h = createHmac(alg, key); return { update: (b) => h.update(b), digest: () => h.digest() }; })();
      return {
        withTextSecret: (k: string) => withSecret(Buffer.from(k, "utf8")),
        withHexSecret: (k: string) => withSecret(Buffer.from(k, "hex")),
        withBase64Secret: (k: string) => withSecret(Buffer.from(k, "base64")),
      };
    };
  }
  out.hmac = hmac;
  return out;
}

function headerValues(headers: [string, string][], name: string): string[] {
  return headers.filter(([k]) => k.toLowerCase() === name.toLowerCase()).map(([, v]) => v);
}

/** Response body as JetBrains exposes it: parsed JSON, an XML tree, or text. */
export function scriptBody(response: HttpResponse, messages?: string[]): unknown {
  if (messages) {
    return {
      onEachMessage(cb: (message: unknown, unsubscribe: () => void) => void) {
        let stop = false;
        for (const m of messages) { if (stop) break; let v: unknown = m; try { v = JSON.parse(m); } catch { /* text */ } cb(v, () => { stop = true; }); }
      },
      onEachLine(cb: (line: string, unsubscribe: () => void) => void) {
        let stop = false;
        for (const line of messages.join("\n").split("\n")) { if (stop) break; cb(line, () => { stop = true; }); }
      },
      toString: () => response.text,
    };
  }
  if (/json/i.test(response.contentType)) { try { return JSON.parse(response.text); } catch { /* fall through */ } }
  if (/xml/i.test(response.contentType)) return parseXml(response.text);
  return response.text;
}

function jetbrainsGlobals(run: ScriptRun, tests: TestResult[]): Record<string, unknown> {
  const { session } = run;
  const client = {
    test(name: string, fn: () => void) {
      try { fn(); tests.push({ name, passed: true }); }
      catch (error) { if (error instanceof Exit) throw error; tests.push({ name, passed: false, message: (error as Error).message }); }
    },
    assert(condition: unknown, message?: string) { if (!condition) throw new Error(message ?? "assertion failed"); },
    log(...text: unknown[]) { run.log(text.map(stringify).join(" ")); },
    exit() { throw new Exit(); },
    global: {
      set(name: string, value: unknown) { session.globals.set(name, value); },
      get(name: string) { return session.globals.get(name); },
      isEmpty() { return session.globals.size === 0; },
      clear(name: string) { session.globals.delete(name); },
      clearAll() { session.globals.clear(); },
      headers: {
        set(name: string, value: string) { session.globalHeaders.set(name, value); },
        clear(name: string) { session.globalHeaders.delete(name); },
      },
    },
  };
  const request = {
    method: run.raw.method,
    variables: {
      set(name: string, value: unknown) { run.variables.set(name, value); },
      get(name: string) { return run.variables.get(name) ?? run.scope[name]; },
    },
    environment: {
      get(name: string) { return run.environment[name]; },
    },
    url: {
      getRaw: () => run.raw.url,
      tryGetSubstituted: () => run.prepared?.url ?? run.raw.url,
    },
    body: {
      getRaw: () => run.raw.body,
      tryGetSubstituted: () => run.prepared?.bodyText ?? run.raw.body,
    },
    headers: {
      all: () => (run.prepared?.headers ?? run.raw.headers).map(([name, value]) => ({ name, getRawValue: () => value, tryGetSubstitutedValue: () => value, value })),
      findByName: (name: string) => {
        const v = headerValues(run.prepared?.headers ?? run.raw.headers, name)[0];
        return v === undefined ? null : { name, getRawValue: () => v, tryGetSubstitutedValue: () => v, value: v };
      },
    },
    iteration: () => Number(run.scope.$index ?? 0),
    templateValue: (i: number) => run.scope[`$template${i}`],
  };
  const out: Record<string, unknown> = {
    client, request, crypto: cryptoApi(), console: { log: client.log, error: client.log, warn: client.log, info: client.log },
    jsonPath: (obj: unknown, path: string) => jsonPathFirst(typeof obj === "string" ? JSON.parse(obj) : obj, path),
    xpath: (doc: unknown, expr: string) => { const found = xpath(typeof doc === "string" ? parseXml(doc) : doc as ReturnType<typeof parseXml>, expr); return found.length ? textContent(found[0]!) : null; },
    Buffer, URL, URLSearchParams, TextEncoder, TextDecoder, setTimeout, clearTimeout, atob, btoa,
  };
  if (run.response) {
    const res = run.response;
    const contentType = res.contentType;
    out.response = {
      body: scriptBody(res, run.messages),
      status: res.status,
      headers: {
        valueOf: (name: string) => headerValues(res.headers, name)[0] ?? null,
        valuesOf: (name: string) => headerValues(res.headers, name),
      },
      contentType: {
        mimeType: contentType.split(";")[0]!.trim(),
        charset: /charset\s*=\s*"?([\w-]+)/i.exec(contentType)?.[1] ?? "utf-8",
      },
      cookiesByName: (name: string) => run.cookies?.(name) ?? [],
    };
  }
  return out;
}

function httpyacGlobals(run: ScriptRun, tests: TestResult[], exports: Record<string, unknown>): Record<string, unknown> {
  const res = run.response;
  const record = (name: string, fn: () => void): void => {
    try { fn(); tests.push({ name, passed: true }); }
    catch (error) { tests.push({ name, passed: false, message: (error as Error).message }); }
  };
  const expect = (cond: boolean, message: string): void => { if (!cond) throw new Error(message); };
  const header = (name: string): string | undefined => res ? headerValues(res.headers, name)[0] : undefined;
  const test = Object.assign(
    (name: string, fn: () => void | Promise<void>) => record(name, fn as () => void),
    {
      status: (code: number) => record(`status == ${code}`, () => expect(res?.status === code, `status ${res?.status} is not ${code}`)),
      totalTime: (ms: number) => record(`duration < ${ms}`, () => expect((res?.duration ?? Infinity) < ms, `took ${Math.round(res?.duration ?? 0)}ms, limit ${ms}ms`)),
      header: (name: string, value: string) => record(`header ${name} == ${value}`, () => expect(header(name) === value, `${name} is ${header(name)}`)),
      headerContains: (name: string, value: string) => record(`header ${name} contains ${value}`, () => expect((header(name) ?? "").includes(value), `${name} is ${header(name)}`)),
      responseBody: (content: string) => record("response body", () => expect(res?.text === content, "body differs")),
      hasResponseBody: () => record("has response body", () => expect((res?.text ?? "").length > 0, "body is empty")),
      hasNoResponseBody: () => record("has no response body", () => expect((res?.text ?? "") === "", "body is not empty")),
    },
  );
  const parsedBody = res ? (() => { try { return JSON.parse(res.text); } catch { return undefined; } })() : undefined;
  const response = res ? {
    statusCode: res.status, statusMessage: res.statusText, httpVersion: res.httpVersion,
    headers: Object.fromEntries(res.headers.map(([k, v]) => [k.toLowerCase(), v])),
    body: parsedBody ?? res.text, rawBody: res.body, parsedBody, contentType: { mimeType: res.contentType.split(";")[0]!.trim(), contentType: res.contentType },
    timings: { total: res.duration }, request: run.prepared,
  } : undefined;
  const request = run.prepared ? {
    method: run.prepared.method, url: run.prepared.url,
    headers: Object.fromEntries(run.prepared.headers.map(([k, v]) => [k, v])),
    body: run.prepared.bodyText,
  } : { method: run.raw.method, url: run.raw.url, headers: Object.fromEntries(run.raw.headers), body: run.raw.body };
  return {
    ...run.scope,
    exports, module: { exports }, require: createRequire(`${run.baseDir}/`),
    test, sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
    response, request, console: { log: (...a: unknown[]) => run.log(a.map(stringify).join(" ")), error: (...a: unknown[]) => run.log(a.map(stringify).join(" ")), info: (...a: unknown[]) => run.log(a.map(stringify).join(" ")), warn: (...a: unknown[]) => run.log(a.map(stringify).join(" ")) },
    process, Buffer, URL, URLSearchParams, TextEncoder, TextDecoder, setTimeout, clearTimeout, fetch, atob, btoa,
  };
}

/** Run one script; JetBrains `client.exit()` stops it without failing. */
export async function runScript(script: Script, run: ScriptRun): Promise<ScriptOutcome> {
  const tests: TestResult[] = [];
  let code = script.code ?? "";
  let filename = `script:${script.line}`;
  if (script.file) {
    const path = resolve(run.baseDir, run.substitute ? await run.substitute(script.file) : script.file);
    code = await readFile(path, "utf8");
    filename = path;
  }
  const exports: Record<string, unknown> = {};
  const globals = script.dialect === "jetbrains" ? jetbrainsGlobals(run, tests) : httpyacGlobals(run, tests, exports);
  const context = vm.createContext(globals);
  try {
    const wrapped = `(async () => {\n${code}\n})()`;
    await vm.runInContext(wrapped, context, { filename, timeout: 60_000 });
  } catch (error) {
    if (error instanceof Exit || (error as Error)?.constructor?.name === "Exit") return { tests, exited: true };
    tests.push({ name: `script error (line ${script.line})`, passed: false, message: (error as Error)?.message ?? String(error) });
  }
  if (script.dialect === "httpyac") {
    for (const [k, v] of Object.entries(exports)) run.variables.set(k, v);
    // Top-level `exports = {...}` replacement is visible on the context.
    const replaced = (context as { exports?: Record<string, unknown> }).exports;
    if (replaced && replaced !== exports) for (const [k, v] of Object.entries(replaced)) run.variables.set(k, v);
  }
  return { tests, exited: false };
}

function compare(actual: unknown, operator: string, expected: string): boolean {
  const a = actual === undefined || actual === null ? "" : typeof actual === "string" ? actual : JSON.stringify(actual);
  const numeric = (): [number, number] => [Number(a), Number(expected)];
  switch (operator) {
    case "==": return a === expected || (Number.isFinite(Number(a)) && a !== "" && Number(a) === Number(expected));
    case "!=": return !(a === expected || (Number.isFinite(Number(a)) && a !== "" && Number(a) === Number(expected)));
    case ">": { const [x, y] = numeric(); return x > y; }
    case ">=": { const [x, y] = numeric(); return x >= y; }
    case "<": { const [x, y] = numeric(); return x < y; }
    case "<=": { const [x, y] = numeric(); return x <= y; }
    case "startsWith": return a.startsWith(expected);
    case "endsWith": return a.endsWith(expected);
    case "includes": case "contains": return a.includes(expected);
    case "exists": return actual !== undefined && actual !== null;
    case "isTrue": return actual === true || a === "true";
    case "isFalse": return actual === false || a === "false";
    case "isNumber": return typeof actual === "number" || (a !== "" && Number.isFinite(Number(a)));
    case "isBoolean": return typeof actual === "boolean" || a === "true" || a === "false";
    case "isString": return typeof actual === "string";
    case "isArray": return Array.isArray(actual);
    case "matches": { const m = /^\/(.*)\/(\w*)$/.exec(expected); return new RegExp(m ? m[1]! : expected, m?.[2]).test(a); }
    case "sha256": case "sha512": case "md5": return createHash(operator).update(a).digest("hex") === expected.toLowerCase() || createHash(operator).update(a).digest("base64") === expected;
  }
  throw new Error(`unknown operator ${operator}`);
}

/** Evaluate `??` assertions against a response. */
export async function runAssertions(assertions: Assertion[], response: HttpResponse, scope: Record<string, unknown>, substitute: (s: string) => Promise<string>): Promise<TestResult[]> {
  const out: TestResult[] = [];
  for (const assertion of assertions) {
    const expected = await substitute(assertion.expected);
    let actual: unknown;
    try {
      switch (assertion.kind) {
        case "status": actual = response.status; break;
        case "duration": actual = Math.round(response.duration); break;
        case "header": actual = headerValues(response.headers, assertion.target)[0]; break;
        case "body":
          if (!assertion.target) actual = response.text;
          else { try { actual = jsonPath(JSON.parse(response.text), assertion.target)[0]; } catch { actual = undefined; } }
          break;
        case "xpath": actual = xpathText(response.text, assertion.target); break;
        case "js": {
          const parsedBody = (() => { try { return JSON.parse(response.text); } catch { return undefined; } })();
          const context = vm.createContext({ ...scope, response: { statusCode: response.status, headers: Object.fromEntries(response.headers.map(([k, v]) => [k.toLowerCase(), v])), body: parsedBody ?? response.text, parsedBody, timings: { total: response.duration } } });
          actual = await vm.runInContext(`(async () => (${assertion.target}))()`, context, { timeout: 5000 });
          break;
        }
      }
      const passed = compare(actual, assertion.operator, expected);
      out.push({ name: assertion.source.replace(/^\?\?\s*/, ""), passed, message: passed ? undefined : `got ${stringify(actual) || "nothing"}` });
    } catch (error) {
      out.push({ name: assertion.source.replace(/^\?\?\s*/, ""), passed: false, message: (error as Error).message });
    }
  }
  return out;
}
