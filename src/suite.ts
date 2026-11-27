/**
 * Running a collection, or part of one, unattended: pick requests by path,
 * name or tag, preview the order without sending, run once per data row with
 * optional setup/teardown requests, pace and stop on the first failure, and
 * report as text, JSON or JUnit XML.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { folderDefaults, metadataTags } from "./http/folder.ts";
import type { RunResult, Session } from "./http/runner.ts";
import type { HttpFile, HttpRequest } from "./http/types.ts";

export interface SuiteItem {
  file: HttpFile;
  request: HttpRequest;
  /** Path relative to the collection root. */
  id: string;
  label: string;
  tags: string[];
}

export interface Selection {
  /** Files, directories, or `file.http#name` specs. Empty means the whole root. */
  targets: string[];
  tags?: string[];
  excludeTags?: string[];
  /** Substring or glob (`*`) matched against the request label or `path#label`. */
  names?: string[];
  includeDisabled?: boolean;
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".r3q", ".r3q-trash"]);

/** Every `.http`/`.rest` under `dir`, depth-first and sorted, so runs are reproducible. */
export function requestFiles(dir: string, depth = 0): string[] {
  if (depth > 16) return [];
  let entries: string[];
  try { entries = readdirSync(dir).sort((a, b) => a.localeCompare(b)); } catch { return []; }
  const files: string[] = [];
  const dirs: string[] = [];
  for (const name of entries) {
    if (name.startsWith(".") || SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) dirs.push(full);
    else if (/\.(http|rest)$/.test(name)) files.push(full);
  }
  return [...files, ...dirs.flatMap((d) => requestFiles(d, depth + 1))];
}

const label = (r: HttpRequest): string => r.name ?? r.title ?? `${r.method} ${r.url.split("\n")[0]}`;

function globMatch(pattern: string, text: string): boolean {
  if (!pattern.includes("*")) return text.toLowerCase().includes(pattern.toLowerCase());
  const re = new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i");
  return re.test(text);
}

export async function collect(session: Session, root: string, selection: Selection): Promise<SuiteItem[]> {
  const base = resolve(root);
  const specs = selection.targets.length ? selection.targets : [base];
  const items: SuiteItem[] = [];
  const seen = new Set<string>();
  for (const spec of specs) {
    const hash = spec.lastIndexOf("#");
    const path = resolve(base, hash > 0 ? spec.slice(0, hash) : spec);
    const which = hash > 0 ? spec.slice(hash + 1) : undefined;
    if (!existsSync(path)) throw new Error(`${spec}: no such file or folder`);
    const files = statSync(path).isDirectory() ? requestFiles(path) : [path];
    for (const f of files) {
      const file = await session.load(f);
      const folder = folderDefaults(base, dirname(f));
      const fileTags = metadataTags(file.metadata);
      file.requests.forEach((request, i) => {
        if (which && !(request.name === which || request.title === which || String(i + 1) === which)) return;
        const key = `${f}#${i}`;
        if (seen.has(key)) return;
        seen.add(key);
        const id = relative(base, f).split(sep).join("/");
        items.push({ file, request, id, label: label(request), tags: [...new Set([...folder.tags, ...fileTags, ...metadataTags(request.metadata)])] });
      });
    }
  }
  return items.filter((item) => {
    if (selection.tags?.length && !selection.tags.some((t) => item.tags.includes(t))) return false;
    if (selection.excludeTags?.some((t) => item.tags.includes(t))) return false;
    if (selection.names?.length && !selection.names.some((n) => globMatch(n, item.label) || globMatch(n, `${item.id}#${item.label}`))) return false;
    if (!selection.includeDisabled && (item.request.metadata.has("disabled") || item.file.metadata.has("disabled"))) {
      const v = item.request.metadata.get("disabled")?.at(-1) ?? item.file.metadata.get("disabled")?.at(-1);
      if (!v || v === "true") return false;
    }
    return true;
  });
}

// ── data rows ───────────────────────────────────────────────────────────────

/** RFC 4180 CSV: quoted fields, doubled quotes, newlines inside quotes. First row is the header. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((v) => v !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((v) => v !== "")) rows.push(row);
  const [header, ...data] = rows;
  if (!header) return [];
  const names = header.map((h) => h.trim());
  return data.map((r) => Object.fromEntries(names.map((n, i) => [n, r[i] ?? ""])));
}

export function readDataRows(path: string): Record<string, string>[] {
  const text = readFileSync(path, "utf8");
  if (/\.json$/i.test(path) || /^\s*[[{]/.test(text)) {
    const parsed = JSON.parse(text) as unknown;
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.map((row, i) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(`${path}: row ${i + 1} is not an object`);
      return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
    });
  }
  return parseCsv(text);
}

// ── running ─────────────────────────────────────────────────────────────────

export interface SuiteOptions {
  overrides?: Record<string, string>;
  data?: Record<string, string>[];
  setup?: SuiteItem[];
  teardown?: SuiteItem[];
  delayMs?: number;
  failFast?: boolean;
  signal?: AbortSignal;
  onResult?(entry: SuiteEntry): void;
}

export interface SuiteEntry {
  item: SuiteItem;
  result: RunResult;
  passed: boolean;
  /** 1-based data row, when running with data. */
  row?: number;
  phase: "setup" | "test" | "teardown";
}

export interface SuiteReport {
  startedAt: string;
  durationMs: number;
  entries: SuiteEntry[];
  passed: number;
  failed: number;
  skipped: number;
  stopped?: string;
}

/** A result passes when it was sent, got a non-error status (unless tests decide), and every test passed. */
export function passed(result: RunResult): boolean {
  if (result.iterations) return result.iterations.every(passed);
  if (result.skipped) return true;
  if (result.error) return false;
  if (result.tests.length) return result.tests.every((t) => t.passed);
  const s = result.response?.status ?? 0;
  return s > 0 && s < 400 || s === 101;
}

export async function runSuite(session: Session, items: SuiteItem[], options: SuiteOptions = {}): Promise<SuiteReport> {
  const started = Date.now();
  const report: SuiteReport = { startedAt: new Date(started).toISOString(), durationMs: 0, entries: [], passed: 0, failed: 0, skipped: 0 };
  const rows: (Record<string, string> | undefined)[] = options.data?.length ? options.data : [undefined];
  let first = true;
  const one = async (item: SuiteItem, phase: SuiteEntry["phase"], vars: Record<string, string>, row?: number): Promise<boolean> => {
    if (options.signal?.aborted) { report.stopped ??= "stopped"; return false; }
    if (!first && options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
    first = false;
    const result = await session.run(item.file, item.request, { overrides: vars, batch: true });
    const ok = passed(result);
    const entry: SuiteEntry = { item, result, passed: ok, row, phase };
    report.entries.push(entry);
    if (result.skipped) report.skipped++; else if (ok) report.passed++; else report.failed++;
    options.onResult?.(entry);
    return ok;
  };
  outer: for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const vars = { ...options.overrides, ...row, ...(row ? { $row: String(r + 1) } : {}) };
    const rowNo = row ? r + 1 : undefined;
    let setupOk = true;
    for (const s of options.setup ?? []) setupOk = await one(s, "setup", vars, rowNo) && setupOk;
    if (setupOk) {
      for (const item of items) {
        const ok = await one(item, "test", vars, rowNo);
        if (!ok && options.failFast) { report.stopped = `--fail-fast after ${item.id}#${item.label}`; break outer; }
        if (options.signal?.aborted) break outer;
      }
    } else if (options.failFast) { report.stopped = "--fail-fast: setup failed"; break; }
    for (const t of options.teardown ?? []) await one(t, "teardown", vars, rowNo);
  }
  report.durationMs = Date.now() - started;
  return report;
}

// ── reports ─────────────────────────────────────────────────────────────────

const xml = (s: string): string => s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]!)).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");

export function junitReport(report: SuiteReport, name = "r3q"): string {
  const byFile = new Map<string, SuiteEntry[]>();
  for (const e of report.entries) byFile.set(e.item.id, [...(byFile.get(e.item.id) ?? []), e]);
  const suites: string[] = [];
  for (const [file, entries] of byFile) {
    const cases = entries.map((e) => {
      const res = e.result;
      const caseName = `${e.phase === "test" ? "" : `[${e.phase}] `}${e.item.label}${e.row ? ` [row ${e.row}]` : ""}`;
      const time = ((res.response?.duration ?? 0) / 1000).toFixed(3);
      let inner = "";
      if (res.skipped) inner = `<skipped message="${xml(res.skipped)}"/>`;
      else if (res.error) inner = `<error message="${xml(res.error)}"/>`;
      else if (!e.passed) {
        const failures = res.tests.filter((t) => !t.passed);
        const message = failures.length ? failures.map((t) => `${t.name}${t.message ? `: ${t.message}` : ""}`).join("; ") : `HTTP ${res.response?.status ?? 0}`;
        inner = `<failure message="${xml(message)}">${xml(failures.map((t) => `✗ ${t.name}${t.message ? `: ${t.message}` : ""}`).join("\n") || message)}</failure>`;
      }
      const out = res.response ? `<system-out>${xml(`${res.prepared?.method} ${res.prepared?.url} -> ${res.response.status} ${res.response.statusText}\n${res.tests.map((t) => `${t.passed ? "✓" : "✗"} ${t.name}`).join("\n")}`)}</system-out>` : "";
      return `    <testcase classname="${xml(file.replace(/\.(http|rest)$/, "").split("/").join("."))}" name="${xml(caseName)}" time="${time}">${inner}${out}</testcase>`;
    });
    const failures = entries.filter((e) => !e.passed && !e.result.error && !e.result.skipped).length;
    const errors = entries.filter((e) => e.result.error).length;
    const skipped = entries.filter((e) => e.result.skipped).length;
    const time = (entries.reduce((n, e) => n + (e.result.response?.duration ?? 0), 0) / 1000).toFixed(3);
    suites.push(`  <testsuite name="${xml(file)}" tests="${entries.length}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${time}" timestamp="${report.startedAt}">\n${cases.join("\n")}\n  </testsuite>`);
  }
  const total = report.entries.length;
  const errors = report.entries.filter((e) => e.result.error).length;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="${xml(name)}" tests="${total}" failures="${report.failed - errors}" errors="${errors}" skipped="${report.skipped}" time="${(report.durationMs / 1000).toFixed(3)}">\n${suites.join("\n")}\n</testsuites>\n`;
}

export function jsonReport(report: SuiteReport): object {
  return {
    startedAt: report.startedAt, durationMs: report.durationMs,
    summary: { total: report.entries.length, passed: report.passed, failed: report.failed, skipped: report.skipped, stopped: report.stopped ?? null },
    results: report.entries.map((e) => ({
      file: e.item.id, name: e.item.label, tags: e.item.tags, phase: e.phase, row: e.row ?? null,
      passed: e.passed, skipped: e.result.skipped ?? null, error: e.result.error ?? null,
      request: e.result.prepared ? { method: e.result.prepared.method, url: e.result.prepared.url } : null,
      response: e.result.response ? { status: e.result.response.status, statusText: e.result.response.statusText, durationMs: Math.round(e.result.response.duration), bytes: e.result.response.body.length, redirects: e.result.response.redirects } : null,
      tests: e.result.tests,
    })),
  };
}

export function dryRunPlan(items: SuiteItem[], options: Pick<SuiteOptions, "data" | "setup" | "teardown"> = {}): string[] {
  const lines: string[] = [];
  const rows = options.data?.length ?? 0;
  const show = (i: SuiteItem, prefix = ""): string => `${prefix}${i.request.method.padEnd(7)} ${i.id}#${i.label}${i.tags.length ? `  [${i.tags.join(", ")}]` : ""}`;
  if (rows) lines.push(`${rows} data row${rows === 1 ? "" : "s"}; for each row:`);
  for (const s of options.setup ?? []) lines.push(show(s, rows ? "  setup    " : "setup    "));
  items.forEach((i, n) => lines.push(show(i, `${rows ? "  " : ""}${String(n + 1).padStart(3)}. `)));
  for (const t of options.teardown ?? []) lines.push(show(t, rows ? "  teardown " : "teardown "));
  lines.push(`${items.length} request${items.length === 1 ? "" : "s"}${rows ? ` x ${rows} rows` : ""}; nothing was sent (--dry-run)`);
  return lines;
}

