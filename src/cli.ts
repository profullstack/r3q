/**
 * The non-interactive side: run requests from a script or CI, convert to and
 * from curl/Postman/OpenAPI/Bruno, and save/load workspace bundles.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { generateCode, importBruno, importInsomnia, importInsomniaEnvironments, importOpenApi, importPostman, importPostmanEnvironment, curlToHttp, exportOpenApi, exportPostman, toCurl, LANGUAGES } from "./http/convert.ts";
import { CookieJar } from "./http/cookies.ts";
import { deleteSecret, getSecret, secretBackend, secretNames, setSecret } from "./http/secrets.ts";
import { parseHttpFile } from "./http/parse.ts";
import { VERSION } from "./http/runner.ts";
import { Redactor, appendHistory, clearHistory, formatEntry, readHistory, toEntry, type HistoryEntry } from "./history.ts";
import { collect, dryRunPlan, jsonReport, junitReport, readDataRows, requestFiles, runSuite, type SuiteEntry, type SuiteItem } from "./suite.ts";
import { auditCollection, createCollection, formatCollection, inspectCollection } from "./collection-tools.ts";
import { installSkill, skillText, uninstallSkill } from "./agent.ts";
import { Resolver } from "./http/variables.ts";
import { Session, type RunResult } from "./http/runner.ts";
import type { HttpFile, HttpRequest, Interaction } from "./http/types.ts";
import { createOrg, createProject, loadBundle, readBundle, saveBundle, setTeam, workspaceTree, writeBundle } from "./workspace.ts";
import { loadCollection } from "./collection.ts";

export const COMMANDS = ["run", "curl", "code", "import", "export", "save", "load", "org", "project", "team", "tree", "env", "collection", "inspect", "audit", "format", "fmt", "secret", "cookies", "history", "agent", "update", "version"] as const;

export const CLI_USAGE = `Commands:
  r3q run <file.http>[#name|#N] [--all] [--env NAME]... [--var k=v]... [-o FILE] [-v]
        send requests; prints the response and test results, exits 1 on a failure
  r3q run <dir|file>... [--tag T]... [--exclude-tag T]... [--name GLOB]... [--dry-run]
        [--data rows.csv|rows.json] [--setup SPEC]... [--teardown SPEC]... [--delay MS] [--fail-fast]
        [--reporter text|json|junit] [--output FILE] [--json] [--cookie-jar] [--no-history]
        run a collection or part of it (also: r3q collection run ...)
  r3q collection create <dir>               scaffold a collection with an example request
  r3q inspect [dir|file]... [--json]        list requests, methods, URLs and tags
  r3q audit [dir] [--json]                  parse errors, undefined {{vars}}, leaked secrets; exit 1 on errors
  r3q format [dir|file]... [--check]        normalise .http formatting (--check exits 1 when changes are needed)
  r3q secret set|get|list|rm [NAME] [VALUE] secrets in the OS credential store, used as {{NAME}}
  r3q cookies [list|clear|rm DOMAIN [NAME]|set NAME VALUE DOMAIN [PATH]]   the collection's cookie jar
  r3q history [-n N] | show N | clear       recent sends, secrets redacted
  r3q export openapi|postman [dir] [-o FILE] [--title T]
  r3q agent install|uninstall|show [--agent claude|codex|agents|all]... [--project DIR]
  r3q update                                upgrade r3q in place
  r3q version
  r3q curl <file.http>[#name|#N]            print the request as a curl command
  r3q code <lang> <file.http>[#name|#N]     generate code (r3q code --list)
  r3q import curl '<curl command>' [-o FILE]
  r3q import postman|insomnia|openapi|swagger|bruno <file> [--out DIR]
  r3q save [BUNDLE] [--org ORG] [--project PROJECT] [--secrets]
        pack the workspace into one file you can scp anywhere (default r3q-bundle.json)
  r3q load <BUNDLE> [--force] [--dry-run]   unpack a bundle here; conflicts are kept unless --force
  r3q org add <name> [--description TEXT]
  r3q project add <org> <name> [--description TEXT] [--team a,b]
  r3q team add|remove <org>[/<project>] <member>...
  r3q tree                                  orgs, projects, teams and request counts
  r3q env                                   environments available here

  --root DIR   the workspace (default: the working directory)`;

interface Args { positional: string[]; flags: Map<string, string[]> }

export function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  const valued = new Set(["env", "e", "var", "o", "output", "out", "root", "org", "project", "description", "team", "timeout", "tag", "exclude-tag", "name", "data", "setup", "teardown", "delay", "reporter", "n", "agent", "title", "version"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") { positional.push(...argv.slice(i + 1)); break; }
    const m = /^--?([\w-]+)(?:=(.*))?$/.exec(a);
    if (!m || /^-\d/.test(a)) { positional.push(a); continue; }
    const key = m[1]!;
    const value = m[2] ?? (valued.has(key) ? argv[++i] ?? "" : "true");
    flags.set(key, [...(flags.get(key) ?? []), value]);
  }
  return { positional, flags };
}

const one = (args: Args, ...keys: string[]): string | undefined => { for (const k of keys) { const v = args.flags.get(k)?.at(-1); if (v !== undefined) return v; } return undefined; };
const all = (args: Args, ...keys: string[]): string[] => keys.flatMap((k) => args.flags.get(k) ?? []);

/** Prompts on a terminal; with no terminal, defaults or failure. */
export function terminalInteraction(): Interaction {
  const tty = process.stdin.isTTY && process.stderr.isTTY;
  const ask = async (question: string, secret = false): Promise<string> => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    if (secret) (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => { if (s.includes(question)) process.stderr.write(s); };
    try { return await rl.question(question); } finally { rl.close(); if (secret) process.stderr.write("\n"); }
  };
  return {
    async prompt(message, options) {
      if (!tty) { if (options?.default !== undefined) return options.default; throw new Error(`"${message}" needs an answer; run in a terminal or pass --var`); }
      const answer = await ask(`${message}${options?.default ? ` [${options.default}]` : ""}: `, options?.secret);
      return answer === "" ? options?.default ?? "" : answer;
    },
    async pick(message, options) {
      if (!tty) return options[0];
      options.forEach((o, i) => process.stderr.write(`  ${i + 1}) ${o}\n`));
      const answer = await ask(`${message} [1-${options.length}]: `);
      return options[Number(answer) - 1] ?? options.find((o) => o === answer) ?? options[0];
    },
    async confirm(message) {
      if (!tty) { process.stderr.write(`${message}: no terminal to confirm, skipping\n`); return false; }
      return /^y(es)?$/i.test(await ask(`${message} [y/N] `));
    },
    log(message) { process.stderr.write(`${message}\n`); },
  };
}

/** `file.http#name`, `file.http#3`, or the file alone. */
export async function select(session: Session, spec: string): Promise<{ file: HttpFile; requests: HttpRequest[] }> {
  const hash = spec.lastIndexOf("#");
  const path = resolve(hash > 0 ? spec.slice(0, hash) : spec);
  const which = hash > 0 ? spec.slice(hash + 1) : undefined;
  if (!existsSync(path)) throw new Error(`${path}: no such file`);
  const file = await session.load(path);
  for (const e of file.errors) process.stderr.write(`${path}:${e.line}: ${e.message}\n`);
  if (!which) return { file, requests: file.requests };
  const byIndex = /^\d+$/.test(which) ? file.requests[Number(which) - 1] : undefined;
  const found = byIndex ?? file.requests.find((r) => r.name === which || r.title === which);
  if (!found) throw new Error(`${path}: no request "${which}" (have: ${file.requests.map((r, i) => r.name ?? r.title ?? `#${i + 1}`).join(", ")})`);
  return { file, requests: [found] };
}

const color = (code: number, text: string): string => process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text;

function report(result: RunResult, verbose: boolean): boolean {
  const label = result.request.name ?? result.request.title ?? `${result.request.method} ${result.request.url.split("\n")[0]}`;
  if (result.iterations) { let ok = true; for (const r of result.iterations) ok = report(r, verbose) && ok; return ok; }
  if (result.skipped) { console.log(color(90, `- ${label}: skipped (${result.skipped})`)); return true; }
  if (result.error) { console.log(color(31, `✗ ${label}: ${result.error}`)); return false; }
  const res = result.response!;
  const ok = res.status > 0 && res.status < 400;
  console.log(color(ok ? 32 : 31, `${res.status} ${res.statusText}`) + color(90, `  ${result.prepared?.method} ${result.prepared?.url}  ${Math.round(res.duration)}ms  ${res.body.length}B`));
  if (verbose) {
    for (const [k, v] of result.prepared?.headers ?? []) console.log(color(90, `> ${k}: ${v}`));
    for (const [k, v] of res.headers) console.log(color(90, `< ${k}: ${v}`));
  }
  if (result.messages?.length) for (const m of result.messages) console.log(m);
  else if (res.text) {
    let text = res.text;
    if (/json/i.test(res.contentType)) { try { text = JSON.stringify(JSON.parse(text), null, 2); } catch { /* as is */ } }
    console.log(text);
  }
  for (const line of result.logs) console.log(color(90, `log: ${line}`));
  if (result.savedTo) console.log(color(90, `saved ${result.savedTo}`));
  let passed = true;
  for (const t of result.tests) {
    console.log(t.passed ? color(32, `  ✓ ${t.name}`) : color(31, `  ✗ ${t.name}${t.message ? `: ${t.message}` : ""}`));
    passed &&= t.passed;
  }
  return passed;
}

const SUITE_FLAGS = ["tag", "exclude-tag", "name", "data", "setup", "teardown", "delay", "fail-fast", "bail", "dry-run", "reporter", "json"];

/** Collects every result of a run and appends them to the timeline, redacted, when the run ends. */
function historyRecorder(root: string, session: Session, source: HistoryEntry["source"]): { add(r: RunResult): void; flush(): Promise<void> } {
  const pending: RunResult[] = [];
  return {
    add: (r) => { pending.push(r); },
    async flush() {
      if (!pending.length) return;
      const secretish = /pass|secret|token|key|auth|cookie|session|credential/i;
      const values: string[] = [...Object.values(session.secrets())];
      try {
        const env = await session.environment(root);
        for (const [k, v] of Object.entries(env.variables)) if (secretish.test(k) && typeof v === "string") values.push(v);
        values.push(...Object.values(env.dotenv));
      } catch { /* no environment */ }
      const redactor = new Redactor(values);
      const entries = pending.flatMap((r) => r.iterations ?? [r]).map((r) => toEntry(root, r, redactor, source)).filter((e): e is HistoryEntry => !!e);
      pending.length = 0;
      await appendHistory(root, entries).catch(() => {});
    },
  };
}

async function run(args: Args, root: string): Promise<number> {
  const spec = args.positional[0];
  if (!spec && !SUITE_FLAGS.some((f) => args.flags.has(f))) throw new Error("r3q run <file.http>[#name] | r3q run <dir> [--tag T] [--dry-run]");
  const interaction = terminalInteraction();
  let recorder: ReturnType<typeof historyRecorder> | undefined;
  const session = new Session({
    root, interaction, environments: all(args, "env", "e"),
    timeoutMs: one(args, "timeout") ? Number(one(args, "timeout")) * 1000 : undefined,
    cookieFile: args.flags.has("cookie-jar") ? join(root, ".r3q", "cookies.json") : undefined,
    onEvent: (e) => { if (e.kind === "log" && args.flags.has("v")) process.stderr.write(`${e.text}\n`); },
    onResult: (r) => recorder?.add(r),
  });
  recorder = args.flags.has("no-history") || args.flags.has("dry-run") ? undefined : historyRecorder(root, session, "cli");
  try {
    const target = spec ? resolve(spec) : undefined;
    const suite = !spec || args.positional.length > 1 || SUITE_FLAGS.some((f) => args.flags.has(f)) || (!!target && existsSync(target) && statSync(target).isDirectory());
    if (suite) return await runCollection(args, root, session);
    return await runFile(args, session, spec, interaction);
  } finally { await recorder?.flush(); }
}

function printEntry(e: SuiteEntry, verbose: boolean): void {
  const res = e.result;
  const where = `${e.phase !== "test" ? `[${e.phase}] ` : ""}${e.item.id}#${e.item.label}${e.row ? ` [row ${e.row}]` : ""}`;
  if (res.skipped) { console.log(color(90, `- ${where}: skipped (${res.skipped})`)); return; }
  if (res.error) { console.log(color(31, `✗ ${where}: ${res.error}`)); return; }
  const r = res.response;
  console.log(`${e.passed ? color(32, "✓") : color(31, "✗")} ${where}  ${color(90, `${r?.status ?? 0} ${r?.statusText ?? ""} ${Math.round(r?.duration ?? 0)}ms`)}`);
  for (const t of res.tests) if (!t.passed || verbose) console.log(t.passed ? color(32, `    ✓ ${t.name}`) : color(31, `    ✗ ${t.name}${t.message ? `: ${t.message}` : ""}`));
  if (verbose) for (const l of res.logs) console.log(color(90, `    log: ${l}`));
}

async function runCollection(args: Args, root: string, session: Session): Promise<number> {
  const overrides = Object.fromEntries(all(args, "var").map((kv) => { const i = kv.indexOf("="); return [kv.slice(0, i), kv.slice(i + 1)]; }));
  const list = (key: string): string[] => all(args, key).flatMap((t) => t.split(",")).map((t) => t.trim()).filter(Boolean);
  const items = await collect(session, root, { targets: args.positional, tags: list("tag"), excludeTags: list("exclude-tag"), names: all(args, "name") });
  const fixtures = async (specs: string[]): Promise<SuiteItem[]> => specs.length ? collect(session, root, { targets: specs, includeDisabled: true }) : [];
  const setup = await fixtures(all(args, "setup"));
  const teardown = await fixtures(all(args, "teardown"));
  const fixtureIds = new Set([...setup, ...teardown].map((i) => `${i.file.path}#${i.request.index}`));
  const tests = items.filter((i) => !fixtureIds.has(`${i.file.path}#${i.request.index}`));
  const dataPath = one(args, "data");
  const data = dataPath ? readDataRows(resolve(root, dataPath)) : undefined;
  const reporter = one(args, "reporter") ?? (args.flags.has("json") ? "json" : "text");
  if (!["text", "json", "junit"].includes(reporter)) throw new Error(`--reporter: text, json or junit (got ${reporter})`);
  if (args.flags.has("dry-run")) {
    if (reporter === "json") console.log(JSON.stringify({ dryRun: true, rows: data?.length ?? 0, setup: setup.map((i) => `${i.id}#${i.label}`), requests: tests.map((i) => ({ file: i.id, name: i.label, method: i.request.method, url: i.request.url.split("\n")[0], tags: i.tags })), teardown: teardown.map((i) => `${i.id}#${i.label}`) }, null, 2));
    else for (const line of dryRunPlan(tests, { data, setup, teardown })) console.log(line);
    return 0;
  }
  if (!tests.length) { process.stderr.write("no requests matched\n"); return 1; }
  const output = one(args, "output", "o");
  const verbose = args.flags.has("v") || args.flags.has("verbose");
  const textToStdout = reporter === "text" || !!output;
  const controller = new AbortController();
  const onSigint = (): void => {
    process.stderr.write("\nstopping; results so far are kept (Ctrl+C again to quit now)\n");
    controller.abort(); session.abort();
    process.once("SIGINT", () => process.exit(130));
  };
  process.once("SIGINT", onSigint);
  const report = await runSuite(session, tests, {
    overrides, data, setup, teardown,
    delayMs: one(args, "delay") ? Number(one(args, "delay")) : undefined,
    failFast: args.flags.has("fail-fast") || args.flags.has("bail"),
    signal: controller.signal,
    onResult: (e) => { if (textToStdout) printEntry(e, verbose); },
  });
  process.off("SIGINT", onSigint);
  const summary = `${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped in ${(report.durationMs / 1000).toFixed(1)}s${report.stopped ? ` (${report.stopped})` : ""}`;
  if (textToStdout) console.log(report.failed ? color(31, summary) : color(32, summary));
  if (reporter !== "text") {
    const body = reporter === "junit" ? junitReport(report) : `${JSON.stringify(jsonReport(report), null, 2)}\n`;
    if (output) {
      await mkdir(dirname(resolve(output)), { recursive: true });
      await writeFile(resolve(output), body);
      process.stderr.write(`${reporter} report: ${resolve(output)}\n`);
    } else process.stdout.write(body);
  }
  return report.failed || report.stopped === "stopped" ? 1 : 0;
}

async function runFile(args: Args, session: Session, spec: string, interaction: Interaction): Promise<number> {
  const overrides = Object.fromEntries(all(args, "var").map((kv) => { const i = kv.indexOf("="); return [kv.slice(0, i), kv.slice(i + 1)]; }));
  const { file, requests } = await select(session, spec);
  const verbose = args.flags.has("v") || args.flags.has("verbose");
  let ok = true;
  const output = one(args, "o", "output");
  const results: RunResult[] = [];
  if (!spec.includes("#") && (args.flags.has("all") || requests.length === 1 || !process.stdin.isTTY)) {
    if (Object.keys(overrides).length) for (const r of file.requests) for (const [k, v] of Object.entries(overrides)) r.variables.push({ name: k, value: v, lazy: false, line: r.line });
    for (const r of await session.runAll(file)) { results.push(r); ok = report(r, verbose) && ok; }
  } else {
    let targets = requests;
    if (!spec.includes("#") && requests.length > 1) {
      const pick = await interaction.pick("Which request?", requests.map((r, i) => `${i + 1}. ${r.name ?? r.title ?? `${r.method} ${r.url.split("\n")[0]}`}`));
      targets = [requests[Number(pick?.split(".")[0]) - 1] ?? requests[0]!];
    }
    for (const request of targets) {
      const result = await session.run(file, request, { overrides });
      results.push(result);
      ok = report(result, verbose) && ok;
    }
  }
  if (output) {
    const last = results.filter((r) => r.response).at(-1);
    if (!last?.response) throw new Error("-o: there is no response to save");
    await mkdir(dirname(resolve(output)), { recursive: true });
    await writeFile(output, last.response.body);
    process.stderr.write(`saved ${resolve(output)}\n`);
  }
  return ok ? 0 : 1;
}

async function prepareOnly(args: Args, root: string, spec: string) {
  const session = new Session({ root, interaction: terminalInteraction(), environments: all(args, "env", "e") });
  const { file, requests } = await select(session, spec);
  const request = requests[0];
  if (!request) throw new Error(`${spec}: no requests`);
  // Resolve variables the way a send would, without sending.
  const env = await session.environment(dirname(file.path));
  const resolver = new Resolver({
    root, baseDir: dirname(file.path), request: new Map(), file: [...file.variables, ...request.variables], globals: session.globals,
    env: env.variables, dotenv: env.dotenv, responses: session.responses, interaction: terminalInteraction(), cache: session.cache,
  });
  const metadata = new Map([...file.metadata, ...request.metadata]);
  return session.prepare(request.fromCurl ? (await import("./http/parse.ts")).parseHttpFile(curlToHttp(request.url)).requests[0]! : request, metadata, resolver, dirname(file.path), env);
}

async function importCommand(args: Args, root: string): Promise<number> {
  const [kind, source] = args.positional;
  if (!kind || !source) throw new Error("r3q import curl|postman|insomnia|openapi|bruno <source>");
  const outDir = resolve(root, one(args, "out") ?? ".");
  const write = async (files: Map<string, string>): Promise<void> => {
    for (const [rel, text] of files) {
      const target = join(outDir, rel);
      if (existsSync(target) && !args.flags.has("force")) { process.stderr.write(`exists, skipped: ${target} (use --force)\n`); continue; }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, text);
      console.log(target);
    }
  };
  switch (kind) {
    case "curl": {
      const text = curlToHttp(source, true);
      const out = one(args, "o", "output");
      if (out) await write(new Map([[out, text]])); else process.stdout.write(text);
      return 0;
    }
    case "postman": {
      const json = JSON.parse(await readFile(source, "utf8")) as Record<string, unknown>;
      if (json.values && !json.item) {
        const envFile = join(outDir, "http-client.env.json");
        const existing = existsSync(envFile) ? JSON.parse(await readFile(envFile, "utf8")) as Record<string, unknown> : {};
        await writeFile(envFile, JSON.stringify({ ...existing, ...importPostmanEnvironment(json) }, null, 2));
        console.log(envFile);
        return 0;
      }
      const warnings: string[] = [];
      await write(importPostman(json, warnings));
      for (const w of warnings) process.stderr.write(`warning: ${w}\n`);
      return 0;
    }
    case "insomnia": {
      const text = await readFile(source, "utf8");
      const warnings: string[] = [];
      await write(importInsomnia(text, warnings));
      const envs = importInsomniaEnvironments(text);
      if (Object.keys(envs).length) {
        const envFile = join(outDir, "http-client.env.json");
        const existing = existsSync(envFile) ? JSON.parse(await readFile(envFile, "utf8")) as Record<string, unknown> : {};
        await writeFile(envFile, JSON.stringify({ ...existing, ...envs }, null, 2));
        console.log(envFile);
      }
      for (const w of warnings) process.stderr.write(`warning: ${w}\n`);
      return 0;
    }
    case "openapi": case "swagger": {
      const text = await readFile(source, "utf8");
      let spec: unknown = text;
      try { spec = JSON.parse(text); } catch { /* YAML */ }
      await write(importOpenApi(spec));
      return 0;
    }
    case "bruno": {
      const files = new Map<string, string>();
      const sources = statSync(source).isDirectory() ? readdirSync(source).filter((f) => f.endsWith(".bru")).sort().map((f) => join(source, f)) : [source];
      const out = sources.map((s) => importBruno(readFileSync(s, "utf8"))).join("\n\n###\n\n");
      files.set(one(args, "o", "output") ?? `${(source.split("/").pop() ?? "bruno").replace(/\.bru$/, "")}.http`, `${out}\n`);
      await write(files);
      return 0;
    }
  }
  throw new Error(`unknown import kind ${kind}`);
}

export async function cli(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  const root = resolve(one(args, "root") ?? ".");
  switch (command) {
    case "run": return run(args, root);
    case "curl": console.log(toCurl(await prepareOnly(args, root, args.positional[0] ?? ""))); return 0;
    case "code": {
      if (args.flags.has("list")) { console.log(LANGUAGES.join("\n")); return 0; }
      const [lang, spec] = args.positional;
      if (!lang || !spec) throw new Error("r3q code <lang> <file.http>[#name]  (r3q code --list)");
      console.log(generateCode(lang, await prepareOnly(args, root, spec)));
      return 0;
    }
    case "import": return importCommand(args, root);
    case "save": {
      const path = resolve(args.positional[0] ?? "r3q-bundle.json");
      const { bundle, skipped } = await saveBundle(root, { org: one(args, "org"), project: one(args, "project"), secrets: args.flags.has("secrets"), savedBy: `${userInfo().username}@${hostname()}` });
      await writeBundle(path, bundle);
      console.log(`saved ${Object.keys(bundle.files).length} files to ${path}${bundle.includesSecrets ? " (includes secrets; mode 0600)" : ""}`);
      for (const s of skipped) console.log(`  left out: ${s}`);
      console.log(`share it: scp ${path} host:  then on host: r3q load ${path.split("/").pop()} --root ~/api`);
      return 0;
    }
    case "load": {
      const path = args.positional[0];
      if (!path) throw new Error("r3q load <bundle.json>");
      const bundle = await readBundle(path);
      const report = await loadBundle(root, bundle, { force: args.flags.has("force"), dryRun: args.flags.has("dry-run") });
      const verb = args.flags.has("dry-run") ? "would write" : "wrote";
      console.log(`${verb} ${report.written.length}, replaced ${report.replaced.length}, unchanged ${report.unchanged.length}, conflicts ${report.conflicts.length} (from ${bundle.savedBy ?? "?"} at ${bundle.savedAt})`);
      for (const c of report.conflicts) console.log(`  conflict (kept local): ${c}`);
      if (report.conflicts.length) console.log("  re-run with --force to take the bundle's version; the local copy moves to .r3q-trash");
      return report.conflicts.length ? 2 : 0;
    }
    case "org": {
      if (args.positional[0] !== "add" || !args.positional[1]) throw new Error("r3q org add <name>");
      console.log(`org ${await createOrg(root, args.positional[1], { description: one(args, "description") })}`);
      return 0;
    }
    case "project": {
      const [verb, org, name] = args.positional;
      if (verb !== "add" || !org || !name) throw new Error("r3q project add <org> <name>");
      const team = one(args, "team")?.split(",").map((s) => s.trim()).filter(Boolean);
      console.log(`project ${org}/${await createProject(root, org, name, { description: one(args, "description"), team })}`);
      return 0;
    }
    case "team": {
      const [verb, target, ...members] = args.positional;
      if ((verb !== "add" && verb !== "remove") || !target) throw new Error("r3q team add|remove <org>[/<project>] <member>...");
      const [org, project] = target.split("/");
      const team = await setTeam(root, org!, project, verb === "add" ? members : [], verb === "remove" ? members : []);
      console.log(`${target}: ${team.join(", ") || "(no members)"}`);
      return 0;
    }
    case "tree": {
      const tree = await workspaceTree(root, loadCollection(root).map((r) => r.file ?? r.id));
      if (!tree.length) console.log("no orgs yet: r3q org add <name>, then r3q project add <org> <name>");
      for (const org of tree) {
        console.log(`${org.slug}${org.info.name && org.info.name !== org.slug ? ` (${org.info.name})` : ""}${org.info.team?.length ? `  team: ${org.info.team.join(", ")}` : ""}`);
        for (const p of org.projects) console.log(`  ${p.slug}  ${p.requests} request${p.requests === 1 ? "" : "s"}${p.info.team?.length ? `  team: ${p.info.team.join(", ")}` : ""}${p.info.description ? `  ${p.info.description}` : ""}`);
      }
      return 0;
    }
    case "env": {
      const session = new Session({ root, interaction: terminalInteraction() });
      const names = await session.environmentNames(root);
      console.log(names.length ? names.join("\n") : "no environments (http-client.env.json, .vscode/settings.json, httpyac config)");
      return 0;
    }
    case "collection": {
      const [verb, ...more] = args.positional;
      if (verb === "run") return run({ ...args, positional: more }, root);
      if (verb === "create" || verb === "new") {
        const dir = resolve(root, more[0] ?? ".");
        const written = await createCollection(dir, { force: args.flags.has("force") });
        for (const w of written) console.log(w);
        console.log(written.length ? `collection ready: r3q ${more[0] ?? "."}   (or r3q run ${more[0] ?? "."} --tag smoke)` : `${dir} already has these files (use --force to overwrite)`);
        return 0;
      }
      if (verb === "inspect") return cli(["inspect", ...more, ...flagArgs(args)]);
      if (verb === "audit") return cli(["audit", ...more, ...flagArgs(args)]);
      if (verb === "format" || verb === "fmt") return cli(["format", ...more, ...flagArgs(args)]);
      throw new Error("r3q collection create|run|inspect|audit|format ...");
    }
    case "inspect": {
      const rows = await inspectCollection(root, args.positional);
      if (args.flags.has("json")) { console.log(JSON.stringify(rows, null, 2)); return 0; }
      if (!rows.length) { console.log("no requests"); return 0; }
      for (const r of rows) console.log(`${r.method.padEnd(7)} ${`${r.file}#${r.name || r.index}`.padEnd(48)} ${r.url}${r.tags.length ? color(36, `  [${r.tags.join(", ")}]`) : ""}${r.error ? color(31, `  ✗ ${r.error}`) : ""}`);
      console.log(color(90, `${rows.length} request${rows.length === 1 ? "" : "s"} in ${new Set(rows.map((r) => r.file)).size} file(s)`));
      return 0;
    }
    case "audit": {
      const findings = await auditCollection(resolve(root, args.positional[0] ?? "."));
      if (args.flags.has("json")) console.log(JSON.stringify(findings, null, 2));
      else {
        for (const f of findings) console.log(`${f.level === "error" ? color(31, "error") : color(33, "warning")} ${f.file}${f.line ? `:${f.line}` : ""}  ${f.message}`);
        const errors = findings.filter((f) => f.level === "error").length;
        console.log(findings.length ? `${errors} error(s), ${findings.length - errors} warning(s)` : color(32, "no problems found"));
      }
      return findings.some((f) => f.level === "error") ? 1 : 0;
    }
    case "format": case "fmt": {
      const check = args.flags.has("check");
      const { changed, checked } = await formatCollection(root, args.positional, { check });
      for (const c of changed) console.log(`${check ? "would format" : "formatted"} ${c}`);
      console.log(`${changed.length} of ${checked} file(s) ${check ? "need formatting" : "changed"}`);
      return check && changed.length ? 1 : 0;
    }
    case "secret": case "secrets": {
      const [verb = "list", name, value] = args.positional;
      if (verb === "list") {
        const names = secretNames(root);
        console.log(names.length ? names.join("\n") : "no secrets: r3q secret set NAME");
        process.stderr.write(color(90, `store: ${secretBackend()?.name ?? "none found"}\n`));
        return 0;
      }
      if (!name) throw new Error(`r3q secret ${verb} NAME`);
      if (verb === "set") {
        let v = value;
        if (v === undefined) {
          if (!process.stdin.isTTY) v = (await readStdin()).replace(/\r?\n$/, "");
          else v = await terminalInteraction().prompt(`Value for ${name}`, { secret: true }) ?? "";
        } else process.stderr.write(color(33, "note: a value on the command line lands in shell history; omit it to be prompted\n"));
        console.log(`stored ${name} in ${setSecret(root, name, v)}; use it as {{${name}}}`);
        return 0;
      }
      if (verb === "get") {
        const v = getSecret(root, name);
        if (v === undefined) { process.stderr.write(`no secret ${name}\n`); return 1; }
        process.stdout.write(`${v}\n`);
        return 0;
      }
      if (verb === "rm" || verb === "delete" || verb === "remove") { console.log(deleteSecret(root, name) ? `removed ${name}` : `no secret ${name}`); return 0; }
      throw new Error("r3q secret set|get|list|rm NAME");
    }
    case "cookies": case "cookie": {
      const jar = new CookieJar(join(root, ".r3q", "cookies.json"));
      const [verb = "list", a, b, c, d] = args.positional;
      if (verb === "list") {
        const cookies = a ? jar.cookies.filter((k) => k.domain === a || k.domain.endsWith(`.${a}`)) : jar.cookies;
        if (args.flags.has("json")) { console.log(JSON.stringify(cookies, null, 2)); return 0; }
        if (!cookies.length) { console.log("the cookie jar is empty"); return 0; }
        for (const k of cookies) console.log(`${k.hostOnly ? "" : "."}${k.domain}${k.path}  ${k.name}=${k.value.length > 40 ? `${k.value.slice(0, 40)}…` : k.value}${k.expires ? color(90, `  expires ${new Date(k.expires).toISOString()}`) : color(90, "  session")}${k.secure ? color(90, " secure") : ""}${k.httpOnly ? color(90, " httponly") : ""}`);
        return 0;
      }
      if (verb === "clear") { const n = jar.cookies.length; jar.clear(); console.log(`removed ${n} cookie(s)`); return 0; }
      if (verb === "rm" || verb === "remove") { if (!a) throw new Error("r3q cookies rm DOMAIN [NAME]"); console.log(`removed ${jar.remove(a, b)} cookie(s)`); return 0; }
      if (verb === "set") { if (!a || b === undefined || !c) throw new Error("r3q cookies set NAME VALUE DOMAIN [PATH]"); jar.set({ name: a, value: b, domain: c, path: d }); console.log(`set ${a} for ${c}${d ?? "/"}`); return 0; }
      throw new Error("r3q cookies list|clear|rm|set");
    }
    case "history": {
      const [verb, n] = args.positional;
      if (verb === "clear") { await clearHistory(root); console.log("history cleared"); return 0; }
      if (verb === "show") {
        const entries = await readHistory(root, Number(n ?? 1));
        const e = entries[Number(n ?? 1) - 1];
        if (!e) { process.stderr.write("no such entry\n"); return 1; }
        console.log(args.flags.has("json") ? JSON.stringify(e, null, 2) : formatEntry(e, true));
        return 0;
      }
      const entries = await readHistory(root, Number(one(args, "n") ?? 20));
      if (args.flags.has("json")) { console.log(JSON.stringify(entries, null, 2)); return 0; }
      if (!entries.length) { console.log("no history yet"); return 0; }
      entries.forEach((e, i) => console.log(`${String(i + 1).padStart(3)}  ${formatEntry(e)}`));
      console.log(color(90, "r3q history show N  for the full exchange"));
      return 0;
    }
    case "export": {
      const [kind, dir] = args.positional;
      if (kind !== "openapi" && kind !== "postman") throw new Error("r3q export openapi|postman [dir] [-o FILE]");
      const base = resolve(root, dir ?? ".");
      const files = await Promise.all(requestFiles(base).map(async (path) => ({ path, file: parseHttpFile(await readFile(path, "utf8"), path) })));
      const title = one(args, "title") ?? base.split("/").pop() ?? "r3q";
      const doc = kind === "openapi" ? exportOpenApi(files, { title, version: one(args, "version"), root: base }) : exportPostman(files, { name: title, root: base });
      const text = `${JSON.stringify(doc, null, 2)}\n`;
      const out = one(args, "o", "output");
      if (out) { await writeFile(resolve(out), text); process.stderr.write(`wrote ${resolve(out)} (${files.length} file(s))\n`); }
      else process.stdout.write(text);
      return 0;
    }
    case "agent": {
      const [verb = "install"] = args.positional;
      const opts = { project: one(args, "project"), agents: all(args, "agent").flatMap((a) => a.split(",")) };
      if (verb === "show") { process.stdout.write(skillText()); return 0; }
      if (verb === "uninstall" || verb === "remove") { const removed = await uninstallSkill(opts); console.log(removed.length ? removed.map((r) => `removed ${r}`).join("\n") : "no r3q skill installed"); return 0; }
      if (verb !== "install") throw new Error("r3q agent install|uninstall|show");
      const { installed, unchanged } = await installSkill(opts);
      for (const p of installed) console.log(`installed ${p}`);
      for (const p of unchanged) console.log(color(90, `up to date ${p}`));
      console.log("re-run after upgrading r3q so the skill matches the new version");
      return 0;
    }
    case "version": console.log(VERSION); return 0;
    case "update": {
      const bun = process.versions.bun !== undefined;
      const managed = existsSync(join(process.env.HOME ?? "", ".local", "share", "r3q"));
      const [cmd, cmdArgs] = managed
        ? ["sh", ["-c", "curl -fsSL https://raw.githubusercontent.com/profullstack/r3q/main/install.sh | sh"]]
        : bun ? ["bun", ["add", "-g", "@profullstack/r3q@latest"]] : ["npm", ["install", "-g", "@profullstack/r3q@latest"]];
      process.stderr.write(`r3q ${VERSION}: running ${cmd} ${(cmdArgs as string[]).join(" ")}\n`);
      const { spawnSync } = await import("node:child_process");
      const r = spawnSync(cmd as string, cmdArgs as string[], { stdio: "inherit" });
      return r.status ?? 1;
    }
  }
  throw new Error(`unknown command ${command}`);
}

/** Flags back into argv form, for commands that forward to another. */
function flagArgs(args: Args): string[] {
  return [...args.flags].flatMap(([k, vs]) => vs.map((v) => v === "true" ? `--${k}` : `--${k}=${v}`));
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
