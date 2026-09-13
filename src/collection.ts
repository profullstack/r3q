/**
 * A collection is a directory of request files. Nothing is hidden in a binary
 * workspace: a request is a file, so it diffs, reviews and merges like the rest
 * of the repository it lives in.
 */
import { readdirSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export interface RequestFile {
  /** Path relative to the collection root, used as the display name and id. */
  id: string;
  path: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  /** Parse errors are carried rather than thrown: one bad file is not a crash. */
  error?: string;
}

const METHODS = new Set([
  "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE",
]);

/**
 * The `.http` format, as understood by every editor that speaks it:
 *
 *   POST https://api.example.com/things
 *   Content-Type: application/json
 *
 *   {"name": "thing"}
 *
 * A blank line ends the headers and starts the body. `#` and `//` are comments
 * before the request line, so a file can explain itself.
 */
export function parseRequest(source: string, id: string, path: string): RequestFile {
  const fail = (error: string): RequestFile =>
    ({ id, path, method: "GET", url: "", headers: {}, error });

  const lines = source.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = (lines[i] ?? "").trim();
    if (line !== "" && !line.startsWith("#") && !line.startsWith("//")) break;
    i++;
  }
  if (i >= lines.length) return fail("no request line");

  const [method, ...rest] = (lines[i] as string).trim().split(/\s+/);
  if (!method || !METHODS.has(method.toUpperCase())) {
    return fail(`unknown method ${JSON.stringify(method ?? "")}`);
  }
  const url = rest.join(" ").trim();
  if (url === "") return fail("no URL");
  i++;

  const headers: Record<string, string> = {};
  for (; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.trim() === "") { i++; break; }
    const colon = line.indexOf(":");
    if (colon <= 0) return fail(`malformed header: ${line.trim()}`);
    headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }

  const body = lines.slice(i).join("\n").trim();
  return {
    id, path,
    method: method.toUpperCase(),
    url,
    headers,
    body: body === "" ? undefined : body,
  };
}

export interface ScanLimits {
  /** How deep below the root the walk goes. */
  maxDepth: number;
  /** How many directories it reads before it stops. */
  maxDirs: number;
}

/**
 * Enough for any collection, and small enough that a home directory with
 * hundreds of repositories under it comes back in well under a second
 * instead of minutes, which is what `r3q` in the wrong directory used to do.
 */
export const SCAN_LIMITS: ScanLimits = { maxDepth: 8, maxDirs: 2000 };

export interface Scan {
  requests: RequestFile[];
  /** Directories read. */
  dirs: number;
  /** The walk stopped at a limit, so there may be requests it never saw. */
  truncated: boolean;
}

/** Every `.http` file under `root`, depth first, in a stable order, within the limits. */
export function scanCollection(root: string, limits: ScanLimits = SCAN_LIMITS): Scan {
  const out: RequestFile[] = [];
  let dirs = 0;
  let truncated = false;
  // The directory cap ends the whole walk; the depth limit only skips the
  // subtree it was reached in, so one deep tree does not hide its siblings.
  let stopped = false;
  const walk = (dir: string, depth: number): void => {
    if (stopped) return;
    if (dirs >= limits.maxDirs) {
      stopped = true;
      truncated = true;
      return;
    }
    dirs += 1;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (stopped) return;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth >= limits.maxDepth) {
          truncated = true;
          continue;
        }
        walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".http")) {
        const id = relative(root, full).split(sep).join("/");
        try {
          out.push(parseRequest(readFileSync(full, "utf8"), id, full));
        } catch (error) {
          out.push({
            id, path: full, method: "GET", url: "", headers: {},
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  };
  walk(root, 0);
  return { requests: out, dirs, truncated };
}

/** The requests alone, scanned within the default limits. */
export function loadCollection(root: string): RequestFile[] {
  return scanCollection(root).requests;
}

/** Scan without blocking rendering or keyboard input, publishing each request as it is found. */
export async function scanCollectionAsync(
  root: string,
  options: { signal?: AbortSignal; onRequest?: (request: RequestFile) => void; limits?: ScanLimits } = {},
): Promise<Scan> {
  const out: RequestFile[] = [];
  const limits = options.limits ?? SCAN_LIMITS;
  let dirs = 0;
  let truncated = false;
  let stopped = false;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (options.signal?.aborted || stopped) return;
    if (dirs >= limits.maxDirs) {
      stopped = true;
      truncated = true;
      return;
    }
    dirs += 1;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (options.signal?.aborted || stopped) return;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth >= limits.maxDepth) {
          truncated = true;
          continue;
        }
        await walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".http")) {
        const id = relative(root, full).split(sep).join("/");
        let request: RequestFile;
        try {
          request = parseRequest(await readFile(full, { encoding: "utf8", signal: options.signal }), id, full);
        } catch (error) {
          if (options.signal?.aborted) return;
          request = {
            id, path: full, method: "GET", url: "", headers: {},
            error: error instanceof Error ? error.message : String(error),
          };
        }
        if (options.signal?.aborted) return;
        out.push(request);
        options.onRequest?.(request);
      }
    }
  };
  await walk(root, 0);
  return { requests: out, dirs, truncated };
}

export async function loadCollectionAsync(
  root: string,
  options: { signal?: AbortSignal; onRequest?: (request: RequestFile) => void } = {},
): Promise<RequestFile[]> {
  return (await scanCollectionAsync(root, options)).requests;
}

/**
 * Substitute `{{name}}` from the environment.
 *
 * Values come from a `.env`-shaped file or the process environment, so secrets
 * stay out of the committed request files.
 */
export function interpolate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (whole, name: string) => vars[name] ?? whole);
}

export function resolveRequest(request: RequestFile, vars: Record<string, string>): RequestFile {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    headers[interpolate(key, vars)] = interpolate(value, vars);
  }
  return {
    ...request,
    url: interpolate(request.url, vars),
    headers,
    body: request.body === undefined ? undefined : interpolate(request.body, vars),
  };
}
