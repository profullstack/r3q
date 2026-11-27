/**
 * Collection housekeeping for the command line: scaffold a new collection,
 * list what is in one, audit it for mistakes, and tidy the formatting.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { loadEnvironment } from "./http/env.ts";
import { FOLDER_FILE, folderDefaults, metadataTags } from "./http/folder.ts";
import { parseHttpFile } from "./http/parse.ts";
import { secretNames } from "./http/secrets.ts";
import { requestFiles } from "./suite.ts";

// ── create ──────────────────────────────────────────────────────────────────

const EXAMPLE = `# A first request. Run it: r3q run example.http, or open the folder with r3q and press Enter.
# @name Check response
# @tag smoke
GET {{base}}/get?hello=world
Accept: application/json

?? status == 200
?? body $.args.hello == world

> {%
  test("echoes the query", () => {
    expect(response.status).to.equal(200);
    expect(response.body).to.have.property("url");
  });
%}
`;

export async function createCollection(dir: string, options: { force?: boolean } = {}): Promise<string[]> {
  const root = resolve(dir);
  await mkdir(root, { recursive: true });
  const files: [string, string][] = [
    ["example.http", EXAMPLE],
    ["http-client.env.json", `${JSON.stringify({ dev: { base: "https://httpbin.org" }, prod: { base: "https://httpbin.org" } }, null, 2)}\n`],
    [FOLDER_FILE, `${JSON.stringify({ headers: { Accept: "application/json" }, variables: { base: "https://httpbin.org" }, tags: [] }, null, 2)}\n`],
    [".gitignore", ".env\n.env.*\n*.private.env.json\nhttp-client.env.json.user\n.r3q/\n.r3q-trash/\n"],
  ];
  const written: string[] = [];
  for (const [name, text] of files) {
    const path = join(root, name);
    if (existsSync(path) && !options.force) continue;
    await writeFile(path, text);
    written.push(path);
  }
  return written;
}

// ── inspect ─────────────────────────────────────────────────────────────────

export interface InspectRow { file: string; index: number; name: string; method: string; url: string; tags: string[]; error?: string }

export async function inspectCollection(root: string, targets: string[] = []): Promise<InspectRow[]> {
  const base = resolve(root);
  const rows: InspectRow[] = [];
  const paths = targets.length ? targets.map((t) => resolve(base, t)) : [base];
  for (const p of paths) {
    const files = existsSync(p) && !/\.(http|rest)$/.test(p) ? requestFiles(p) : [p];
    for (const f of files) {
      const file = parseHttpFile(await readFile(f, "utf8"), f);
      const folder = folderDefaults(base, dirname(f));
      for (const r of file.requests) {
        rows.push({
          file: relative(base, f).split(sep).join("/"), index: r.index + 1,
          name: r.name ?? r.title ?? "", method: r.method, url: r.url.split("\n")[0]!.trim(),
          tags: [...new Set([...folder.tags, ...metadataTags(file.metadata), ...metadataTags(r.metadata)])],
          error: r.error,
        });
      }
    }
  }
  return rows;
}

// ── audit ───────────────────────────────────────────────────────────────────

export interface Finding { level: "error" | "warning"; file: string; line?: number; message: string }

/** Credentials that look real when written literally in a committed file. */
const SECRET_PATTERNS: [RegExp, string][] = [
  [/\b(sk_live_|sk-live-|sk-proj-|sk-ant-)[\w-]{8,}/, "an API secret key"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, "a GitHub token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "an AWS access key id"],
  [/\bxox[abposr]-[\w-]{10,}/, "a Slack token"],
  [/\beyJ[\w-]{10,}\.eyJ[\w-]{10,}\.[\w-]{10,}/, "a JWT"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
];

const DYNAMIC_OR_BUILTIN = /^(\$|%|[\w-]+\.(response|request)\.)/;

export async function auditCollection(root: string): Promise<Finding[]> {
  const base = resolve(root);
  const findings: Finding[] = [];
  const files = requestFiles(base);
  const known = new Set<string>(secretNames(base));
  const names = new Map<string, string[]>();
  const envCache = new Map<string, Awaited<ReturnType<typeof loadEnvironment>>>();
  const rel = (p: string): string => relative(base, p).split(sep).join("/");

  for (const f of files) {
    const source = await readFile(f, "utf8");
    const file = parseHttpFile(source, f);
    const dir = dirname(f);
    const folder = folderDefaults(base, dir);
    for (const e of folder.errors) findings.push({ level: "error", file: rel(e.split(":")[0] ?? f), message: e });
    let env = envCache.get(dir);
    if (!env) {
      // Every environment's names count as defined: the person picks one when sending.
      const all = await loadEnvironment(base, dir, []);
      const merged = await loadEnvironment(base, dir, all.names);
      env = merged;
      envCache.set(dir, env);
    }
    const defined = new Set<string>([...known, ...Object.keys(env.variables), ...Object.keys(env.dotenv), ...folder.variables.map((v) => v.name), ...file.variables.map((v) => v.name)]);
    for (const r of file.requests) {
      if (r.name) defined.add(r.name);
      for (const v of r.variables) defined.add(v.name);
      for (const spec of [...(r.metadata.get("prompt") ?? []), ...(r.metadata.get("secret") ?? [])]) defined.add(spec.trim().split(/\s+/)[0] ?? "");
      for (const spec of [...(r.metadata.get("capture") ?? []), ...(r.metadata.get("capture-env") ?? []), ...(r.metadata.get("capture-secret") ?? [])]) defined.add(spec.split("=")[0]!.trim());
    }
    // Script-set variables (client.global.set("x"), exports.x, request.variables.set) are defined too.
    for (const m of source.matchAll(/(?:global\.set|variables\.set)\(\s*["'`]([\w.-]+)["'`]|exports\.([\w$]+)\s*=/g)) defined.add(m[1] ?? m[2]!);

    for (const e of file.errors) findings.push({ level: "error", file: rel(f), line: e.line, message: e.message });
    for (const r of file.requests) {
      const label = r.name ?? r.title ?? `${r.method} ${r.url.split("\n")[0]}`;
      if (r.error) findings.push({ level: "error", file: rel(f), line: r.line, message: `${label}: ${r.error}` });
      if (r.name) names.set(r.name, [...(names.get(r.name) ?? []), `${rel(f)}:${r.line}`]);
      if (r.method === "TRACE" || r.method === "CONNECT") findings.push({ level: "warning", file: rel(f), line: r.line, message: `${label}: ${r.method} is kept as a template; it cannot be sent` });
      for (const part of r.body) {
        if (part.kind !== "file" || part.path.includes("{{")) continue;
        const target = resolve(dir, part.path.replace(/^~\//, `${process.env.HOME ?? ""}/`));
        if (!existsSync(target)) findings.push({ level: "error", file: rel(f), line: r.line, message: `${label}: body file ${part.path} does not exist` });
      }
    }
    // Undefined {{variables}}.
    const lines = source.split(/\r?\n/);
    lines.forEach((line, i) => {
      if (/^\s*(#|\/\/)/.test(line) && !/^\s*(#|\/\/)\s*@/.test(line)) return;
      for (const m of line.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) {
        const expr = m[1]!;
        if (DYNAMIC_OR_BUILTIN.test(expr) || /[^\w.-]/.test(expr)) continue;
        const head = expr.split(".")[0]!;
        if (defined.has(expr) || defined.has(head) || process.env[head] !== undefined) continue;
        findings.push({ level: "warning", file: rel(f), line: i + 1, message: `{{${expr}}} is not defined in any environment, folder, file or secret` });
      }
      for (const [re, what] of SECRET_PATTERNS) {
        if (re.test(line)) findings.push({ level: "error", file: rel(f), line: i + 1, message: `looks like ${what} written in the file; move it to a secret (r3q secret set NAME) and use {{NAME}}` });
      }
      const auth = /^\s*Authorization\s*:\s*(Bearer|Basic)\s+([^{\s][^\s]{11,})\s*$/i.exec(line);
      if (auth && !auth[2]!.includes("{{")) findings.push({ level: "warning", file: rel(f), line: i + 1, message: `literal ${auth[1]} credential; use {{VARIABLE}} so the value stays out of the repository` });
    });
  }
  for (const [name, where] of names) if (where.length > 1) findings.push({ level: "warning", file: where[0]!.split(":")[0]!, message: `request name "${name}" is used ${where.length} times (${where.join(", ")}); {{${name}.response...}} picks the first` });
  // Committed env files with values that look secret.
  for (const envFile of ["http-client.env.json"]) {
    const path = join(base, envFile);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    for (const [re, what] of SECRET_PATTERNS) if (re.test(text)) findings.push({ level: "error", file: envFile, message: `contains ${what}; private values belong in http-client.private.env.json (gitignored) or r3q secret` });
  }
  return findings;
}

// ── format ──────────────────────────────────────────────────────────────────

const HEADER = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+)\s*:\s*(.*?)\s*$/;
const BODY_END = /^(>\s*\{%|>\s*\S+\.js\s*$|\?\?|<>|>>!?\s|###)/;

/**
 * Normalise a `.http` file without changing what it sends: LF line endings,
 * no trailing spaces outside bodies, upper-case methods, `Name: value`
 * headers, JSON bodies indented when they parse, one blank line before `###`,
 * and one newline at the end.
 */
export function formatHttp(source: string): string {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const file = parseHttpFile(lines.join("\n"));
  const isRequestLine = new Set(file.requests.filter((r) => !r.fromCurl).map((r) => r.line - 1));
  const headerLines = new Set<number>();
  const bodyRanges: { start: number; end: number; json: boolean }[] = [];
  for (const r of file.requests) {
    if (r.fromCurl) continue;
    let i = r.line;
    // URL continuation lines are indented or start with ? / &.
    while (i < r.span.end && /^\s+\S|^\s*[?&]/.test(lines[i] ?? "")) i++;
    while (i < r.span.end && (lines[i] ?? "").trim() !== "") { if (HEADER.test(lines[i]!) && !/^\s/.test(lines[i]!)) headerLines.add(i); i++; }
    const start = i + 1;
    let end = start;
    while (end < r.span.end && !BODY_END.test(lines[end] ?? "")) end++;
    const contentType = r.headers.find((h): h is { name: string; value: string } => "name" in h && h.name.toLowerCase() === "content-type")?.value ?? "";
    bodyRanges.push({ start, end, json: /json/i.test(contentType) });
  }
  const inBody = (n: number): boolean => bodyRanges.some((b) => n >= b.start && n < b.end);
  const out: string[] = [];
  for (let n = 0; n < lines.length; n++) {
    const body = bodyRanges.find((b) => b.start === n && b.end > b.start);
    if (body) {
      let chunk = lines.slice(body.start, body.end);
      while (chunk.length && chunk[chunk.length - 1]!.trim() === "") chunk.pop();
      const text = chunk.join("\n");
      if (body.json && text.trim() && !/^\s*</.test(text)) {
        try { chunk = JSON.stringify(JSON.parse(text), null, 2).split("\n"); } catch { /* templated or not JSON: leave it */ }
      }
      out.push(...chunk);
      const trailing = body.end - body.start - chunk.length;
      if (trailing > 0 && body.end < lines.length && lines.slice(body.start, body.end).length > chunk.length) out.push("");
      n = body.end - 1;
      continue;
    }
    let line = lines[n]!;
    if (inBody(n)) { out.push(line); continue; }
    line = line.replace(/[ \t]+$/, "");
    if (isRequestLine.has(n)) line = line.replace(/^(\s*)([a-z]+)(\s)/, (_m, s: string, m: string, sp: string) => `${s}${m.toUpperCase()}${sp}`);
    else if (headerLines.has(n)) { const h = HEADER.exec(line)!; line = `${h[1]}: ${h[2]}`; }
    if (/^###/.test(line) && out.length && out[out.length - 1] !== "") out.push("");
    out.push(line);
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  // Collapse runs of more than two blank lines.
  const collapsed: string[] = [];
  for (const l of out) { if (l === "" && collapsed.at(-1) === "" && collapsed.at(-2) === "") continue; collapsed.push(l); }
  return `${collapsed.join("\n")}\n`;
}

export async function formatCollection(root: string, targets: string[], options: { check?: boolean } = {}): Promise<{ changed: string[]; checked: number }> {
  const base = resolve(root);
  const paths = targets.length ? targets.map((t) => resolve(base, t)) : [base];
  const files = paths.flatMap((p) => /\.(http|rest)$/.test(p) ? [p] : requestFiles(p));
  const changed: string[] = [];
  for (const f of files) {
    const before = await readFile(f, "utf8");
    const after = formatHttp(before);
    if (after === before) continue;
    // Never write a reformat that parses into different requests.
    const a = parseHttpFile(before).requests.map((r) => [r.method.toUpperCase(), r.url.replace(/\s+/g, ""), r.headers.length].join(" "));
    const b = parseHttpFile(after).requests.map((r) => [r.method.toUpperCase(), r.url.replace(/\s+/g, ""), r.headers.length].join(" "));
    if (a.join("\n") !== b.join("\n")) continue;
    changed.push(relative(base, f));
    if (!options.check) await writeFile(f, after);
  }
  return { changed, checked: files.length };
}
