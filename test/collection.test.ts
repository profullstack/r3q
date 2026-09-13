import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { interpolate, loadCollection, parseRequest, resolveRequest } from "../src/collection.ts";
import { formatBody, statusKind } from "../src/send.ts";

const EXAMPLES = resolve(import.meta.dirname, "..", "examples");

test("parses method, url, headers and body", () => {
  const r = parseRequest(
    'POST https://x.test/things\nContent-Type: application/json\n\n{"a":1}\n',
    "x.http",
    "/x.http",
  );
  assert.equal(r.error, undefined);
  assert.equal(r.method, "POST");
  assert.equal(r.url, "https://x.test/things");
  assert.deepEqual(r.headers, { "Content-Type": "application/json" });
  assert.equal(r.body, '{"a":1}');
});

test("comments before the request line are skipped", () => {
  const r = parseRequest("# note\n// another\nGET https://x.test\n", "x.http", "/x.http");
  assert.equal(r.error, undefined);
  assert.equal(r.method, "GET");
});

test("a request with no body has no body, not an empty one", () => {
  const r = parseRequest("GET https://x.test\nAccept: */*\n\n", "x.http", "/x.http");
  assert.equal(r.body, undefined);
});

test("a bad method is carried as an error rather than thrown", () => {
  const r = parseRequest("FETCH https://x.test\n", "x.http", "/x.http");
  assert.match(r.error ?? "", /unknown method/);
});

test("a missing url is an error", () => {
  assert.match(parseRequest("GET\n", "x.http", "/x.http").error ?? "", /no URL/);
});

test("an empty file is an error, not a crash", () => {
  assert.match(parseRequest("\n\n", "x.http", "/x.http").error ?? "", /no request line/);
});

test("interpolation fills known variables and leaves unknown ones visible", () => {
  assert.equal(interpolate("Bearer {{T}}", { T: "abc" }), "Bearer abc");
  assert.equal(interpolate("Bearer {{ T }}", { T: "abc" }), "Bearer abc");
  assert.equal(interpolate("Bearer {{NOPE}}", {}), "Bearer {{NOPE}}");
});

test("resolveRequest substitutes into url, headers and body", () => {
  const r = parseRequest(
    "POST https://{{HOST}}/x\nAuthorization: Bearer {{T}}\n\n{\"h\":\"{{HOST}}\"}\n",
    "x.http",
    "/x.http",
  );
  const out = resolveRequest(r, { HOST: "api.test", T: "sekrit" });
  assert.equal(out.url, "https://api.test/x");
  assert.equal(out.headers.Authorization, "Bearer sekrit");
  assert.equal(out.body, '{"h":"api.test"}');
  // The original is untouched, so the file on disk still shows the template.
  assert.equal(r.url, "https://{{HOST}}/x");
});

test("loads the example collection, bad file included", () => {
  const found = loadCollection(EXAMPLES);
  const ids = found.map((r) => r.id).sort();
  assert.deepEqual(ids, ["broken.http", "httpbin-get.http", "httpbin-post.http", ...["delete", "get", "head", "options", "patch", "post", "put", "trace"].map((method) => `methods/${method}.http`)]);
  assert.equal(found.find((r) => r.id === "broken.http")?.error !== undefined, true);
  assert.equal(found.find((r) => r.id === "httpbin-get.http")?.method, "GET");
});

test("a missing directory yields no requests rather than throwing", () => {
  assert.deepEqual(loadCollection("/nope/not/here"), []);
});

test("json bodies are pretty-printed, others left alone", () => {
  assert.equal(formatBody('{"a":1}', "application/json"), '{\n  "a": 1\n}');
  assert.equal(formatBody("plain", "text/plain"), "plain");
  // A content-type that lies is common; do not lose the body over it.
  assert.equal(formatBody("not json", "application/json"), "not json");
});

test("status colours group by class", () => {
  assert.equal(statusKind(200), "success");
  assert.equal(statusKind(301), "accent");
  assert.equal(statusKind(404), "warning");
  assert.equal(statusKind(500), "danger");
  assert.equal(statusKind(0), "danger");
});
