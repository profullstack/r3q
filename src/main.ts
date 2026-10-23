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
import { RequestManager } from "./request-manager.ts";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { hostname, userInfo } from "node:os";
import { CLI_USAGE, COMMANDS, cli } from "./cli.ts";
import { toCurl } from "./http/convert.ts";
import { Session, type RunResult } from "./http/runner.ts";
import type { TestResult } from "./http/scripts.ts";
import { PromptDialog } from "./prompt-dialog.ts";
import { createOrg, createProject, loadBundle, readBundle, saveBundle, writeBundle } from "./workspace.ts";

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
  /** Test results, log lines and streamed messages of the last send. */
  tests?: TestResult[];
  logs?: string[];
  messages?: string[];
  /** Active environment names (http-client.env.json, VS Code, httpyac). */
  environments?: string[];
  /** What was actually sent, once it has been. */
  sent?: { method: string; url: string; headers: [string, string][]; body?: string };
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
  r3q [dir]   browse the .http/.rest files in dir (default: the working directory)

  n new request  v view file  e edit  d duplicate  x delete  r reload
  s save response  c copy as curl  E environment  p new org/project
  S save workspace bundle  L load bundle  Esc cancel a running request
  Enter sends the selected request, or starts the wizard in an empty collection
  Saved requests are .http files. Deleted files move to .r3q-trash.

${CLI_USAGE}`;

/** The runner's result as the response pane shows it. */
export function toExchange(result: RunResult): Exchange {
  const res = result.response;
  if (!res) {
    return { status: 0, statusText: "", headers: [], body: "", ms: 0, bytes: 0, contentType: "", error: result.error ?? (result.skipped ? `not sent: ${result.skipped}` : "no response") };
  }
  return {
    status: res.status, statusText: res.statusText, headers: [...res.headers].sort((a, b) => a[0].localeCompare(b[0])),
    body: result.messages?.length ? result.messages.join("\n") : res.text, ms: res.duration, bytes: res.body.length, contentType: res.contentType,
    error: result.error ?? (res.status === 0 ? res.statusText || "failed" : undefined),
  };
}

/** OSC 52: put text on the terminal's clipboard, local or over ssh. */
function copyToClipboard(text: string): void {
  process.stdout.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
}

export async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.some((a) => a === "-h" || a === "--help")) {
    console.log(USAGE);
    return;
  }
  if ((COMMANDS as readonly string[]).includes(argv[0] ?? "")) {
    process.exitCode = await cli(argv);
    return;
  }
  const root = resolve(argv[0] ?? ".");
  const state = createState(root, { requests: [], dirs: 0, truncated: false });

  // The form owns cursor movement and Tab order, including multiline fields.
  const app = await createApp({ theme: themes.dark, title: "r3q", quitKeys: ["ctrl+c"], focusNavigation: false });

  const dialog = new PromptDialog(() => app.invalidate(), (line) => { (state.logs ??= []).push(line); app.invalidate(); });
  const session = new Session({
    root, interaction: dialog, cookieFile: join(root, ".r3q", "cookies.json"),
    onEvent: (event) => {
      if (event.kind === "message") (state.messages ??= []).push(event.text);
      else (state.logs ??= []).push(event.text);
      app.invalidate();
    },
  });
  let scanController: AbortController | undefined;
  const reload = async (selectId = state.requests[state.selected]?.id, note = ""): Promise<void> => {
    scanController?.abort();
    const controller = new AbortController();
    scanController = controller;
    state.requests = [];
    state.selected = 0;
    state.offset = 0;
    state.loading = true;
    state.note = note;
    state.vars = loadVars(root);
    app.invalidate();
    try {
      const scan = await scanCollectionAsync(root, {
        signal: controller.signal,
        onRequest: (request) => {
          state.requests.push(request);
          if (request.id === selectId) state.selected = state.requests.length - 1;
          app.invalidate();
        },
      });
      if (!controller.signal.aborted) state.note = [note, scanNote(scan)].filter(Boolean).join(" · ");
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
  const manager = new RequestManager(root, {
    current,
    invalidate: () => app.invalidate(),
    changed: async (id, note) => {
      state.exchange = undefined;
      state.bodyOffset = 0;
      state.pane = "collection";
      await reload(id, note);
    },
    note: (note) => { state.note = note; app.invalidate(); },
  });

  let lastResult: RunResult | undefined;
  const fire = async (): Promise<void> => {
    const request = current();
    if (!request || state.sending) return;
    if (request.error) { state.note = request.error; app.invalidate(); return; }
    state.sending = true;
    state.note = "";
    state.exchange = undefined;
    state.tests = [];
    state.logs = [];
    state.messages = [];
    state.sent = undefined;
    state.bodyOffset = 0;
    app.invalidate();
    try {
      const file = await session.load(request.path);
      let result: RunResult;
      if (request.method === "RUN") {
        const run = file.runs[request.index ?? 0];
        if (!run) throw new Error("run directive not found; press r to reload");
        const results = await session.runDirective(file, run);
        const final = results[results.length - 1];
        if (!final) throw new Error("nothing ran");
        result = { ...final, tests: results.flatMap((r) => r.tests) };
      } else {
        const target = file.requests[request.index ?? 0];
        if (!target) throw new Error("this request moved; press r to reload");
        result = await session.run(file, target);
      }
      lastResult = result;
      state.exchange = toExchange(result);
      state.tests = result.tests;
      if (result.prepared) state.sent = { method: result.prepared.method, url: result.prepared.url, headers: result.prepared.headers, body: result.prepared.bodyText };
      if (result.savedTo) state.note = `saved ${result.savedTo}`;
      if (result.iterations) state.note = `@loop ran ${result.iterations.length} times`;
    } catch (error) {
      state.exchange = { status: 0, statusText: "", headers: [], body: "", ms: 0, bytes: 0, contentType: "", error: error instanceof Error ? error.message : String(error) };
    }
    state.sending = false;
    app.invalidate();
  };

  const ask = async (message: string, fallback: string): Promise<string | undefined> => {
    const answer = await dialog.prompt(message, { default: fallback });
    return answer?.trim() || undefined;
  };
  const fail = (error: unknown): void => { state.note = error instanceof Error ? error.message : String(error); app.invalidate(); };
  const saveResponse = async (): Promise<void> => {
    const res = lastResult?.response;
    if (!lastResult || !res) { state.note = "Send a request first; s saves its response."; app.invalidate(); return; }
    const name = (lastResult.request.name ?? lastResult.request.title ?? "response").replace(/[^\w.-]+/g, "-");
    const ext = /json/i.test(res.contentType) ? ".json" : /xml/i.test(res.contentType) ? ".xml" : /html/i.test(res.contentType) ? ".html" : /text/i.test(res.contentType) ? ".txt" : ".bin";
    const path = await ask("Save the response body to", join(dirname(lastResult.file), "responses", `${name}${ext}`));
    if (!path) return;
    const target = resolve(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, res.body);
    state.note = `saved ${target}`;
    app.invalidate();
  };
  const saveWorkspace = async (): Promise<void> => {
    const path = await ask("Save the workspace bundle (orgs, projects, requests, shared envs) to", join(root, "r3q-bundle.json"));
    if (!path) return;
    const secrets = await dialog.confirm("Include secrets (.env files, private env files, keys)?");
    const { bundle, skipped } = await saveBundle(root, { secrets, savedBy: `${userInfo().username}@${hostname()}` });
    await writeBundle(resolve(root, path), bundle);
    state.note = `saved ${Object.keys(bundle.files).length} files to ${resolve(root, path)}${skipped.length ? ` (left out ${skipped.length})` : ""}; scp it, then r3q load it there`;
    app.invalidate();
  };
  const loadWorkspace = async (): Promise<void> => {
    const path = await ask("Load a workspace bundle from", join(root, "r3q-bundle.json"));
    if (!path) return;
    const bundle = await readBundle(resolve(root, path));
    let report = await loadBundle(root, bundle);
    let replaced = 0;
    if (report.conflicts.length && await dialog.confirm(`${report.conflicts.length} file(s) differ locally (${report.conflicts.slice(0, 3).join(", ")}${report.conflicts.length > 3 ? ", ..." : ""}). Replace them? Local copies move to .r3q-trash.`)) {
      const forced = await loadBundle(root, bundle, { force: true });
      replaced = forced.replaced.length;
      report = { ...report, conflicts: forced.conflicts };
    }
    await reload(undefined, `loaded bundle from ${bundle.savedBy ?? "?"}: ${report.written.length} new, ${replaced} replaced, ${report.unchanged.length} unchanged, ${report.conflicts.length} kept local`);
  };
  const chooseEnvironment = async (): Promise<void> => {
    const names = await session.environmentNames(root);
    if (!names.length) { state.note = "No environments: add http-client.env.json (or .vscode/settings.json, httpyac config)."; app.invalidate(); return; }
    const pick = await dialog.pick("Environment", ["(none)", ...names]);
    if (pick === undefined) return;
    session.setEnvironments(pick === "(none)" ? [] : [pick]);
    state.environments = session.environments;
    state.note = `environment: ${pick}`;
    app.invalidate();
  };
  const newProject = async (): Promise<void> => {
    const org = await ask("Organization", current()?.org ?? "");
    if (!org) return;
    const project = await ask("Project (a team's workspace)", "");
    if (!project) return;
    const team = await dialog.prompt("Team members, comma separated (optional)", { default: "" });
    const orgSlug = await createOrg(root, org);
    const slug = await createProject(root, orgSlug, project, { team: team ? team.split(",").map((m) => m.trim()).filter(Boolean) : undefined });
    manager.create(`${orgSlug}/${slug}`);
  };
  const copyCurl = (): void => {
    const sent = lastResult?.prepared;
    if (!sent) { state.note = "Send the request first; c copies what was sent as curl."; app.invalidate(); return; }
    copyToClipboard(toCurl(sent));
    state.note = "copied as curl";
    app.invalidate();
  };

  app.on("key", (event: KeyEvent) => {
    if (dialog.open) { dialog.key(event); return; }
    if (manager.dialog) { manager.key(event); return; }
    switch (event.key) {
      case "escape": if (state.sending) { session.abort(); state.note = "cancelled"; } return;
      case "s": saveResponse().catch(fail); return;
      case "S": case "shift+s": saveWorkspace().catch(fail); return;
      case "L": case "shift+l": loadWorkspace().catch(fail); return;
      case "E": case "shift+e": chooseEnvironment().catch(fail); return;
      case "c": copyCurl(); return;
      case "p": newProject().catch(fail); return;
      case "q": app.quit(); return;
      case "tab": state.pane = state.pane === "collection" ? "response" : "collection"; return;
      case "r": void reload(); return;
      case "n": manager.create(current()?.org && current()?.project ? `${current()!.org}/${current()!.project}` : ""); return;
      case "v": void manager.open("view"); return;
      case "e": void manager.open("edit"); return;
      case "d": void manager.open("duplicate"); return;
      case "x": case "delete": void manager.open("delete"); return;
      case "enter": if (state.requests.length === 0) manager.create(); else void fire(); return;
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
  app.on("paste", (event) => { if (dialog.open) dialog.paste(event.text); else manager.paste(event.text); });

  app.render((args) => {
    view(args, state, {
      create: () => manager.create(),
      open: (kind) => void manager.open(kind),
      reload: () => void reload(),
      send: () => { if (state.requests.length === 0) manager.create(); else void fire(); },
    });
    manager.render(args.ui, args.theme, args.width, args.height);
    dialog.render(args.ui, args.theme, args.width, args.height);
  });
  void reload();
  try {
    await app.start();
  } finally {
    scanController?.abort();
    session.abort();
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
  actions?: { create: () => void; open: (kind: "view" | "edit" | "duplicate" | "delete") => void; reload: () => void; send: () => void },
): void {
  {
    ui.row({ size: 1 }, (header) => {
      header.text(" r3q", { fg: theme.title, bold: true, size: 6 });
      header.text(state.root, { fg: theme.muted });
      header.text(
        `${state.loading ? "Loading… " : ""}${state.requests.length} requests  env ${state.environments?.join("+") || "none"} (E)  n new  Enter send  q quit `,
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
          p.spacer(1);
          p.button({ label: "New request (n)", onPress: actions?.create });
          p.label("Press n or Enter for the wizard.");
          p.label("Prefilled methods, headers and bodies.");
          return;
        }
        p.table({
          rows: state.requests.map((r) => ({
            method: r.error ? "ERR" : r.method,
            name: (r.siblings ?? 1) > 1 ? `${r.file} › ${r.label ?? `#${(r.index ?? 0) + 1}`}` : r.id,
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
          if (!request) {
            p.label("Create your first request with n.");
            p.label("Choose GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS or TRACE.");
            p.label("The wizard saves a .http file in this collection.");
            p.label("Press Enter on a saved request when you want to send it.");
            return;
          }
          if (request.error) {
            p.text(`${request.id}: ${request.error}`, { fg: theme.danger, wrap: true });
            return;
          }
          // Before a send: the file with .env values filled in. After: exactly what went out.
          const preview = resolveRequest(request, state.vars);
          const sent = state.sent && state.exchange ? state.sent : undefined;
          const resolved = sent ? { method: sent.method, url: sent.url, headers: Object.fromEntries(sent.headers), body: sent.body } : preview;
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
          for (const t of state.tests ?? []) {
            p.text(`${t.passed ? "✓" : "✗"} ${t.name}${t.message ? `: ${t.message}` : ""}`, { fg: t.passed ? theme.success : theme.danger, size: 1 });
          }
          for (const line of (state.logs ?? []).slice(-3)) p.text(line, { fg: theme.muted, size: 1 });
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
        { key: "n", label: "New", onPress: actions?.create },
        { key: "v", label: "View", onPress: () => actions?.open("view") },
        { key: "e", label: "Edit", onPress: () => actions?.open("edit") },
        { key: "d", label: "Duplicate", onPress: () => actions?.open("duplicate") },
        { key: "x", label: "Delete", onPress: () => actions?.open("delete") },
        { key: "Enter", label: state.requests.length ? "Send" : "New", onPress: actions?.send },
        { key: "s", label: "Save resp" },
        { key: "S/L", label: "Save/Load bundle" },
        { key: "E", label: "Env" },
        { key: "p", label: "Project" },
        { key: "Tab", label: state.pane === "collection" ? "Collection" : "Response", active: true },
        { key: "r", label: "Reload", onPress: actions?.reload },
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
