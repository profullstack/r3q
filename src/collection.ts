/**
 * A collection is a directory of request files. Nothing is hidden in a binary
 * workspace: a request is a file, so it diffs, reviews and merges like the rest
 * of the repository it lives in.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
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

/** Every `.http` file under `root`, depth first, in a stable order. */
export function loadCollection(root: string): RequestFile[] {
  const out: RequestFile[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith(".") || entry === "node_modules") continue;
      const full = join(dir, entry);
      let stats;
      try {
        stats = statSync(full);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        walk(full);
      } else if (entry.endsWith(".http")) {
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
  walk(root);
  return out;
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
