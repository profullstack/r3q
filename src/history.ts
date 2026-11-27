/**
 * The timeline: every send, from the TUI or `r3q run`, appended to
 * `.r3q/history.jsonl` in the collection so earlier exchanges can be reopened.
 *
 * Known secrets are redacted before anything is written: values from the OS
 * credential store, values from private env files and `.env`, credentials in
 * Authorization/Cookie/API-key headers, and `password`/`token`-like JSON
 * fields. The file is mode 0600 and lives under a hidden directory the
 * collection scan skips.
 */
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { RunResult } from "./http/runner.ts";

export const HISTORY_FILE = join(".r3q", "history.jsonl");
const MAX_BODY = 64 * 1024;
const MAX_FILE = 8 * 1024 * 1024;

export interface HistoryEntry {
  at: string;
  file: string;
  name?: string;
  method: string;
  url: string;
  requestHeaders: [string, string][];
  requestBody?: string;
  status: number;
  statusText: string;
  durationMs: number;
  responseHeaders: [string, string][];
  responseBody?: string;
  redirects?: string[];
  tests?: { name: string; passed: boolean; message?: string }[];
  error?: string;
  source: "tui" | "cli" | "runner";
}

const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|x-access-token)$/i;
const SECRET_FIELD = /pass(word)?|secret|token|api[-_]?key|private[-_]?key|client[-_]?secret|authorization|cookie|session/i;
export const REDACTED = "‹redacted›";

export class Redactor {
  private readonly values: string[];
  constructor(secrets: Iterable<string>) {
    // Longest first, so a secret that contains another is replaced whole. Short values would redact ordinary text.
    this.values = [...new Set([...secrets].filter((s) => typeof s === "string" && s.length >= 6))].sort((a, b) => b.length - a.length);
  }
  text(input: string): string {
    let out = input;
    for (const v of this.values) if (out.includes(v)) out = out.split(v).join(REDACTED);
    return out;
  }
  header([k, v]: [string, string]): [string, string] {
    if (!SECRET_HEADER.test(k)) return [k, this.text(v)];
    const scheme = /^(\w+)\s+\S/.exec(v)?.[1];
    return [k, scheme && /^(basic|bearer|digest|ntlm|negotiate|oauth|aws4-hmac-sha256)$/i.test(scheme) ? `${scheme} ${REDACTED}` : REDACTED];
  }
  body(text: string | undefined): string | undefined {
    if (text === undefined) return undefined;
    const clipped = text.length > MAX_BODY ? `${text.slice(0, MAX_BODY)}\n… ${text.length - MAX_BODY} more characters not kept` : text;
    try { return JSON.stringify(scrub(JSON.parse(clipped)), null, 2); } catch { /* not JSON */ }
    return this.text(clipped.replace(/((?:^|&)(?:[^=&]*(?:pass|secret|token|key)[^=&]*)=)[^&]*/gi, `$1${REDACTED}`));
  }
}

function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_FIELD.test(k) && (typeof v === "string" || typeof v === "number") ? REDACTED : scrub(v)]));
  return value;
}

export function toEntry(root: string, result: RunResult, redactor: Redactor, source: HistoryEntry["source"]): HistoryEntry | undefined {
  const p = result.prepared;
  if (!p && !result.error) return undefined;
  const r = result.response;
  const entry: HistoryEntry = {
    at: new Date().toISOString(),
    file: relative(resolve(root), result.file) || result.file,
    name: result.request.name ?? result.request.title,
    method: p?.method ?? result.request.method,
    url: redactor.text(p?.url ?? result.request.url),
    requestHeaders: (p?.headers ?? []).map((h) => redactor.header(h)),
    requestBody: redactor.body(p?.bodyText),
    status: r?.status ?? 0,
    statusText: r?.statusText ?? "",
    durationMs: Math.round(r?.duration ?? 0),
    responseHeaders: (r?.headers ?? []).map((h) => redactor.header(h)),
    responseBody: redactor.body(r?.text),
    source,
  };
  if (r?.redirects.length) entry.redirects = r.redirects.map((u) => redactor.text(u));
  if (result.tests.length) entry.tests = result.tests.map((t) => ({ ...t, message: t.message && redactor.text(t.message) }));
  if (result.error) entry.error = redactor.text(result.error);
  return entry;
}

export async function appendHistory(root: string, entries: HistoryEntry[]): Promise<void> {
  if (!entries.length || process.env.R3Q_NO_HISTORY) return;
  const path = join(resolve(root), HISTORY_FILE);
  await mkdir(join(resolve(root), ".r3q"), { recursive: true, mode: 0o700 });
  // Keep the newest half when the file grows past the cap.
  try {
    if ((await stat(path)).size > MAX_FILE) {
      const lines = (await readFile(path, "utf8")).split("\n").filter(Boolean);
      await writeFile(path, `${lines.slice(Math.floor(lines.length / 2)).join("\n")}\n`, { mode: 0o600 });
    }
  } catch { /* first write */ }
  await appendFile(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", { mode: 0o600 });
}

/** Newest first. */
export async function readHistory(root: string, limit = 50): Promise<HistoryEntry[]> {
  let text = "";
  try { text = await readFile(join(resolve(root), HISTORY_FILE), "utf8"); } catch { return []; }
  const out: HistoryEntry[] = [];
  const lines = text.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    try { out.push(JSON.parse(lines[i]!) as HistoryEntry); } catch { /* torn line */ }
  }
  return out;
}

export async function clearHistory(root: string): Promise<void> {
  await writeFile(join(resolve(root), HISTORY_FILE), "", { mode: 0o600 }).catch(() => {});
}

export function formatEntry(e: HistoryEntry, full = false): string {
  const head = `${e.at.replace("T", " ").slice(0, 19)}  ${e.status || "ERR"} ${e.method} ${e.url}  ${e.durationMs}ms  ${e.file}${e.name ? `#${e.name}` : ""}`;
  if (!full) return head;
  const lines = [head, ""];
  for (const [k, v] of e.requestHeaders) lines.push(`> ${k}: ${v}`);
  if (e.requestBody) lines.push(">", e.requestBody);
  lines.push("");
  for (const u of e.redirects ?? []) lines.push(`→ ${u}`);
  lines.push(`< ${e.status} ${e.statusText}`);
  for (const [k, v] of e.responseHeaders) lines.push(`< ${k}: ${v}`);
  if (e.responseBody) lines.push("", e.responseBody);
  for (const t of e.tests ?? []) lines.push(`${t.passed ? "✓" : "✗"} ${t.name}${t.message ? `: ${t.message}` : ""}`);
  if (e.error) lines.push(`error: ${e.error}`);
  return lines.join("\n");
}
