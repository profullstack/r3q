/**
 * The non-interactive side: run requests from a script or CI, convert to and
 * from curl/Postman/OpenAPI/Bruno, and save/load workspace bundles.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { generateCode, importBruno, importOpenApi, importPostman, importPostmanEnvironment, curlToHttp, toCurl, LANGUAGES } from "./http/convert.ts";
import { Resolver } from "./http/variables.ts";
import { Session, type RunResult } from "./http/runner.ts";
import type { HttpFile, HttpRequest, Interaction } from "./http/types.ts";
import { createOrg, createProject, loadBundle, readBundle, saveBundle, setTeam, workspaceTree, writeBundle } from "./workspace.ts";
import { loadCollection } from "./collection.ts";

export const COMMANDS = ["run", "curl", "code", "import", "save", "load", "org", "project", "team", "tree", "env"] as const;

export const CLI_USAGE = `Commands:
  r3q run <file.http>[#name|#N] [--all] [--env NAME]... [--var k=v]... [-o FILE] [-v]
        send requests; prints the response and test results, exits 1 on a failure
  r3q curl <file.http>[#name|#N]            print the request as a curl command
  r3q code <lang> <file.http>[#name|#N]     generate code (r3q code --list)
  r3q import curl '<curl command>' [-o FILE]
  r3q import postman|openapi|bruno <file> [--out DIR]
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
  const valued = new Set(["env", "e", "var", "o", "output", "out", "root", "org", "project", "description", "team", "timeout"]);
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

async function run(args: Args, root: string): Promise<number> {
  const spec = args.positional[0];
  if (!spec) throw new Error("r3q run <file.http>[#name]");
  const interaction = terminalInteraction();
  const session = new Session({
    root, interaction, environments: all(args, "env", "e"),
    timeoutMs: one(args, "timeout") ? Number(one(args, "timeout")) * 1000 : undefined,
    onEvent: (e) => { if (e.kind === "log" && args.flags.has("v")) process.stderr.write(`${e.text}\n`); },
  });
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
  if (!kind || !source) throw new Error("r3q import curl|postman|openapi|bruno <source>");
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
      await write(importPostman(json));
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
  }
  throw new Error(`unknown command ${command}`);
}
