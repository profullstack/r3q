import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCollection, loadCollectionAsync, scanCollectionAsync } from "../src/collection.ts";

test("async collection scans preserve request order and skip symlink cycles and ignored directories", async () => {
  const root = mkdtempSync(join(tmpdir(), "r3q-scan-"));
  try {
    writeFileSync(join(root, "first.http"), "GET https://example.test/first");
    for (const name of ["nested", ".hidden", "node_modules"]) {
      mkdirSync(join(root, name));
      writeFileSync(join(root, name, "request.http"), "GET https://example.test/nested");
    }
    symlinkSync(root, join(root, "nested", "cycle"), "dir");
    symlinkSync(join(root, "first.http"), join(root, "linked.http"));
    const found = await loadCollectionAsync(root);
    assert.deepEqual(found.map((request) => request.id), ["first.http", "nested/request.http"]);
    assert.deepEqual(found, loadCollection(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a scan yields before delivering files and stops when a reload or quit aborts it", async () => {
  const root = mkdtempSync(join(tmpdir(), "r3q-abort-"));
  try {
    writeFileSync(join(root, "first.http"), "GET https://example.test/first");
    writeFileSync(join(root, "second.http"), "GET https://example.test/second");
    const controller = new AbortController();
    const seen: string[] = [];
    const result = loadCollectionAsync(root, {
      signal: controller.signal,
      onRequest: (request) => {
        seen.push(request.id);
        controller.abort();
      },
    });
    assert.deepEqual(seen, [], "startup must not synchronously walk the collection");
    const found = await result;
    assert.deepEqual(seen, ["first.http"]);
    assert.deepEqual(found.map((request) => request.id), seen);
    assert.deepEqual(await loadCollectionAsync(root, { signal: controller.signal }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an absent directory remains an empty collection during async loading", async () => {
  assert.deepEqual(await loadCollectionAsync(join(tmpdir(), "r3q-absent-directory")), []);
});

test("the async scan reports both depth and directory limits without hiding root requests", async () => {
  const root = mkdtempSync(join(tmpdir(), "r3q-limits-"));
  try {
    writeFileSync(join(root, "first.http"), "GET https://example.test/first");
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "nested", "request.http"), "GET https://example.test/nested");
    for (const limits of [{ maxDepth: 0, maxDirs: 20 }, { maxDepth: 8, maxDirs: 1 }]) {
      const scan = await scanCollectionAsync(root, { limits });
      assert.deepEqual(scan.requests.map((request) => request.id), ["first.http"]);
      assert.equal(scan.truncated, true);
      assert.equal(scan.dirs, 1);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
