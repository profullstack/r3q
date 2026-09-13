import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const launcher = fileURLToPath(new URL("../bin/r3q.mjs", import.meta.url));
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("the published Node launcher executes the CLI entry point", () => {
  const result = spawnSync("node", [launcher, "--help"], { encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("Usage: r3q [directory]");
  expect(result.stdout).toContain("Enter send");
});

test("the published launcher reports the package version without a terminal", () => {
  const result = spawnSync("node", [launcher, "--version"], { encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout.trim()).toBe(`r3q ${version}`);
});
