import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");

/**
 * The package as npm installs it: built, then the bin run by node with no bun
 * in sight. This is the path `bunx @profullstack/r3q` takes, and the one that
 * did nothing in 0.1.0.
 */
test("the installed command prints its usage", () => {
  const build = spawnSync("bun", ["x", "tsc", "-p", "tsconfig.json"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(build.status, 0, build.stdout + build.stderr);
  const run = spawnSync("node", [join(ROOT, "bin", "r3q.mjs"), "--help"], { cwd: ROOT, encoding: "utf8", timeout: 30_000 });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Usage:/);
  assert.match(run.stdout, /r3q \[dir\]/);
});
