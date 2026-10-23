import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrg, createProject, loadBundle, readBundle, readManifest, saveBundle, setTeam, workspaceTree, writeBundle } from "../src/workspace.ts";
import { loadCollection } from "../src/collection.ts";

const scratch = (): string => mkdtempSync(join(process.env.CLAUDE_JOB_DIR ? join(process.env.CLAUDE_JOB_DIR, "tmp") : tmpdir(), "r3q-ws-"));

async function seeded(): Promise<string> {
  const root = scratch();
  await createOrg(root, "Acme Corp", { description: "the company" });
  await createProject(root, "acme-corp", "Billing API", { team: ["ana@acme.test"] });
  await setTeam(root, "acme-corp", "billing-api", ["bo@acme.test"]);
  const dir = join(root, "acme-corp", "billing-api");
  writeFileSync(join(dir, "invoices.http"), "### list\nGET {{host}}/invoices\n\n### create\nPOST {{host}}/invoices\n");
  writeFileSync(join(dir, "http-client.env.json"), JSON.stringify({ dev: { host: "http://localhost" } }));
  writeFileSync(join(dir, "http-client.private.env.json"), JSON.stringify({ dev: { token: "s3cret" } }));
  writeFileSync(join(dir, ".env"), "TOKEN=s3cret\n");
  writeFileSync(join(dir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
  return root;
}

test("orgs, projects and teams live in r3q.json and as folders", async () => {
  const root = await seeded();
  const manifest = await readManifest(root);
  expect(manifest.orgs["acme-corp"]!.name).toBe("Acme Corp");
  expect(manifest.orgs["acme-corp"]!.projects["billing-api"]!.team).toEqual(["ana@acme.test", "bo@acme.test"]);
  const tree = await workspaceTree(root, loadCollection(root).map((r) => r.file ?? r.id));
  expect(tree[0]!.projects[0]!.slug).toBe("billing-api");
  expect(loadCollection(root).map((r) => [r.org, r.project, r.label])).toEqual([["acme-corp", "billing-api", "list"], ["acme-corp", "billing-api", "create"]]);
});

test("a bundle carries requests and shared envs, not secrets, and loads on another server", async () => {
  const root = await seeded();
  const { bundle, skipped } = await saveBundle(root, { savedBy: "me@here" });
  expect(Object.keys(bundle.files).sort()).toEqual(["acme-corp/billing-api/http-client.env.json", "acme-corp/billing-api/invoices.http", "acme-corp/billing-api/logo.png"]);
  expect(skipped.join(" ")).toContain(".env");
  expect("base64" in bundle.files["acme-corp/billing-api/logo.png"]!).toBe(true);
  const path = join(scratch(), "r3q-bundle.json");
  await writeBundle(path, bundle);
  expect(statSync(path).mode & 0o777).toBe(0o644);

  const other = scratch();
  const report = await loadBundle(other, await readBundle(path));
  expect(report.written.length).toBe(3);
  expect(readFileSync(join(other, "acme-corp/billing-api/logo.png"))).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
  expect((await readManifest(other)).orgs["acme-corp"]!.projects["billing-api"]!.team).toEqual(["ana@acme.test", "bo@acme.test"]);

  // Loading again changes nothing.
  const again = await loadBundle(other, bundle);
  expect(again.unchanged.length).toBe(3);
});

test("--secrets includes them, mode 0600", async () => {
  const root = await seeded();
  const { bundle } = await saveBundle(root, { secrets: true });
  expect(bundle.files["acme-corp/billing-api/.env"]).toEqual({ text: "TOKEN=s3cret\n" });
  const path = join(scratch(), "b.json");
  await writeBundle(path, bundle);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  const other = scratch();
  await loadBundle(other, bundle);
  expect(statSync(join(other, "acme-corp/billing-api/.env")).mode & 0o777).toBe(0o600);
});

test("local edits are conflicts, kept unless forced; forced copies go to .r3q-trash", async () => {
  const root = await seeded();
  const { bundle } = await saveBundle(root, { org: "acme-corp", project: "billing-api" });
  const other = scratch();
  await loadBundle(other, bundle);
  writeFileSync(join(other, "acme-corp/billing-api/invoices.http"), "GET http://changed\n");
  const report = await loadBundle(other, bundle);
  expect(report.conflicts).toEqual(["acme-corp/billing-api/invoices.http"]);
  expect(readFileSync(join(other, "acme-corp/billing-api/invoices.http"), "utf8")).toBe("GET http://changed\n");
  const forced = await loadBundle(other, bundle, { force: true });
  expect(forced.replaced).toEqual(["acme-corp/billing-api/invoices.http"]);
  expect(readdirSync(join(other, ".r3q-trash")).length).toBe(1);
});

test("a bundle cannot write outside the workspace", async () => {
  const other = scratch();
  const evil = { format: "r3q-bundle", version: 1, savedAt: "", scope: {}, manifest: { version: 1, orgs: {} }, includesSecrets: false, files: { "../escape.http": { text: "x" } } } as const;
  await expect(loadBundle(other, evil as never)).rejects.toThrow(/unsafe path/);
  expect(existsSync(join(other, "..", "escape.http"))).toBe(false);
  mkdirSync(join(other, "x"));
});
