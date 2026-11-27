/**
 * Secrets in the operating system's credential store, never in the collection.
 *
 * Linux: libsecret through `secret-tool` (GNOME Keyring, KWallet's Secret
 * Service). macOS: the login Keychain through `security`. Windows: a DPAPI
 * blob per user through PowerShell, so only the same Windows account can read
 * it. The collection keeps only `.r3q/secrets.json`, a list of names, so
 * `{{NAME}}` knows to ask the store and `r3q secret list` can show what exists.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";

export interface SecretBackend {
  name: string;
  get(service: string, account: string): string | undefined;
  set(service: string, account: string, value: string): void;
  delete(service: string, account: string): void;
}

const run = (cmd: string, args: string[], input?: string) => spawnSync(cmd, args, { input, encoding: "utf8", timeout: 15_000 });
const available = (cmd: string): boolean => {
  const probe = spawnSync(platform() === "win32" ? "where" : "which", [cmd], { encoding: "utf8" });
  return probe.status === 0;
};

const secretTool: SecretBackend = {
  name: "libsecret (secret-tool)",
  get(service, account) {
    const r = run("secret-tool", ["lookup", "service", service, "account", account]);
    return r.status === 0 ? r.stdout.replace(/\n$/, "") : undefined;
  },
  set(service, account, value) {
    const r = run("secret-tool", ["store", "--label", `r3q ${account}`, "service", service, "account", account], value);
    if (r.status !== 0) throw new Error(`secret-tool store failed: ${r.stderr.trim() || r.error?.message}`);
  },
  delete(service, account) { run("secret-tool", ["clear", "service", service, "account", account]); },
};

const keychain: SecretBackend = {
  name: "macOS Keychain",
  get(service, account) {
    const r = run("security", ["find-generic-password", "-s", service, "-a", account, "-w"]);
    return r.status === 0 ? r.stdout.replace(/\n$/, "") : undefined;
  },
  set(service, account, value) {
    // -U updates an existing item. The value is an argument here (security has no stdin mode for -w).
    const r = run("security", ["add-generic-password", "-U", "-s", service, "-a", account, "-w", value]);
    if (r.status !== 0) throw new Error(`security add-generic-password failed: ${r.stderr.trim()}`);
  },
  delete(service, account) { run("security", ["delete-generic-password", "-s", service, "-a", account]); },
};

function dpapiFile(service: string, account: string): string {
  const safe = (s: string) => s.replace(/[^\w.-]+/g, "_").slice(0, 80);
  return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "r3q", "secrets", `${safe(service)}--${safe(account)}.dpapi`);
}

const dpapi: SecretBackend = {
  name: "Windows DPAPI (current user)",
  get(service, account) {
    const file = dpapiFile(service, account);
    if (!existsSync(file)) return undefined;
    const script = `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String((Get-Content -Raw '${file.replace(/'/g, "''")}')); [Console]::Out.Write([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser')))`;
    const r = run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]);
    return r.status === 0 ? r.stdout : undefined;
  },
  set(service, account, value) {
    const file = dpapiFile(service, account);
    mkdirSync(join(file, ".."), { recursive: true });
    const script = `Add-Type -AssemblyName System.Security; $v=[Console]::In.ReadToEnd(); $b=[Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($v),$null,'CurrentUser'); Set-Content -NoNewline -Path '${file.replace(/'/g, "''")}' -Value ([Convert]::ToBase64String($b))`;
    const r = run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], value);
    if (r.status !== 0) throw new Error(`DPAPI protect failed: ${r.stderr.trim()}`);
  },
  delete(service, account) { const f = dpapiFile(service, account); if (existsSync(f)) unlinkSync(f); },
};

/** In memory only: tests, and `R3Q_SECRET_BACKEND=memory`. */
export function memoryBackend(): SecretBackend {
  const store = new Map<string, string>();
  return {
    name: "memory",
    get: (s, a) => store.get(`${s}\0${a}`),
    set: (s, a, v) => { store.set(`${s}\0${a}`, v); },
    delete: (s, a) => { store.delete(`${s}\0${a}`); },
  };
}

let override: SecretBackend | undefined;
export function setSecretBackend(backend: SecretBackend | undefined): void { override = backend; }

export function secretBackend(): SecretBackend | undefined {
  if (override) return override;
  if (process.env.R3Q_SECRET_BACKEND === "memory") return (override = memoryBackend());
  const os = platform();
  if (os === "darwin" && available("security")) return keychain;
  if (os === "win32") return dpapi;
  if (available("secret-tool")) return secretTool;
  return undefined;
}

const NO_BACKEND = "no credential store found: install libsecret-tools (secret-tool) on Linux; macOS and Windows have one built in";

/** One service per collection, so two collections can both have a TOKEN. */
export const serviceFor = (root: string): string => `r3q:${resolve(root)}`;
const indexFile = (root: string): string => join(resolve(root), ".r3q", "secrets.json");

export function secretNames(root: string): string[] {
  try { const v = JSON.parse(readFileSync(indexFile(root), "utf8")) as { names?: string[] }; return Array.isArray(v.names) ? v.names : []; }
  catch { return []; }
}

function writeNames(root: string, names: string[]): void {
  mkdirSync(join(resolve(root), ".r3q"), { recursive: true });
  writeFileSync(indexFile(root), `${JSON.stringify({ note: "names only; values live in the OS credential store", names: [...new Set(names)].sort() }, null, 2)}\n`);
}

export function setSecret(root: string, name: string, value: string): string {
  if (!/^[\w.-]+$/.test(name)) throw new Error(`secret names are letters, digits, _ . - (got "${name}")`);
  const backend = secretBackend();
  if (!backend) throw new Error(NO_BACKEND);
  backend.set(serviceFor(root), name, value);
  writeNames(root, [...secretNames(root), name]);
  return backend.name;
}

export function getSecret(root: string, name: string): string | undefined {
  return secretBackend()?.get(serviceFor(root), name);
}

export function deleteSecret(root: string, name: string): boolean {
  const names = secretNames(root);
  secretBackend()?.delete(serviceFor(root), name);
  if (!names.includes(name)) return false;
  writeNames(root, names.filter((n) => n !== name));
  return true;
}

/** Every indexed secret's value, read once per session. Missing values are skipped. */
export function loadSecrets(root: string): Record<string, string> {
  const names = secretNames(root);
  if (!names.length) return {};
  const backend = secretBackend();
  if (!backend) return {};
  const out: Record<string, string> = {};
  for (const n of names) { const v = backend.get(serviceFor(root), n); if (v !== undefined) out[n] = v; }
  return out;
}
