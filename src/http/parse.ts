/**
 * The `.http` reader. One pass over the lines with a small state machine:
 * blocks split on `###`, and inside a block the preamble (comments, metadata,
 * variables, pre-request scripts) runs until the request line, then headers
 * until a blank line, then the body until a handler or the next separator.
 */
import type {
  Assertion, BodyPart, FileVariable, HttpFile, HttpRequest, Metadata, RunDirective, Script, StreamMessage,
} from "./types.ts";

/** Every method keyword the spec lists across clients, plus the protocol keywords. */
export const HTTP_METHODS = [
  "GET", "HEAD", "POST", "PUT", "DELETE", "CONNECT", "PATCH", "OPTIONS", "TRACE",
  // WebDAV (VS Code REST Client)
  "LOCK", "UNLOCK", "PROPFIND", "PROPPATCH", "COPY", "MOVE", "MKCOL", "MKCALENDAR", "ACL", "SEARCH",
  // httpyac
  "CHECKOUT", "CHECKIN", "REPORT", "MERGE", "MKACTIVITY", "MKWORKSPACE", "VERSION-CONTROL", "BASELINE-CONTROL",
] as const;
export const PROTOCOL_METHODS = ["GRAPHQL", "WEBSOCKET", "WS", "WSS", "SSE", "EVENTSOURCE", "GRPC", "MQTT", "AMQP"] as const;
export const ALL_METHODS = new Set<string>([...HTTP_METHODS, ...PROTOCOL_METHODS]);

const SEPARATOR = /^\s*#{3,}(.*)$/;
const METADATA = /^\s*(?:#|\/\/)\s*@([\w-]+)(?:\s*[=:]?\s*(.*?))?\s*$/;
const VARIABLE = /^\s*@([^\s=:]+)\s*(:?=)\s?(.*)$/;
const COMMENT = /^\s*(#|\/\/)/;
const VERSION = /\s+(HTTP\/[\d.]+)\s*$/i;
const HEADER = /^([^\s:][^:]*?)\s*:\s?(.*)$/;
const HTTPYAC_SCRIPT = /^\s*\{\{(\+[\w]*|@[\w]+)?\s*$/;

export function addMetadata(metadata: Metadata, key: string, value: string): void {
  const list = metadata.get(key) ?? [];
  list.push(value);
  metadata.set(key, list);
}

/** Does this line start a request? Returns method and the rest, or undefined. */
export function requestLine(line: string): { method: string; url: string; httpVersion?: string } | undefined {
  let text = line.trim();
  if (text === "") return undefined;
  let httpVersion: string | undefined;
  const version = VERSION.exec(text);
  if (version) { httpVersion = version[1]!.toUpperCase(); text = text.slice(0, version.index).trim(); }
  const space = text.search(/\s/);
  const first = space === -1 ? text : text.slice(0, space);
  if (ALL_METHODS.has(first.toUpperCase())) {
    const url = space === -1 ? "" : text.slice(space).trim();
    return { method: first.toUpperCase(), url, httpVersion };
  }
  // Method omitted: GET. Only for something that is plainly a URL.
  if (/^(https?|wss?|grpcs?|mqtts?|tcp|amqps?):\/\//i.test(text) || /^\{\{[^}]+\}\}/.test(text) || /^\/[^/]/.test(text) || /^[\w.-]+:\d+(\/|$)/.test(text)) {
    if (/\s/.test(text)) return undefined;
    return { method: "GET", url: text, httpVersion };
  }
  return undefined;
}

/** Scripts end at a line that closes them; returns the code and the index after the closing line. */
function readUntil(lines: string[], start: number, open: string, close: string): { code: string; next: number } | undefined {
  const first = lines[start]!;
  const at = first.indexOf(open);
  const rest = first.slice(at + open.length);
  const closeHere = rest.indexOf(close);
  if (closeHere !== -1) return { code: rest.slice(0, closeHere).trim(), next: start + 1 };
  const out = [rest];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    const end = line.indexOf(close);
    if (end !== -1) {
      out.push(line.slice(0, end));
      return { code: out.join("\n").trim(), next: i + 1 };
    }
    out.push(line);
  }
  return undefined;
}

/** httpyac `{{ ... }}`: the block closes on a line that is just `}}`. */
function readHttpyacBlock(lines: string[], start: number): { code: string; next: number } | undefined {
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]!.trim() === "}}") return { code: out.join("\n"), next: i + 1 };
    out.push(lines[i]!);
  }
  return undefined;
}

function scriptHeader(line: string, lineNo: number): Pick<Script, "event" | "global" | "line"> {
  const tag = HTTPYAC_SCRIPT.exec(line)?.[1] ?? "";
  const out: Pick<Script, "event" | "global" | "line"> = { line: lineNo };
  if (tag.startsWith("+")) {
    out.global = true;
    const event = tag.slice(1);
    if (event) out.event = event as Script["event"];
  } else if (tag.startsWith("@")) out.event = tag.slice(1) as Script["event"];
  return out;
}

const ASSERT = /^\?\?\s+(status|header|body|duration|js|xpath)\b\s*(.*)$/;
const OPERATORS = ["==", "!=", ">=", "<=", ">", "<", "startsWith", "endsWith", "includes", "contains", "exists", "isFalse", "isTrue", "isNumber", "isBoolean", "isString", "isArray", "matches", "sha256", "sha512", "md5"];

export function parseAssertion(line: string, lineNo: number): Assertion | undefined {
  const match = ASSERT.exec(line.trim());
  if (!match) return undefined;
  const kind = match[1] as Assertion["kind"];
  const rest = match[2]!.trim();
  if (kind === "js") {
    // `?? js expr op expected` or a bare boolean expression.
    for (const op of OPERATORS) {
      const re = new RegExp(`\\s${op.replace(/[<>=!]/g, "\\$&")}(\\s|$)`);
      const m = re.exec(rest);
      if (m) return { kind, target: rest.slice(0, m.index).trim(), operator: op, expected: rest.slice(m.index + m[0].length).trim(), source: line.trim(), line: lineNo };
    }
    return { kind, target: rest, operator: "isTrue", expected: "", source: line.trim(), line: lineNo };
  }
  const words = rest.split(/\s+/);
  let targetWords = kind === "status" || kind === "duration" ? 0 : 1;
  if (kind === "body" && words[0] && OPERATORS.includes(words[0])) targetWords = 0;
  const target = words.slice(0, targetWords).join(" ");
  const operator = words[targetWords] ?? "exists";
  const expected = words.slice(targetWords + 1).join(" ");
  return { kind, target, operator, expected, source: line.trim(), line: lineNo };
}

function parseRun(text: string, line: number): RunDirective {
  const m = /^run\s+(\S+?)(?:#([^\s(]+))?\s*(?:\((.*)\))?\s*$/.exec(text.trim())!;
  const overrides: Record<string, string> = {};
  for (const part of (m?.[3] ?? "").split(",")) {
    const kv = /^\s*@?([^=\s]+)\s*=\s*(.*?)\s*$/.exec(part);
    if (kv) overrides[kv[1]!] = kv[2]!;
  }
  return { path: m?.[1] ?? "", name: m?.[2], overrides, line };
}

function isPathLike(text: string): boolean {
  return /^(\.{0,2}\/|~\/|[A-Za-z]:[\\/]|\{\{)/.test(text) || /\.[\w]+$/.test(text);
}

/** Parse a `.http` / `.rest` file. Never throws: problems are recorded in `errors`. */
export function parseHttpFile(source: string, path = ""): HttpFile {
  const lines = source.replace(/^﻿/, "").split(/\r?\n/);
  const file: HttpFile = { path, requests: [], variables: [], metadata: new Map(), globalScripts: [], imports: [], runs: [], errors: [] };

  // Blocks: [start, end) line ranges plus the separator title.
  const blocks: { start: number; end: number; title?: string }[] = [];
  let start = 0;
  let title: string | undefined;
  let inScript: "" | "jb" | "yac" | "block" = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (inScript === "jb") { if (line.includes("%}")) inScript = ""; continue; }
    if (inScript === "yac") { if (line.trim() === "}}") inScript = ""; continue; }
    if (inScript === "block") { if (line.includes("*/")) inScript = ""; continue; }
    if (/\{%/.test(line) && !line.includes("%}")) { inScript = "jb"; continue; }
    if (HTTPYAC_SCRIPT.test(line)) { inScript = "yac"; continue; }
    if (/^\s*\/\*/.test(line) && !line.includes("*/")) { inScript = "block"; continue; }
    const sep = SEPARATOR.exec(line);
    if (sep) {
      blocks.push({ start, end: i, title });
      start = i + 1;
      title = sep[1]!.trim() || undefined;
    }
  }
  blocks.push({ start, end: lines.length, title });

  for (const block of blocks) parseBlock(lines, block.start, block.end, block.title, file);
  return file;
}

function parseBlock(lines: string[], start: number, end: number, title: string | undefined, file: HttpFile): void {
  const metadata: Metadata = new Map();
  const variables: FileVariable[] = [];
  const preScripts: Script[] = [];
  let request: HttpRequest | undefined;
  let i = start;
  const error = (line: number, message: string): void => { file.errors.push({ line: line + 1, message }); };

  // Preamble.
  for (; i < end; i++) {
    const raw = lines[i]!;
    const line = raw.trim();
    if (line === "") continue;
    if (line.startsWith("/*")) {
      while (i < end && !lines[i]!.includes("*/")) i++;
      continue;
    }
    const meta = METADATA.exec(raw);
    if (meta) {
      const key = meta[1]!;
      const value = meta[2] ?? "";
      if (key === "import") file.imports.push(value);
      else addMetadata(metadata, key, value);
      continue;
    }
    if (COMMENT.test(raw)) continue;
    const variable = VARIABLE.exec(raw);
    if (variable && !line.startsWith("@{{")) {
      variables.push({ name: variable[1]!, value: variable[3]!.trim(), lazy: variable[2] === ":=", line: i + 1 });
      continue;
    }
    if (/^<\s*\{%/.test(line)) {
      const read = readUntil(lines, i, "{%", "%}");
      if (!read || read.next > end) { error(i, "unclosed {% script"); return; }
      preScripts.push({ dialect: "jetbrains", code: read.code, line: i + 1 });
      i = read.next - 1;
      continue;
    }
    if (/^<\s+\S+\.(m?js|cjs|ts)$/.test(line)) {
      preScripts.push({ dialect: "jetbrains", file: line.slice(1).trim(), line: i + 1 });
      continue;
    }
    if (HTTPYAC_SCRIPT.test(raw)) {
      const read = readHttpyacBlock(lines, i);
      if (!read || read.next > end) { error(i, "unclosed {{ script"); return; }
      const script: Script = { dialect: "httpyac", code: read.code, ...scriptHeader(raw, i + 1) };
      if (script.global) file.globalScripts.push(script);
      else preScripts.push(script);
      i = read.next - 1;
      continue;
    }
    if (/^import\s+\S/.test(line)) { file.imports.push(line.slice(6).trim()); continue; }
    if (/^run\s+\S/.test(line)) { file.runs.push(parseRun(line, i + 1)); continue; }
    if (/^curl\s/.test(line)) {
      const parts: string[] = [];
      let j = i;
      for (; j < end; j++) {
        const l = lines[j]!;
        if (j > i && l.trim() === "") break;
        parts.push(l);
      }
      request = blank(file.requests.length, i, title, metadata, variables, preScripts);
      request.method = "CURL";
      request.url = parts.join("\n");
      request.fromCurl = true;
      i = j;
      break;
    }
    const req = requestLine(raw);
    if (!req) { error(i, `not a request line: ${line.slice(0, 80)}`); return; }
    request = blank(file.requests.length, i, title, metadata, variables, preScripts);
    request.method = req.method;
    request.url = req.url;
    request.httpVersion = req.httpVersion;
    i++;
    break;
  }

  if (!request) {
    // A global region: everything applies file-wide (httpyac). `@name` in it names nothing.
    file.variables.push(...variables);
    for (const [key, values] of metadata) if (key !== "name") for (const v of values) addMetadata(file.metadata, key, v);
    for (const script of preScripts) file.globalScripts.push({ ...script, global: true });
    return;
  }
  file.variables.push(...variables);

  // URL continuation and headers.
  if (!request.fromCurl) {
    let sawHeader = false;
    for (; i < end; i++) {
      const raw = lines[i]!;
      const line = raw.trim();
      if (line === "") { i++; break; }
      if (!sawHeader && (/^\s/.test(raw) || /^[?&]/.test(line))) {
        request.url += line;
        continue;
      }
      if (sawHeader && /^\s/.test(raw) && request.headers.length > 0) {
        const last = request.headers[request.headers.length - 1]!;
        if ("name" in last) { last.value = `${last.value} ${line}`.trim(); continue; }
      }
      const meta = METADATA.exec(raw);
      if (meta) { addMetadata(request.metadata, meta[1]!, meta[2] ?? ""); continue; }
      if (COMMENT.test(raw)) continue;
      if (isHandlerLine(line)) break;
      if (line.startsWith("...")) { request.headers.push({ spread: line.slice(3).trim() }); sawHeader = true; continue; }
      if (/^proto\s*</.test(line)) { addMetadata(request.metadata, "proto", line.replace(/^proto\s*<\s*/, "")); sawHeader = true; continue; }
      const header = HEADER.exec(line);
      if (header && !/^</.test(line)) {
        request.headers.push({ name: header[1]!.trim(), value: header[2]!.trim() });
        sawHeader = true;
        continue;
      }
      // No blank line before the body: JetBrains accepts `< file` straight after headers.
      if (/^<[@\s]/.test(line)) break;
      error(i, `malformed header: ${line.slice(0, 80)}`);
      request.error = `malformed header: ${line.slice(0, 80)}`;
      break;
    }

    // Body and handlers.
    const isStream = ["WEBSOCKET", "WS", "WSS", "GRPC"].includes(request.method);
    let text: string[] = [];
    let messages: StreamMessage[] | undefined;
    let handlersStarted = false;
    const flushText = (): void => {
      if (text.length) request!.body.push({ kind: "text", text: text.join("\n") });
      text = [];
    };
    for (; i < end; i++) {
      const raw = lines[i]!;
      const line = raw.trim();
      if (/^>\s*\{%/.test(line)) {
        const read = readUntil(lines, i, "{%", "%}");
        if (!read || read.next > end) { error(i, "unclosed {% script"); break; }
        request.postScripts.push({ dialect: "jetbrains", code: read.code, line: i + 1 });
        handlersStarted = true;
        i = read.next - 1;
        continue;
      }
      if (/^>>!?\s*\S/.test(line)) {
        request.save = { overwrite: line.startsWith(">>!"), path: line.replace(/^>>!?\s*/, "") };
        handlersStarted = true;
        continue;
      }
      if (/^>\s+\S/.test(line) && isPathLike(line.slice(1).trim())) {
        request.postScripts.push({ dialect: "jetbrains", file: line.slice(1).trim(), line: i + 1 });
        handlersStarted = true;
        continue;
      }
      if (/^<>\s*\S/.test(line)) { request.compareWith = line.slice(2).trim(); handlersStarted = true; continue; }
      if (line.startsWith("?? ")) {
        const assertion = parseAssertion(line, i + 1);
        if (assertion) request.assertions.push(assertion);
        else error(i, `unknown assertion: ${line}`);
        handlersStarted = true;
        continue;
      }
      if (HTTPYAC_SCRIPT.test(raw)) {
        const read = readHttpyacBlock(lines, i);
        if (!read || read.next > end) { error(i, "unclosed {{ script"); break; }
        const script: Script = { dialect: "httpyac", code: read.code, ...scriptHeader(raw, i + 1) };
        if (script.global) file.globalScripts.push(script);
        else if (script.event === "request") request.preScripts.push(script);
        else request.postScripts.push(script);
        if (script.event !== "streaming" && script.event !== "request") handlersStarted = true;
        i = read.next - 1;
        continue;
      }
      if (handlersStarted) {
        if (line !== "" && !COMMENT.test(raw)) error(i, `text after a response handler is ignored: ${line.slice(0, 60)}`);
        continue;
      }
      if (isStream && /^===(\s+wait-for-server)?\s*$/.test(line)) {
        messages ??= [];
        messages.push({ text: text.join("\n").trim(), waitForServer: false });
        text = [];
        if (/wait-for-server/.test(line)) messages[messages.length - 1]!.waitForServer = true;
        continue;
      }
      const gql = /^gql\s+(?:\S+\s+)?<\s*(\S+)\s*$/.exec(line);
      if (gql && text.every((l) => l.trim() === "")) { request.graphqlFile = gql[1]; text = []; continue; }
      const include = /^<(@([\w-]*))?\s+(\S.*)$/.exec(line);
      if (include) {
        flushText();
        const encoding = include[2] ? include[2] as BufferEncoding : undefined;
        request.body.push({ kind: "file", path: include[3]!.trim(), substitute: include[1] !== undefined, encoding });
        text = [];
        continue;
      }
      text.push(raw);
    }
    if (messages) {
      const last = text.join("\n").trim();
      if (last) messages.push({ text: last, waitForServer: false });
      request.messages = messages.map((m, n) => ({ text: m.text, waitForServer: n > 0 && messages![n - 1]!.waitForServer }));
      text = [];
    }
    // Trim leading and trailing blank lines of the textual body.
    while (text.length && text[text.length - 1]!.trim() === "") text.pop();
    flushText();
    const first = request.body[0];
    if (first?.kind === "text") {
      first.text = first.text.replace(/^(\s*\n)+/, "");
      if (first.text === "") request.body.shift();
    }
    const lastPart = request.body[request.body.length - 1];
    if (lastPart?.kind === "text") lastPart.text = lastPart.text.replace(/(\n\s*)+$/, "");
    if (messages && request.body.length === 0) request.body = [];
  }
  request.span = { start, end };
  file.requests.push(request);
}

function isHandlerLine(line: string): boolean {
  return /^>\s*\{%/.test(line) || /^>>!?\s/.test(line) || line.startsWith("?? ") || /^<>\s/.test(line);
}

function blank(index: number, line: number, title: string | undefined, metadata: Metadata, variables: FileVariable[], preScripts: Script[]): HttpRequest {
  const name = metadata.get("name")?.at(-1)?.trim() || undefined;
  return {
    index, name: name ?? (title && /^[\w.-]+$/.test(title) ? title : undefined), title,
    method: "GET", url: "", headers: [], body: [], metadata, variables, preScripts,
    postScripts: [], assertions: [], span: { start: line, end: line }, line: line + 1,
  };
}

/** The label shown for a request in lists: title, name, or method + URL. */
export function requestLabel(request: HttpRequest): string {
  return request.title ?? request.name ?? `${request.method} ${request.url.split("\n")[0]}`;
}
