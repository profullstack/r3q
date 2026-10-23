/**
 * Getting requests into and out of `.http` files: curl commands both ways,
 * code snippets in other languages (what VS Code REST Client does with
 * httpsnippet), and importers for Postman, OpenAPI and Bruno collections.
 *
 * Everything here is text in, text out. Nothing touches the network or the
 * file system; the caller decides where the converted files go.
 */
import { isUtf8 } from "node:buffer";
import type { PreparedRequest } from "./types.ts";

// ---------------------------------------------------------------- curl in

export interface CurlRequest {
  method: string;
  url: string;
  headers: [string, string][];
  body?: string;
  bodyFile?: string;
  form?: { name: string; value?: string; file?: string; type?: string }[];
  user?: string;
  cookies?: string;
  head?: boolean;
  followRedirects?: boolean;
  insecure?: boolean;
  proxy?: string;
  maxTime?: number;
  compressed?: boolean;
  http2?: boolean;
}

const ANSI_C: Record<string, string> = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?" };

/**
 * Split a command line into words the way a shell would. POSIX quoting
 * (`'..'`, `".."`, `$'..'`, backslashes, backslash-newline continuations),
 * plus Windows cmd's `^` escapes so "Copy as cURL (cmd)" pastes work too.
 */
export function shellWords(input: string): string[] {
  let s = input;
  if (/\^\r?\n/.test(s) || /\^"/.test(s)) s = s.replace(/\^\r?\n/g, " ").replace(/\^(.)/g, "$1");
  s = s.replace(/\\\r?\n/g, " ");
  const out: string[] = [];
  let cur = "";
  let has = false;
  let i = 0;
  while (i < s.length) {
    const c = s[i] as string;
    if (/\s/.test(c)) {
      if (has) { out.push(cur); cur = ""; has = false; }
      i++;
      continue;
    }
    has = true;
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) throw new Error("unterminated ' quote in command");
      cur += s.slice(i + 1, end);
      i = end + 1;
    } else if (c === "$" && s[i + 1] === "'") {
      i += 2;
      while (i < s.length && s[i] !== "'") {
        if (s[i] === "\\" && i + 1 < s.length) {
          const e = s[i + 1] as string;
          if (e === "x") {
            const hex = /^[0-9a-fA-F]{1,2}/.exec(s.slice(i + 2))?.[0] ?? "";
            cur += String.fromCharCode(parseInt(hex || "0", 16));
            i += 2 + hex.length;
          } else if (e === "u" || e === "U") {
            const hex = new RegExp(`^[0-9a-fA-F]{1,${e === "u" ? 4 : 8}}`).exec(s.slice(i + 2))?.[0] ?? "";
            cur += String.fromCodePoint(parseInt(hex || "0", 16));
            i += 2 + hex.length;
          } else if (/[0-7]/.test(e)) {
            const oct = /^[0-7]{1,3}/.exec(s.slice(i + 1))?.[0] ?? "0";
            cur += String.fromCharCode(parseInt(oct, 8));
            i += 1 + oct.length;
          } else {
            cur += ANSI_C[e] ?? `\\${e}`;
            i += 2;
          }
        } else {
          cur += s[i];
          i++;
        }
      }
      if (i >= s.length) throw new Error("unterminated $' quote in command");
      i++;
    } else if (c === '"') {
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === "\\" && i + 1 < s.length && '$`"\\\n'.includes(s[i + 1] as string)) {
          cur += s[i + 1];
          i += 2;
        } else {
          cur += s[i];
          i++;
        }
      }
      if (i >= s.length) throw new Error('unterminated " quote in command');
      i++;
    } else if (c === "\\" && i + 1 < s.length) {
      cur += s[i + 1];
      i += 2;
    } else {
      cur += c;
      i++;
    }
  }
  if (has) out.push(cur);
  return out;
}

/** Short options that take an argument; every other letter is a switch. */
const SHORT_ARG = new Set("XHdubAexmFoTwrEKcDzYyCQt".split(""));
/** Long options that take an argument when not written as `--opt=value`. */
const LONG_ARG = new Set([
  "request", "header", "data", "data-raw", "data-binary", "data-ascii", "data-urlencode", "json",
  "form", "form-string", "user", "cookie", "user-agent", "referer", "proxy", "max-time", "url",
  "output", "upload-file", "cert", "key", "cacert", "capath", "connect-timeout", "write-out",
  "cookie-jar", "dump-header", "range", "retry", "retry-delay", "retry-max-time", "proxy-user",
  "resolve", "interface", "cert-type", "key-type", "pass", "limit-rate", "max-redirs", "oauth2-bearer",
  "aws-sigv4", "config", "time-cond", "local-port", "unix-socket", "connect-to", "request-target",
  "max-filesize", "expect100-timeout", "tls-max", "ciphers", "proto", "proto-redir", "stderr", "trace",
  "trace-ascii", "variable", "url-query", "service-name", "netrc-file", "keepalive-time",
]);

function hasHeader(headers: [string, string][], name: string): boolean {
  return headers.some(([k]) => k.toLowerCase() === name.toLowerCase());
}

function urlencodeData(arg: string): string {
  // curl's --data-urlencode forms: content, =content, name=content, @file, name@file.
  const eq = arg.indexOf("=");
  const at = arg.indexOf("@");
  if (eq === 0) return encodeURIComponent(arg.slice(1));
  if (eq > 0 && (at < 0 || eq < at)) return `${arg.slice(0, eq)}=${encodeURIComponent(arg.slice(eq + 1))}`;
  if (at >= 0) return arg; // file forms are left for the reader to resolve
  return encodeURIComponent(arg);
}

function parseFormArg(arg: string, literal: boolean): NonNullable<CurlRequest["form"]>[number] {
  const eq = arg.indexOf("=");
  const name = eq < 0 ? arg : arg.slice(0, eq);
  let rest = eq < 0 ? "" : arg.slice(eq + 1);
  if (literal) return { name, value: rest };
  const field: NonNullable<CurlRequest["form"]>[number] = { name };
  const attrs: string[] = [];
  if (rest.startsWith('"')) {
    const end = rest.indexOf('"', 1);
    const quoted = end < 0 ? rest.slice(1) : rest.slice(1, end);
    attrs.push(...(end < 0 ? [] : rest.slice(end + 1).split(";").filter(Boolean)));
    rest = quoted;
    field.value = rest;
  } else {
    const parts = rest.split(";");
    rest = parts[0] ?? "";
    attrs.push(...parts.slice(1));
    if (rest.startsWith("@")) field.file = rest.slice(1);
    else if (rest.startsWith("<")) field.file = rest.slice(1), field.value = "";
    else field.value = rest;
  }
  for (const attr of attrs) {
    const [k, v = ""] = attr.split(/=(.*)/s);
    if (k?.trim() === "type") field.type = v;
  }
  return field;
}

/**
 * Parse a curl command into its parts. The flags people actually paste are
 * understood; anything else is skipped rather than rejected.
 */
export function parseCurl(command: string): CurlRequest {
  const words = shellWords(command.trim());
  if (words[0] === "curl" || words[0]?.endsWith("/curl") || words[0] === "curl.exe") words.shift();
  const headers: [string, string][] = [];
  const data: { text: string; file?: string }[] = [];
  const form: NonNullable<CurlRequest["form"]> = [];
  const out: CurlRequest = { method: "", url: "", headers };
  let method = "";
  let get = false;
  let json = false;
  let upload: string | undefined;

  const apply = (flag: string, value: string | undefined): void => {
    const v = value ?? "";
    switch (flag) {
      case "X": case "request": method = v.toUpperCase(); break;
      case "H": case "header": {
        const colon = v.indexOf(":");
        if (colon > 0) {
          const val = v.slice(colon + 1).trim();
          if (val !== "") headers.push([v.slice(0, colon).trim(), val]);
        } else if (v.endsWith(";")) headers.push([v.slice(0, -1).trim(), ""]);
        break;
      }
      case "d": case "data": case "data-ascii": case "data-binary":
        if (v.startsWith("@")) data.push({ text: "", file: v.slice(1) });
        else data.push({ text: v });
        break;
      case "data-raw": data.push({ text: v }); break;
      case "data-urlencode": data.push({ text: urlencodeData(v) }); break;
      case "json":
        json = true;
        if (v.startsWith("@")) data.push({ text: "", file: v.slice(1) });
        else data.push({ text: v });
        break;
      case "F": case "form": form.push(parseFormArg(v, false)); break;
      case "form-string": form.push(parseFormArg(v, true)); break;
      case "u": case "user": out.user = v; break;
      case "b": case "cookie": if (v.includes("=")) out.cookies = out.cookies ? `${out.cookies}; ${v}` : v; break;
      case "A": case "user-agent": headers.push(["User-Agent", v]); break;
      case "e": case "referer": { const r = v.replace(/;auto$/, ""); if (r) headers.push(["Referer", r]); break; }
      case "I": case "head": out.head = true; break;
      case "L": case "location": out.followRedirects = true; break;
      case "k": case "insecure": out.insecure = true; break;
      case "x": case "proxy": out.proxy = v; break;
      case "m": case "max-time": { const n = Number(v); if (Number.isFinite(n)) out.maxTime = n; break; }
      case "compressed": out.compressed = true; break;
      case "http2": case "http2-prior-knowledge": out.http2 = true; break;
      case "G": case "get": get = true; break;
      case "url": if (!out.url) out.url = v; break;
      case "T": case "upload-file": upload = v; break;
      case "oauth2-bearer": headers.push(["Authorization", `Bearer ${v}`]); break;
    }
  };

  for (let i = 0; i < words.length; i++) {
    const word = words[i] as string;
    if (word.startsWith("--") && word.length > 2) {
      const eq = word.indexOf("=");
      const name = eq < 0 ? word.slice(2) : word.slice(2, eq);
      if (eq >= 0) apply(name, word.slice(eq + 1));
      else if (LONG_ARG.has(name)) apply(name, words[++i]);
      else apply(name, undefined);
    } else if (word.startsWith("-") && word.length > 1) {
      for (let j = 1; j < word.length; j++) {
        const letter = word[j] as string;
        if (SHORT_ARG.has(letter)) {
          const attached = word.slice(j + 1);
          apply(letter, attached !== "" ? attached : words[++i]);
          break;
        }
        apply(letter, undefined);
      }
    } else if (!out.url) {
      out.url = word;
    }
  }

  if (out.url && !/^[a-z][a-z0-9+.-]*:\/\//i.test(out.url)) out.url = `http://${out.url}`;

  const texts = data.filter((d) => d.file === undefined).map((d) => d.text);
  const files = data.filter((d) => d.file !== undefined);
  if (get && data.length > 0) {
    const query = data.map((d) => d.file !== undefined ? `@${d.file}` : d.text).join("&");
    out.url += (out.url.includes("?") ? "&" : "?") + query;
  } else if (data.length > 0) {
    if (files.length === 1 && texts.length === 0) out.bodyFile = files[0]?.file;
    else out.body = data.map((d) => d.file !== undefined ? `@${d.file}` : d.text).join(json ? "" : "&");
    if (json) {
      if (!hasHeader(headers, "Content-Type")) headers.push(["Content-Type", "application/json"]);
      if (!hasHeader(headers, "Accept")) headers.push(["Accept", "application/json"]);
    } else if (!hasHeader(headers, "Content-Type")) {
      headers.push(["Content-Type", "application/x-www-form-urlencoded"]);
    }
  }
  if (upload !== undefined && out.bodyFile === undefined && out.body === undefined) out.bodyFile = upload;
  if (form.length > 0) out.form = form;

  out.method = method
    || (out.head ? "HEAD"
      : (out.body !== undefined || out.bodyFile !== undefined) && upload !== undefined && data.length === 0 ? "PUT"
        : out.body !== undefined || out.bodyFile !== undefined || form.length > 0 ? "POST"
          : "GET");
  return out;
}

const BOUNDARY = "WebAppBoundary";

function filePath(path: string): string {
  return path.startsWith("/") || path.startsWith("./") || path.startsWith("../") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("~")
    ? path
    : `./${path}`;
}

function basenameOf(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** Multipart body in the `.http` spelling: boundary lines and `< ./file` parts. */
function multipartBody(parts: { name: string; value?: string; file?: string; filename?: string; type?: string }[]): string {
  const lines: string[] = [];
  for (const part of parts) {
    lines.push(`--${BOUNDARY}`);
    if (part.file !== undefined) {
      const filename = part.filename ?? (part.value === "" ? undefined : basenameOf(part.file));
      lines.push(`Content-Disposition: form-data; name="${part.name}"${filename !== undefined ? `; filename="${filename}"` : ""}`);
      if (part.type) lines.push(`Content-Type: ${part.type}`);
      lines.push("", `< ${filePath(part.file)}`);
    } else {
      lines.push(`Content-Disposition: form-data; name="${part.name}"`);
      if (part.type) lines.push(`Content-Type: ${part.type}`);
      lines.push("", part.value ?? "");
    }
  }
  lines.push(`--${BOUNDARY}--`);
  return lines.join("\n");
}

/**
 * Turn a curl command into a `.http` request block. With `keepComment` the
 * original command stays above it as a comment, the way JetBrains converts
 * a paste.
 */
export function curlToHttp(command: string, keepComment = false): string {
  const curl = parseCurl(command);
  const lines: string[] = [];
  if (keepComment) lines.push(`# ${command.trim().replace(/\\\r?\n\s*/g, "").replace(/\^\r?\n\s*/g, "").replace(/\s*\r?\n\s*/g, " ")}`);
  if (!curl.followRedirects) lines.push("# @no-redirect");
  if (curl.insecure) lines.push("# @no-reject-unauthorized");
  if (curl.proxy) lines.push(`# @proxy ${curl.proxy}`);
  if (curl.maxTime !== undefined) lines.push(`# @timeout ${curl.maxTime} s`);
  lines.push(`${curl.method} ${curl.url}${curl.http2 ? " HTTP/2" : ""}`);
  const headers = [...curl.headers];
  if (curl.user !== undefined) {
    const colon = curl.user.indexOf(":");
    headers.push(["Authorization", colon < 0 ? `Basic ${curl.user}` : `Basic ${curl.user.slice(0, colon)} ${curl.user.slice(colon + 1)}`]);
  }
  if (curl.cookies !== undefined) headers.push(["Cookie", curl.cookies]);
  if (curl.compressed && !hasHeader(headers, "Accept-Encoding")) headers.push(["Accept-Encoding", "gzip, deflate, br"]);
  if (curl.form) {
    const others = headers.filter(([k]) => k.toLowerCase() !== "content-type");
    headers.length = 0;
    headers.push(...others, ["Content-Type", `multipart/form-data; boundary=${BOUNDARY}`]);
  }
  for (const [k, v] of headers) lines.push(`${k}: ${v}`);
  if (curl.form) lines.push("", multipartBody(curl.form));
  else if (curl.bodyFile !== undefined) lines.push("", `< ${filePath(curl.bodyFile)}`);
  else if (curl.body !== undefined) lines.push("", curl.body);
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------- curl out

/** Quote a word for a POSIX shell. */
export function shellQuote(word: string): string {
  if (word !== "" && /^[A-Za-z0-9_@%+=:,./-]+$/.test(word)) return word;
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

interface BodyText { text?: string; binary?: Buffer }

function bodyOf(req: PreparedRequest): BodyText {
  if (req.body === undefined || req.body.length === 0) return req.bodyText !== undefined && req.bodyText !== "" ? { text: req.bodyText } : {};
  if (isUtf8(req.body)) return { text: req.body.toString("utf8") };
  return { binary: req.body };
}

/** A curl command for a prepared request, safe to paste into a POSIX shell. */
export function toCurl(req: PreparedRequest): string {
  const parts: string[] = [];
  const body = bodyOf(req);
  let prefix = "";
  const method = req.method.toUpperCase();
  if (method === "HEAD") parts.push("--head");
  else if (method !== "GET" || body.text !== undefined || body.binary !== undefined) {
    if (!(method === "POST" && (body.text !== undefined || body.binary !== undefined))) parts.push(`-X ${shellQuote(method)}`);
  }
  if (req.httpVersion && /2/.test(req.httpVersion)) parts.push("--http2");
  for (const [k, v] of req.headers) parts.push(`-H ${shellQuote(`${k}: ${v}`)}`);
  if (body.text !== undefined) parts.push(`--data-raw ${shellQuote(body.text)}`);
  else if (body.binary !== undefined) {
    prefix = `printf '%s' ${shellQuote(body.binary.toString("base64"))} | base64 -d | `;
    parts.push("--data-binary @-");
  }
  return `${prefix}curl ${shellQuote(req.url)}${parts.map((p) => ` \\\n  ${p}`).join("")}`;
}

// ---------------------------------------------------------------- code generation

export const LANGUAGES = [
  "curl", "httpie", "wget", "powershell", "javascript-fetch", "node-fetch", "axios",
  "python-requests", "python-httpx", "go", "rust-reqwest", "java-httpclient", "csharp-httpclient",
  "php-curl", "ruby-net-http", "swift-urlsession", "kotlin-okhttp", "dart-http", "c-libcurl", "http",
] as const;

/** Escape for C-family double- or single-quoted literals. */
function cString(s: string, quote: string, ctrl: (code: number) => string, extra: Record<string, string> = {}): string {
  let out = quote;
  for (const ch of s) {
    const code = ch.codePointAt(0) as number;
    if (extra[ch] !== undefined) out += extra[ch];
    else if (ch === "\\") out += "\\\\";
    else if (ch === quote) out += `\\${quote}`;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f) out += ctrl(code);
    else out += ch;
  }
  return out + quote;
}

const hex = (code: number, width: number): string => code.toString(16).padStart(width, "0");
const lit = {
  json: (s: string) => JSON.stringify(s),
  rust: (s: string) => cString(s, '"', (c) => `\\u{${hex(c, 2)}}`),
  swift: (s: string) => cString(s, '"', (c) => `\\u{${hex(c, 2)}}`),
  kotlin: (s: string) => cString(s, '"', (c) => `\\u${hex(c, 4)}`, { $: "\\$" }),
  dart: (s: string) => cString(s, "'", (c) => `\\u{${hex(c, 2)}}`, { $: "\\$" }),
  c: (s: string) => cString(s, '"', (c) => `\\${c.toString(8).padStart(3, "0")}`, { "?": "\\?" }),
  php: (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`,
  ruby: (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`,
  ps: (s: string) => `'${s.replace(/'/g, "''")}'`,
};

/** Header list collapsed to one value per name, for languages that take a map. */
function headerMap(headers: [string, string][]): [string, string][] {
  const map = new Map<string, [string, string]>();
  for (const [k, v] of headers) {
    const key = k.toLowerCase();
    const prev = map.get(key);
    if (prev) prev[1] = `${prev[1]}${key === "cookie" ? "; " : ", "}${v}`;
    else map.set(key, [k, v]);
  }
  return [...map.values()];
}

function contentType(headers: [string, string][]): string | undefined {
  return headers.find(([k]) => k.toLowerCase() === "content-type")?.[1];
}

/**
 * Code that sends the same request, in one of {@link LANGUAGES}. Binary
 * bodies are left out with a note: a snippet is for reading, and a base64
 * blob in eighteen languages helps nobody.
 */
export function generateCode(lang: string, req: PreparedRequest): string {
  const body = bodyOf(req);
  const text = body.text;
  const method = req.method.toUpperCase();
  const headers = headerMap(req.headers);
  const binaryNote = (comment: string): string => body.binary ? `${comment} binary body (${body.binary.length} bytes) omitted; read it from a file\n` : "";
  const indent = (lines: string[], pad: string): string => lines.map((l) => `${pad}${l}`).join("\n");

  switch (lang) {
    case "curl":
      return toCurl(req);

    case "httpie": {
      const parts = [`http ${shellQuote(method)} ${shellQuote(req.url)}`];
      for (const [k, v] of req.headers) parts.push(shellQuote(`${k}:${v}`));
      if (text !== undefined) parts.push(`--raw ${shellQuote(text)}`);
      return binaryNote("#") + parts.join(" \\\n  ");
    }

    case "wget": {
      const parts = ["wget --quiet", `--method=${shellQuote(method)}`];
      for (const [k, v] of req.headers) parts.push(`--header=${shellQuote(`${k}: ${v}`)}`);
      if (text !== undefined) parts.push(`--body-data=${shellQuote(text)}`);
      parts.push("--output-document=-", shellQuote(req.url));
      return binaryNote("#") + parts.join(" \\\n  ");
    }

    case "powershell": {
      const ct = contentType(headers);
      const rest = headers.filter(([k]) => k.toLowerCase() !== "content-type");
      const lines: string[] = [];
      if (rest.length) {
        lines.push("$headers = @{");
        for (const [k, v] of rest) lines.push(`    ${lit.ps(k)} = ${lit.ps(v)}`);
        lines.push("}");
      }
      let call = `$response = Invoke-WebRequest -Uri ${lit.ps(req.url)} -Method ${lit.ps(method)}`;
      if (rest.length) call += " -Headers $headers";
      if (ct) call += ` -ContentType ${lit.ps(ct)}`;
      if (text !== undefined) call += ` -Body ${lit.ps(text)}`;
      lines.push(call, "$response.Content");
      return binaryNote("#") + lines.join("\n");
    }

    case "javascript-fetch":
    case "node-fetch": {
      const lines: string[] = [];
      if (lang === "node-fetch") lines.push("import fetch from 'node-fetch';", "");
      lines.push(`const response = await fetch(${lit.json(req.url)}, {`, `  method: ${lit.json(method)},`);
      if (headers.length) {
        lines.push("  headers: {");
        for (const [k, v] of headers) lines.push(`    ${lit.json(k)}: ${lit.json(v)},`);
        lines.push("  },");
      }
      if (text !== undefined) lines.push(`  body: ${lit.json(text)},`);
      lines.push("});", "console.log(response.status);", "console.log(await response.text());");
      return binaryNote("//") + lines.join("\n");
    }

    case "axios": {
      const lines = ["import axios from 'axios';", "", "const response = await axios.request({", `  method: ${lit.json(method)},`, `  url: ${lit.json(req.url)},`];
      if (headers.length) {
        lines.push("  headers: {");
        for (const [k, v] of headers) lines.push(`    ${lit.json(k)}: ${lit.json(v)},`);
        lines.push("  },");
      }
      if (text !== undefined) lines.push(`  data: ${lit.json(text)},`);
      lines.push("});", "console.log(response.status);", "console.log(response.data);");
      return binaryNote("//") + lines.join("\n");
    }

    case "python-requests":
    case "python-httpx": {
      const mod = lang === "python-requests" ? "requests" : "httpx";
      const lines = [`import ${mod}`, "", `url = ${lit.json(req.url)}`];
      const args = ["url"];
      if (headers.length) {
        lines.push("headers = {");
        for (const [k, v] of headers) lines.push(`    ${lit.json(k)}: ${lit.json(v)},`);
        lines.push("}");
        args.push("headers=headers");
      }
      if (text !== undefined) {
        lines.push(`data = ${lit.json(text)}`);
        args.push(lang === "python-requests" ? "data=data.encode('utf-8')" : "content=data.encode('utf-8')");
      }
      lines.push("", `response = ${mod}.request(${lit.json(method)}, ${args.join(", ")})`, "print(response.status_code)", "print(response.text)");
      return binaryNote("#") + lines.join("\n");
    }

    case "go": {
      const imports = ['"fmt"', '"io"', '"net/http"'];
      if (text !== undefined) imports.push('"strings"');
      const lines = ["package main", "", "import (", indent(imports, "\t"), ")", "", "func main() {"];
      const body = text !== undefined ? `strings.NewReader(${lit.json(text)})` : "nil";
      lines.push(`\treq, err := http.NewRequest(${lit.json(method)}, ${lit.json(req.url)}, ${body})`, "\tif err != nil {", "\t\tpanic(err)", "\t}");
      for (const [k, v] of req.headers) lines.push(`\treq.Header.Add(${lit.json(k)}, ${lit.json(v)})`);
      lines.push("\tres, err := http.DefaultClient.Do(req)", "\tif err != nil {", "\t\tpanic(err)", "\t}", "\tdefer res.Body.Close()",
        "\tdata, _ := io.ReadAll(res.Body)", "\tfmt.Println(res.Status)", "\tfmt.Println(string(data))", "}");
      return binaryNote("//") + lines.join("\n");
    }

    case "rust-reqwest": {
      const lines = ["// Cargo.toml: reqwest = { version = \"0.12\", features = [\"blocking\"] }", "fn main() -> Result<(), Box<dyn std::error::Error>> {",
        "    let client = reqwest::blocking::Client::new();",
        `    let response = client`, `        .request(reqwest::Method::from_bytes(${lit.rust(method)}.as_bytes())?, ${lit.rust(req.url)})`];
      for (const [k, v] of req.headers) lines.push(`        .header(${lit.rust(k)}, ${lit.rust(v)})`);
      if (text !== undefined) lines.push(`        .body(${lit.rust(text)})`);
      lines.push("        .send()?;", "    println!(\"{}\", response.status());", "    println!(\"{}\", response.text()?);", "    Ok(())", "}");
      return binaryNote("//") + lines.join("\n");
    }

    case "java-httpclient": {
      const publisher = text !== undefined ? `HttpRequest.BodyPublishers.ofString(${lit.json(text)})` : "HttpRequest.BodyPublishers.noBody()";
      const lines = ["import java.net.URI;", "import java.net.http.HttpClient;", "import java.net.http.HttpRequest;", "import java.net.http.HttpResponse;", "",
        "public class Main {", "    public static void main(String[] args) throws Exception {",
        "        HttpRequest request = HttpRequest.newBuilder()", `            .uri(URI.create(${lit.json(req.url)}))`];
      const restricted = new Set(["host", "connection", "content-length", "expect", "upgrade"]);
      for (const [k, v] of req.headers) if (!restricted.has(k.toLowerCase())) lines.push(`            .header(${lit.json(k)}, ${lit.json(v)})`);
      lines.push(`            .method(${lit.json(method)}, ${publisher})`, "            .build();",
        "        HttpResponse<String> response = HttpClient.newHttpClient().send(request, HttpResponse.BodyHandlers.ofString());",
        "        System.out.println(response.statusCode());", "        System.out.println(response.body());", "    }", "}");
      return binaryNote("//") + lines.join("\n");
    }

    case "csharp-httpclient": {
      const ct = contentType(headers);
      const lines = ["using System.Net.Http;", "using System.Text;", "", "var client = new HttpClient();",
        `var request = new HttpRequestMessage(new HttpMethod(${lit.json(method)}), ${lit.json(req.url)});`];
      for (const [k, v] of headers) {
        if (k.toLowerCase() === "content-type") continue;
        lines.push(`request.Headers.TryAddWithoutValidation(${lit.json(k)}, ${lit.json(v)});`);
      }
      if (text !== undefined) {
        lines.push(`request.Content = new StringContent(${lit.json(text)}, Encoding.UTF8);`);
        if (ct) lines.push(`request.Content.Headers.Remove("Content-Type");`, `request.Content.Headers.TryAddWithoutValidation("Content-Type", ${lit.json(ct)});`);
      }
      lines.push("var response = await client.SendAsync(request);", "Console.WriteLine((int)response.StatusCode);", "Console.WriteLine(await response.Content.ReadAsStringAsync());");
      return binaryNote("//") + lines.join("\n");
    }

    case "php-curl": {
      const lines = ["<?php", "", "$curl = curl_init();", "curl_setopt_array($curl, [",
        `    CURLOPT_URL => ${lit.php(req.url)},`, "    CURLOPT_RETURNTRANSFER => true,", `    CURLOPT_CUSTOMREQUEST => ${lit.php(method)},`];
      if (method === "HEAD") lines.push("    CURLOPT_NOBODY => true,");
      if (text !== undefined) lines.push(`    CURLOPT_POSTFIELDS => ${lit.php(text)},`);
      if (req.headers.length) {
        lines.push("    CURLOPT_HTTPHEADER => [");
        for (const [k, v] of req.headers) lines.push(`        ${lit.php(`${k}: ${v}`)},`);
        lines.push("    ],");
      }
      lines.push("]);", "$response = curl_exec($curl);", "echo curl_getinfo($curl, CURLINFO_HTTP_CODE), \"\\n\";", "echo $response;", "curl_close($curl);");
      return binaryNote("//") + lines.join("\n");
    }

    case "ruby-net-http": {
      const lines = ["require 'net/http'", "require 'uri'", "", `uri = URI(${lit.ruby(req.url)})`,
        `request = Net::HTTPGenericRequest.new(${lit.ruby(method)}, ${text !== undefined ? "true" : "false"}, ${method === "HEAD" ? "false" : "true"}, uri.request_uri)`];
      for (const [k, v] of headers) lines.push(`request[${lit.ruby(k)}] = ${lit.ruby(v)}`);
      if (text !== undefined) lines.push(`request.body = ${lit.ruby(text)}`);
      lines.push("response = Net::HTTP.start(uri.hostname, uri.port, use_ssl: uri.scheme == 'https') do |http|", "  http.request(request)", "end",
        "puts response.code", "puts response.body");
      return binaryNote("#") + lines.join("\n");
    }

    case "swift-urlsession": {
      const lines = ["import Foundation", "", `var request = URLRequest(url: URL(string: ${lit.swift(req.url)})!)`, `request.httpMethod = ${lit.swift(method)}`];
      for (const [k, v] of req.headers) lines.push(`request.addValue(${lit.swift(v)}, forHTTPHeaderField: ${lit.swift(k)})`);
      if (text !== undefined) lines.push(`request.httpBody = ${lit.swift(text)}.data(using: .utf8)`);
      lines.push("let (data, response) = try await URLSession.shared.data(for: request)", "print((response as! HTTPURLResponse).statusCode)",
        "print(String(data: data, encoding: .utf8) ?? \"\")");
      return binaryNote("//") + lines.join("\n");
    }

    case "kotlin-okhttp": {
      const ct = contentType(headers);
      const lines = ["import okhttp3.OkHttpClient", "import okhttp3.Request", "import okhttp3.MediaType.Companion.toMediaTypeOrNull", "import okhttp3.RequestBody.Companion.toRequestBody", "",
        "val client = OkHttpClient()"];
      const bodyExpr = text !== undefined
        ? `${lit.kotlin(text)}.toRequestBody(${ct ? `${lit.kotlin(ct)}.toMediaTypeOrNull()` : "null"})`
        : ["POST", "PUT", "PATCH"].includes(method) ? `"".toRequestBody(null)` : "null";
      lines.push("val request = Request.Builder()", `    .url(${lit.kotlin(req.url)})`, `    .method(${lit.kotlin(method)}, ${bodyExpr})`);
      for (const [k, v] of req.headers) lines.push(`    .addHeader(${lit.kotlin(k)}, ${lit.kotlin(v)})`);
      lines.push("    .build()", "client.newCall(request).execute().use { response ->", "    println(response.code)", "    println(response.body?.string())", "}");
      return binaryNote("//") + lines.join("\n");
    }

    case "dart-http": {
      const lines = ["import 'package:http/http.dart' as http;", "", "Future<void> main() async {",
        `  final request = http.Request(${lit.dart(method)}, Uri.parse(${lit.dart(req.url)}));`];
      for (const [k, v] of headers) lines.push(`  request.headers[${lit.dart(k)}] = ${lit.dart(v)};`);
      if (text !== undefined) lines.push(`  request.body = ${lit.dart(text)};`);
      lines.push("  final response = await http.Response.fromStream(await request.send());", "  print(response.statusCode);", "  print(response.body);", "}");
      return binaryNote("//") + lines.join("\n");
    }

    case "c-libcurl": {
      const lines = ["#include <curl/curl.h>", "", "int main(void) {", "  CURL *curl = curl_easy_init();", "  if (!curl) return 1;",
        `  curl_easy_setopt(curl, CURLOPT_CUSTOMREQUEST, ${lit.c(method)});`, `  curl_easy_setopt(curl, CURLOPT_URL, ${lit.c(req.url)});`];
      if (method === "HEAD") lines.push("  curl_easy_setopt(curl, CURLOPT_NOBODY, 1L);");
      if (req.headers.length) {
        lines.push("  struct curl_slist *headers = NULL;");
        for (const [k, v] of req.headers) lines.push(`  headers = curl_slist_append(headers, ${lit.c(`${k}: ${v}`)});`);
        lines.push("  curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);");
      }
      if (text !== undefined) lines.push(`  curl_easy_setopt(curl, CURLOPT_POSTFIELDS, ${lit.c(text)});`);
      lines.push("  CURLcode res = curl_easy_perform(curl);");
      if (req.headers.length) lines.push("  curl_slist_free_all(headers);");
      lines.push("  curl_easy_cleanup(curl);", "  return res == CURLE_OK ? 0 : 1;", "}");
      return binaryNote("//") + lines.join("\n");
    }

    case "http": {
      let target = req.url;
      let host = "";
      try {
        const u = new URL(req.url);
        target = `${u.pathname}${u.search}` || "/";
        host = u.host;
      } catch { /* a URL with unresolved variables stays as written */ }
      const lines = [`${method} ${target} HTTP/1.1`];
      if (host && !hasHeader(req.headers, "Host")) lines.push(`Host: ${host}`);
      for (const [k, v] of req.headers) lines.push(`${k}: ${v}`);
      const bytes = body.binary ?? (text !== undefined ? Buffer.from(text, "utf8") : undefined);
      if (bytes && !hasHeader(req.headers, "Content-Length")) lines.push(`Content-Length: ${bytes.length}`);
      lines.push("");
      if (text !== undefined) lines.push(text);
      else if (body.binary) lines.push(`<binary body, ${body.binary.length} bytes>`);
      return lines.join("\r\n");
    }
  }
  throw new Error(`unknown language ${JSON.stringify(lang)}; choose one of ${LANGUAGES.join(", ")}`);
}

// ---------------------------------------------------------------- shared importer helpers

/** `Get all users` → `get-all-users`: a request name the variable syntax accepts. */
export function slug(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "request";
}

/** Percent-encode but leave `{{variables}}` as written. */
function encodeKeepVars(s: string): string {
  return s.split(/(\{\{[^}]*\}\})/).map((part, i) => i % 2 === 1 ? part : encodeURIComponent(part)).join("");
}

function formBody(pairs: [string, string][]): string {
  return pairs.map(([k, v], i) => `${i === 0 ? "" : "&"}${encodeKeepVars(k)}=${encodeKeepVars(v)}`).join("\n");
}

/** A JS script block in the JetBrains spelling, prefixed for pre-request or response handling. */
function scriptBlock(prefix: "<" | ">", code: string, note: string): string {
  return `${prefix} {%\n// ${note}\n${code.replace(/\s+$/, "")}\n%}`;
}

const RAW_TYPES: Record<string, string> = {
  json: "application/json", xml: "application/xml", javascript: "application/javascript", html: "text/html", text: "text/plain", graphql: "application/graphql",
};

function uniqueName(name: string, used: Set<string>): string {
  let candidate = name;
  for (let n = 2; used.has(candidate); n++) candidate = `${name}-${n}`;
  used.add(candidate);
  return candidate;
}

// ---------------------------------------------------------------- Postman

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

function str(v: unknown): string {
  if (v === undefined || v === null) return "";
  return typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
}

/** Auth parameters are `{key: value}` in v2.0 and `[{key, value}]` in v2.1. */
function authParam(auth: Json, type: string, key: string): string {
  const params = auth?.[type];
  if (Array.isArray(params)) return str(params.find((p: Json) => p?.key === key)?.value);
  if (params && typeof params === "object") return str(params[key]);
  return "";
}

function postmanUrl(url: Json): { url: string; vars: [string, string][] } {
  if (typeof url === "string") return { url, vars: [] };
  if (!url || typeof url !== "object") return { url: "", vars: [] };
  let raw: string = url.raw ?? "";
  if (!raw) {
    const host = Array.isArray(url.host) ? url.host.join(".") : str(url.host);
    const path = Array.isArray(url.path) ? url.path.map(str).join("/") : str(url.path);
    const query = Array.isArray(url.query) ? url.query.filter((q: Json) => !q?.disabled).map((q: Json) => `${str(q.key)}${q.value === null || q.value === undefined ? "" : `=${str(q.value)}`}`).join("&") : "";
    raw = `${url.protocol ? `${url.protocol}://` : ""}${host}${path ? `/${path}` : ""}${query ? `?${query}` : ""}`;
  }
  const vars: [string, string][] = [];
  const known = new Map<string, string>();
  for (const v of Array.isArray(url.variable) ? url.variable : []) if (v?.key) known.set(str(v.key), str(v.value));
  // Postman path variables `:id` become `{{id}}`, with their saved value as a request variable.
  raw = raw.replace(/(^|\/):([A-Za-z_][\w-]*)(?=\/|\?|#|$)/g, (_m, lead: string, name: string) => {
    const value = known.get(name);
    if (value !== undefined && value !== "") vars.push([name, value]);
    return `${lead}{{${name}}}`;
  });
  return { url: raw, vars };
}

function postmanAuth(auth: Json, headers: [string, string][], url: { url: string }): string[] {
  const notes: string[] = [];
  if (!auth || typeof auth !== "object") return notes;
  const p = (key: string) => authParam(auth, auth.type, key);
  switch (auth.type) {
    case "noauth": case "inherit": break;
    case "basic": headers.push(["Authorization", `Basic ${p("username")} ${p("password")}`]); break;
    case "bearer": headers.push(["Authorization", `Bearer ${p("token")}`]); break;
    case "digest": headers.push(["Authorization", `Digest ${p("username")} ${p("password")}`]); break;
    case "apikey": {
      const key = p("key") || "X-API-Key";
      if (p("in") === "query") url.url += `${url.url.includes("?") ? "&" : "?"}${key}=${p("value")}`;
      else headers.push([key, p("value")]);
      break;
    }
    case "awsv4": {
      const parts = ["AWS", p("accessKey"), p("secretKey")];
      if (p("sessionToken")) parts.push(`token:${p("sessionToken")}`);
      if (p("region")) parts.push(`region:${p("region")}`);
      if (p("service")) parts.push(`service:${p("service")}`);
      headers.push(["Authorization", parts.join(" ")]);
      break;
    }
    case "oauth2": {
      const token = p("accessToken");
      if (token) headers.push(["Authorization", `${p("headerPrefix") || "Bearer"} ${token}`]);
      else notes.push("# OAuth 2.0 auth was not converted: set Authorization: Bearer {{token}} or use `Authorization: openid <flow> <prefix>`");
      break;
    }
    default: notes.push(`# ${str(auth.type)} auth was not converted`);
  }
  return notes;
}

function postmanBody(body: Json, headers: [string, string][]): string | undefined {
  if (!body || typeof body !== "object" || body.disabled) return undefined;
  const setType = (type: string) => { if (!hasHeader(headers, "Content-Type")) headers.push(["Content-Type", type]); };
  switch (body.mode) {
    case "raw": {
      const raw = str(body.raw);
      if (raw === "") return undefined;
      const language = body.options?.raw?.language;
      if (language && RAW_TYPES[language]) setType(RAW_TYPES[language] as string);
      return raw;
    }
    case "urlencoded": {
      const pairs = (Array.isArray(body.urlencoded) ? body.urlencoded : []).filter((x: Json) => !x?.disabled).map((x: Json) => [str(x.key), str(x.value)] as [string, string]);
      setType("application/x-www-form-urlencoded");
      return formBody(pairs);
    }
    case "formdata": {
      const parts = (Array.isArray(body.formdata) ? body.formdata : []).filter((x: Json) => !x?.disabled).map((x: Json) => {
        if (x.type === "file") {
          const src = Array.isArray(x.src) ? x.src[0] : x.src;
          return { name: str(x.key), file: str(src) || "./file", type: x.contentType ? str(x.contentType) : undefined };
        }
        return { name: str(x.key), value: str(x.value), type: x.contentType ? str(x.contentType) : undefined };
      });
      const others = headers.filter(([k]) => k.toLowerCase() !== "content-type");
      headers.length = 0;
      headers.push(...others, ["Content-Type", `multipart/form-data; boundary=${BOUNDARY}`]);
      return multipartBody(parts);
    }
    case "file": {
      const src = str(body.file?.src);
      return src ? `< ${filePath(src)}` : undefined;
    }
    case "graphql": {
      setType("application/json");
      headers.push(["X-REQUEST-TYPE", "GraphQL"]);
      const query = str(body.graphql?.query).replace(/\s+$/, "");
      const variables = str(body.graphql?.variables).trim();
      return variables ? `${query}\n\n${variables}` : query;
    }
  }
  return undefined;
}

function scriptCode(events: Json, listen: string): string {
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.listen !== listen || event.disabled) continue;
    const exec = event.script?.exec;
    const code = Array.isArray(exec) ? exec.join("\n") : str(exec);
    if (code.trim()) return code;
  }
  return "";
}

function postmanRequest(item: Json, inheritedAuth: Json, used: Set<string>): string {
  const request = typeof item.request === "string" ? { url: item.request, method: "GET" } : (item.request ?? {});
  const title = str(item.name) || "request";
  const lines: string[] = [`### ${title}`, `# @name ${uniqueName(slug(title), used)}`];
  if (request.description) {
    const desc = typeof request.description === "string" ? request.description : str(request.description?.content);
    for (const line of desc.split(/\r?\n/).filter((l: string) => l.trim())) lines.push(`# ${line}`);
  }
  const url = postmanUrl(request.url);
  const headers: [string, string][] = (Array.isArray(request.header) ? request.header : [])
    .filter((h: Json) => !h?.disabled && h?.key)
    .map((h: Json) => [str(h.key), str(h.value)] as [string, string]);
  const auth = request.auth ?? inheritedAuth;
  const notes = postmanAuth(auth, headers, url);
  const body = postmanBody(request.body, headers);
  lines.push(...notes);
  for (const [k, v] of url.vars) lines.push(`@${k} = ${v}`);
  const pre = scriptCode(item.event, "prerequest");
  if (pre) lines.push(scriptBlock("<", pre, "Converted from Postman: pm.* calls are kept verbatim; port them to request.* / client.*"));
  lines.push(`${str(request.method || "GET").toUpperCase()} ${url.url}`);
  for (const [k, v] of headers) lines.push(`${k}: ${v}`);
  if (body !== undefined) lines.push("", body);
  const test = scriptCode(item.event, "test");
  if (test) lines.push("", scriptBlock(">", test, "Converted from Postman: pm.* calls are kept verbatim; port them to client.* / response.*"));
  return lines.join("\n");
}

/**
 * A Postman collection (v2.0 or v2.1) as `.http` files. Top-level requests go
 * in `<collection>.http`; a folder's requests go in `<folder>.http`, and its
 * subfolders under a `<folder>/` directory. Collection variables are written
 * at the top of every file so each one runs on its own.
 */
export function importPostman(collection: unknown): Map<string, string> {
  const doc = (typeof collection === "string" ? JSON.parse(collection) : collection) as Json;
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.item)) throw new Error("not a Postman collection: no item array");
  const files = new Map<string, string>();
  const header = (Array.isArray(doc.variable) ? doc.variable : [])
    .filter((v: Json) => v?.key && !v.disabled)
    .map((v: Json) => `@${str(v.key)} = ${str(v.value)}`);

  const write = (path: string, blocks: string[]): void => {
    if (blocks.length === 0) return;
    let target = path;
    for (let n = 2; files.has(target); n++) target = path.replace(/\.http$/, `-${n}.http`);
    const top = header.length ? `${header.join("\n")}\n\n` : "";
    files.set(target, `${top}${blocks.join("\n\n")}\n`);
  };

  const walkNested = (folders: Json[], dir: string, auth: Json): void => {
    const used = new Set<string>();
    for (const folder of folders) {
      const name = uniqueName(slug(str(folder.name) || "folder"), used);
      const folderAuth = folder.auth && folder.auth.type !== "inherit" ? folder.auth : auth;
      const requests = folder.item.filter((x: Json) => !Array.isArray(x?.item));
      const usedNames = new Set<string>();
      write(`${dir}${name}.http`, requests.map((item: Json) => postmanRequest(item, folderAuth, usedNames)));
      const nested = folder.item.filter((x: Json) => Array.isArray(x?.item));
      if (nested.length) walkNested(nested, `${dir}${name}/`, folderAuth);
    }
  };

  const rootAuth = doc.auth && doc.auth.type !== "inherit" ? doc.auth : undefined;
  const rootName = slug(str(doc.info?.name) || "collection");
  // Top-level requests share one file; folders are written by walkNested.
  const topRequests = doc.item.filter((x: Json) => !Array.isArray(x?.item));
  const used = new Set<string>();
  write(`${rootName}.http`, topRequests.map((item: Json) => postmanRequest(item, rootAuth, used)));
  walkNested(doc.item.filter((x: Json) => Array.isArray(x?.item)), "", rootAuth);
  return files;
}

/** A Postman environment export as an `http-client.env.json` fragment. */
export function importPostmanEnvironment(env: unknown): Record<string, Record<string, string>> {
  const doc = (typeof env === "string" ? JSON.parse(env) : env) as Json;
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.values)) throw new Error("not a Postman environment: no values array");
  const vars: Record<string, string> = {};
  for (const v of doc.values) if (v?.key && v.enabled !== false) vars[str(v.key)] = str(v.value);
  return { [str(doc.name) || "default"]: vars };
}

// ---------------------------------------------------------------- YAML (the subset OpenAPI documents use)

function stripComment(s: string): string {
  let quote = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) {
        if (quote === "'" && s[i + 1] === "'") { i++; continue; }
        quote = "";
      } else if (c === "\\" && quote === '"') i++;
    } else if (c === '"' || c === "'") {
      if (i === 0 || /[\s,[{:]/.test(s[i - 1] as string)) quote = c;
    } else if (c === "#" && (i === 0 || /\s/.test(s[i - 1] as string))) {
      return s.slice(0, i).trimEnd();
    }
  }
  return s;
}

function plainScalar(s: string): unknown {
  const t = s.trim();
  if (t === "" || t === "~" || t === "null" || t === "Null" || t === "NULL") return null;
  if (/^(true|True|TRUE)$/.test(t)) return true;
  if (/^(false|False|FALSE)$/.test(t)) return false;
  if (/^[-+]?\d+$/.test(t)) return Number(t);
  if (/^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(t)) return Number(t);
  if (/^0x[0-9a-fA-F]+$/.test(t)) return parseInt(t, 16);
  if (/^[-+]?\.(inf|Inf|INF)$/.test(t)) return t.startsWith("-") ? -Infinity : Infinity;
  return t;
}

function unquote(s: string): string {
  if (s.startsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  try { return JSON.parse(s.replace(/\\\//g, "/").replace(/\t/g, "\\t")) as string; }
  catch { return s.slice(1, -1); }
}

/** Flow collections: `[a, b]`, `{a: 1, b: [c]}`. */
function parseFlow(src: string): unknown {
  let i = 0;
  const ws = () => { while (i < src.length && /\s/.test(src[i] as string)) i++; };
  const scalarUntil = (stops: string): unknown => {
    ws();
    const c = src[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "\\" && c === '"') { j += 2; continue; }
        if (src[j] === c) {
          if (c === "'" && src[j + 1] === "'") { j += 2; continue; }
          break;
        }
        j++;
      }
      const out = unquote(src.slice(i, j + 1));
      i = j + 1;
      return out;
    }
    let j = i;
    while (j < src.length && !stops.includes(src[j] as string)) j++;
    const out = plainScalar(src.slice(i, j));
    i = j;
    return out;
  };
  const value = (): unknown => {
    ws();
    if (src[i] === "[") {
      i++;
      const arr: unknown[] = [];
      ws();
      if (src[i] === "]") { i++; return arr; }
      while (i < src.length) {
        arr.push(value());
        ws();
        if (src[i] === ",") { i++; ws(); if (src[i] === "]") { i++; break; } continue; }
        if (src[i] === "]") { i++; break; }
        break;
      }
      return arr;
    }
    if (src[i] === "{") {
      i++;
      const obj: Record<string, unknown> = {};
      ws();
      if (src[i] === "}") { i++; return obj; }
      while (i < src.length) {
        const key = String(scalarUntil(":,}") ?? "");
        ws();
        let v: unknown = null;
        if (src[i] === ":") { i++; v = value(); }
        obj[key] = v;
        ws();
        if (src[i] === ",") { i++; ws(); if (src[i] === "}") { i++; break; } continue; }
        if (src[i] === "}") { i++; break; }
        break;
      }
      return obj;
    }
    return scalarUntil(",]}");
  };
  return value();
}

const KEY = /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|([^\s#'"[\]{},&*!|>%@`-][^#]*?|-[^\s#][^#]*?))\s*:(?=\s|$)/;

/** Parse the YAML OpenAPI documents are written in: block maps and lists, flow collections, quoted and block scalars. */
export function parseYaml(text: string): unknown {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((l) => !/^(---|\.\.\.)(\s.*)?$/.test(l) || l.startsWith("--- |"));
  let i = 0;
  const indentOf = (l: string) => l.length - l.trimStart().length;
  const significant = (l: string) => { const t = l.trim(); return t !== "" && !t.startsWith("#"); };
  const peek = (): number => { while (i < lines.length && !significant(lines[i] as string)) i++; return i; };
  const isItem = (t: string) => t === "-" || t.startsWith("- ");

  const block = (header: string, ind: number): string => {
    const style = header[0];
    const chomp = header.includes("-") ? "strip" : header.includes("+") ? "keep" : "clip";
    const explicit = /\d/.exec(header);
    let blockIndent = explicit ? ind + Number(explicit[0]) : -1;
    const raw: string[] = [];
    while (i < lines.length) {
      const l = lines[i] as string;
      if (l.trim() === "") { raw.push(""); i++; continue; }
      const li = indentOf(l);
      if (blockIndent < 0) { if (li <= ind) break; blockIndent = li; }
      if (li < blockIndent) break;
      raw.push(l.slice(blockIndent));
      i++;
    }
    let trailing = 0;
    while (raw.length && raw[raw.length - 1] === "") { raw.pop(); trailing++; }
    let out: string;
    if (style === "|") out = raw.join("\n");
    else {
      out = "";
      for (let k = 0; k < raw.length; k++) {
        const line = raw[k] as string;
        if (line === "") out += "\n";
        else out += (k > 0 && raw[k - 1] !== "" ? " " : "") + line;
      }
    }
    if (out === "") return "";
    if (chomp === "strip") return out;
    if (chomp === "keep") return `${out}\n${"\n".repeat(trailing)}`;
    return `${out}\n`;
  };

  /** A value written on the same line as its key or dash, possibly continued below. */
  const inline = (raw: string, ind: number): unknown => {
    let rest = raw.replace(/^(?:&\S+\s*|!!?\S+\s*)+/, "").trim();
    if (rest === "") return nested(ind);
    if (rest.startsWith("|") || rest.startsWith(">")) return block(rest, ind);
    if (rest.startsWith("[") || rest.startsWith("{")) {
      let depth = 0;
      const balance = (s: string) => { let q = ""; for (let k = 0; k < s.length; k++) { const c = s[k]; if (q) { if (c === q) q = ""; else if (c === "\\" && q === '"') k++; } else if (c === '"' || c === "'") q = c; else if (c === "[" || c === "{") depth++; else if (c === "]" || c === "}") depth--; } };
      balance(rest);
      while (depth > 0 && i < lines.length) {
        const next = stripComment((lines[i] as string).trim());
        i++;
        rest += ` ${next}`;
        balance(next);
      }
      return parseFlow(rest);
    }
    if (rest.startsWith('"') || rest.startsWith("'")) {
      const q = rest[0] as string;
      const closed = (s: string) => {
        for (let k = 1; k < s.length; k++) {
          if (s[k] === "\\" && q === '"') { k++; continue; }
          if (s[k] === q) { if (q === "'" && s[k + 1] === "'") { k++; continue; } return k; }
        }
        return -1;
      };
      while (closed(rest) < 0 && i < lines.length) {
        const next = (lines[i] as string).trim();
        i++;
        rest += next === "" ? "\n" : ` ${next}`;
      }
      return unquote(rest.slice(0, closed(rest) + 1));
    }
    rest = stripComment(rest);
    // A plain scalar continues on more-indented lines.
    while (peek() < lines.length && indentOf(lines[i] as string) > ind) {
      rest += ` ${stripComment((lines[i] as string).trim())}`;
      i++;
    }
    return plainScalar(rest);
  };

  /** The value below a key with nothing after its colon. */
  const nested = (ind: number): unknown => {
    if (peek() >= lines.length) return null;
    const line = lines[i] as string;
    const li = indentOf(line);
    if (li > ind) return node(li);
    if (li === ind && isItem(line.trim())) return list(ind);
    return null;
  };

  const map = (ind: number): Record<string, unknown> => {
    const obj: Record<string, unknown> = {};
    while (peek() < lines.length) {
      const line = lines[i] as string;
      if (indentOf(line) !== ind) break;
      const t = line.slice(ind);
      if (isItem(t)) break;
      const m = KEY.exec(t);
      if (!m) break;
      const key = m[1] !== undefined ? unquote(`"${m[1]}"`) : m[2] !== undefined ? m[2].replace(/''/g, "'") : (m[3] as string).trim();
      i++;
      obj[key] = inline(t.slice(m[0].length), ind);
    }
    return obj;
  };

  const list = (ind: number): unknown[] => {
    const arr: unknown[] = [];
    while (peek() < lines.length) {
      const line = lines[i] as string;
      if (indentOf(line) !== ind) break;
      const t = line.slice(ind);
      if (!isItem(t)) break;
      const content = t.slice(1).trimStart();
      if (content === "" || content.startsWith("#")) {
        i++;
        const next = peek() < lines.length ? lines[i] as string : "";
        arr.push(next && indentOf(next) > ind ? node(indentOf(next)) : null);
        continue;
      }
      const col = ind + (t.length - content.length);
      lines[i] = " ".repeat(col) + content;
      arr.push(node(col));
    }
    return arr;
  };

  const node = (ind: number): unknown => {
    if (peek() >= lines.length) return null;
    const line = lines[i] as string;
    const t = line.trim();
    if (isItem(t)) return list(ind);
    if (KEY.test(t)) return map(ind);
    i++;
    return inline(t, ind);
  };

  if (peek() >= lines.length) return null;
  return node(indentOf(lines[i] as string));
}

// ---------------------------------------------------------------- OpenAPI / Swagger

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

function resolveRef(doc: Json, value: Json, seen = new Set<string>()): Json {
  let v = value;
  while (v && typeof v === "object" && typeof v.$ref === "string") {
    const ref: string = v.$ref;
    if (!ref.startsWith("#/") || seen.has(ref)) return {};
    seen.add(ref);
    v = ref.slice(2).split("/").map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~")).reduce((acc: Json, key) => acc?.[key], doc);
  }
  return v ?? {};
}

/** A plausible example value for a JSON Schema, so imported requests have a body to edit. */
function exampleFor(doc: Json, schemaIn: Json, depth = 0): unknown {
  const schema = resolveRef(doc, schemaIn);
  if (depth > 8 || !schema || typeof schema !== "object") return null;
  if (schema.example !== undefined) return schema.example;
  if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.allOf)) {
    const merged: Record<string, unknown> = {};
    for (const part of schema.allOf) {
      const v = exampleFor(doc, part, depth + 1);
      if (v && typeof v === "object" && !Array.isArray(v)) Object.assign(merged, v);
    }
    return merged;
  }
  const alt = schema.oneOf ?? schema.anyOf;
  if (Array.isArray(alt) && alt.length) return exampleFor(doc, alt[0], depth + 1);
  const type = Array.isArray(schema.type) ? schema.type.find((t: string) => t !== "null") : schema.type;
  if (type === "object" || (!type && schema.properties)) {
    const out: Record<string, unknown> = {};
    for (const [key, prop] of Object.entries(schema.properties ?? {})) {
      const p = resolveRef(doc, prop);
      if (p?.readOnly) continue;
      out[key] = exampleFor(doc, p, depth + 1);
    }
    return out;
  }
  if (type === "array") return [exampleFor(doc, schema.items ?? {}, depth + 1)];
  if (type === "integer" || type === "number") return schema.minimum ?? 0;
  if (type === "boolean") return true;
  if (type === "string") {
    switch (schema.format) {
      case "date-time": return "2024-01-01T00:00:00Z";
      case "date": return "2024-01-01";
      case "email": return "user@example.com";
      case "uuid": return "00000000-0000-0000-0000-000000000000";
      case "uri": case "url": return "https://example.com";
      case "binary": case "byte": return "";
    }
    return "string";
  }
  return null;
}

function mediaExample(doc: Json, media: Json): unknown {
  if (media?.example !== undefined) return media.example;
  if (media?.examples && typeof media.examples === "object") {
    const first = Object.values(media.examples)[0];
    const resolved = resolveRef(doc, first);
    if (resolved?.value !== undefined) return resolved.value;
  }
  return exampleFor(doc, media?.schema ?? {});
}

function paramValue(doc: Json, param: Json): string | undefined {
  const schema = resolveRef(doc, param.schema ?? param);
  const v = param.example ?? (param.examples ? resolveRef(doc, Object.values(param.examples)[0])?.value : undefined) ?? schema?.example ?? schema?.default;
  return v === undefined ? undefined : typeof v === "string" ? v : JSON.stringify(v);
}

function bodyText(value: unknown, type: string): string {
  if (typeof value === "string") return value;
  if (/json/i.test(type)) return JSON.stringify(value, null, 2);
  if (/x-www-form-urlencoded/i.test(type) && value && typeof value === "object") {
    return formBody(Object.entries(value).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
  }
  if (/xml/i.test(type) && value && typeof value === "object") {
    const xml = (v: unknown, tag: string): string => Array.isArray(v) ? v.map((x) => xml(x, tag)).join("")
      : v && typeof v === "object" ? `<${tag}>${Object.entries(v).map(([k, x]) => xml(x, k)).join("")}</${tag}>`
        : `<${tag}>${String(v ?? "")}</${tag}>`;
    return xml(value, "root");
  }
  return JSON.stringify(value, null, 2);
}

/**
 * An OpenAPI 3.x or Swagger 2 document as `.http` files, one per tag. The
 * first server becomes `@baseUrl`; path parameters become `{{name}}`, with
 * their example as a request variable when the document gives one.
 */
export function importOpenApi(spec: unknown | string): Map<string, string> {
  let doc: Json = spec;
  if (typeof spec === "string") {
    try { doc = JSON.parse(spec); } catch { doc = parseYaml(spec); }
  }
  if (!doc || typeof doc !== "object" || !doc.paths) throw new Error("not an OpenAPI document: no paths");
  const swagger2 = typeof doc.swagger === "string";
  let baseUrl = "";
  if (swagger2) {
    const scheme = Array.isArray(doc.schemes) && doc.schemes.length ? doc.schemes[0] : "https";
    baseUrl = doc.host ? `${scheme}://${doc.host}${doc.basePath ?? ""}` : str(doc.basePath);
  } else if (Array.isArray(doc.servers) && doc.servers.length) {
    const server = doc.servers[0];
    baseUrl = str(server.url).replace(/\{([^}]+)\}/g, (_m, name: string) => str(server.variables?.[name]?.default) || `{{${name}}}`);
  }
  baseUrl = baseUrl.replace(/\/+$/, "");

  const schemes: Json = swagger2 ? doc.securityDefinitions ?? {} : doc.components?.securitySchemes ?? {};
  const securityHeaders = (requirements: Json): [string, string][] => {
    const out: [string, string][] = [];
    for (const requirement of Array.isArray(requirements) ? requirements : []) {
      for (const name of Object.keys(requirement ?? {})) {
        const scheme = resolveRef(doc, schemes[name]);
        if (!scheme) continue;
        if ((scheme.type === "http" && /^bearer$/i.test(scheme.scheme)) || scheme.type === "oauth2" || scheme.type === "openIdConnect") out.push(["Authorization", "Bearer {{token}}"]);
        else if ((scheme.type === "http" && /^basic$/i.test(scheme.scheme)) || scheme.type === "basic") out.push(["Authorization", "Basic {{username}} {{password}}"]);
        else if (scheme.type === "apiKey" && scheme.in === "header") out.push([str(scheme.name), `{{${slug(str(scheme.name)).replace(/-/g, "_")}}}`]);
      }
      if (out.length) break; // one alternative is enough
    }
    return out;
  };

  const byTag = new Map<string, string[]>();
  const names = new Map<string, Set<string>>();
  for (const [path, itemIn] of Object.entries(doc.paths as Record<string, Json>)) {
    const item = resolveRef(doc, itemIn);
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!op) continue;
      const tag = str(op.tags?.[0]) || "default";
      const params = [...(item.parameters ?? []), ...(op.parameters ?? [])].map((p: Json) => resolveRef(doc, p));
      const seen = new Set<string>();
      const unique = params.reverse().filter((p: Json) => { const k = `${p.in}:${p.name}`; if (seen.has(k)) return false; seen.add(k); return true; }).reverse();

      const lines: string[] = [];
      const title = str(op.summary) || str(op.operationId) || `${method.toUpperCase()} ${path}`;
      lines.push(`### ${title}`);
      const used = names.get(tag) ?? new Set<string>();
      names.set(tag, used);
      lines.push(`# @name ${uniqueName(op.operationId ? str(op.operationId) : slug(`${method} ${path}`), used)}`);
      const description = str(op.description).split(/\r?\n/).find((l) => l.trim());
      if (description && description.trim() !== title) lines.push(`# ${description.trim()}`);
      if (op.deprecated) lines.push("# deprecated");

      const url = path.replace(/\{([^}]+)\}/g, "{{$1}}");
      for (const p of unique.filter((p: Json) => p.in === "path")) {
        const v = paramValue(doc, p);
        if (v !== undefined) lines.push(`@${p.name} = ${v}`);
      }
      const query: string[] = [];
      for (const p of unique.filter((p: Json) => p.in === "query")) {
        const v = paramValue(doc, p);
        if (v !== undefined) query.push(`${p.name}=${encodeKeepVars(v)}`);
        else if (p.required) query.push(`${p.name}={{${p.name}}}`);
      }
      lines.push(`${method.toUpperCase()} {{baseUrl}}${url}${query.length ? `?${query.join("&")}` : ""}`);

      const headers: [string, string][] = [];
      for (const p of unique.filter((p: Json) => p.in === "header")) {
        const v = paramValue(doc, p);
        if (v !== undefined) headers.push([p.name, v]);
        else if (p.required) headers.push([p.name, `{{${p.name}}}`]);
      }
      headers.push(...securityHeaders(op.security ?? doc.security));

      let body: string | undefined;
      if (swagger2) {
        const produces = op.produces ?? doc.produces;
        if (Array.isArray(produces) && produces.length) headers.push(["Accept", str(produces[0])]);
        const consumes = (op.consumes ?? doc.consumes ?? ["application/json"]) as string[];
        const bodyParam = unique.find((p: Json) => p.in === "body");
        const formParams = unique.filter((p: Json) => p.in === "formData");
        if (bodyParam) {
          const type = consumes[0] ?? "application/json";
          headers.push(["Content-Type", type]);
          body = bodyText(exampleFor(doc, bodyParam.schema ?? {}), type);
        } else if (formParams.length) {
          if (formParams.some((p: Json) => p.type === "file") || consumes.includes("multipart/form-data")) {
            headers.push(["Content-Type", `multipart/form-data; boundary=${BOUNDARY}`]);
            body = multipartBody(formParams.map((p: Json) => p.type === "file" ? { name: p.name, file: `./${p.name}` } : { name: p.name, value: paramValue(doc, p) ?? `{{${p.name}}}` }));
          } else {
            headers.push(["Content-Type", "application/x-www-form-urlencoded"]);
            body = formBody(formParams.map((p: Json) => [p.name, paramValue(doc, p) ?? `{{${p.name}}}`]));
          }
        }
      } else {
        const okResponse = Object.entries(op.responses ?? {}).find(([code]) => /^2/.test(code))?.[1];
        const accept = Object.keys(resolveRef(doc, okResponse)?.content ?? {})[0];
        if (accept) headers.push(["Accept", accept]);
        const requestBody = resolveRef(doc, op.requestBody);
        const content = requestBody?.content ?? {};
        const types = Object.keys(content);
        const type = types.find((t) => /json/i.test(t)) ?? types[0];
        if (type) {
          const media = content[type];
          if (/multipart\/form-data/i.test(type)) {
            headers.push(["Content-Type", `multipart/form-data; boundary=${BOUNDARY}`]);
            const schema = resolveRef(doc, media?.schema ?? {});
            const props = Object.entries(schema.properties ?? {});
            body = multipartBody(props.map(([name, prop]) => {
              const p = resolveRef(doc, prop);
              if (p?.format === "binary" || p?.format === "base64") return { name, file: `./${name}` };
              const v = exampleFor(doc, p);
              return { name, value: typeof v === "string" ? v : JSON.stringify(v) };
            }));
          } else {
            headers.push(["Content-Type", type]);
            const example = mediaExample(doc, media);
            if (/octet-stream/i.test(type) || resolveRef(doc, media?.schema)?.format === "binary") body = "< ./body.bin";
            else body = bodyText(example, type);
          }
        }
      }
      for (const [k, v] of headers) lines.push(`${k}: ${v}`);
      if (body !== undefined) lines.push("", body);
      const list = byTag.get(tag) ?? [];
      list.push(lines.join("\n"));
      byTag.set(tag, list);
    }
  }

  const files = new Map<string, string>();
  const usedFiles = new Set<string>();
  for (const [tag, blocks] of byTag) {
    const file = `${uniqueName(slug(tag), usedFiles)}.http`;
    files.set(file, `${baseUrl ? `@baseUrl = ${baseUrl}\n\n` : ""}${blocks.join("\n\n")}\n`);
  }
  return files;
}

// ---------------------------------------------------------------- Bruno

interface BruBlock { name: string; lines: string[] }

/** Split a `.bru` file into its top-level `name { ... }` blocks, contents dedented. */
function bruBlocks(source: string): BruBlock[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const out: BruBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z][\w:-]*)\s*\{\s*$/.exec(lines[i] as string);
    if (!m) continue;
    const body: string[] = [];
    i++;
    while (i < lines.length && lines[i] !== "}") {
      const line = lines[i] as string;
      body.push(line.startsWith("  ") ? line.slice(2) : line.trimStart());
      i++;
    }
    out.push({ name: m[1] as string, lines: body });
  }
  return out;
}

function bruDict(block: BruBlock | undefined): [string, string, boolean][] {
  if (!block) return [];
  const out: [string, string, boolean][] = [];
  for (const line of block.lines) {
    if (!line.trim()) continue;
    const m = /^(~?)([^:]+?)\s*:\s?(.*)$/.exec(line.trim());
    if (m) out.push([m[2] as string, m[3] as string, m[1] !== "~"]);
  }
  return out;
}

function bruText(block: BruBlock | undefined): string | undefined {
  if (!block) return undefined;
  const text = block.lines.join("\n").replace(/^\n+|\s+$/g, "");
  return text === "" ? undefined : text;
}

const BRU_OPS: Record<string, string> = {
  eq: "==", neq: "!=", gt: ">", gte: ">=", lt: "<", lte: "<=", contains: "includes", notContains: "!includes",
  startsWith: "startsWith", endsWith: "endsWith", matches: "matches", isDefined: "exists", isNotEmpty: "exists",
};

function bruAssertion(target: string, expr: string): string | undefined {
  const [opWord = "", ...rest] = expr.trim().split(/\s+/);
  const op = BRU_OPS[opWord];
  if (!op) return undefined;
  let expected = rest.join(" ");
  if (/^".*"$|^'.*'$/.test(expected)) expected = expected.slice(1, -1);
  const suffix = op === "exists" ? " exists" : ` ${op} ${expected}`;
  if (target === "res.status") return `?? status${suffix}`;
  if (target === "res.responseTime") return `?? duration${suffix}`;
  const header = /^res\.headers?\.(.+)$/.exec(target) ?? /^res\.headers?\[['"](.+)['"]\]$/.exec(target);
  if (header) return `?? header ${header[1]}${suffix}`;
  if (target === "res.body") return `?? body $${suffix}`;
  const body = /^res\.body(.*)$/.exec(target);
  if (body) return `?? body $${body[1]}${suffix}`;
  return undefined;
}

/** A Bruno `.bru` request as a `.http` request block. */
export function importBruno(source: string): string {
  const blocks = bruBlocks(source);
  const find = (name: string) => blocks.find((b) => b.name === name);
  const meta = Object.fromEntries(bruDict(find("meta")).map(([k, v]) => [k, v]));
  const methodBlock = blocks.find((b) => ["get", "post", "put", "patch", "delete", "options", "head", "connect", "trace"].includes(b.name));
  const graphqlBlock = find("graphql") ?? find("http");
  const main = methodBlock ?? graphqlBlock;
  if (!main) throw new Error("not a Bruno request: no method block");
  const settings = Object.fromEntries(bruDict(main).map(([k, v]) => [k, v]));
  const method = methodBlock ? methodBlock.name.toUpperCase() : str(settings.method || "POST").toUpperCase();
  let url = str(settings.url);

  const lines: string[] = [];
  if (meta.name) lines.push(`# ${meta.name}`, `# @name ${slug(meta.name)}`);
  const docs = bruText(find("docs"));
  if (docs) for (const l of docs.split("\n")) lines.push(`# ${l}`);
  for (const [k, v, on] of bruDict(find("vars:pre-request"))) if (on) lines.push(`@${k} = ${v}`);
  const pre = bruText(find("script:pre-request"));
  if (pre) lines.push(scriptBlock("<", pre, "Converted from Bruno: req.* / bru.* calls are kept verbatim; port them to request.* / client.*"));

  const query = bruDict(find("params:query")).filter(([, , on]) => on);
  if (query.length && !url.includes("?")) url += `?${query.map(([k, v]) => `${k}=${v}`).join("&")}`;
  for (const [k, v, on] of bruDict(find("params:path"))) if (on) url = url.replace(new RegExp(`:${k}(?=/|\\?|$)`), v);
  lines.push(`${method} ${url}`);

  const headers: [string, string][] = bruDict(find("headers")).filter(([, , on]) => on).map(([k, v]) => [k, v]);
  const authMode = str(settings.auth);
  if (authMode === "basic" || (!authMode && find("auth:basic"))) {
    const a = Object.fromEntries(bruDict(find("auth:basic")).map(([k, v]) => [k, v]));
    if (a.username !== undefined) headers.push(["Authorization", `Basic ${a.username} ${a.password ?? ""}`]);
  } else if (authMode === "bearer" || (!authMode && find("auth:bearer"))) {
    const a = Object.fromEntries(bruDict(find("auth:bearer")).map(([k, v]) => [k, v]));
    if (a.token !== undefined) headers.push(["Authorization", `Bearer ${a.token}`]);
  } else if (authMode === "digest") {
    const a = Object.fromEntries(bruDict(find("auth:digest")).map(([k, v]) => [k, v]));
    headers.push(["Authorization", `Digest ${a.username ?? ""} ${a.password ?? ""}`]);
  } else if (authMode === "awsv4") {
    const a = Object.fromEntries(bruDict(find("auth:awsv4")).map(([k, v]) => [k, v]));
    const parts = ["AWS", a.accessKeyId ?? "", a.secretAccessKey ?? ""];
    if (a.sessionToken) parts.push(`token:${a.sessionToken}`);
    if (a.region) parts.push(`region:${a.region}`);
    if (a.service) parts.push(`service:${a.service}`);
    headers.push(["Authorization", parts.join(" ")]);
  }

  const setType = (type: string) => { if (!hasHeader(headers, "Content-Type")) headers.push(["Content-Type", type]); };
  const bodyMode = str(settings.body) || (blocks.find((b) => b.name.startsWith("body:"))?.name.slice(5) ?? "none");
  let body: string | undefined;
  switch (bodyMode) {
    case "json": body = bruText(find("body:json")); if (body) setType("application/json"); break;
    case "xml": body = bruText(find("body:xml")); if (body) setType("application/xml"); break;
    case "text": body = bruText(find("body:text")); if (body) setType("text/plain"); break;
    case "sparql": body = bruText(find("body:sparql")); if (body) setType("application/sparql-query"); break;
    case "formUrlEncoded":
    case "form-urlencoded": {
      const pairs = bruDict(find("body:form-urlencoded")).filter(([, , on]) => on).map(([k, v]) => [k, v] as [string, string]);
      if (pairs.length) { setType("application/x-www-form-urlencoded"); body = formBody(pairs); }
      break;
    }
    case "multipartForm":
    case "multipart-form": {
      const parts = bruDict(find("body:multipart-form")).filter(([, , on]) => on).map(([k, v]) => {
        const file = /^@file\((.*)\)$/.exec(v.trim());
        return file ? { name: k, file: (file[1] as string).split("|")[0] as string } : { name: k, value: v };
      });
      if (parts.length) {
        const others = headers.filter(([k]) => k.toLowerCase() !== "content-type");
        headers.length = 0;
        headers.push(...others, ["Content-Type", `multipart/form-data; boundary=${BOUNDARY}`]);
        body = multipartBody(parts);
      }
      break;
    }
    case "graphql": {
      const q = bruText(find("body:graphql"));
      const vars = bruText(find("body:graphql:vars"));
      if (q) {
        setType("application/json");
        headers.push(["X-REQUEST-TYPE", "GraphQL"]);
        body = vars ? `${q}\n\n${vars}` : q;
      }
      break;
    }
  }
  for (const [k, v] of headers) lines.push(`${k}: ${v}`);
  if (body !== undefined) lines.push("", body);

  const post = [bruText(find("script:post-response")), bruText(find("tests"))].filter(Boolean).join("\n\n");
  if (post) lines.push("", scriptBlock(">", post, "Converted from Bruno: res.* / bru.* / test() calls are kept verbatim; port them to response.* / client.*"));
  const asserts: string[] = [];
  for (const [target, expr, on] of bruDict(find("assert"))) {
    if (!on) continue;
    asserts.push(bruAssertion(target, expr) ?? `# assert not converted: ${target}: ${expr}`);
  }
  if (asserts.length) lines.push("", ...asserts);
  return `${lines.join("\n")}\n`;
}
