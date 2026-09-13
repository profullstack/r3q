import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile, mkdir, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { METHODS, parseRequest, scanCollectionAsync } from "../src/collection.ts";
import { TEMPLATES, draftFromSource, duplicateFilename, readSnapshot, saveDraft, serializeDraft, templateDraft, trashRequest } from "../src/requests.ts";
import { send } from "../src/send.ts";

async function collection(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "r3q-requests-test-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("every parser-supported method has an editable, round-tripping example", async () => {
  assert.deepEqual(new Set(TEMPLATES.map((t) => t.method)), METHODS);
  await collection(async (root) => {
    for (let index = 0; index < TEMPLATES.length; index++) {
      const draft = templateDraft(index);
      await saveDraft(root, draft);
      const source = await readFile(join(root, draft.file), "utf8");
      const parsed = parseRequest(source, draft.file, draft.file);
      assert.equal(parsed.error, undefined);
      assert.equal(parsed.method, draft.method);
      assert.equal(parsed.url, draft.url);
      assert.equal(parsed.body ?? "", draft.body);
      assert.equal(serializeDraft(draftFromSource(source, draft.file)), source);
    }
    assert.equal((await scanCollectionAsync(root)).requests.length, TEMPLATES.length);
  });
});

test("edit preserves comments, variable placeholders, headers and a multiline body", async () => {
  await collection(async (root) => {
    const source = '# My request\n// Keep this explanation\n\nPOST {{ BASE_URL }}/items\nAuthorization: Bearer {{TOKEN}}\nContent-Type: application/json\n\n{\n  "value": "{{VALUE}}"\n}\n';
    await writeFile(join(root, "one.http"), source, { mode: 0o640 });
    const original = await readSnapshot(root, "one.http");
    const draft = draftFromSource(source, original.id);
    assert.equal(serializeDraft(draft), source);
    draft.name = "Renamed request";
    draft.body = '{\n  "value": "changed"\n}';
    await saveDraft(root, draft, original);
    const saved = await readFile(join(root, "one.http"), "utf8");
    assert.match(saved, /^# Renamed request\n\/\/ Keep this explanation\n\nPOST/);
    assert.match(saved, /Bearer \{\{TOKEN\}\}/);
    assert.match(saved, /"changed"/);
    assert.equal((await stat(join(root, "one.http"))).mode & 0o777, 0o640);
    assert.deepEqual(await readdir(root), ["one.http"]);
  });
});

test("new saves never overwrite an existing file, including simultaneous creators", async () => {
  await collection(async (root) => {
    const draft = templateDraft();
    const results = await Promise.allSettled([saveDraft(root, draft), saveDraft(root, { ...draft, name: "Other" })]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const source = await readFile(join(root, draft.file), "utf8");
    await assert.rejects(saveDraft(root, { ...draft, body: "" }), /already exists/);
    assert.equal(await readFile(join(root, draft.file), "utf8"), source);
  });
});

test("an external edit or replacement prevents stale edits and deletes", async () => {
  await collection(async (root) => {
    const draft = templateDraft(1);
    await saveDraft(root, draft);
    const original = await readSnapshot(root, draft.file);
    const external = original.source + "external change\n";
    await writeFile(join(root, draft.file), external);
    await assert.rejects(saveDraft(root, { ...draft, name: "Stale" }, original), /changed on disk/);
    await assert.rejects(trashRequest(root, original), /changed on disk/);
    assert.equal(await readFile(join(root, draft.file), "utf8"), external);
    await writeFile(join(root, "replacement.http"), original.source);
    await rename(join(root, "replacement.http"), join(root, draft.file));
    await assert.rejects(saveDraft(root, draft, original), /changed on disk/);
    assert.deepEqual(await readdir(root), [draft.file]);
  });
});

test("duplicate uses another filename and deletion keeps recoverable bytes outside scans", async () => {
  await collection(async (root) => {
    const draft = templateDraft(2);
    draft.file = "nested/update.http";
    await saveDraft(root, draft);
    const original = await readSnapshot(root, draft.file);
    const copy = { ...draft, file: await duplicateFilename(root, draft.file) };
    assert.equal(copy.file, "nested/update-copy.http");
    await saveDraft(root, copy);
    assert.equal(await duplicateFilename(root, draft.file), "nested/update-copy-2.http");
    const trash = await trashRequest(root, original);
    assert.match(trash, /^\.r3q-trash\//);
    assert.equal(await readFile(join(root, trash), "utf8"), original.source);
    assert.deepEqual((await scanCollectionAsync(root)).requests.map((request) => request.id), [copy.file]);
  });
});

test("save rejects unsafe paths, symlink files, symlink parents, and symlink trash", async () => {
  await collection(async (root) => {
    const draft = templateDraft();
    for (const file of ["../escape.http", "/tmp/escape.http", ".secret.http", "node_modules/a.http", "a.txt", "one\\two.http"]) {
      await assert.rejects(saveDraft(root, { ...draft, file }));
    }
    await mkdir(join(root, "outside"));
    await writeFile(join(root, "outside", "preserve.http"), "preserved");
    await symlink(join(root, "outside"), join(root, "shortcut"));
    await symlink(join(root, "outside", "preserve.http"), join(root, "link.http"));
    await assert.rejects(saveDraft(root, { ...draft, file: "shortcut/new.http" }), /symlinks/);
    await assert.rejects(saveDraft(root, { ...draft, file: "link.http" }), /already exists/);
    await assert.rejects(readSnapshot(root, "link.http"));
    assert.equal(await readFile(join(root, "outside", "preserve.http"), "utf8"), "preserved");
    await saveDraft(root, draft);
    await symlink(join(root, "outside"), join(root, ".r3q-trash"));
    await assert.rejects(trashRequest(root, await readSnapshot(root, draft.file)), /symlink/);
    assert.ok(await readFile(join(root, draft.file), "utf8"));
  });
});

test("validation catches invalid URLs, header injection, duplicate headers and unsupported bodies", () => {
  const draft = templateDraft();
  for (const url of ["file:///etc/passwd", "not-a-url", "https://example.com/has spaces"]) assert.throws(() => serializeDraft({ ...draft, url }));
  assert.doesNotThrow(() => serializeDraft({ ...draft, url: "http://{{HOST}}:{{ PORT }}/path" }));
  assert.throws(() => serializeDraft({ ...draft, headers: "Accept: one\naccept: two" }), /Duplicate/);
  assert.throws(() => serializeDraft({ ...draft, headers: "X-Test: one\rInjected: yes" }), /Headers/);
  assert.throws(() => serializeDraft({ ...draft, body: "not supported" }), /cannot send a body/);
});

test("TRACE is inspectable and reports the runtime limit without calling fetch", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error("must not send"); }) as typeof fetch;
  try {
    const draft = templateDraft(7);
    const result = await send(parseRequest(serializeDraft(draft), draft.file, draft.file));
    assert.match(result.error ?? "", /does not support sending/);
  } finally { globalThis.fetch = original; }
});
