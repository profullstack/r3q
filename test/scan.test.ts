import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCAN_LIMITS, scanCollection } from "../src/collection.ts";
import { scanNote } from "../src/main.ts";

const REQUEST = "GET https://example.test/x\n";

test("the scan stops at the depth limit and says so", () => {
  const root = mkdtempSync(join(tmpdir(), "r3q-deep-"));
  let dir = root;
  for (let i = 1; i <= 12; i++) {
    dir = join(dir, `d${i}`);
    mkdirSync(dir);
    if (i === 2 || i === 11) writeFileSync(join(dir, `at-${i}.http`), REQUEST);
  }
  const scan = scanCollection(root);
  assert.deepEqual(scan.requests.map((r) => r.id), ["d1/d2/at-2.http"]);
  assert.equal(scan.truncated, true);
  assert.match(scanNote(scan), /stopped scanning after \d+ directories/);
  const whole = scanCollection(root, { maxDepth: 20, maxDirs: 100 });
  assert.equal(whole.requests.length, 2);
  assert.equal(whole.truncated, false);
  assert.equal(scanNote(whole), "");
});

test("the scan stops at the directory limit, which is what makes a home directory bearable", () => {
  const root = mkdtempSync(join(tmpdir(), "r3q-wide-"));
  for (let i = 0; i < 30; i++) {
    const p = join(root, `p${String(i).padStart(2, "0")}`);
    mkdirSync(p);
    writeFileSync(join(p, "r.http"), REQUEST);
  }
  const scan = scanCollection(root, { maxDepth: SCAN_LIMITS.maxDepth, maxDirs: 10 });
  assert.equal(scan.dirs, 10);
  assert.equal(scan.truncated, true);
  assert.equal(scan.requests.length, 9, "the root plus nine of the thirty");
});
