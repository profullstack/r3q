/**
 * Environments in every format the spec lists, merged:
 *
 *   .env, .env.<name>, <name>.env, .env.local, local.env          (httpyac, kulala, r3q)
 *   http-client.env.json + http-client.private.env.json           (JetBrains, kulala, VS 2022)
 *   http-client.env.json.user                                     (Visual Studio 2022)
 *   .vscode/settings.json "rest-client.environmentVariables"      (VS Code REST Client)
 *   httpyac.config.js / .httpyac.js / .httpyac.json / package.json "httpyac"
 *
 * `$shared` (and httpyac `$default`) apply to every environment; a selected
 * environment overrides them; private and `.user` files override public ones.
 * Several environments may be active at once (httpyac `--env a --env b`).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import type { TlsOptions } from "./types.ts";

type Bag = Record<string, unknown>;

export interface CertificateConfig { cert?: string; key?: string; pfx?: string; passphrase?: string; ca?: string; verify?: boolean; format?: string }

export interface Environment {
  /** Every environment name found, for pickers. */
  names: string[];
  /** Variables of the selected environment(s), highest precedence last-merged. */
  variables: Bag;
  /** `.env`-style values, for `{{$dotenv NAME}}`. */
  dotenv: Record<string, string>;
  /** Client certificates by host (`host` or `host:port`), from VS Code, httpyac and JetBrains SSLConfiguration (key "*"). */
  certificates: Record<string, CertificateConfig>;
  /** Proxy from VS Code `http.proxy`, httpyac `proxy`, or a `request_proxy` variable. */
  proxy?: string;
  /** Hosts that bypass the proxy (VS Code rest-client.excludeHostsForProxy). */
  noProxy: string[];
  /** Where each file came from, for the UI. */
  sources: string[];
  /** httpyac.config.js `cookieJarEnabled`, VS Code `rememberCookiesForSubsequentRequests`. */
  cookieJar: boolean;
  /** VS Code `rest-client.defaultHeaders`, httpyac `defaultHeaders`. */
  defaultHeaders?: Record<string, string>;
}

function readJson(path: string): Bag | undefined {
  try {
    // settings.json allows comments and trailing commas.
    const text = readFileSync(path, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:"\\])\/\/.*$/gm, "$1")
      .replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(text) as Bag;
  } catch { return undefined; }
}

/** dotenv syntax: KEY=value, export KEY=value, quotes, \n in double quotes, # comments. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([\w.-]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2]!;
    const quote = value[0];
    if (quote === '"' || quote === "'" || quote === "`") {
      let full = value.slice(1);
      while (!full.trimEnd().endsWith(quote) && i + 1 < lines.length) full += `\n${lines[++i]}`;
      value = full.trimEnd().slice(0, -1);
      if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t").replace(/\\"/g, '"');
    } else value = value.replace(/\s+#.*$/, "").trim();
    out[m[1]!] = value;
  }
  return out;
}

function readDotenv(path: string): Record<string, string> | undefined {
  try { return parseDotenv(readFileSync(path, "utf8")); } catch { return undefined; }
}

/** Directories searched: the file's directory up to the collection root, `env/` beside each, and $HTTPYAC_ENV. */
export function searchDirs(root: string, fileDir: string): string[] {
  const dirs: string[] = [];
  const top = resolve(root);
  let dir = resolve(fileDir);
  for (;;) {
    dirs.unshift(dir);
    if (dir === top || dirname(dir) === dir || !dir.startsWith(top)) break;
    dir = dirname(dir);
  }
  const out: string[] = [];
  for (const d of dirs) out.push(d, join(d, "env"));
  if (process.env.HTTPYAC_ENV) out.push(resolve(process.env.HTTPYAC_ENV));
  return [...new Set(out)];
}

/** Visual Studio 2022 secret providers inside env files. */
function secret(value: unknown, dir: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("provider" in value)) return value;
  const v = value as { provider: string; secretName?: string; resourceId?: string; value?: string };
  switch (v.provider) {
    case "AspnetUserSecrets": {
      const id = findUserSecretsId(dir);
      const base = process.platform === "win32" ? join(process.env.APPDATA ?? "", "Microsoft", "UserSecrets") : join(homedir(), ".microsoft", "usersecrets");
      const secrets = id ? readJson(join(base, id, "secrets.json")) : undefined;
      return secrets?.[v.secretName ?? ""] ?? "";
    }
    case "AzureKeyVault": {
      const vault = /vaults\/([^/]+)/.exec(v.resourceId ?? "")?.[1];
      if (!vault || !v.secretName) return "";
      try {
        return execFileSync("az", ["keyvault", "secret", "show", "--vault-name", vault, "--name", v.secretName, "--query", "value", "-o", "tsv"], { encoding: "utf8", timeout: 30_000 }).trim();
      } catch (error) { throw new Error(`Azure Key Vault ${vault}/${v.secretName}: install and sign in to the az CLI (${(error as Error).message.split("\n")[0]})`); }
    }
    case "Encrypted":
      throw new Error("DPAPI-encrypted values can only be read by Visual Studio on Windows; move this value to http-client.private.env.json.");
  }
  return value;
}

function findUserSecretsId(dir: string): string | undefined {
  let d = dir;
  for (let n = 0; n < 8; n++) {
    try {
      for (const f of readdirSync(d)) if (f.endsWith(".csproj")) {
        const m = /<UserSecretsId>([^<]+)<\/UserSecretsId>/.exec(readFileSync(join(d, f), "utf8"));
        if (m) return m[1];
      }
    } catch { /* keep walking */ }
    if (dirname(d) === d) break;
    d = dirname(d);
  }
  return undefined;
}

/** JetBrains SSLConfiguration → certificate config. */
function sslConfiguration(value: unknown, dir: string): CertificateConfig | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Bag;
  const cert = v.clientCertificate as string | { path?: string; format?: string } | undefined;
  const key = v.clientCertificateKey as string | { path?: string } | undefined;
  const path = (p: unknown): string | undefined => typeof p === "string" ? resolve(dir, p) : p && typeof p === "object" && "path" in p ? resolve(dir, String((p as Bag).path)) : undefined;
  return {
    cert: path(cert),
    key: path(key),
    format: typeof cert === "object" ? cert?.format : undefined,
    verify: v.verifyHostCertificate === undefined ? undefined : Boolean(v.verifyHostCertificate),
    passphrase: typeof v.certificatePassphrase === "string" ? v.certificatePassphrase : undefined,
  };
}

function certificatesFrom(value: unknown, dir: string): Record<string, CertificateConfig> {
  const out: Record<string, CertificateConfig> = {};
  if (!value || typeof value !== "object") return out;
  for (const [host, cfg] of Object.entries(value as Record<string, Bag>)) {
    const p = (k: string): string | undefined => typeof cfg[k] === "string" ? resolve(dir, cfg[k] as string) : undefined;
    out[host] = { cert: p("cert"), key: p("key"), pfx: p("pfx"), ca: p("ca"), passphrase: typeof cfg.passphrase === "string" ? cfg.passphrase : undefined };
  }
  return out;
}

async function loadHttpyacConfig(dir: string): Promise<Bag | undefined> {
  for (const name of ["httpyac.config.js", "httpyac.config.cjs", "httpyac.config.mjs", ".httpyac.js", ".httpyac.cjs", ".httpyac.mjs"]) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    try {
      const mod = await import(pathToFileURL(path).href) as { default?: unknown };
      const cfg = (mod.default ?? mod) as Bag | (() => Bag);
      return typeof cfg === "function" ? await cfg() : cfg;
    } catch (error) { throw new Error(`${path}: ${(error as Error).message}`); }
  }
  for (const name of [".httpyac.json", "httpyac.config.json"]) {
    const cfg = readJson(join(dir, name));
    if (cfg) return cfg;
  }
  const pkg = readJson(join(dir, "package.json"));
  return pkg?.httpyac as Bag | undefined;
}

/** Load and merge every environment source for a file. `selected` may be empty (only $shared/$default and .env). */
export async function loadEnvironment(root: string, fileDir: string, selected: string[]): Promise<Environment> {
  const env: Environment = { names: [], variables: {}, dotenv: {}, certificates: {}, noProxy: [], sources: [], cookieJar: true };
  const names = new Set<string>();
  const layers: Bag[] = [];
  const dotenvLayers: Record<string, string>[] = [];

  const applyEnvObject = (obj: Bag | undefined, source: string, dir: string): void => {
    if (!obj) return;
    env.sources.push(source);
    for (const key of Object.keys(obj)) if (!key.startsWith("$")) names.add(key);
    const pick = (key: string): Bag | undefined => obj[key] && typeof obj[key] === "object" ? obj[key] as Bag : undefined;
    for (const key of ["$shared", "$default", ...selected]) {
      const bag = pick(key);
      if (!bag) continue;
      const layer: Bag = {};
      for (const [k, v] of Object.entries(bag)) {
        if (k === "SSLConfiguration") {
          const ssl = sslConfiguration(v, dir);
          if (ssl) env.certificates["*"] = { ...env.certificates["*"], ...ssl };
          continue;
        }
        layer[k] = secret(v, dir);
      }
      layers.push(layer);
    }
  };

  for (const dir of searchDirs(root, fileDir)) {
    const dot = (name: string): void => {
      const values = readDotenv(join(dir, name));
      if (values) { dotenvLayers.push(values); env.sources.push(join(dir, name)); }
    };
    dot(".env");
    for (const name of selected) { dot(`.env.${name}`); dot(`${name}.env`); }
    dot(".env.local");
    dot("local.env");

    for (const name of ["http-client.env.json", "http-client.private.env.json", "http-client.env.json.user"]) {
      applyEnvObject(readJson(join(dir, name)), join(dir, name), dir);
    }

    const settings = readJson(join(dir, ".vscode", "settings.json"));
    if (settings) {
      applyEnvObject(settings["rest-client.environmentVariables"] as Bag | undefined, join(dir, ".vscode/settings.json"), dir);
      Object.assign(env.certificates, certificatesFrom(settings["rest-client.certificates"], dir));
      if (typeof settings["http.proxy"] === "string" && settings["http.proxy"]) env.proxy = settings["http.proxy"] as string;
      if (settings["http.proxyStrictSSL"] === false) env.certificates["*"] = { ...env.certificates["*"], verify: false };
      if (Array.isArray(settings["rest-client.excludeHostsForProxy"])) env.noProxy.push(...settings["rest-client.excludeHostsForProxy"] as string[]);
      if (settings["rest-client.rememberCookiesForSubsequentRequests"] === false) env.cookieJar = false;
      if (settings["rest-client.defaultHeaders"]) env.defaultHeaders = settings["rest-client.defaultHeaders"] as Record<string, string>;
    }

    const yac = await loadHttpyacConfig(dir);
    if (yac) {
      applyEnvObject(yac.environments as Bag | undefined, join(dir, "httpyac config"), dir);
      Object.assign(env.certificates, certificatesFrom(yac.clientCertificates, dir));
      const request = yac.request as Bag | undefined;
      if (typeof yac.proxy === "string") env.proxy = yac.proxy;
      if (typeof request?.proxy === "string") env.proxy = request.proxy as string;
      if (request?.https && typeof request.https === "object" && (request.https as Bag).rejectUnauthorized === false) env.certificates["*"] = { ...env.certificates["*"], verify: false };
      if (yac.cookieJarEnabled === false) env.cookieJar = false;
      if (yac.defaultHeaders) env.defaultHeaders = yac.defaultHeaders as Record<string, string>;
    }
  }

  for (const layer of dotenvLayers) Object.assign(env.dotenv, layer);
  // .env values are the lowest file-based layer; JSON environments override them.
  Object.assign(env.variables, env.dotenv);
  for (const layer of layers) Object.assign(env.variables, layer);
  if (typeof env.variables.request_proxy === "string") env.proxy = env.variables.request_proxy;
  env.names = [...names].sort();
  return env;
}

/** Read the certificate files for a host into TLS options. */
export function tlsFor(env: Pick<Environment, "certificates">, host: string, port: string): TlsOptions | undefined {
  const cfg = env.certificates[`${host}:${port}`] ?? env.certificates[host] ?? env.certificates["*"];
  if (!cfg) return undefined;
  const read = (p?: string): Buffer | undefined => p ? readFileSync(p) : undefined;
  const isPfx = cfg.pfx || /p12|pfx/i.test(cfg.format ?? "") || /\.(p12|pfx)$/i.test(cfg.cert ?? "");
  return {
    pfx: read(cfg.pfx ?? (isPfx ? cfg.cert : undefined)),
    cert: isPfx ? undefined : read(cfg.cert),
    key: read(cfg.key),
    ca: read(cfg.ca),
    passphrase: cfg.passphrase,
    rejectUnauthorized: cfg.verify,
  };
}
