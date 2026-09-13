/**
 * r3q — a REST client for your terminal.
 *
 *   bunx @profullstack/r3q            # the collection in the working directory
 *   bunx @profullstack/r3q ./api      # a collection somewhere else
 *
 * Three panes: the collection, the request, the response. Enter sends.
 */
import { createApp, themes, type Container, type KeyEvent, type Theme } from "@profullstack/hqtui";
import { scanCollection, scanCollectionAsync, resolveRequest, type RequestFile, type Scan } from "./collection.ts";
import { formatBody, send, statusKind, type Exchange } from "./send.ts";
import { highlightBody, type JsonPalette } from "./highlight.ts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface State {
  requests: RequestFile[];
  selected: number;
  offset: number;
  bodyOffset: number;
  exchange?: Exchange;
  sending: boolean;
  pane: "collection" | "response";
  vars: Record<string, string>;
  root: string;
  note: string;
  loading: boolean;
}

/** Variables come from `.env` beside the collection, then the environment. */
function loadVars(root: string): Record<string, string> {
  const vars: Record<string, string> = {};
  try {
    for (const line of readFileSync(resolve(root, ".env"), "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      vars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    // No .env is the normal case, not a problem.
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !(key in vars)) vars[key] = value;
  }
  return vars;
}

/** Explain when the collection exceeds the scan limits. */
export function scanNote(scan: Pick<Scan, "dirs" | "truncated">): string {
  return scan.truncated ? `stopped scanning after ${scan.dirs} directories; point r3q at your collection` : "";
}

export function createState(root: string, scan = scanCollection(root)): State {
  return {
    requests: scan.requests,
    selected: 0,
    offset: 0,
    bodyOffset: 0,
    sending: false,
    pane: "collection",
    vars: loadVars(root),
    root,
    note: scanNote(scan),
    loading: false,
  };
}

const methodColor = (theme: Record<string, number>, method: string): number => ({
  GET: theme.success, POST: theme.accent, PUT: theme.warning,
  PATCH: theme.warning, DELETE: theme.danger,
}[method] ?? theme.secondary) as number;

export const USAGE = `Usage:
  r3q [dir]   browse the .http files in dir (default: the working directory); Enter sends`;

export async function main(): Promise<void> {
  if (process.argv.slice(2).some((a) => a === "-h" || a === "--help")) {
    console.log(USAGE);
    return;
  }
  const root = resolve(process.argv[2] ?? ".");
  const state = createState(root, { requests: [], dirs: 0, truncated: false });

  const app = await createApp({ theme: themes.dark, title: "r3q", quitKeys: ["ctrl+c"] });

  let scanController: AbortController | undefined;
  const reload = async (): Promise<void> => {
    scanController?.abort();
    const controller = new AbortController();
    scanController = controller;
    state.requests = [];
    state.selected = 0;
    state.offset = 0;
    state.loading = true;
    state.note = "";
    state.vars = loadVars(root);
    app.invalidate();
    try {
      const scan = await scanCollectionAsync(root, {
        signal: controller.signal,
        onRequest: (request) => {
          state.requests.push(request);
          app.invalidate();
        },
      });
      if (!controller.signal.aborted) state.note = scanNote(scan);
    } catch (error) {
      if (!controller.signal.aborted) state.note = String(error);
    } finally {
      if (!controller.signal.aborted) {
        state.loading = false;
        app.invalidate();
      }
    }
  };

  const current = (): RequestFile | undefined => state.requests[state.selected];

  const fire = async (): Promise<void> => {
    const request = current();
    if (!request || state.sending) return;
    if (request.error) { state.note = request.error; app.invalidate(); return; }
    state.sending = true;
    state.note = "";
    state.exchange = undefined;
    state.bodyOffset = 0;
    app.invalidate();
    state.exchange = await send(resolveRequest(request, state.vars));
    state.sending = false;
    app.invalidate();
  };

  app.on("key", (event: KeyEvent) => {
    switch (event.key) {
      case "q": app.quit(); return;
      case "tab": state.pane = state.pane === "collection" ? "response" : "collection"; return;
      case "r": void reload(); return;
      case "enter": void fire(); return;
      case "up":
        if (state.pane === "collection") state.selected = Math.max(0, state.selected - 1);
        else state.bodyOffset = Math.max(0, state.bodyOffset - 1);
        return;
      case "down":
        if (state.pane === "collection") {
          state.selected = Math.min(state.requests.length - 1, state.selected + 1);
        } else state.bodyOffset += 1;
        return;
      case "pageup": state.bodyOffset = Math.max(0, state.bodyOffset - 20); return;
      case "pagedown": state.bodyOffset += 20; return;
      case "home": state.bodyOffset = 0; return;
    }
  });

  app.render((args) => view(args, state));
  void reload();
  try {
    await app.start();
  } finally {
    scanController?.abort();
  }
}


/** JSON token colours, drawn from the active theme rather than hard-coded. */
export function jsonPalette(theme: Theme): JsonPalette {
  return {
    key: theme.accent,
    string: theme.success,
    number: theme.warning,
    boolean: theme.secondary,
    null: theme.muted,
    punctuation: theme.muted,
    plain: theme.foreground,
  };
}

export function view(
  { ui, theme, height }: { ui: Container; theme: Theme; height: number },
  state: State,
): void {
  {
    ui.row({ size: 1 }, (header) => {
      header.text(" r3q", { fg: theme.title, bold: true, size: 6 });
      header.text(state.root, { fg: theme.muted });
      header.text(
        `${state.loading ? "Loading… " : ""}${state.requests.length} requests  Tab panes  Enter send  r reload  q quit `,
        { fg: theme.muted, align: "right" },
      );
    });

    ui.row({ size: height - 2, gap: 1 }, (row) => {
      row.panel({
        title: "Collection",
        width: "0.9fr",
        borderColor: state.pane === "collection" ? theme.borderFocused : theme.border,
      }, (p) => {
        if (state.requests.length === 0) {
          if (state.loading) {
            p.label("Loading request files…");
            return;
          }
          p.label(`No .http files under ${state.root}`);
          p.label("Create one and press r to reload.");
          return;
        }
        p.table({
          rows: state.requests.map((r) => ({
            method: r.error ? "ERR" : r.method,
            name: r.id,
          })),
          selected: state.selected,
          offset: state.offset,
          followSelection: true,
          scrollbar: true,
          onScroll: (delta) => { state.offset = Math.max(0, state.offset + delta); },
          onSelectRow: (index) => { state.selected = state.offset + index; },
          header: false,
          columns: [
            { key: "method", title: "", width: 7, color: theme.secondary },
            { key: "name", title: "", min: 10, color: theme.foreground },
          ],
        });
      });

      row.column({ width: "2fr", gap: 1 }, (right) => {
        const request = state.requests[state.selected];
        right.panel({ title: "Request", size: 9 }, (p) => {
          if (!request) { p.label("Nothing selected."); return; }
          if (request.error) {
            p.text(`${request.id}: ${request.error}`, { fg: theme.danger, wrap: true });
            return;
          }
          const resolved = resolveRequest(request, state.vars);
          p.row({ size: 1 }, (r) => {
            r.badge({ text: resolved.method, color: methodColor(theme as never, resolved.method), size: 8 });
            r.text(` ${resolved.url}`, { fg: theme.foreground });
          });
          p.spacer(1);
          const entries = Object.entries(resolved.headers);
          if (entries.length > 0) {
            p.keyValues(entries.map(([k, v]) => ({ label: `${k}:`, value: v, color: theme.muted })));
          } else {
            p.label("No headers.");
          }
          if (resolved.body) {
            p.divider({ label: "body" });
            p.text(resolved.body, { fg: theme.foreground, wrap: true });
          }
        });

        const exchange = state.exchange;
        const subtitle = state.sending
          ? "sending…"
          : exchange
            ? `${exchange.status || "—"} ${exchange.statusText}  ${Math.round(exchange.ms)}ms  ${exchange.bytes}B`
            : "press Enter";
        right.panel({
          title: "Response",
          subtitle,
          subtitleColor: exchange ? theme[statusKind(exchange.status)] : theme.muted,
          size: "1fr",
          borderColor: state.pane === "response" ? theme.borderFocused : theme.border,
        }, (p) => {
          if (state.note !== "") p.text(state.note, { fg: theme.warning, size: 1 });
          if (state.sending) { p.label("Waiting for the server…"); return; }
          if (!exchange) { p.label("No response yet."); return; }
          if (exchange.error) { p.text(exchange.error, { fg: theme.danger, wrap: true }); return; }
          p.keyValues(
            exchange.headers.slice(0, 4).map(([k, v]) => ({ label: `${k}:`, value: v, color: theme.muted })),
          );
          p.divider({ label: "body" });
          const body = highlightBody(
            formatBody(exchange.body, exchange.contentType),
            exchange.contentType,
            jsonPalette(theme),
          );
          // One text() call per line rather than one for the whole body: the
          // pane scrolls by line, so slicing here is what makes bodyOffset work.
          for (const line of body.slice(state.bodyOffset, state.bodyOffset + 400)) {
            p.text(line.length === 0 ? " " : line, { size: 1 });
          }
        });
      });
    });

    ui.statusBar({
      items: [
        { key: "Enter", label: "Send" },
        { key: "Tab", label: state.pane === "collection" ? "Collection" : "Response", active: true },
        { key: "↑↓", label: "Move" },
        { key: "r", label: "Reload" },
        { key: "q", label: "Quit" },
      ],
    });
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
