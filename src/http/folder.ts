/**
 * Folder defaults: an `r3q.folder.json` in any directory of a collection
 * applies to every request below it. The one at the collection root is the
 * collection's settings; a nearer folder adds to and overrides a farther one.
 *
 *   {
 *     "headers":   { "Accept": "application/json" },
 *     "auth":      "Bearer {{TOKEN}}",
 *     "variables": { "base": "https://api.example.com" },
 *     "tags":      ["billing"],
 *     "pre":       ["./scripts/sign.js"],
 *     "post":      ["./scripts/check.js"],
 *     "timeout":   "10s"
 *   }
 *
 * A request's own headers always win. Folder variables are defaults: an
 * environment, a secret or a variable in the file overrides them. `auth` is shorthand for an
 * Authorization header, so every scheme the request line accepts works here.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { FileVariable, Metadata, Script } from "./types.ts";

export const FOLDER_FILE = "r3q.folder.json";

export interface FolderConfig {
  headers?: Record<string, string>;
  auth?: string;
  variables?: Record<string, string | number | boolean>;
  tags?: string[];
  pre?: string | string[];
  post?: string | string[];
  timeout?: string | number;
  /** Metadata applied as if written `# @key value` above every request. */
  metadata?: Record<string, string | string[]>;
}

export interface FolderDefaults {
  headers: [string, string][];
  variables: FileVariable[];
  tags: string[];
  preScripts: Script[];
  postScripts: Script[];
  metadata: Metadata;
  /** The folder files that contributed, outermost first. */
  sources: string[];
  errors: string[];
}

const list = (v: string | string[] | undefined): string[] => v === undefined ? [] : Array.isArray(v) ? v : [v];

/** Directories from the collection root down to `dir`, inclusive; just `dir` when it is outside the root. */
export function chain(root: string, dir: string): string[] {
  const base = resolve(root);
  const target = resolve(dir);
  const rel = relative(base, target);
  if (rel.startsWith("..") || rel.startsWith(sep)) return [target];
  const out = [base];
  let cur = base;
  for (const part of rel.split(sep).filter(Boolean)) { cur = join(cur, part); out.push(cur); }
  return out;
}

const cache = new Map<string, { mtime: number; config: FolderConfig | Error }>();

function readConfig(path: string): FolderConfig | Error | undefined {
  if (!existsSync(path)) return undefined;
  const mtime = statSync(path).mtimeMs;
  const hit = cache.get(path);
  if (hit && hit.mtime === mtime) return hit.config;
  let config: FolderConfig | Error;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected a JSON object");
    config = parsed as FolderConfig;
  } catch (error) { config = new Error(`${path}: ${(error as Error).message}`); }
  cache.set(path, { mtime, config });
  return config;
}

/** Merge every `r3q.folder.json` from the root down to `dir`. */
export function folderDefaults(root: string, dir: string): FolderDefaults {
  const out: FolderDefaults = { headers: [], variables: [], tags: [], preScripts: [], postScripts: [], metadata: new Map(), sources: [], errors: [] };
  const headers = new Map<string, [string, string]>();
  for (const d of chain(root, dir)) {
    const path = join(d, FOLDER_FILE);
    const config = readConfig(path);
    if (!config) continue;
    if (config instanceof Error) { out.errors.push(config.message); continue; }
    out.sources.push(path);
    for (const [k, v] of Object.entries(config.headers ?? {})) headers.set(k.toLowerCase(), [k, String(v)]);
    if (config.auth) headers.set("authorization", ["Authorization", config.auth]);
    for (const [name, value] of Object.entries(config.variables ?? {})) out.variables.push({ name, value: String(value), lazy: false, line: -1 });
    for (const t of config.tags ?? []) if (!out.tags.includes(t)) out.tags.push(t);
    for (const file of list(config.pre)) out.preScripts.push({ dialect: "jetbrains", file: resolve(d, file), line: 0 });
    for (const file of list(config.post)) out.postScripts.push({ dialect: "jetbrains", file: resolve(d, file), line: 0 });
    if (config.timeout !== undefined) out.metadata.set("timeout", [String(config.timeout)]);
    for (const [k, v] of Object.entries(config.metadata ?? {})) out.metadata.set(k, list(v as string | string[]));
  }
  out.headers = [...headers.values()];
  return out;
}

/** `# @tag a, b` / `# @tags a b` on a request (and its file's global region). */
export function metadataTags(metadata: Metadata): string[] {
  return [...(metadata.get("tag") ?? []), ...(metadata.get("tags") ?? [])].flatMap((v) => v.split(/[\s,]+/)).filter(Boolean);
}

