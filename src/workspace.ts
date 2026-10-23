/**
 * Organisations, projects and teams, without a server.
 *
 * On disk a workspace is the collection directory itself:
 *
 *   ~/api/r3q.json                      orgs, projects, team members, descriptions
 *   ~/api/<org>/<project>/*.http        the requests
 *   ~/api/<org>/<project>/http-client.env.json   shared environments
 *
 * Sharing is a file: `r3q save` writes one bundle (JSON, so it diffs and
 * survives any transport), `scp` it anywhere, and `r3q load` it there.
 * Secrets (`.env*`, private env files) stay behind unless asked for.
 */
import { constants, existsSync } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

export interface ProjectInfo { name?: string; description?: string; team?: string[] }
export interface OrgInfo { name?: string; description?: string; team?: string[]; projects: Record<string, ProjectInfo> }
export interface Manifest { version: 1; orgs: Record<string, OrgInfo> }

export const MANIFEST = "r3q.json";
export const BUNDLE_FORMAT = "r3q-bundle";

export interface Bundle {
  format: typeof BUNDLE_FORMAT;
  version: 1;
  savedAt: string;
  /** Who saved it (user@host), for the receiving side. */
  savedBy?: string;
  /** What the bundle covers: everything, one org, or one project. */
  scope: { org?: string; project?: string };
  manifest: Manifest;
  /** Relative path → content. Text as-is, anything else base64. */
  files: Record<string, { text: string } | { base64: string }>;
  includesSecrets: boolean;
}

const SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const slugify = (name: string): string => name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|-+$/g, "").slice(0, 64) || "default";

/** Files that hold secrets in one format or another. */
export function isSecretFile(path: string): boolean {
  const name = basename(path);
  return name === ".env" || name.startsWith(".env.") || name.endsWith(".env") || name === "http-client.private.env.json" || name === "http-client.env.json.user" || /\.(pem|key|p12|pfx)$/i.test(name);
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".r3q-trash", ".claude"]);
const MAX_FILE = 5 * 1024 * 1024;

export async function readManifest(root: string): Promise<Manifest> {
  try {
    const parsed = JSON.parse(await readFile(join(root, MANIFEST), "utf8")) as Partial<Manifest>;
    const orgs: Record<string, OrgInfo> = {};
    for (const [slug, org] of Object.entries(parsed.orgs ?? {})) orgs[slug] = { ...org, projects: { ...(org?.projects ?? {}) } };
    return { version: 1, orgs };
  } catch { return { version: 1, orgs: {} }; }
}

export async function writeManifest(root: string, manifest: Manifest): Promise<void> {
  await mkdir(root, { recursive: true });
  const temporary = join(root, `.${MANIFEST}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  await rename(temporary, join(root, MANIFEST));
}

export interface TreeProject { slug: string; info: ProjectInfo; requests: number }
export interface TreeOrg { slug: string; info: OrgInfo; projects: TreeProject[] }

/** Orgs and projects from the manifest plus any `<org>/<project>/` directory holding requests. */
export async function workspaceTree(root: string, requestIds: string[] = []): Promise<TreeOrg[]> {
  const manifest = await readManifest(root);
  const orgs = new Map<string, TreeOrg>();
  const org = (slug: string): TreeOrg => {
    let o = orgs.get(slug);
    if (!o) { o = { slug, info: manifest.orgs[slug] ?? { projects: {} }, projects: [] }; orgs.set(slug, o); }
    return o;
  };
  const project = (o: TreeOrg, slug: string): TreeProject => {
    let p = o.projects.find((x) => x.slug === slug);
    if (!p) { p = { slug, info: o.info.projects[slug] ?? {}, requests: 0 }; o.projects.push(p); }
    return p;
  };
  for (const [slug, info] of Object.entries(manifest.orgs)) for (const p of Object.keys(info.projects)) project(org(slug), p);
  for (const id of requestIds) {
    const parts = id.split("/");
    if (parts.length >= 3) project(org(parts[0]!), parts[1]!).requests++;
  }
  return [...orgs.values()].sort((a, b) => a.slug.localeCompare(b.slug)).map((o) => ({ ...o, projects: o.projects.sort((a, b) => a.slug.localeCompare(b.slug)) }));
}

/** Create (or update) an org; its directory appears with it. */
export async function createOrg(root: string, name: string, info: Partial<Omit<OrgInfo, "projects">> = {}): Promise<string> {
  const slug = SLUG.test(name) ? name : slugify(name);
  const manifest = await readManifest(root);
  const existing = manifest.orgs[slug];
  manifest.orgs[slug] = { ...existing, ...info, name: info.name ?? existing?.name ?? name, projects: existing?.projects ?? {} };
  await mkdir(join(root, slug), { recursive: true });
  await writeManifest(root, manifest);
  return slug;
}

/** Create (or update) a project inside an org (creating the org if needed). */
export async function createProject(root: string, org: string, name: string, info: ProjectInfo = {}): Promise<string> {
  const orgSlug = SLUG.test(org) ? org : slugify(org);
  const slug = SLUG.test(name) ? name : slugify(name);
  const manifest = await readManifest(root);
  const o = manifest.orgs[orgSlug] ?? { name: org, projects: {} };
  o.projects[slug] = { ...o.projects[slug], ...info, name: info.name ?? o.projects[slug]?.name ?? name };
  manifest.orgs[orgSlug] = o;
  await mkdir(join(root, orgSlug, slug), { recursive: true });
  await writeManifest(root, manifest);
  return slug;
}

/** Add or remove team members on an org or project. */
export async function setTeam(root: string, org: string, project: string | undefined, add: string[], remove: string[] = []): Promise<string[]> {
  const manifest = await readManifest(root);
  const o = manifest.orgs[org] ?? { name: org, projects: {} };
  const target: { team?: string[] } = project ? (o.projects[project] ??= { name: project }) : o;
  const team = new Set(target.team ?? []);
  for (const m of add) team.add(m);
  for (const m of remove) team.delete(m);
  target.team = [...team].sort();
  manifest.orgs[org] = o;
  await writeManifest(root, manifest);
  if (project) await mkdir(join(root, org, project), { recursive: true });
  return target.team;
}

async function walk(root: string, dir: string, out: string[]): Promise<void> {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      // Hidden directories are skipped except .vscode (REST Client settings).
      if (entry.name.startsWith(".") && entry.name !== ".vscode") continue;
      await walk(root, full, out);
    } else if (entry.isFile()) out.push(relative(root, full).split(sep).join("/"));
  }
}

function isText(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); return true; } catch { return false; }
}

/** Pack the workspace (or one org/project) into a bundle. */
export async function saveBundle(root: string, options: { org?: string; project?: string; secrets?: boolean; savedBy?: string } = {}): Promise<{ bundle: Bundle; skipped: string[] }> {
  const manifest = await readManifest(root);
  const base = options.org ? join(root, options.org, ...(options.project ? [options.project] : [])) : root;
  if (options.org && !existsSync(base)) throw new Error(`${relative(root, base) || "."} does not exist in ${root}`);
  const paths: string[] = [];
  await walk(root, base, paths);
  const files: Bundle["files"] = {};
  const skipped: string[] = [];
  for (const relToRoot of paths) {
    if (relToRoot === MANIFEST) continue;
    if (relToRoot.startsWith("responses/") || relToRoot.includes("/responses/")) { skipped.push(`${relToRoot} (saved response)`); continue; }
    if (!options.secrets && isSecretFile(relToRoot)) { skipped.push(`${relToRoot} (secret; use --secrets to include)`); continue; }
    if (/^r3q-bundle.*\.json$|\.r3q\.json$/.test(basename(relToRoot))) { skipped.push(`${relToRoot} (a bundle)`); continue; }
    const bytes = await readFile(join(root, relToRoot));
    if (bytes.length > MAX_FILE) { skipped.push(`${relToRoot} (over 5 MiB)`); continue; }
    files[relToRoot] = isText(bytes) ? { text: bytes.toString("utf8") } : { base64: bytes.toString("base64") };
  }
  let scoped: Manifest = manifest;
  if (options.org) {
    const org = manifest.orgs[options.org] ?? { name: options.org, projects: {} };
    const projects = options.project ? { [options.project]: org.projects[options.project] ?? { name: options.project } } : org.projects;
    scoped = { version: 1, orgs: { [options.org]: { ...org, projects } } };
  }
  return {
    bundle: {
      format: BUNDLE_FORMAT, version: 1, savedAt: new Date().toISOString(), savedBy: options.savedBy,
      scope: { org: options.org, project: options.project }, manifest: scoped, files, includesSecrets: Boolean(options.secrets),
    },
    skipped,
  };
}

/** Write a bundle; private (0600) when it carries secrets. */
export async function writeBundle(path: string, bundle: Bundle): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(path, `${JSON.stringify(bundle, null, 2)}\n`, { mode: bundle.includesSecrets ? 0o600 : 0o644 });
}

export async function readBundle(path: string): Promise<Bundle> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as Bundle;
  if (parsed?.format !== BUNDLE_FORMAT || parsed.version !== 1 || typeof parsed.files !== "object") throw new Error(`${path} is not an r3q bundle`);
  return parsed;
}

export interface LoadReport { written: string[]; unchanged: string[]; conflicts: string[]; replaced: string[] }

function safeRelative(rel: string): boolean {
  if (!rel || rel.startsWith("/") || rel.includes("\\") || /[\x00-\x1f]/.test(rel)) return false;
  return rel.split("/").every((part) => part !== "" && part !== "." && part !== ".." && (!part.startsWith(".") || part === ".vscode" || /^\.env/.test(part) || part === ".httpyac.json" || part === ".httpyac.js"));
}

/**
 * Unpack a bundle into `root`. New files are written; identical ones are left
 * alone; files that differ locally are conflicts and stay untouched unless
 * `force`, in which case the local copy moves to `.r3q-trash` first.
 */
export async function loadBundle(root: string, bundle: Bundle, options: { force?: boolean; dryRun?: boolean } = {}): Promise<LoadReport> {
  const report: LoadReport = { written: [], unchanged: [], conflicts: [], replaced: [] };
  await mkdir(root, { recursive: true });
  const base = await realpath(root);
  for (const [rel, content] of Object.entries(bundle.files)) {
    if (!safeRelative(rel)) throw new Error(`refusing unsafe path in bundle: ${JSON.stringify(rel)}`);
    const target = resolve(base, rel);
    if (relative(base, target).startsWith("..")) throw new Error(`refusing path outside the workspace: ${rel}`);
    const bytes = "text" in content ? Buffer.from(content.text, "utf8") : Buffer.from(content.base64, "base64");
    let current: Buffer | undefined;
    try {
      const stat = await lstat(target);
      if (stat.isSymbolicLink() || !stat.isFile()) { report.conflicts.push(`${rel} (not a regular file here)`); continue; }
      current = await readFile(target);
    } catch { /* new file */ }
    if (current && Buffer.compare(current, bytes) === 0) { report.unchanged.push(rel); continue; }
    if (current && !options.force) { report.conflicts.push(rel); continue; }
    if (options.dryRun) { (current ? report.replaced : report.written).push(rel); continue; }
    // Parents must be real directories inside the workspace.
    let parent = base;
    for (const part of rel.split("/").slice(0, -1)) {
      parent = join(parent, part);
      await mkdir(parent).catch((e: NodeJS.ErrnoException) => { if (e.code !== "EEXIST") throw e; });
      const stat = await lstat(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${relative(base, parent)} is not a real directory`);
    }
    if (current) {
      const trash = join(base, ".r3q-trash");
      await mkdir(trash, { recursive: true, mode: 0o700 });
      await rename(target, join(trash, `${Date.now()}-${randomUUID()}-${basename(rel)}`));
      report.replaced.push(rel);
    } else report.written.push(rel);
    const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, isSecretFile(rel) ? 0o600 : 0o644);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, target);
  }
  // Merge the manifest: bundle entries add to or update local ones.
  if (!options.dryRun) {
    const local = await readManifest(base);
    for (const [slug, org] of Object.entries(bundle.manifest.orgs)) {
      const mine = local.orgs[slug] ?? { projects: {} };
      local.orgs[slug] = { ...mine, ...org, projects: { ...mine.projects, ...org.projects } };
    }
    await writeManifest(base, local);
  }
  return report;
}
