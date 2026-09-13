import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InputParser } from "@profullstack/hqtui";
import { renderToText } from "@profullstack/hqtui/testing";
import { RequestManager, type Editor } from "../src/request-manager.ts";
import { templateDraft, saveDraft } from "../src/requests.ts";

async function managerTest(run: (manager: RequestManager, root: string, changes: string[]) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "r3q-manager-test-"));
  const changes: string[] = [];
  const manager = new RequestManager(root, {
    current: () => undefined, invalidate: () => {}, note: (note) => { changes.push(note); },
    changed: (id, note) => { changes.push(`${id}: ${note}`); },
  });
  try { await run(manager, root, changes); } finally { await rm(root, { recursive: true, force: true }); }
}

function keys(manager: RequestManager, source: string): void {
  const parser = new InputParser();
  for (const event of [...parser.parse(source), ...parser.flush()]) {
    if (event.type === "key") manager.key(event);
    else if (event.type === "paste") manager.paste(event.text);
  }
}

function frame(manager: RequestManager, width = 100, height = 32): string {
  return renderToText(({ ui, theme }) => manager.render(ui, theme, width, height), { width, height });
}

test("empty-screen wizard starts prefilled, chooses POST and cancels without files", async () => {
  await managerTest(async (manager, root) => {
    manager.create();
    assert.match(frame(manager), /New request/);
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE"]) assert.match(frame(manager), new RegExp(method));
    keys(manager, "\x1b[B\r");
    const editor = manager.dialog as Editor;
    assert.equal(editor.draft.method, "POST");
    assert.match(editor.draft.headers, /Content-Type: application\/json/);
    assert.match(editor.draft.body, /Example item/);
    assert.match(frame(manager), /create-item.http/);
    assert.match(frame(manager), /Review/);
    keys(manager, "\x1b");
    assert.equal(manager.dialog, undefined);
    assert.deepEqual(await readdir(root), []);
  });
});

test("multiline paste stays in the form, body/headers round-trip, and save selects the file", async () => {
  await managerTest(async (manager, root, changes) => {
    manager.create();
    keys(manager, "\x1b[B\r");
    keys(manager, "\x15My quoted request");
    keys(manager, "\t\t\t\x15");
    manager.paste("Content-Type: application/json\nAuthorization: Bearer {{TOKEN}}");
    keys(manager, "\t\x15");
    keys(manager, '\x1b[200~{\n  "note": "n q x are just text"\n}\x1b[201~');
    assert.equal((manager.dialog as Editor).draft.body, '{\n  "note": "n q x are just text"\n}');
    await manager.save();
    assert.equal(manager.dialog, undefined);
    assert.match(await readFile(join(root, "my-quoted-request.http"), "utf8"), /Bearer \{\{TOKEN\}\}/);
    assert.match(changes[0]!, /^my-quoted-request.http: Saved/);
  });
});

test("overwrite protection keeps the draft open and unchanged bytes on disk", async () => {
  await managerTest(async (manager, root) => {
    await saveDraft(root, templateDraft());
    const original = await readFile(join(root, "read-items.http"), "utf8");
    manager.create();
    keys(manager, "\r");
    await manager.save();
    assert.match((manager.dialog as Editor).error, /already exists/);
    assert.match(frame(manager), /already exists/);
    assert.equal(await readFile(join(root, "read-items.http"), "utf8"), original);
  });
});

test("a conflicting edit can be saved as a copy without losing draft changes", async () => {
  await managerTest(async (manager, root) => {
    await saveDraft(root, templateDraft(1));
    await manager.open("edit", "create-item.http");
    const editor = manager.dialog as Editor;
    editor.draft.body = '{"mine": true}';
    const changed = "POST https://example.com/elsewhere\n\nexternal version\n";
    await writeFile(join(root, "create-item.http"), changed);
    await manager.save();
    assert.match(editor.error, /changed on disk/);
    await manager.saveAsCopy();
    assert.equal(editor.draft.file, "create-item-copy.http");
    assert.equal(editor.draft.body, '{"mine": true}');
    await manager.save();
    assert.equal(await readFile(join(root, "create-item.http"), "utf8"), changed);
    assert.match(await readFile(join(root, "create-item-copy.http"), "utf8"), /"mine": true/);
  });
});

test("view shows raw variables; duplicate and delete never act until explicitly saved or confirmed", async () => {
  await managerTest(async (manager, root) => {
    await saveDraft(root, { ...templateDraft(), headers: "Authorization: Bearer {{TOKEN}}" });
    await manager.open("view", "read-items.http");
    assert.match(frame(manager), /Bearer \{\{TOKEN\}\}/);
    await manager.open("duplicate", "read-items.http");
    assert.equal((manager.dialog as Editor).draft.file, "read-items-copy.http");
    assert.deepEqual(await readdir(root), ["read-items.http"]);
    await manager.save();
    await manager.open("delete", "read-items.http");
    assert.match(frame(manager), /\.r3q-trash/);
    keys(manager, "\r"); // Cancel is the default.
    assert.ok(await readFile(join(root, "read-items.http"), "utf8"));
    await manager.open("delete", "read-items.http");
    await manager.remove();
    assert.deepEqual((await readdir(root)).sort(), [".r3q-trash", "read-items-copy.http"]);
  });
});

test("editing unicode and a narrow form keep content intact", async () => {
  await managerTest(async (manager) => {
    manager.create(); keys(manager, "\r\x15");
    manager.paste("request 🚀");
    keys(manager, "\x7f");
    assert.equal((manager.dialog as Editor).draft.name, "request ");
    const output = frame(manager, 60, 24);
    assert.match(output, /Review/);
    assert.match(output, /Body/);
    assert.ok(output.split("\n").every((line) => line.length <= 60));
  });
});
