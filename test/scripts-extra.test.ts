import { describe, expect as bunExpect, test } from "bun:test";
import { validateSchema } from "../src/http/schema.ts";
import { makeHelpers } from "../src/http/helpers.ts";
import { expect as r3qExpect, runScript, type ScriptRun } from "../src/http/scripts.ts";
import type { HttpResponse, Script } from "../src/http/types.ts";

const response = (body: unknown, status = 200): HttpResponse => {
  const text = JSON.stringify(body);
  return { status, statusText: "OK", httpVersion: "HTTP/1.1", headers: [["Content-Type", "application/json"]], body: Buffer.from(text), text, contentType: "application/json", duration: 12, url: "http://x.test/", redirects: [] };
};

const run = (extra: Partial<ScriptRun> = {}): ScriptRun => ({
  session: { globals: new Map(), globalHeaders: new Map() },
  variables: new Map(), scope: {}, baseDir: process.cwd(), environment: {},
  raw: { method: "GET", url: "http://x.test/", headers: [] },
  log: () => {}, ...extra,
});

const script = (code: string, dialect: Script["dialect"] = "jetbrains"): Script => ({ dialect, code, line: 1 });

describe("validateSchema", () => {
  const schema = {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    required: ["id", "name"],
    properties: {
      id: { type: "integer", minimum: 1 },
      name: { type: "string", minLength: 1, maxLength: 5 },
      email: { type: "string", format: "email" },
      tags: { type: "array", items: { type: "string" }, uniqueItems: true },
      kind: { enum: ["a", "b"] },
      child: { $ref: "#/definitions/node" },
    },
    additionalProperties: false,
    definitions: { node: { type: "object", properties: { next: { $ref: "#/definitions/node" }, v: { type: "number" } } } },
  };

  test("accepts a valid document", () => {
    bunExpect(validateSchema({ id: 1, name: "ab", email: "a@b.co", tags: ["x"], kind: "a", child: { v: 1, next: { v: 2 } } }, schema)).toEqual({ valid: true, errors: [] });
  });

  test("reports each problem with a JSON pointer", () => {
    const r = validateSchema({ id: 0, name: "toolong", email: "nope", tags: ["x", "x"], kind: "c", extra: 1, child: { next: { v: "s" } } }, schema);
    bunExpect(r.valid).toBe(false);
    const paths = r.errors.map((e) => e.path);
    for (const p of ["/id", "/name", "/email", "/tags", "/kind", "/extra", "/child/next/v"]) bunExpect(paths).toContain(p);
    bunExpect(validateSchema({ name: "a" }, schema).errors[0]!.message).toContain('"id"');
  });

  test("combinators, conditionals, tuples and boolean schemas", () => {
    bunExpect(validateSchema(5, { oneOf: [{ type: "integer" }, { type: "number" }] }).valid).toBe(false);
    bunExpect(validateSchema("x", { anyOf: [{ type: "integer" }, { type: "string" }] }).valid).toBe(true);
    bunExpect(validateSchema(3, { not: { type: "integer" } }).valid).toBe(false);
    bunExpect(validateSchema({ a: 1 }, { if: { required: ["a"] }, then: { required: ["b"] } }).valid).toBe(false);
    bunExpect(validateSchema([1, "a", true], { items: [{ type: "integer" }, { type: "string" }], additionalItems: false }).valid).toBe(false);
    bunExpect(validateSchema([1, 2], { contains: { const: 2 } }).valid).toBe(true);
    bunExpect(validateSchema(1, false).valid).toBe(false);
    bunExpect(validateSchema({ a: 1 }, { dependencies: { a: ["b"] } }).valid).toBe(false);
    bunExpect(validateSchema({ Ab: 1 }, { propertyNames: { pattern: "^[a-z]+$" } }).valid).toBe(false);
    bunExpect(validateSchema(10, { exclusiveMaximum: 10 }).valid).toBe(false);
    bunExpect(validateSchema(0.3, { multipleOf: 0.1 }).valid).toBe(true);
    bunExpect(validateSchema("😀😀", { maxLength: 2 }).valid).toBe(true);
    bunExpect(validateSchema({ "a/b": 1 }, { properties: { "a/b": { $ref: "#/definitions/x~1y" } }, definitions: { "x/y": { type: "string" } } }).valid).toBe(false);
    bunExpect(validateSchema("2026-02-30", { format: "date" }).valid).toBe(false);
    bunExpect(validateSchema("::1", { format: "ipv6" }).valid).toBe(true);
  });
});

describe("makeHelpers", () => {
  test("seeded random repeats", () => {
    const a = makeHelpers({ seed: 42 });
    const b = makeHelpers({ seed: 42 });
    const seq = (h: ReturnType<typeof makeHelpers>) => [h.random.int(1, 6), h.random.float(), h.random.string(8), h.random.uuid(), h.random.pick(["x", "y", "z"])];
    bunExpect(seq(a)).toEqual(seq(b));
    bunExpect(a.random.uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    for (let i = 0; i < 200; i++) { const n = a.random.int(3, 5); bunExpect(n >= 3 && n <= 5).toBe(true); }
  });

  test("date arithmetic and formatting", () => {
    const h = makeHelpers({ now: () => new Date("2026-01-31T00:00:00Z") });
    bunExpect(h.date.iso(h.date.add(h.date.now(), 1, "day"))).toBe("2026-02-01T00:00:00.000Z");
    bunExpect(h.date.iso(h.date.subtract("2026-03-01T00:00:00Z", 2, "h"))).toBe("2026-02-28T22:00:00.000Z");
    bunExpect(h.date.format("2026-05-04T03:02:01Z", "YYYY-MM-DD HH:mm", true)).toBe("2026-05-04 03:02");
    bunExpect(h.date.diff("2026-01-03", "2026-01-01", "days")).toBe(2);
    bunExpect(h.date.unix()).toBe(1769817600);
  });

  test("crypto", () => {
    const h = makeHelpers();
    bunExpect(h.crypto.sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    bunExpect(h.crypto.hmac("sha256", "key", "msg", "base64")).toBe("LZPLwb4We8sWN6SiPL/wGnh48MUO6DOVTqUiG7G4xig=");
    bunExpect(h.crypto.base64Decode(h.crypto.base64("héllo"))).toBe("héllo");
  });
});

describe("expect", () => {
  test("passes and fails readably, with not", () => {
    r3qExpect({ a: [1, 2] }).to.eql({ a: [1, 2] } as never);
    (r3qExpect("abc") as any).to.be.a("string").and.include("b");
    (r3qExpect([1, 2, 3]) as any).to.have.length(3).and.not.include(4);
    (r3qExpect(5) as any).toBeGreaterThan(4);
    (r3qExpect(null) as any).to.be.null;
    (r3qExpect({ status: 201 }) as any).to.have.status(201);
    (r3qExpect({ id: 1 }) as any).toMatchSchema({ type: "object", required: ["id"] });
    bunExpect(() => (r3qExpect(1) as any).to.equal(2)).toThrow("expected 1 to equal 2");
    bunExpect(() => (r3qExpect(1) as any).not.to.equal(1)).toThrow("expected 1 not to equal 1");
    bunExpect(() => (r3qExpect({}) as any).toMatchSchema({ required: ["id"] })).toThrow('/: missing required property "id"');
    bunExpect(() => (r3qExpect(undefined) as any).to.exist).toThrow("to exist");
  });
});

describe("scripts get expect, test, validateSchema and r3q", () => {
  test("jetbrains: top-level test with expect, async tests awaited in order", async () => {
    const out = await runScript(script(`
      test("status", () => expect(response.status).to.equal(200));
      test("schema", () => expect(response.body).toMatchSchema({ type: "object", required: ["id"] }));
      client.test("async fails", async () => { await new Promise((r) => setTimeout(r, 5)); expect(response.body.id).to.equal(2); });
      test("validateSchema global", () => client.assert(validateSchema(1, { type: "integer" }).valid));
      test("helpers", () => expect(r3q.random.int(1, 1)).to.equal(1));
    `), run({ response: response({ id: 1 }) }));
    bunExpect(out.tests.map((t) => [t.name, t.passed])).toEqual([["status", true], ["schema", true], ["async fails", false], ["validateSchema global", true], ["helpers", true]]);
    bunExpect(out.tests[2]!.message).toBe("expected 1 to equal 2");
  });

  test("httpyac: async test and r3q.send", async () => {
    const calls: string[] = [];
    const out = await runScript(script(`
      test("send", async () => {
        const res = await r3q.send("other.http#login", { user: "a" });
        expect(res.status).to.equal(204);
      });
    `, "httpyac"), run({ response: response({}), runRequest: async (spec, vars) => { calls.push(`${spec} ${vars?.user}`); return { status: 204, headers: {}, body: "", text: "" }; } }));
    bunExpect(out.tests).toEqual([{ name: "send", passed: true }]);
    bunExpect(calls).toEqual(["other.http#login a"]);
  });

  test("r3q.send without a runner fails the test", async () => {
    const out = await runScript(script(`test("x", () => r3q.send("a.http"));`), run());
    bunExpect(out.tests[0]).toEqual({ name: "x", passed: false, message: "r3q.send is not available here" });
  });

  test("client.exit inside a test still exits", async () => {
    const out = await runScript(script(`client.test("t", () => client.exit()); client.test("never", () => {});`), run());
    bunExpect(out).toEqual({ tests: [], exited: true });
  });
});
