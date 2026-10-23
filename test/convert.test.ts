import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  LANGUAGES, curlToHttp, generateCode, importBruno, importOpenApi, importPostman,
  importPostmanEnvironment, parseCurl, parseYaml, shellWords, toCurl,
} from "../src/http/convert.ts";
import type { PreparedRequest } from "../src/http/types.ts";

const FIXTURES = resolve(import.meta.dirname, "fixtures", "convert");
const fixture = (name: string) => readFileSync(resolve(FIXTURES, name), "utf8");

test("shell words: quotes, $'..', escapes and continuations", () => {
  assert.deepEqual(shellWords(`curl 'a b' "c \\"d\\"" $'e\\nf' g\\ h \\\n  -k`), ["curl", "a b", 'c "d"', "e\nf", "g h", "-k"]);
  assert.deepEqual(shellWords(`curl ^"https://x.test/^" ^\n  -H ^"accept: */*^"`), ["curl", "https://x.test/", "-H", "accept: */*"]);
  assert.deepEqual(shellWords(`a '' b`), ["a", "", "b"]);
});

test("parseCurl: multiline Chrome-style command with data", () => {
  const c = parseCurl(`curl 'https://api.test/users?x=1' \\
  -H 'Content-Type: application/json' \\
  -H 'Authorization: Bearer abc' \\
  --data-raw '{"name":"Ada"}' \\
  --compressed -L -k`);
  assert.equal(c.method, "POST");
  assert.equal(c.url, "https://api.test/users?x=1");
  assert.deepEqual(c.headers, [["Content-Type", "application/json"], ["Authorization", "Bearer abc"]]);
  assert.equal(c.body, '{"name":"Ada"}');
  assert.equal(c.compressed, true);
  assert.equal(c.followRedirects, true);
  assert.equal(c.insecure, true);
});

test("parseCurl: flags, -G, -u, -b, combined short options, @file, defaults", () => {
  const g = parseCurl(`curl -sSG https://x.test/search -d q=hello --data-urlencode 'tag=a b'`);
  assert.equal(g.method, "GET");
  assert.equal(g.url, "https://x.test/search?q=hello&tag=a%20b");
  assert.equal(g.body, undefined);

  const u = parseCurl(`curl -XPUT -u admin:pw -b 'a=1; b=2' -A agent/1 -e https://ref.test -m 5 -x http://proxy:8080 example.com/x --data @payload.json`);
  assert.equal(u.method, "PUT");
  assert.equal(u.url, "http://example.com/x");
  assert.equal(u.user, "admin:pw");
  assert.equal(u.cookies, "a=1; b=2");
  assert.equal(u.maxTime, 5);
  assert.equal(u.proxy, "http://proxy:8080");
  assert.equal(u.bodyFile, "payload.json");
  assert.ok(u.headers.some(([k, v]) => k === "User-Agent" && v === "agent/1"));
  assert.ok(u.headers.some(([k, v]) => k === "Content-Type" && v === "application/x-www-form-urlencoded"));

  const j = parseCurl(`curl --json '{"a":1}' --url=https://x.test --http2 -I`);
  assert.equal(j.url, "https://x.test");
  assert.equal(j.head, true);
  assert.equal(j.http2, true);
  assert.ok(j.headers.some(([k, v]) => k === "Content-Type" && v === "application/json"));
  assert.equal(parseCurl("curl https://x.test --unknown-flag").method, "GET");
});

test("curlToHttp: multipart -F with files and a kept comment", () => {
  const http = curlToHttp(`curl -L -F 'caption=hello' -F 'file=@photos/cat.png;type=image/png' -u bob https://up.test/upload`, true);
  const lines = http.split("\n");
  assert.match(lines[0] ?? "", /^# curl -L -F/);
  assert.ok(http.includes("POST https://up.test/upload\n"));
  assert.ok(http.includes("Authorization: Basic bob\n"));
  assert.ok(http.includes("Content-Type: multipart/form-data; boundary=WebAppBoundary\n"));
  assert.ok(http.includes('Content-Disposition: form-data; name="caption"\n\nhello\n'));
  assert.ok(http.includes('Content-Disposition: form-data; name="file"; filename="cat.png"\nContent-Type: image/png\n\n< ./photos/cat.png\n'));
  assert.ok(http.trimEnd().endsWith("--WebAppBoundary--"));
  assert.ok(!http.includes("@no-redirect"));
});

test("curlToHttp: metadata from curl switches, user:password basic auth", () => {
  const http = curlToHttp(`curl -k -m 30 -x http://p:1 -u a:b https://x.test --http2`);
  assert.equal(http, [
    "# @no-redirect", "# @no-reject-unauthorized", "# @proxy http://p:1", "# @timeout 30 s",
    "GET https://x.test HTTP/2", "Authorization: Basic a b", "",
  ].join("\n"));
});

const prepared: PreparedRequest = {
  method: "POST",
  url: "https://api.test/items?q=it's",
  headers: [["Content-Type", "application/json"], ["X-Note", "it's \"quoted\" $HOME"]],
  body: Buffer.from('{"name":"O\'Brien","line":"a\\nb"}'),
};

test("toCurl: quoting survives a shell round trip", () => {
  const command = toCurl(prepared);
  const back = parseCurl(command);
  assert.equal(back.method, "POST");
  assert.equal(back.url, prepared.url);
  assert.deepEqual(back.headers, prepared.headers);
  assert.equal(back.body, prepared.body?.toString());
  assert.match(toCurl({ method: "HEAD", url: "https://x.test", headers: [] }), /--head/);
  assert.match(toCurl({ method: "DELETE", url: "https://x.test", headers: [] }), /-X DELETE/);
});

test("toCurl: binary bodies go through base64 on stdin", () => {
  const command = toCurl({ method: "PUT", url: "https://x.test/f", headers: [], body: Buffer.from([0xff, 0x00, 0xfe]) });
  assert.match(command, /^printf '%s' \/wD\+ \| base64 -d \| curl/);
  assert.match(command, /--data-binary @-/);
});

test("generateCode: every language produces the method, URL and body", () => {
  assert.ok(LANGUAGES.length >= 20);
  for (const lang of LANGUAGES) {
    const code = generateCode(lang, prepared);
    // curl implies POST from --data-raw rather than spelling it out.
    assert.ok(lang === "curl" || code.includes("POST"), `${lang} has the method`);
    assert.ok(code.includes("api.test"), `${lang} has the host`);
    assert.ok(code.includes("Brien"), `${lang} has the body`);
  }
  assert.ok(generateCode("python-requests", prepared).includes('"X-Note": "it\'s \\"quoted\\" $HOME"'));
  assert.ok(generateCode("kotlin-okhttp", prepared).includes("\\$HOME"));
  assert.ok(generateCode("http", prepared).startsWith("POST /items?q=it%27s HTTP/1.1\r\nHost: api.test\r\n"));
  assert.throws(() => generateCode("cobol", prepared), /unknown language/);
});

test("importPostman: folders, auth inheritance, path variables, bodies and scripts", () => {
  const files = importPostman(JSON.parse(fixture("postman.json")));
  assert.deepEqual([...files.keys()].sort(), ["demo-api.http", "users.http", "users/admin.http"]);

  const root = files.get("demo-api.http") ?? "";
  assert.ok(root.startsWith("@baseUrl = https://api.example.com\n\n### Health check\n# @name health-check\nGET {{baseUrl}}/health"));
  assert.ok(!root.includes("Authorization"), "noauth overrides the collection bearer");

  const users = files.get("users.http") ?? "";
  assert.ok(users.includes("@id = 42\n"));
  assert.ok(users.includes("GET {{baseUrl}}/users/{{id}}\nAccept: application/json\nAuthorization: Bearer {{token}}"));
  assert.ok(!users.includes("X-Off"));
  assert.ok(users.includes("> {%\n// Converted from Postman"));
  assert.ok(users.includes("pm.test('ok'"));
  assert.ok(users.includes("< {%\n// Converted from Postman"));
  assert.ok(users.includes("POST {{baseUrl}}/users\nAuthorization: Basic admin s3cret\nContent-Type: application/json\n\n{\"name\": \"Ada\"}"));
  assert.ok(users.indexOf("< {%") < users.indexOf("POST {{baseUrl}}/users"), "pre-request script precedes the request line");

  const admin = files.get("users/admin.http") ?? "";
  assert.ok(admin.includes("Content-Type: multipart/form-data; boundary=WebAppBoundary"));
  assert.ok(admin.includes('name="avatar"; filename="avatar.png"\n\n< /tmp/avatar.png'));
  assert.ok(admin.includes("user=a%20b\n&pass={{pw}}"));
  assert.ok(admin.includes("Authorization: Bearer {{token}}"), "folder requests inherit the collection auth");
});

test("importPostmanEnvironment: enabled values only", () => {
  const env = importPostmanEnvironment({ name: "staging", values: [
    { key: "baseUrl", value: "https://staging.test", enabled: true },
    { key: "off", value: "x", enabled: false },
    { key: "token", value: "t" },
  ] });
  assert.deepEqual(env, { staging: { baseUrl: "https://staging.test", token: "t" } });
  assert.throws(() => importPostmanEnvironment({}), /not a Postman environment/);
});

test("parseYaml: the subset OpenAPI files use", () => {
  const doc = parseYaml(fixture("petstore.yaml")) as Record<string, any>;
  assert.equal(doc.openapi, "3.0.0");
  assert.equal(doc.info.title, "Swagger Petstore");
  assert.equal(doc.info.description, "A sample API that uses a petstore as an example.\n");
  assert.deepEqual(doc.paths["/pets"].post.tags, ["pets"]);
  assert.deepEqual(doc.paths["/pets"].post.security, [{ bearerAuth: [] }]);
  assert.equal(doc.paths["/pets"].get.responses["200"].content["application/json"].schema.$ref, "#/components/schemas/Pets");
  assert.equal(doc.components.schemas.Pet.properties.notes.description, "Free text.\nTwo lines.\n");
  assert.deepEqual(parseYaml("a: {b: [1, 'two', \"three\"], c: ~}\nd:\n- x\n- y: 1\n  z: 2\n"), { a: { b: [1, "two", "three"], c: null }, d: ["x", { y: 1, z: 2 }] });
});

test("importOpenApi: one file per tag, base URL, params, auth, example bodies", () => {
  const files = importOpenApi(fixture("petstore.yaml"));
  assert.deepEqual([...files.keys()].sort(), ["pets.http", "store.http"]);
  const pets = files.get("pets.http") ?? "";
  assert.ok(pets.startsWith("@baseUrl = https://api.petstore.example.com/v1\n\n### List all pets\n# @name listPets\nGET {{baseUrl}}/pets?limit=10\nAccept: application/json"));
  assert.ok(pets.includes("# @name createPets\nPOST {{baseUrl}}/pets\nAuthorization: Bearer {{token}}\nContent-Type: application/json\n\n{\n  \"name\": \"Rex\",\n  \"tag\": \"dog\",\n  \"notes\": \"string\"\n}"));
  assert.ok(pets.includes("@petId = 7\nGET {{baseUrl}}/pets/{{petId}}"));
  assert.ok((files.get("store.http") ?? "").includes("# @name getInventory\nGET {{baseUrl}}/store/inventory"));

  const swagger = importOpenApi({
    swagger: "2.0", host: "api.test", basePath: "/v2", schemes: ["https"],
    paths: { "/login": { post: { tags: ["auth"], operationId: "login", consumes: ["application/x-www-form-urlencoded"],
      parameters: [{ name: "user", in: "formData", type: "string", default: "me" }] } } },
  });
  assert.equal(swagger.get("auth.http"), "@baseUrl = https://api.test/v2\n\n### login\n# @name login\nPOST {{baseUrl}}/login\nContent-Type: application/x-www-form-urlencoded\n\nuser=me\n");
});

test("importBruno: meta, vars, auth, json body, scripts and asserts", () => {
  const http = importBruno(fixture("create-user.bru"));
  assert.equal(http, [
    "# Create User",
    "# @name create-user",
    "@stamp = 123",
    "< {%",
    "// Converted from Bruno: req.* / bru.* calls are kept verbatim; port them to request.* / client.*",
    'req.setHeader("X-Time", Date.now());',
    "%}",
    "POST {{baseUrl}}/users",
    "Accept: application/json",
    "Authorization: Bearer {{token}}",
    "Content-Type: application/json",
    "",
    "{",
    '  "name": "Ada"',
    "}",
    "",
    "> {%",
    "// Converted from Bruno: res.* / bru.* / test() calls are kept verbatim; port them to response.* / client.*",
    'bru.setVar("userId", res.body.id);',
    "%}",
    "",
    "?? status == 201",
    "?? body $.name == Ada",
    "?? header content-type includes json",
    "?? body $.id exists",
    "",
  ].join("\n"));
  assert.throws(() => importBruno("meta {\n  name: x\n}\n"), /no method block/);
});
