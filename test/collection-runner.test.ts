/**
 * The collection features: folder defaults, tags, dry runs, data rows,
 * setup/teardown, fail-fast, reports, captures, secrets, the timeline, and the
 * collection tools, against a local server.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session, captureValue } from "../src/http/runner.ts";
import { folderDefaults } from "../src/http/folder.ts";
import { memoryBackend, secretNames, setSecret, setSecretBackend, getSecret, deleteSecret } from "../src/http/secrets.ts";
import { collect, dryRunPlan, jsonReport, junitReport, parseCsv, runSuite } from "../src/suite.ts";
import { Redactor, REDACTED, readHistory, appendHistory, toEntry } from "../src/history.ts";
import { auditCollection, createCollection, formatHttp, inspectCollection } from "../src/collection-tools.ts";
import { fuzzyFilter, fuzzyScore, keyBindings } from "../src/tui-config.ts";
import { agentTargets, installSkill, skillText, uninstallSkill } from "../src/agent.ts";
import { cli } from "../src/cli.ts";
import type { HttpResponse, Interaction } from "../src/http/types.ts";

const scratch = (name: string): string => mkdtempSync(join(process.env.CLAUDE_JOB_DIR ? join(process.env.CLAUDE_JOB_DIR, "tmp") : tmpdir(), `r3q-${name}-`));
const quiet: Interaction = { prompt: async (_m, o) => o?.default ?? "", pick: async (_m, o) => o[0], confirm: async () => true, log: () => {} };

let server: Server;
let base = "";
const seen: { method: string; path: string; headers: Record<string, string | string[] | undefined>; body: string }[] = [];

beforeAll(async () => {
  process.env.R3Q_NO_HISTORY = "";
  setSecretBackend(memoryBackend());
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const url = new URL(req.url ?? "/", "http://x");
      seen.push({ method: req.method ?? "", path: url.pathname + url.search, headers: req.headers, body });
      if (url.pathname === "/fail") { res.writeHead(500, { "content-type": "text/plain" }); res.end("nope"); return; }
      if (url.pathname === "/token") { res.writeHead(200, { "content-type": "application/json", "x-trace": "t-9" }); res.end(JSON.stringify({ access_token: "secret-token-abcdef", id: 42, nested: { items: [{ name: "first" }] } })); return; }
      res.writeHead(url.pathname === "/created" ? 201 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(() => { server.close(); setSecretBackend(undefined); });

function collection(): string {
  const root = scratch("col");
  writeFileSync(join(root, "r3q.folder.json"), JSON.stringify({ headers: { "X-Collection": "root", Accept: "application/json" }, variables: { base }, tags: ["all"] }));
  mkdirSync(join(root, "orders"));
  writeFileSync(join(root, "orders", "r3q.folder.json"), JSON.stringify({ headers: { "X-Collection": "orders" }, auth: "Bearer {{TOKEN}}", tags: ["orders"] }));
  writeFileSync(join(root, "health.http"), `# @name health\n# @tag smoke\nGET {{base}}/health\n\n?? status == 200\n`);
  writeFileSync(join(root, "orders", "orders.http"), [
    "# @name create", "# @tag smoke", "POST {{base}}/created", "Content-Type: application/json", "", '{"sku": "{{sku}}"}', "", "?? status == 201", "",
    "###", "# @name broken", "GET {{base}}/fail", "", "###", "# @name list", "GET {{base}}/orders?sku={{sku}}", "",
  ].join("\n"));
  return root;
}

test("folder defaults merge from the root down; nearer folders win", () => {
  const root = collection();
  const d = folderDefaults(root, join(root, "orders"));
  expect(d.headers).toContainEqual(["X-Collection", "orders"]);
  expect(d.headers).toContainEqual(["Accept", "application/json"]);
  expect(d.headers).toContainEqual(["Authorization", "Bearer {{TOKEN}}"]);
  expect(d.tags).toEqual(["all", "orders"]);
  expect(d.variables.map((v) => v.name)).toEqual(["base"]);
});

test("folder headers and auth reach the wire; request headers still win", async () => {
  const root = collection();
  const session = new Session({ root, interaction: quiet, secrets: false });
  const items = await collect(session, root, { targets: ["orders/orders.http#create"] });
  const r = await session.run(items[0]!.file, items[0]!.request, { overrides: { TOKEN: "t0k", sku: "A1" } });
  const echoed = JSON.parse(r.response!.text) as { headers: Record<string, string>; body: string };
  expect(echoed.headers["x-collection"]).toBe("orders");
  expect(echoed.headers.authorization).toBe("Bearer t0k");
  expect(echoed.body).toBe('{"sku": "A1"}');
});

test("selection by folder, file#name, tag and exclude-tag; dry run lists without sending", async () => {
  const root = collection();
  const session = new Session({ root, interaction: quiet, secrets: false });
  expect((await collect(session, root, { targets: [] })).map((i) => i.label)).toEqual(["health", "create", "broken", "list"]);
  expect((await collect(session, root, { targets: [], tags: ["smoke"] })).map((i) => i.label)).toEqual(["health", "create"]);
  expect((await collect(session, root, { targets: ["orders"], excludeTags: ["smoke"] })).map((i) => i.label)).toEqual(["broken", "list"]);
  expect((await collect(session, root, { targets: [], names: ["l*"] })).map((i) => i.label)).toEqual(["list"]);
  const before = seen.length;
  const plan = dryRunPlan(await collect(session, root, { targets: [], tags: ["smoke"] }));
  expect(plan.at(-1)).toContain("nothing was sent");
  expect(plan.join("\n")).toContain("health.http#health");
  expect(seen.length).toBe(before);
});

test("data rows run the suite once per row with setup and teardown around each", async () => {
  const root = collection();
  const rows = parseCsv('sku,label\nA1,"first, with comma"\nB2,"say ""hi"""\n');
  expect(rows).toEqual([{ sku: "A1", label: "first, with comma" }, { sku: "B2", label: 'say "hi"' }]);
  const session = new Session({ root, interaction: quiet, secrets: false });
  const tests = await collect(session, root, { targets: ["orders/orders.http#list"] });
  const setup = await collect(session, root, { targets: ["health.http"] });
  const before = seen.length;
  const report = await runSuite(session, tests, { data: rows, setup, teardown: setup });
  expect(report.entries.map((e) => `${e.phase}:${e.item.label}:${e.row}`)).toEqual(["setup:health:1", "test:list:1", "teardown:health:1", "setup:health:2", "test:list:2", "teardown:health:2"]);
  expect(seen.slice(before).filter((s) => s.path.startsWith("/orders")).map((s) => s.path)).toEqual(["/orders?sku=A1", "/orders?sku=B2"]);
  expect(report.failed).toBe(0);
});

test("fail-fast stops at the first failure; JUnit and JSON reports describe it", async () => {
  const root = collection();
  const session = new Session({ root, interaction: quiet, secrets: false });
  const items = await collect(session, root, { targets: ["orders/orders.http"] });
  const report = await runSuite(session, items, { failFast: true, overrides: { sku: "Z" } });
  expect(report.entries.map((e) => e.item.label)).toEqual(["create", "broken"]);
  expect(report.stopped).toContain("--fail-fast");
  const xml = junitReport(report);
  expect(xml).toContain('<testsuites name="r3q" tests="2" failures="1"');
  expect(xml).toContain('name="broken"');
  expect(xml).toContain("<failure");
  const json = jsonReport(report) as { summary: { passed: number; failed: number } };
  expect(json.summary).toMatchObject({ passed: 1, failed: 1 });
});

test("captures: run-scoped, into the private env file, and into the secret store", async () => {
  const root = scratch("cap");
  writeFileSync(join(root, "flow.http"), [
    `# @capture token = body.$.access_token`, `# @capture-env TRACE = header x-trace`, `# @capture-secret API_TOKEN = $.access_token`, `GET ${base}/token`, "",
    "###", `GET ${base}/echo?t={{token}}&first={{token}}`, "",
  ].join("\n"));
  const session = new Session({ root, interaction: quiet });
  const file = await session.load(join(root, "flow.http"));
  const results = await session.runAll(file);
  expect(JSON.parse(results[1]!.response!.text).query.t).toBe("secret-token-abcdef");
  expect(JSON.parse(readFileSync(join(root, "http-client.private.env.json"), "utf8"))).toEqual({ $shared: { TRACE: "t-9" } });
  expect(getSecret(root, "API_TOKEN")).toBe("secret-token-abcdef");
  expect(secretNames(root)).toEqual(["API_TOKEN"]);
  const res = { status: 200, text: '{"a":{"b":[1,2]}}', headers: [["X-Id", "7"]] } as unknown as HttpResponse;
  expect(captureValue(res, "status")).toBe("200");
  expect(captureValue(res, "header x-id")).toBe("7");
  expect(captureValue(res, "a.b[1]")).toBe("2");
  expect(captureValue(res, "$.missing")).toBeUndefined();
});

test("secrets from the OS store fill {{NAME}} and never touch the collection files", async () => {
  const root = scratch("sec");
  setSecret(root, "TOKEN", "from-the-keychain");
  writeFileSync(join(root, "a.http"), `GET ${base}/echo\nAuthorization: Bearer {{TOKEN}}\n`);
  const session = new Session({ root, interaction: quiet });
  const file = await session.load(join(root, "a.http"));
  const r = await session.run(file, file.requests[0]!);
  expect(JSON.parse(r.response!.text).headers.authorization).toBe("Bearer from-the-keychain");
  expect(readFileSync(join(root, ".r3q", "secrets.json"), "utf8")).not.toContain("from-the-keychain");
  expect(deleteSecret(root, "TOKEN")).toBe(true);
  expect(getSecret(root, "TOKEN")).toBeUndefined();
});

test("the timeline redacts secrets, credentials and token fields", async () => {
  const root = scratch("hist");
  const redactor = new Redactor(["super-secret-value"]);
  expect(redactor.header(["Authorization", "Bearer abc.def"])).toEqual(["Authorization", `Bearer ${REDACTED}`]);
  expect(redactor.header(["X-Note", "has super-secret-value inside"])).toEqual(["X-Note", `has ${REDACTED} inside`]);
  expect(redactor.body('{"password":"p","user":"u","deep":{"access_token":"t"}}')).toContain(`"password": "${REDACTED}"`);
  expect(redactor.body("user=a&password=hunter2")).toBe(`user=a&password=${REDACTED}`);
  writeFileSync(join(root, "a.http"), `GET ${base}/token\nAuthorization: Bearer super-secret-value\n`);
  const session = new Session({ root, interaction: quiet, secrets: false });
  const file = await session.load(join(root, "a.http"));
  const r = await session.run(file, file.requests[0]!);
  await appendHistory(root, [toEntry(root, r, redactor, "cli")!]);
  const [entry] = await readHistory(root);
  expect(entry!.status).toBe(200);
  const raw = readFileSync(join(root, ".r3q", "history.jsonl"), "utf8");
  expect(raw).not.toContain("super-secret-value");
  expect(raw).not.toContain("secret-token-abcdef");
});

test("network trace records each hop", async () => {
  const root = scratch("trace");
  writeFileSync(join(root, "a.http"), `GET ${base}/echo\n`);
  const session = new Session({ root, interaction: quiet, secrets: false });
  const file = await session.load(join(root, "a.http"));
  const r = await session.run(file, file.requests[0]!);
  expect(r.response!.hops).toHaveLength(1);
  expect(r.response!.hops![0]).toMatchObject({ method: "GET", status: 200 });
});

test("collection create, inspect, audit and format", async () => {
  const root = scratch("tools");
  const written = await createCollection(root);
  expect(written.map((w) => w.split("/").pop())).toEqual(["example.http", "http-client.env.json", "r3q.folder.json", ".gitignore"]);
  const rows = await inspectCollection(root);
  expect(rows[0]).toMatchObject({ name: "Check response", method: "GET", tags: ["smoke"] });
  expect((await auditCollection(root)).filter((f) => f.level === "error")).toEqual([]);

  writeFileSync(join(root, "bad.http"), "GET {{base}}/x?k={{undefinedThing}}\nAuthorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789\n\n< ./missing.json\n");
  const findings = await auditCollection(root);
  expect(findings.some((f) => f.message.includes("{{undefinedThing}}"))).toBe(true);
  expect(findings.some((f) => f.level === "error" && f.message.includes("GitHub token"))).toBe(true);
  expect(findings.some((f) => f.message.includes("missing.json"))).toBe(true);

  const messy = "post https://x.test/a   \r\nContent-Type:application/json\r\nX-A:  1\r\n\r\n{\"a\":1,\"b\":[1,2]}\r\n###\nGET https://x.test/b\n\n\n\n";
  expect(formatHttp(messy)).toBe('POST https://x.test/a\nContent-Type: application/json\nX-A: 1\n\n{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}\n\n###\nGET https://x.test/b\n');
  // Templated JSON that does not parse is left exactly as written.
  const templated = 'POST https://x.test\nContent-Type: application/json\n\n{"n": {{count}}}\n';
  expect(formatHttp(templated)).toBe(templated);
  expect(formatHttp(formatHttp(messy))).toBe(formatHttp(messy));
});

test("CLI: run a folder by tag with a JUnit report; dry run sends nothing", async () => {
  const root = collection();
  const out = join(root, "results.xml");
  const log = console.log;
  const lines: string[] = [];
  console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
  try {
    const before = seen.length;
    expect(await cli(["run", "--root", root, root, "--tag", "smoke", "--dry-run", "--var", "TOKEN=x"])).toBe(0);
    expect(seen.length).toBe(before);
    expect(await cli(["run", "--root", root, root, "--tag", "smoke", "--reporter", "junit", "--output", out, "--var", "TOKEN=x", "--var", "sku=Q"])).toBe(0);
    expect(readFileSync(out, "utf8")).toContain('tests="2" failures="0"');
    expect(await cli(["run", "--root", root, join(root, "orders"), "--var", "TOKEN=x", "--var", "sku=Q"])).toBe(1);
    expect(existsSync(join(root, ".r3q", "history.jsonl"))).toBe(true);
  } finally { console.log = log; }
  expect(lines.join("\n")).toContain("2 passed, 0 failed");
});

test("fuzzy search ranks word starts first; config bindings ignore unknown actions", () => {
  expect(fuzzyScore("xyz", "orders/create")).toBeUndefined();
  expect(fuzzyFilter("oc", ["docs/close", "orders/create", "zoo"], (s) => s)[0]).toBe("orders/create");
  expect([...keyBindings({ keys: { "Ctrl+R": "run", f9: "explode" } })]).toEqual([["ctrl+r", "run"]]);
});

test("agent skill installs into present agents and uninstalls only its own", async () => {
  const project = scratch("agent");
  mkdirSync(join(project, ".claude"));
  expect(agentTargets({ project }).map((t) => t.agent)).toEqual(["claude", "agents"]);
  const { installed } = await installSkill({ project });
  expect(installed).toHaveLength(2);
  expect(readFileSync(installed[0]!, "utf8")).toBe(skillText());
  expect((await installSkill({ project })).unchanged).toHaveLength(2);
  expect(await uninstallSkill({ project })).toHaveLength(2);
});

test("folder variables are defaults an environment overrides", async () => {
  const root = scratch("prec");
  writeFileSync(join(root, "r3q.folder.json"), JSON.stringify({ variables: { base, who: "folder" } }));
  writeFileSync(join(root, "http-client.env.json"), JSON.stringify({ dev: { who: "env" } }));
  writeFileSync(join(root, "a.http"), "GET {{base}}/echo?who={{who}}\n");
  for (const [envs, want] of [[[], "folder"], [["dev"], "env"]] as const) {
    const session = new Session({ root, interaction: quiet, secrets: false, environments: [...envs] });
    const file = await session.load(join(root, "a.http"));
    const r = await session.run(file, file.requests[0]!);
    expect(JSON.parse(r.response!.text).query.who).toBe(want);
  }
});
