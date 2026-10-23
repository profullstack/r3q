/**
 * One test per http-files.org/spec page, against a local echo server.
 * Each example is the spec's own, with the host swapped for the server.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { parseHttpFile } from "../src/http/parse.ts";
import { Session, encodeUrl, graphqlEnvelope } from "../src/http/runner.ts";
import { formatDate, offsetDate } from "../src/http/dynamic.ts";
import { jsonPath, xpathText } from "../src/http/query.ts";
import type { Interaction } from "../src/http/types.ts";

let server: Server;
let base = "";
const dir = mkdtempSync(join(process.env.CLAUDE_JOB_DIR ? join(process.env.CLAUDE_JOB_DIR, "tmp") : tmpdir(), "r3q-spec-"));

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname === "/redirect") { res.writeHead(302, { location: "/echo?from=redirect" }); res.end(); return; }
      if (url.pathname === "/login") {
        res.writeHead(200, { "content-type": "application/json", "set-cookie": "sid=abc; Path=/", "x-request-id": "r-1" });
        res.end(JSON.stringify({ token: "tok-123", user: { id: 7, roles: ["a", "b"] } }));
        return;
      }
      if (url.pathname === "/xml") { res.writeHead(200, { "content-type": "application/xml" }); res.end("<root><user id=\"9\"><name>Ann</name></user></root>"); return; }
      if (url.pathname === "/gzip") { res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" }); res.end(gzipSync("compressed!")); return; }
      if (url.pathname === "/digest") {
        if (!req.headers.authorization?.startsWith("Digest ")) {
          res.writeHead(401, { "www-authenticate": 'Digest realm="r", nonce="n1", qop="auth", algorithm=MD5' });
          res.end();
          return;
        }
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body: body.toString("utf8"), bytes: body.length }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});
afterAll(() => server.close());

const answers: string[] = [];
const interaction: Interaction = {
  prompt: async () => answers.shift(),
  pick: async (_m, options) => options[1],
  confirm: async () => true,
  log: () => {},
};

async function run(source: string, name?: string, opts: { env?: string[]; files?: Record<string, string> } = {}) {
  for (const [path, content] of Object.entries(opts.files ?? {})) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  const path = join(dir, `t${Math.random().toString(36).slice(2)}.http`);
  writeFileSync(path, source.replaceAll("BASE", base));
  const session = new Session({ root: dir, interaction, environments: opts.env });
  const file = await session.load(path);
  if (name === "*") return { session, file, results: await session.runAll(file) };
  const request = name ? file.requests.find((r) => r.name === name)! : file.requests[file.requests.length - 1]!;
  const result = await session.run(file, request);
  if (result.error) throw new Error(result.error);
  let echo: Record<string, any> | undefined;
  try { echo = result.response ? JSON.parse(result.response.text) : undefined; } catch { /* not the echo endpoint */ }
  return { session, file, result, echo };
}

// ---- basics, requests, separators ----

test("basics: several requests per file, ### separators and titles", () => {
  const f = parseHttpFile("GET https://a.test/users/1\n\n###\n\nPOST https://a.test/users\nContent-Type: application/json\n\n{\"name\": \"New User\"}\n\n### Delete it\n\nDELETE https://a.test/users/2\n");
  expect(f.requests.map((r) => r.method)).toEqual(["GET", "POST", "DELETE"]);
  expect(f.requests[2]!.title).toBe("Delete it");
  expect(f.requests[1]!.body).toEqual([{ kind: "text", text: '{"name": "New User"}' }]);
});

test("requests: method defaults to GET, HTTP version, multi-line URL and query lines", () => {
  const f = parseHttpFile("https://example.com/x\n###\nGET https://example.com/api\n  /users\n  ?page=2\n  &limit=10\n###\nPOST https://e.com/a HTTP/2\n");
  expect(f.requests[0]!.method).toBe("GET");
  expect(f.requests[1]!.url).toBe("https://example.com/api/users?page=2&limit=10");
  expect(f.requests[2]!.httpVersion).toBe("HTTP/2");
});

test("requests: WebDAV and httpyac methods parse", () => {
  for (const m of ["PROPFIND", "MKCOL", "LOCK", "REPORT", "VERSION-CONTROL"]) expect(parseHttpFile(`${m} https://a.test/x`).requests[0]?.method).toBe(m);
});

test("requests: multi-line header values and spread headers", async () => {
  const { echo } = await run("@common = {\"X-A\": \"1\", \"X-B\": \"2\"}\nGET BASE/echo\nX-Long: one\n  two\n...common\n");
  expect(echo!.headers["x-long"]).toBe("one two");
  expect(echo!.headers["x-a"]).toBe("1");
  expect(echo!.headers["x-b"]).toBe("2");
});

test("requests: multi-line urlencoded forms join", async () => {
  const { echo } = await run("POST BASE/login-form\nContent-Type: application/x-www-form-urlencoded\n\nusername=admin\n&password=secret\n&remember=true\n");
  expect(echo!.body).toBe("username=admin&password=secret&remember=true");
});

test("separators: comments, block comments and metadata", () => {
  const f = parseHttpFile("# c\n// c\n/* block\n comment */\n# @name myRequest\n# @no-redirect\nGET https://a.test\n");
  expect(f.requests[0]!.name).toBe("myRequest");
  expect(f.requests[0]!.metadata.has("no-redirect")).toBe(true);
  expect(f.errors).toEqual([]);
});

test("encoding: non-ASCII URLs are percent-encoded once", () => {
  expect(encodeUrl("https://a.test/ünï?q=a b&x=%20")).toBe("https://a.test/%C3%BCn%C3%AF?q=a%20b&x=%20");
});

// ---- variables ----

test("variables: file variables reference each other; eager vs lazy", async () => {
  const { echo } = await run("@host = BASE\n@path = echo\n@url = {{host}}/{{path}}\n@eager = {{$randomInt 0 1000000}}\n@lazy := {{$randomInt 0 1000000}}\nGET {{url}}?e1={{eager}}&e2={{eager}}&l1={{lazy}}&l2={{lazy}}\n");
  expect(echo!.path).toBe("/echo");
  expect(echo!.query.e1).toBe(echo!.query.e2);
});

test("variables: {{%name}} percent-encodes", async () => {
  const { echo } = await run("@q = a b&c\nGET BASE/echo?q={{%q}}\n");
  expect(echo!.query.q).toBe("a b&c");
});

test("variables: VS Code request variables (JSONPath, headers, request body)", async () => {
  const src = "# @name login\nPOST BASE/login\nContent-Type: application/json\n\n{\"u\": \"admin\"}\n\n###\nGET BASE/echo?t={{login.response.body.$.token}}&id={{login.response.body.$.user.id}}&h={{login.response.headers.X-Request-Id}}&u={{login.request.body.$.u}}\n";
  const { echo } = await run(src);
  expect(echo!.query).toEqual({ t: "tok-123", id: "7", h: "r-1", u: "admin" });
});

test("variables: httpyac @ref and {{login.token}}", async () => {
  const { echo } = await run("# @name login\nPOST BASE/login\n\n###\n# @ref login\nGET BASE/echo?t={{login.token}}&r={{login.user.roles[1]}}\n");
  expect(echo!.query).toEqual({ t: "tok-123", r: "b" });
});

test("variables: XPath into an XML response", async () => {
  const { echo } = await run("# @name x\nGET BASE/xml\n\n###\nGET BASE/echo?n={{x.response.body.//user/name}}&id={{x.response.body.//user/@id}}\n");
  expect(echo!.query).toEqual({ n: "Ann", id: "9" });
});

test("variables: httpyac JavaScript expressions", async () => {
  const { echo } = await run("@n = 4\nGET BASE/echo?v={{ n * 2 }}&s={{ ['a','b'].join('-') }}\n");
  expect(echo!.query).toEqual({ v: "8", s: "a-b" });
});

// ---- dynamic variables ----

test("dynamic variables: VS Code, JetBrains and httpyac forms", async () => {
  const { echo } = await run("GET BASE/echo?g={{$guid}}&u={{$uuid}}&ru={{$random.uuid}}&ri={{$randomInt 5 6}}&ji={{$random.integer(3, 4)}}&ts={{$timestamp}}&iso={{$isoTimestamp}}&dt={{$datetime \"YYYY\"}}&ld={{$localDatetime iso8601}}&al={{$random.alphabetic(5)}}&hx={{$random.hexadecimal(4)}}&em={{$random.email}}&fn={{$random.name.firstName}}&pe={{$processEnv HOME}}&ev={{$env.HOME}}\n");
  const q = echo!.query;
  expect(q.g).toMatch(/^[0-9a-f-]{36}$/);
  expect(q.ri).toBe("5");
  expect(q.ji).toBe("3");
  expect(Number(q.ts)).toBeGreaterThan(1.7e9);
  expect(q.dt).toBe(String(new Date().getUTCFullYear()));
  expect(q.al).toMatch(/^[A-Za-z]{5}$/);
  expect(q.hx).toMatch(/^[0-9a-f]{4}$/);
  expect(q.em).toContain("@");
  expect(q.pe).toBe(process.env.HOME!);
  expect(q.ev).toBe(process.env.HOME!);
});

test("dynamic variables: offsets and Day.js formats", () => {
  const d = new Date(Date.UTC(2024, 0, 31, 12));
  expect(formatDate(offsetDate(d, ["-1", "d"]), "YYYY-MM-DD", true)).toBe("2024-01-30");
  expect(formatDate(offsetDate(d, ["1", "M"]), "DD/MM/YYYY", true)).toBe("02/03/2024");
  expect(formatDate(d, "rfc1123", true)).toBe("Wed, 31 Jan 2024 12:00:00 GMT");
  expect(formatDate(d, "[Day] ddd HH:mm", true)).toBe("Day Wed 12:00");
});

test("dynamic variables: $input, $pick and $input-askonce", async () => {
  answers.push("typed", "once");
  const { echo } = await run("GET BASE/echo?i={{$input Name $value: x}}&p={{$pick Env $value: dev,prod}}&a={{$input-askonce Token}}&b={{$input-askonce Token}}\n");
  expect(echo!.query).toEqual({ i: "typed", p: "prod", a: "once", b: "once" });
});

test("dynamic variables: $dotenv", async () => {
  writeFileSync(join(dir, ".env"), "DOTENV_ONLY=from-dotenv\n");
  const { echo } = await run("GET BASE/echo?d={{$dotenv DOTENV_ONLY}}&plain={{DOTENV_ONLY}}\n");
  expect(echo!.query).toEqual({ d: "from-dotenv", plain: "from-dotenv" });
});

// ---- environments ----

test("environments: JetBrains public + private, VS Code $shared, httpyac .env.<name>", async () => {
  writeFileSync(join(dir, "http-client.env.json"), JSON.stringify({ dev: { host: "public", user: "u1", nested: { deep: "yes" } }, prod: { host: "prod" } }));
  writeFileSync(join(dir, "http-client.private.env.json"), JSON.stringify({ dev: { user: "private-user" } }));
  mkdirSync(join(dir, ".vscode"), { recursive: true });
  writeFileSync(join(dir, ".vscode", "settings.json"), '{\n // comment\n "rest-client.environmentVariables": { "$shared": { "version": "v1", "prodToken": "foo" }, "dev": { "token": "{{$shared prodToken}}" } },\n}');
  writeFileSync(join(dir, ".env.dev"), "FROM_ENV_FILE=dev-file\n");
  const { echo, session } = await run("GET BASE/echo?h={{host}}&u={{user}}&v={{version}}&t={{token}}&f={{FROM_ENV_FILE}}&n={{nested.deep}}\n", undefined, { env: ["dev"] });
  expect(echo!.query).toEqual({ h: "public", u: "private-user", v: "v1", t: "foo", f: "dev-file", n: "yes" });
  expect(await session.environmentNames()).toEqual(["dev", "prod"]);
});

// ---- metadata ----

test("metadata: @no-redirect, @timeout, @note, @disabled, @sleep", async () => {
  const { result } = await run("# @no-redirect\nGET BASE/redirect\n");
  expect(result!.response!.status).toBe(302);
  const followed = await run("GET BASE/redirect\n");
  expect(followed.echo!.query.from).toBe("redirect");
  const all = await run("# @disabled\nGET BASE/echo?a=1\n###\n# @sleep 10\nGET BASE/echo?b=2\n", "*");
  expect(all.results!.map((r) => r.skipped ?? r.response?.status)).toEqual(["@disabled", 200]);
});

test("metadata: @prompt and @secret fill variables", async () => {
  answers.push("alice", "pw");
  const { echo } = await run("# @prompt username Your name\n# @secret password\nGET BASE/echo?u={{username}}&p={{password}}\n");
  expect(echo!.query).toEqual({ u: "alice", p: "pw" });
});

test("metadata: @loop for N and for x of list", async () => {
  const { result } = await run("@items = [\"a\",\"b\",\"c\"]\n# @loop for item of items\nGET BASE/echo?i={{item}}&n={{$index}}\n");
  expect(result!.iterations!.map((r) => JSON.parse(r.response!.text).query.i)).toEqual(["a", "b", "c"]);
  const n = await run("# @loop for 2\nGET BASE/echo?n={{$index}}\n");
  expect(n.result!.iterations!.length).toBe(2);
});

test("metadata: kulala @env-json-key and @jq", async () => {
  const { session } = await run("# @name l\n# @env-json-key TOKEN token\nPOST BASE/login\n");
  expect(session.globals.get("TOKEN")).toBe("tok-123");
  const jq = await run("# @jq .user.id\nPOST BASE/login\n");
  expect(jq.result!.response!.text.trim()).toBe("7");
});

// ---- auth ----

test("auth: Basic with user and password is base64-encoded", async () => {
  const { echo } = await run("GET BASE/echo\nAuthorization: Basic admin secret\n");
  expect(echo!.headers.authorization).toBe(`Basic ${Buffer.from("admin:secret").toString("base64")}`);
});

test("auth: Digest answers the challenge", async () => {
  const { echo } = await run("GET BASE/digest\nAuthorization: Digest user pass\n");
  expect(echo!.headers.authorization).toMatch(/^Digest username="user"/);
});

// ---- cookies ----

test("cookies: Set-Cookie is sent back; @no-cookie-jar opts out", async () => {
  const { results } = await run("POST BASE/login\n###\nGET BASE/echo\n", "*");
  expect(JSON.parse(results![1]!.response!.text).headers.cookie).toBe("sid=abc");
  const none = await run("POST BASE/login\n###\n# @no-cookie-jar\nGET BASE/echo\n", "*");
  expect(JSON.parse(none.results![1]!.response!.text).headers.cookie).toBeUndefined();
});

// ---- curl ----

test("curl: a pasted curl command runs", async () => {
  const { echo } = await run(`curl -X POST BASE/echo -H 'X-From: curl' -d 'a=1'\n`);
  expect(echo!.method).toBe("POST");
  expect(echo!.headers["x-from"]).toBe("curl");
  expect(echo!.body).toBe("a=1");
});

// ---- file operations ----

test("file operations: < file, <@ substitution, multipart, >> and >>!", async () => {
  const files = { "payload.json": '{"v": "{{name}}"}', "plain.txt": "{{keep}}", "doc.bin": "\x00\x01binary" };
  const { echo } = await run("@name = sub\nPOST BASE/echo\nContent-Type: application/json\n\n<@ ./payload.json\n", undefined, { files });
  expect(echo!.body).toBe('{"v": "sub"}');
  const mp = await run("POST BASE/echo\nContent-Type: multipart/form-data; boundary=----FormBoundary\n\n------FormBoundary\nContent-Disposition: form-data; name=\"field1\"\n\nvalue1\n------FormBoundary\nContent-Disposition: form-data; name=\"file\"; filename=\"doc.bin\"\nContent-Type: application/octet-stream\n\n< ./doc.bin\n------FormBoundary--\n", undefined, { files });
  expect(mp.echo!.body).toContain('name="field1"\r\n\r\nvalue1\r\n');
  expect(mp.echo!.body).toContain("\x00\x01binary\r\n------FormBoundary--");
  const saved = await run("GET BASE/echo\n\n>> ./responses/out.json\n");
  const again = await run("GET BASE/echo\n\n>> ./responses/out.json\n");
  expect(saved.result!.savedTo).toEndWith("out.json");
  expect(again.result!.savedTo).toEndWith("out-1.json");
  const over = await run("GET BASE/echo?o=1\n\n>>! ./responses/out.json\n");
  expect(over.result!.savedTo).toEndWith("out.json");
  expect(JSON.parse(readFileSync(join(dir, "responses/out.json"), "utf8")).query.o).toBe("1");
});

test("file operations: <> compares with a saved response", async () => {
  writeFileSync(join(dir, "expected.json"), JSON.stringify({ token: "tok-123", user: { roles: ["a", "b"], id: 7 } }));
  const { result } = await run("POST BASE/login\n\n<> ./expected.json\n");
  expect(result!.comparison!.equal).toBe(true);
});

test("file operations: JetBrains import and run", async () => {
  writeFileSync(join(dir, "auth-requests.http"), `### loginRequest\nPOST ${base}/login\n`);
  const { results } = await run("import ./auth-requests.http\n\nrun ./auth-requests.http#loginRequest\n\n###\nGET BASE/echo?t={{loginRequest.token}}\n", "*");
  expect(results!.length).toBe(2);
  expect(JSON.parse(results![1]!.response!.text).query.t).toBe("tok-123");
});

// ---- GraphQL ----

test("graphql: VS Code header, JetBrains GRAPHQL method, httpyac gql file", async () => {
  const q = "query ($id: ID!) {\n  user(id: $id) { name email }\n}\n\n{\"id\": \"123\"}";
  const vs = await run(`POST BASE/graphql\nContent-Type: application/json\nX-REQUEST-TYPE: GraphQL\n\n${q}\n`);
  expect(JSON.parse(vs.echo!.body)).toEqual({ query: "query ($id: ID!) {\n  user(id: $id) { name email }\n}", variables: { id: "123" } });
  expect(vs.echo!.headers["x-request-type"]).toBeUndefined();
  const jb = await run(`GRAPHQL BASE/graphql\n\n${q}\n`);
  expect(jb.echo!.method).toBe("POST");
  expect(JSON.parse(jb.echo!.body).variables).toEqual({ id: "123" });
  const yac = await run("POST BASE/graphql\nContent-Type: application/json\n\ngql MyQuery < ./query.gql\n\n{\"variable\": \"value\"}\n", undefined, { files: { "query.gql": "query MyQuery { me { id } }" } });
  expect(JSON.parse(yac.echo!.body)).toEqual({ query: "query MyQuery { me { id } }", operationName: "MyQuery", variables: { variable: "value" } });
  expect(graphqlEnvelope("{ me { id } }")).toBe('{"query":"{ me { id } }"}');
});

// ---- scripts ----

test("pre-request scripts: JetBrains request.variables and httpyac exports", async () => {
  const jb = await run('< {%\nrequest.variables.set("ts", "123");\n%}\nPOST BASE/signed\nX-Timestamp: {{ts}}\n');
  expect(jb.echo!.headers["x-timestamp"]).toBe("123");
  const yac = await run("{{\nconst crypto = require('crypto');\nexports.signature = crypto.createHmac('sha256', 'secret').update('x').digest('base64');\n}}\nGET BASE/resource\nX-Signature: {{signature}}\n");
  expect(yac.echo!.headers["x-signature"]).toBe(require("node:crypto").createHmac("sha256", "secret").update("x").digest("base64"));
});

test("pre-request scripts: JetBrains crypto API", async () => {
  const { echo } = await run('< {%\nrequest.variables.set("h", crypto.hmac.sha256().withTextSecret("k").updateWithText("m").digest().toHex());\n%}\nGET BASE/echo?h={{h}}\n');
  expect(echo!.query.h).toBe(require("node:crypto").createHmac("sha256", "k").update("m").digest("hex"));
});

test("response handlers: client.test, client.global.set, response API", async () => {
  const { result, session } = await run('POST BASE/login\n\n> {%\nclient.test("Status is 200", function() {\n  client.assert(response.status === 200);\n});\nclient.test("fails", function() { client.assert(false, "nope"); });\nclient.global.set("auth_token", response.body.token);\nclient.global.headers.set("X-Global", "g");\n%}\n');
  expect(result!.tests.map((t) => [t.name, t.passed])).toEqual([["Status is 200", true], ["fails", false]]);
  expect(session.globals.get("auth_token")).toBe("tok-123");
});

test("response handlers: client.global flows into the next request", async () => {
  const { results } = await run('POST BASE/login\n\n> {%\nclient.global.set("auth_token", response.body.token);\n%}\n\n###\nGET BASE/protected\nAuthorization: Bearer {{auth_token}}\n', "*");
  expect(JSON.parse(results![1]!.response!.text).headers.authorization).toBe("Bearer tok-123");
});

test("response handlers: external handler file", async () => {
  const { result } = await run("POST BASE/login\n\n> ./handler.js\n", undefined, { files: { "handler.js": 'client.test("from file", () => client.assert(response.headers.valueOf("X-Request-Id") === "r-1"));' } });
  expect(result!.tests).toEqual([{ name: "from file", passed: true }]);
});

test("response handlers: httpyac native script with test helpers", async () => {
  const { result } = await run("POST BASE/login\n\n{{\nconst { equal } = require('assert');\ntest('status is 200', () => { equal(response.statusCode, 200); });\ntest.status(200);\ntest.header('content-type', 'application/json');\n}}\n");
  expect(result!.tests.every((t) => t.passed)).toBe(true);
  expect(result!.tests.length).toBe(3);
});

test("response handlers: httpyac ?? assertions", async () => {
  const { result } = await run("POST BASE/login\n\n?? status == 200\n?? header content-type includes json\n?? duration < 5000\n?? body $.user.roles[0] == a\n?? body $.token exists\n?? js response.parsedBody.user.id > 5\n?? js response.parsedBody.user.id > 50\n");
  expect(result!.tests.map((t) => t.passed)).toEqual([true, true, true, true, true, true, false]);
});

test("response handlers: global {{+after}} scripts run for every request", async () => {
  const { results } = await run("{{+after\ntest('ok', () => { if (response.statusCode !== 200) throw new Error('bad'); });\n}}\n###\nGET BASE/echo\n###\nGET BASE/echo\n", "*");
  expect(results!.map((r) => r.tests.length)).toEqual([1, 1]);
});

// ---- transport ----

test("transport: gzip is decoded and TRACE/WebDAV methods are sent", async () => {
  const gz = await run("GET BASE/gzip\n");
  expect(gz.result!.response!.text).toBe("compressed!");
  const prop = await run("PROPFIND BASE/dav\nDepth: 1\n");
  expect(prop.echo!.method).toBe("PROPFIND");
  expect(gunzipSync(gzipSync("x")).toString()).toBe("x");
});

test("proxy: @proxy routes plain HTTP through an HTTP proxy", async () => {
  const seen: string[] = [];
  const proxy = createServer((req, res) => { seen.push(req.url ?? ""); res.writeHead(200, { "content-type": "text/plain" }); res.end("via proxy"); });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  const port = (proxy.address() as { port: number }).port;
  const { result } = await run(`# @proxy http://127.0.0.1:${port}\nGET http://example.invalid/x\n`);
  proxy.close();
  expect(result!.response!.text).toBe("via proxy");
  expect(seen).toEqual(["http://example.invalid/x"]);
});

// ---- query helpers ----

test("JSONPath and XPath helpers", () => {
  const data = { users: [{ name: "John", age: 30 }, { name: "Ann", age: 20 }] };
  expect(jsonPath(data, "$.users[*].name")).toEqual(["John", "Ann"]);
  expect(jsonPath(data, "$.users[?(@.age > 25)].name")).toEqual(["John"]);
  expect(jsonPath(data, "$..age")).toEqual([30, 20]);
  expect(jsonPath(data, "$.users[-1].name")).toEqual(["Ann"]);
  expect(xpathText("<a><b x='1'>t</b><b x='2'>u</b></a>", "/a/b[@x='2']")).toBe("u");
  expect(existsSync(dir)).toBe(true);
});
