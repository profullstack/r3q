/**
 * Frames for the hqtui.com apps showcase.
 *
 * The app declares its own screenshots because only it knows what a good state
 * looks like; hqtui owns the rendering and capture. Deterministic on purpose —
 * a screenshot that changes on every run is a diff nobody can review.
 */
import { createState, view } from "../src/main.ts";
import type { Exchange } from "../src/send.ts";
import { resolve } from "node:path";

const EXAMPLES = resolve(import.meta.dirname, "..", "examples");

const RESPONSE: Exchange = {
  status: 200,
  statusText: "OK",
  headers: [
    ["content-type", "application/json"],
    ["server", "gunicorn/19.9.0"],
    ["date", "Mon, 08 Sep 2026 13:55:00 GMT"],
    ["access-control-allow-origin", "*"],
  ],
  body: JSON.stringify({
    args: { hello: "world" },
    headers: { Accept: "application/json", Host: "httpbin.org" },
    count: 42,
    active: true,
    next: null,
    origin: "203.0.113.7",
    url: "https://httpbin.org/get?hello=world",
  }),
  ms: 214.7,
  bytes: 268,
  contentType: "application/json",
};

export const frames = [
  {
    name: "r3q",
    width: 132,
    height: 34,
    draw: (args: { ui: unknown; theme: unknown; height: number }) => {
      const state = createState(EXAMPLES);
      state.selected = Math.max(0, state.requests.findIndex((r) => r.id === "httpbin-post.http"));
      state.vars = { TOKEN: "sk-live-3f9a2c" };
      state.exchange = RESPONSE;
      view(args as never, state);
    },
  },
];
