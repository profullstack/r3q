/** Request templates and conservative, atomic operations on the user's files. */
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { METHODS, parseRequest } from "./collection.ts";

export const TEMPLATES = [
  { method: "GET", name: "Read items", resource: "items", description: "Read a collection of items", body: "" },
  { method: "POST", name: "Create item", resource: "items", description: "Create an item with a JSON body", body: '{\n  "name": "Example item",\n  "completed": false\n}' },
  { method: "PUT", name: "Replace item", resource: "items/1", description: "Replace all fields of an item", body: '{\n  "name": "Replacement item",\n  "completed": true\n}' },
  { method: "PATCH", name: "Update item", resource: "items/1", description: "Update selected fields of an item", body: '{\n  "completed": true\n}' },
  { method: "DELETE", name: "Delete item", resource: "items/1", description: "Delete an item on the server", body: "" },
  { method: "HEAD", name: "Inspect headers", resource: "items", description: "Inspect headers without a response body", body: "" },
  { method: "OPTIONS", name: "Inspect options", resource: "items", description: "Ask a server which methods it allows", body: "" },
  { method: "TRACE", name: "Trace request", resource: "items", description: "Diagnostic template; save/view only (fetch forbids TRACE)", body: "" },
] as const;

export interface Draft {
  name: string;
  file: string;
  method: string;
  url: string;
  headers: string;
  body: string;
  /** Preserve existing comments and blank lines when editing a file. */
  preamble?: string;
  originalName?: string;
}

export interface Snapshot {
  id: string;
  source: string;
  ino: number;
  dev: number;
  mode: number;
}

export function suggestedFilename(name: string): string {
  return `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "request"}.http`;
}

export function templateDraft(index = 0): Draft {
  const template = TEMPLATES[index] ?? TEMPLATES[0];
  return {
    name: template.name,
    file: suggestedFilename(template.name),
    method: template.method,
    url: `https://httpbin.org/anything/${template.resource}`,
    headers: `Accept: application/json${template.body ? "\nContent-Type: application/json" : ""}`,
    body: template.body,
  };
}

/** Template changes replace only boilerplate the user has not customized. */
export function changeTemplate(draft: Draft, index: number, useDefaults: boolean): void {
  const previous = templateDraft(TEMPLATES.findIndex((t) => t.method === draft.method));
  const next = templateDraft(index);
  if (useDefaults) {
    for (const field of ["name", "file", "url", "headers", "body"] as const) {
      if (draft[field] === previous[field]) draft[field] = next[field];
    }
  }
  draft.method = next.method;
}

export function draftFromSource(source: string, file: string): Draft {
  const parsed = parseRequest(source, file, file);
  if (parsed.error) throw new Error(`${file}: ${parsed.error}. Fix the request line in your editor first.`);
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => {
    const value = line.trim();
    return value !== "" && !value.startsWith("#") && !value.startsWith("//");
  });
  let bodyStart = start + 1;
  while (bodyStart < lines.length && lines[bodyStart]?.trim() !== "") bodyStart++;
  const preamble = lines.slice(0, start).join("\n");
  const name = preamble.split("\n").find((line) => /^\s*(#|\/\/)/.test(line))?.replace(/^\s*(#|\/\/)\s*/, "") || basename(file, ".http");
  return {
    name, file, method: parsed.method, url: parsed.url,
    headers: lines.slice(start + 1, bodyStart).join("\n"),
    body: lines.slice(bodyStart + 1).join("\n").replace(/\n$/, ""),
    preamble, originalName: name,
  };
}

/** Validate the format before writing, including mistakes the permissive reader accepts. */
export function serializeDraft(draft: Draft): string {
  if (!draft.name.trim() || /[\r\n\x00-\x1f\x7f]/.test(draft.name)) throw new Error("Give the request a name on one line.");
  if (!METHODS.has(draft.method)) throw new Error("Choose a supported HTTP method.");
  const checkUrl = draft.url.replace(/\{\{\s*[\w.-]+\s*\}\}/g, "123");
  if (!draft.url.trim() || /\s/.test(checkUrl)) throw new Error("Enter an HTTP(S) URL without spaces.");
  try {
    const url = new URL(checkUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
  } catch {
    // A complete base-URL variable is a normal .http convention.
    if (!/^\{\{\s*[\w.-]+\s*\}\}(\/[^\s]*)?$/.test(draft.url)) throw new Error("Use an http:// or https:// URL (or {{BASE_URL}}/path).");
  }
  if ((draft.method === "GET" || draft.method === "HEAD") && draft.body.trim()) throw new Error(`${draft.method} cannot send a body with this HTTP runtime. Clear Body or choose another method.`);
  const headers: string[] = [];
  const names = new Set<string>();
  for (const line of draft.headers.split("\n")) {
    if (!line.trim()) continue;
    const colon = line.indexOf(":");
    const name = line.slice(0, colon).trim();
    if (colon <= 0 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\x00-\x08\x0b-\x1f\x7f]/.test(line)) throw new Error("Headers must be one Name: value pair per line.");
    if (names.has(name.toLowerCase())) throw new Error(`Duplicate header ${name}; combine its values on one line.`);
    names.add(name.toLowerCase());
    headers.push(line);
  }
  let preamble = draft.preamble ?? `# ${draft.name.trim()}`;
  if (draft.originalName !== undefined && draft.name !== draft.originalName) {
    if (/^\s*(#|\/\/)/m.test(preamble)) preamble = preamble.replace(/^\s*(#|\/\/)[^\n]*/m, `# ${draft.name.trim()}`);
    else preamble = `# ${draft.name.trim()}${preamble ? `\n${preamble}` : ""}`;
  }
  const source = `${preamble ? `${preamble}\n` : ""}${draft.method} ${draft.url}\n${headers.length ? `${headers.join("\n")}\n` : ""}\n${draft.body}${draft.body.endsWith("\n") ? "" : "\n"}`;
  const parsed = parseRequest(source, draft.file, draft.file);
  if (parsed.error) throw new Error(parsed.error);
  if (Buffer.byteLength(source) > 1024 * 1024) throw new Error("The editor supports requests up to 1 MiB; edit larger files externally.");
  return source;
}

function validateFilename(id: string): void {
  if (!id || isAbsolute(id) || /[\\\x00-\x1f\x7f]/.test(id) || !id.endsWith(".http")) throw new Error("Use a relative .http path inside this collection.");
  if (id.split("/").some((part) => !part || part.startsWith(".") || part === "node_modules")) throw new Error("Use visible folders inside the collection; hidden paths and parent traversal are not allowed.");
}

async function requestPath(root: string, id: string, createParents = false): Promise<string> {
  validateFilename(id);
  if (createParents) await mkdir(root, { recursive: true });
  const base = await realpath(root);
  const target = resolve(base, id);
  if (relative(base, target).startsWith(`..${sep}`)) throw new Error("The file must stay inside the collection.");
  let parent = base;
  for (const part of id.split("/").slice(0, -1)) {
    parent = join(parent, part);
    if (createParents) await mkdir(parent).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    const stat = await lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Request folders must be real directories, not symlinks.");
  }
  return target;
}

export async function readSnapshot(root: string, id: string): Promise<Snapshot> {
  const target = await requestPath(root, id);
  const entry = await lstat(target);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Only regular request files can be changed; symlinks are not followed.");
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("Only regular request files can be changed.");
    if (stat.size > 1024 * 1024) throw new Error("The editor supports requests up to 1 MiB; edit larger files externally.");
    return { id, source: await file.readFile("utf8"), ino: stat.ino, dev: stat.dev, mode: stat.mode & 0o777 };
  } finally { await file.close(); }
}

async function checkSnapshot(root: string, snapshot: Snapshot): Promise<void> {
  let current: Snapshot;
  try { current = await readSnapshot(root, snapshot.id); }
  catch { throw new Error("This file was removed or replaced. Cancel and reload before editing it again."); }
  if (current.source !== snapshot.source || current.ino !== snapshot.ino || current.dev !== snapshot.dev) throw new Error("This file changed on disk. Your draft is still open; cancel and reload, or duplicate it to another file.");
}

export async function saveDraft(root: string, draft: Draft, original?: Snapshot): Promise<string> {
  const source = serializeDraft(draft);
  if (original && draft.file !== original.id) throw new Error("Editing keeps the same path. Use Duplicate to save another file.");
  const target = await requestPath(root, draft.file, true);
  if (original) await checkSnapshot(root, original);
  const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", original?.mode ?? 0o600);
  try {
    await file.writeFile(source, "utf8");
    if (original) await file.chmod(original.mode);
    await file.sync();
    await file.close();
    if (original) {
      await checkSnapshot(root, original);
      await rename(temporary, target);
    } else {
      // A hard link publishes the complete file atomically and cannot replace
      // a path another editor or r3q process created while we were writing.
      try { await link(temporary, target); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("That file already exists. Choose another path; nothing was overwritten.");
        throw error;
      }
    }
  } finally {
    await file.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
  return draft.file;
}

export async function duplicateFilename(root: string, id: string): Promise<string> {
  const stem = id.slice(0, -5);
  for (let n = 1; n < 10000; n++) {
    const candidate = `${stem}-copy${n === 1 ? "" : `-${n}`}.http`;
    const target = await requestPath(root, candidate);
    try { await lstat(target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return candidate; throw error; }
  }
  throw new Error("Choose a new filename for this duplicate.");
}

/** Confirmed deletion is reversible: hide the file from scans without destroying it. */
export async function trashRequest(root: string, original: Snapshot): Promise<string> {
  await checkSnapshot(root, original);
  const target = await requestPath(root, original.id);
  const base = await realpath(root);
  const trash = join(base, ".r3q-trash");
  await mkdir(trash, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
  const stat = await lstat(trash);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(".r3q-trash must be a real directory, not a symlink.");
  const destination = join(trash, `${Date.now()}-${randomUUID()}-${basename(original.id)}`);
  await checkSnapshot(root, original);
  await rename(target, destination);
  return relative(base, destination);
}
