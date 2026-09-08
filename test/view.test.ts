import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { renderToText } from "@profullstack/hqtui/testing";
import { createState, view } from "../src/main.ts";

const EXAMPLES = resolve(import.meta.dirname, "..", "examples");

function frame(mutate: (s: ReturnType<typeof createState>) => void = () => {}): string {
  const state = createState(EXAMPLES);
  mutate(state);
  return renderToText((args) => view(args as never, state), { width: 100, height: 30 });
}

test("the three panes draw with the example collection", () => {
  const out = frame();
  assert.match(out, /Collection/);
  assert.match(out, /Request/);
  assert.match(out, /Response/);
  assert.match(out, /httpbin-get\.http/);
  assert.match(out, /No response yet/);
});

test("the selected request's method, url and headers are shown", () => {
  const out = frame((s) => { s.selected = s.requests.findIndex((r) => r.id === "httpbin-get.http"); });
  assert.match(out, /GET/);
  assert.match(out, /httpbin\.org/);
  assert.match(out, /Accept:/);
});

test("a template is shown resolved, not raw", () => {
  const out = frame((s) => {
    s.selected = s.requests.findIndex((r) => r.id === "httpbin-post.http");
    s.vars = { TOKEN: "sekrit" };
  });
  assert.match(out, /Bearer sekrit/);
  assert.doesNotMatch(out, /\{\{TOKEN\}\}/);
});

test("a malformed request reports its error in the request pane", () => {
  const out = frame((s) => { s.selected = s.requests.findIndex((r) => r.id === "broken.http"); });
  assert.match(out, /unknown method/);
});

test("a response renders status, timing and a pretty-printed body", () => {
  const out = frame((s) => {
    s.exchange = {
      status: 200, statusText: "OK",
      headers: [["content-type", "application/json"]],
      body: '{"ok":true,"n":2}',
      ms: 42, bytes: 17, contentType: "application/json",
    };
  });
  assert.match(out, /200 OK/);
  assert.match(out, /42ms/);
  // Pretty-printed rather than one line.
  assert.match(out, /"ok": true/);
});

test("a transport failure is shown instead of an empty body", () => {
  const out = frame((s) => {
    s.exchange = {
      status: 0, statusText: "", headers: [], body: "",
      ms: 12, bytes: 0, contentType: "", error: "getaddrinfo ENOTFOUND nope.test",
    };
  });
  assert.match(out, /ENOTFOUND/);
});

test("an empty collection says so rather than rendering a blank pane", () => {
  const out = frame((s) => { s.requests = []; });
  assert.match(out, /No \.http files/);
});

test("the layout survives a narrow terminal", () => {
  const state = createState(EXAMPLES);
  const out = renderToText((args) => view(args as never, state), { width: 40, height: 20 });
  assert.ok(out.split("\n").every((l) => l.length <= 40), "no row overflows the width");
});
