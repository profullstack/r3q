/**
 * Authorization schemes from http-files.org/spec/auth, applied to a request
 * whose variables are already resolved:
 *
 *   Authorization: Basic user password        base64, VS Code / JetBrains / httpyac
 *   Authorization: Digest user password       challenge-response on the 401
 *   Authorization: AWS key secret [token:..] [region:..] [service:..]   SigV4
 *   Authorization: COGNITO user pass region poolId clientId            SRP login
 *   Authorization: openid <flow> <prefix>     httpyac OAuth2 / OpenID Connect
 *   Authorization: OAuth1 key secret [token tokenSecret] [method:..] [realm:..]   RFC 5849
 *   Authorization: NTLM user password [domain]   NTLMv2 handshake on one connection
 *
 * plus the VS Code token variables {{$aadToken}}, {{$aadV2Token}} and
 * {{$oidcAccessToken}}. Anything else (Bearer, a literal token) is left alone.
 */
import { createHash, createHmac, getDiffieHellman, randomBytes } from "node:crypto";
import http, { createServer, type Server } from "node:http";
import https from "node:https";
import type { HttpResponse, Interaction, PreparedRequest } from "./types.ts";

export interface AuthContext {
  /** Resolved file/env variable lookup (for openid prefix variables). */
  variable(name: string): string | undefined;
  interaction: Interaction;
  /** Raw transport, no auth applied. */
  send(req: PreparedRequest): Promise<HttpResponse>;
  /** Session token cache, keyed by flow and prefix. */
  cache: Map<string, unknown>;
  openUrl?(url: string): void;
}

type AuthResult = {
  request: PreparedRequest;
  onChallenge?: (res: HttpResponse) => Promise<PreparedRequest | undefined>;
  /** Send the request and its challenge retry over this keep-alive agent (NTLM is per connection). */
  agent?: http.Agent;
};

// ── header helpers ──────────────────────────────────────────────────────────

function getHeader(headers: [string, string][], name: string): string | undefined {
  const lower = name.toLowerCase();
  return headers.find(([key]) => key.toLowerCase() === lower)?.[1];
}

function withHeader(req: PreparedRequest, name: string, value: string | undefined): PreparedRequest {
  const lower = name.toLowerCase();
  const headers = req.headers.filter(([key]) => key.toLowerCase() !== lower);
  if (value !== undefined) headers.push([name, value]);
  return { ...req, headers };
}

function words(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

/** `key:value` options after the positional arguments, keys lower-cased. */
function options(tokens: string[]): { positional: string[]; named: Record<string, string> } {
  const positional: string[] = [];
  const named: Record<string, string> = {};
  for (const token of tokens) {
    const colon = token.indexOf(":");
    if (colon > 0 && /^[A-Za-z]+$/.test(token.slice(0, colon))) named[token.slice(0, colon).toLowerCase()] = token.slice(colon + 1);
    else positional.push(token);
  }
  return { positional, named };
}

export async function applyAuth(req: PreparedRequest, ctx: AuthContext): Promise<AuthResult> {
  const value = getHeader(req.headers, "Authorization");
  if (value === undefined) return { request: req };
  const match = /^\s*(\S+)\s*(.*)$/s.exec(value);
  const scheme = match?.[1]?.toLowerCase() ?? "";
  const rest = match?.[2] ?? "";
  switch (scheme) {
    case "basic": return { request: withHeader(req, "Authorization", basicHeader(rest)) };
    case "digest": return digest(req, rest);
    case "aws": return { request: awsAuth(req, rest) };
    case "cognito": return { request: withHeader(req, "Authorization", await cognitoToken(rest, ctx)) };
    case "openid":
    case "oauth2": {
      const [flow = "client_credentials", prefix = "oauth2"] = words(rest);
      const token = await oauth2Token(flow, prefix, ctx);
      return { request: withHeader(req, "Authorization", `Bearer ${token}`) };
    }
    case "oauth1": return { request: withHeader(req, "Authorization", oauth1Header(req, rest)) };
    case "ntlm": return ntlm(req, rest);
    default: return { request: req };
  }
}

// ── Basic ───────────────────────────────────────────────────────────────────

/** `user password`, `user:password`, or an already-encoded token. */
export function basicHeader(rest: string): string {
  const text = rest.trim();
  const space = text.search(/\s/);
  const first = space > 0 ? text.slice(0, space) : text;
  if (first.includes(":")) return `Basic ${Buffer.from(text).toString("base64")}`;
  if (space > 0) return `Basic ${Buffer.from(`${first}:${text.slice(space).trim()}`).toString("base64")}`;
  return `Basic ${text}`;
}

// ── Digest (RFC 7616) ───────────────────────────────────────────────────────

export interface Challenge { scheme: string; params: Record<string, string> }

/** Parse one or more WWW-Authenticate values into challenges. */
export function parseChallenges(header: string): Challenge[] {
  const out: Challenge[] = [];
  let i = 0;
  const s = header;
  const skip = () => { while (i < s.length && /[\s,]/.test(s[i] as string)) i++; };
  while (i < s.length) {
    skip();
    const scheme = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+/.exec(s.slice(i))?.[0];
    if (!scheme) break;
    i += scheme.length;
    const challenge: Challenge = { scheme: scheme.toLowerCase(), params: {} };
    out.push(challenge);
    for (;;) {
      skip();
      const param = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+)\s*=\s*/.exec(s.slice(i));
      if (!param) break;
      i += param[0].length;
      let val = "";
      if (s[i] === '"') {
        i++;
        while (i < s.length && s[i] !== '"') {
          if (s[i] === "\\") i++;
          val += s[i] ?? "";
          i++;
        }
        i++;
      } else {
        const token = /^[^\s,]*/.exec(s.slice(i))?.[0] ?? "";
        val = token;
        i += token.length;
      }
      challenge.params[(param[1] as string).toLowerCase()] = val;
    }
  }
  return out;
}

export interface DigestInput {
  username: string;
  password: string;
  method: string;
  uri: string;
  body?: Buffer;
  cnonce?: string;
  nc?: number;
}

function hashFor(algorithm: string): (data: string | Buffer) => string {
  const name = algorithm.replace(/-sess$/i, "").toUpperCase();
  const node = name === "MD5" ? "md5" : name === "SHA-256" ? "sha256" : name === "SHA-512-256" ? "sha512-256" : undefined;
  if (!node) throw new Error(`Digest algorithm ${algorithm} is not supported`);
  return (data) => createHash(node).update(data).digest("hex");
}

/** The Authorization header value for a Digest challenge. */
export function digestHeader(params: Record<string, string>, input: DigestInput): string {
  const algorithm = params.algorithm ?? "MD5";
  const H = hashFor(algorithm);
  const realm = params.realm ?? "";
  const nonce = params.nonce ?? "";
  const qops = (params.qop ?? "").split(",").map((q) => q.trim()).filter(Boolean);
  const qop = qops.includes("auth") ? "auth" : qops.includes("auth-int") ? "auth-int" : undefined;
  const cnonce = input.cnonce ?? randomBytes(16).toString("hex");
  const nc = (input.nc ?? 1).toString(16).padStart(8, "0");
  let ha1 = H(`${input.username}:${realm}:${input.password}`);
  if (/-sess$/i.test(algorithm)) ha1 = H(`${ha1}:${nonce}:${cnonce}`);
  const ha2 = qop === "auth-int"
    ? H(`${input.method}:${input.uri}:${H(input.body ?? Buffer.alloc(0))}`)
    : H(`${input.method}:${input.uri}`);
  const response = qop ? H(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : H(`${ha1}:${nonce}:${ha2}`);
  const quote = (v: string) => `"${v.replace(/(["\\])/g, "\\$1")}"`;
  const parts = [
    `username=${quote(input.username)}`, `realm=${quote(realm)}`, `nonce=${quote(nonce)}`, `uri=${quote(input.uri)}`,
    `algorithm=${algorithm}`,
  ];
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce=${quote(cnonce)}`);
  parts.push(`response=${quote(response)}`);
  if (params.opaque !== undefined) parts.push(`opaque=${quote(params.opaque)}`);
  return `Digest ${parts.join(", ")}`;
}

function digest(req: PreparedRequest, rest: string): AuthResult {
  const text = rest.trim();
  const space = text.search(/\s/);
  const [username, password] = space > 0 ? [text.slice(0, space), text.slice(space).trim()] : text.split(/:(.*)/s);
  const request = withHeader(req, "Authorization", undefined);
  let nc = 0;
  return {
    request,
    onChallenge: async (res) => {
      if (res.status !== 401) return undefined;
      const challenges = res.headers
        .filter(([key]) => key.toLowerCase() === "www-authenticate")
        .flatMap(([, value]) => parseChallenges(value))
        .filter((c) => c.scheme === "digest");
      const rank = (c: Challenge) => {
        const algo = (c.params.algorithm ?? "MD5").toUpperCase();
        return algo.startsWith("SHA-256") ? 0 : algo.startsWith("SHA-512-256") ? 1 : algo.startsWith("MD5") ? 2 : 9;
      };
      const challenge = challenges.sort((a, b) => rank(a) - rank(b))[0];
      if (!challenge || rank(challenge) === 9) return undefined;
      const url = new URL(request.url);
      nc += 1;
      return withHeader(request, "Authorization", digestHeader(challenge.params, {
        username: username ?? "", password: password ?? "", method: request.method,
        uri: `${url.pathname}${url.search}`, body: request.body, nc,
      }));
    },
  };
}

// ── AWS Signature Version 4 ─────────────────────────────────────────────────

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region?: string;
  service?: string;
}

/** Region and service from an amazonaws.com host, as VS Code REST Client (aws4) infers them. */
export function inferAwsScope(host: string): { region: string; service: string } {
  const labels = host.toLowerCase().replace(/:\d+$/, "").replace(/\.amazonaws\.com(\.cn)?$/, "").split(".");
  const isRegion = (l: string | undefined) => !!l && /^[a-z]{2}(-gov)?-[a-z]+-\d$/.test(l);
  const s3 = labels.findIndex((l) => l === "s3" || l.startsWith("s3-") || l.startsWith("s3."));
  if (s3 >= 0) {
    const label = labels[s3] as string;
    const region = label.startsWith("s3-") && isRegion(label.slice(3)) ? label.slice(3) : isRegion(labels[s3 + 1]) ? labels[s3 + 1] as string : "us-east-1";
    return { region, service: "s3" };
  }
  const last = labels.at(-1);
  if (isRegion(last) && labels.length >= 2) return { region: last as string, service: (labels.at(-2) as string).replace(/-fips$/, "") };
  return { region: "us-east-1", service: (last ?? "execute-api").replace(/-fips$/, "") };
}

const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function canonicalPath(pathname: string, service: string): string {
  const decode = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };
  if (service === "s3") return pathname.split("/").map((seg) => rfc3986(decode(seg))).join("/") || "/";
  const out: string[] = [];
  for (const seg of pathname.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  const trailing = pathname.endsWith("/") && out.length > 0 ? "/" : "";
  return `/${out.map((seg) => rfc3986(rfc3986(decode(seg)))).join("/")}${trailing}`;
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();

/** Sign a request with SigV4. `now` is injectable for tests. */
export function signAwsV4(req: PreparedRequest, creds: AwsCredentials, now: Date = new Date()): PreparedRequest {
  const url = new URL(req.url);
  const inferred = inferAwsScope(url.host);
  const region = creds.region ?? inferred.region;
  const service = creds.service ?? inferred.service;
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const date = amzDate.slice(0, 8);
  const payloadHash = sha256(req.body ?? Buffer.alloc(0));

  let signed = withHeader(withHeader(req, "Authorization", undefined), "X-Amz-Date", amzDate);
  if (!getHeader(signed.headers, "host")) signed = withHeader(signed, "Host", url.host);
  if (creds.sessionToken) signed = withHeader(signed, "X-Amz-Security-Token", creds.sessionToken);
  if (service === "s3" && !getHeader(signed.headers, "x-amz-content-sha256")) signed = withHeader(signed, "X-Amz-Content-Sha256", payloadHash);

  const signable = new Map<string, string[]>();
  for (const [key, val] of signed.headers) {
    const name = key.toLowerCase();
    if (name !== "host" && name !== "content-type" && !name.startsWith("x-amz-")) continue;
    signable.set(name, [...(signable.get(name) ?? []), val.trim().replace(/\s+/g, " ")]);
  }
  const names = [...signable.keys()].sort();
  const canonicalHeaders = names.map((n) => `${n}:${(signable.get(n) as string[]).join(",")}\n`).join("");
  const signedHeaders = names.join(";");
  const query = [...url.searchParams.entries()]
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`).join("&");
  const canonical = [req.method.toUpperCase(), canonicalPath(url.pathname, service), query, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${date}/${region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${creds.secretAccessKey}`, date), region), service), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  return withHeader(signed, "Authorization",
    `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`);
}

function awsAuth(req: PreparedRequest, rest: string): PreparedRequest {
  const { positional, named } = options(words(rest));
  const [accessKeyId, secretAccessKey] = positional;
  if (!accessKeyId || !secretAccessKey) throw new Error("AWS auth needs: AWS <accessKeyId> <secretAccessKey> [token:<session>] [region:<r>] [service:<s>]");
  return signAwsV4(req, { accessKeyId, secretAccessKey, sessionToken: named.token, region: named.region, service: named.service });
}

// ── AWS Cognito (USER_SRP_AUTH) ─────────────────────────────────────────────

const N = BigInt(`0x${getDiffieHellman("modp15").getPrime("hex")}`);
const G = 2n;

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = ((base % mod) + mod) % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

/** amazon-cognito-identity-js padHex: even length, leading 00 when the high bit is set. */
export function padHex(n: bigint): string {
  let hex = n.toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  else if ("89abcdef".includes(hex[0] as string)) hex = `00${hex}`;
  return hex;
}

const hexHash = (hex: string) => sha256(Buffer.from(hex, "hex"));
const K = BigInt(`0x${hexHash(`${padHex(N)}${padHex(G)}`)}`);

/** Cognito's TIMESTAMP: `Tue Feb 1 03:04:05 UTC 2022`, day not padded. */
export function cognitoTimestamp(now: Date): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${days[now.getUTCDay()]} ${months[now.getUTCMonth()]} ${now.getUTCDate()} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())} UTC ${now.getUTCFullYear()}`;
}

/** The SRP client half, separated so it can be checked without a network. */
export function srpPasswordClaim(input: {
  a: bigint; poolId: string; userIdForSrp: string; password: string;
  srpB: string; salt: string; secretBlock: string; timestamp: string;
}): string {
  const A = modPow(G, input.a, N);
  const B = BigInt(`0x${input.srpB}`);
  if (B % N === 0n) throw new Error("Cognito returned an invalid SRP_B");
  const u = BigInt(`0x${hexHash(`${padHex(A)}${padHex(B)}`)}`);
  if (u === 0n) throw new Error("Cognito SRP u is zero");
  const poolName = input.poolId.split("_")[1] ?? "";
  const userHash = sha256(`${poolName}${input.userIdForSrp}:${input.password}`);
  const x = BigInt(`0x${hexHash(`${padHex(BigInt(`0x${input.salt}`))}${userHash}`)}`);
  const gx = modPow(G, x, N);
  const base = (((B - K * gx) % N) + N) % N;
  const S = modPow(base, input.a + u * x, N);
  const prk = createHmac("sha256", Buffer.from(padHex(u), "hex")).update(Buffer.from(padHex(S), "hex")).digest();
  const key = createHmac("sha256", prk).update(Buffer.concat([Buffer.from("Caldera Derived Key"), Buffer.from([1])])).digest().subarray(0, 16);
  return createHmac("sha256", key).update(Buffer.concat([
    Buffer.from(poolName), Buffer.from(input.userIdForSrp), Buffer.from(input.secretBlock, "base64"), Buffer.from(input.timestamp),
  ])).digest("base64");
}

async function cognitoCall(ctx: AuthContext, region: string, target: string, payload: unknown): Promise<Record<string, any>> {
  const body = Buffer.from(JSON.stringify(payload));
  const res = await ctx.send({
    method: "POST",
    url: `https://cognito-idp.${region}.amazonaws.com/`,
    headers: [["Content-Type", "application/x-amz-json-1.1"], ["X-Amz-Target", `AWSCognitoIdentityProviderService.${target}`]],
    body,
  });
  let json: Record<string, any> = {};
  try { json = JSON.parse(res.text); } catch { /* reported below */ }
  if (res.status >= 400) throw new Error(`Cognito ${target} failed: ${json.message ?? json.__type ?? res.status}`);
  return json;
}

/**
 * VS Code REST Client logs in with amazon-cognito-identity-js and sends the
 * session's access token as the bare Authorization value; r3q does the same.
 */
async function cognitoToken(rest: string, ctx: AuthContext): Promise<string> {
  const [username, password, region, poolId, clientId] = words(rest);
  if (!username || !password || !region || !poolId || !clientId) {
    throw new Error("COGNITO auth needs: COGNITO <username> <password> <region> <userPoolId> <clientId>");
  }
  const key = `cognito:${region}:${poolId}:${clientId}:${username}`;
  const cached = ctx.cache.get(key) as { token: string; expires: number } | undefined;
  if (cached && cached.expires > Date.now() + 30_000) return cached.token;

  let a = 0n;
  let A = 0n;
  while (A % N === 0n) {
    a = BigInt(`0x${randomBytes(128).toString("hex")}`) % N;
    A = modPow(G, a, N);
  }
  const init = await cognitoCall(ctx, region, "InitiateAuth", {
    AuthFlow: "USER_SRP_AUTH", ClientId: clientId, AuthParameters: { USERNAME: username, SRP_A: A.toString(16) },
  });
  if (init.ChallengeName !== "PASSWORD_VERIFIER") throw new Error(`Cognito asked for ${init.ChallengeName}; only PASSWORD_VERIFIER is supported`);
  const p = init.ChallengeParameters as Record<string, string>;
  const timestamp = cognitoTimestamp(new Date());
  const signature = srpPasswordClaim({
    a, poolId, userIdForSrp: p.USER_ID_FOR_SRP ?? username, password,
    srpB: p.SRP_B ?? "", salt: p.SALT ?? "", secretBlock: p.SECRET_BLOCK ?? "", timestamp,
  });
  const done = await cognitoCall(ctx, region, "RespondToAuthChallenge", {
    ChallengeName: "PASSWORD_VERIFIER", ClientId: clientId, Session: init.Session,
    ChallengeResponses: {
      USERNAME: p.USER_ID_FOR_SRP ?? username, PASSWORD_CLAIM_SECRET_BLOCK: p.SECRET_BLOCK,
      TIMESTAMP: timestamp, PASSWORD_CLAIM_SIGNATURE: signature,
    },
  });
  const result = done.AuthenticationResult as { AccessToken?: string; ExpiresIn?: number } | undefined;
  if (!result?.AccessToken) throw new Error(`Cognito did not return tokens${done.ChallengeName ? ` (challenge ${done.ChallengeName})` : ""}`);
  ctx.cache.set(key, { token: result.AccessToken, expires: Date.now() + (result.ExpiresIn ?? 3600) * 1000 });
  return result.AccessToken;
}

// ── OAuth 2.0 / OpenID Connect ──────────────────────────────────────────────

interface Token { access_token: string; refresh_token?: string; expires: number; id_token?: string }

interface OAuthConfig {
  tokenEndpoint?: string;
  authorizationEndpoint?: string;
  deviceCodeEndpoint?: string;
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  username?: string;
  password?: string;
  audience?: string;
  resource?: string;
  redirectUri?: string;
  subjectToken?: string;
  subjectTokenType?: string;
  usePkce?: boolean;
  useAuthorizationHeader?: boolean;
  /** Extra form fields for the token request (v1 AAD `resource`, etc.). */
  extra?: Record<string, string>;
}

const FLOWS: Record<string, string> = {
  client_credentials: "client_credentials", client: "client_credentials",
  password: "password",
  authorization_code: "authorization_code", code: "authorization_code",
  implicit: "implicit",
  device_code: "device_code", device: "device_code",
  token_exchange: "token_exchange", exchange: "token_exchange",
  refresh_token: "refresh_token",
};

async function readConfig(prefix: string, ctx: AuthContext): Promise<OAuthConfig> {
  const v = (name: string) => ctx.variable(`${prefix}_${name}`);
  const flag = (name: string) => { const x = v(name); return x === undefined ? undefined : /^(true|1|yes)$/i.test(x); };
  const config: OAuthConfig = {
    tokenEndpoint: v("tokenEndpoint"), authorizationEndpoint: v("authorizationEndpoint"), deviceCodeEndpoint: v("deviceCodeEndpoint"),
    clientId: v("clientId"), clientSecret: v("clientSecret"), scope: v("scope"), username: v("username"), password: v("password"),
    audience: v("audience"), resource: v("resource"), redirectUri: v("redirectUri"),
    subjectToken: v("subjectToken"), subjectTokenType: v("subjectTokenType"),
    usePkce: flag("usePkce"), useAuthorizationHeader: flag("useAuthorizationHeader"),
  };
  const issuer = v("issuer") ?? v("discoveryUrl");
  if (issuer && (!config.tokenEndpoint || !config.authorizationEndpoint || !config.deviceCodeEndpoint)) {
    const url = issuer.includes("/.well-known/") ? issuer : `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
    const res = await ctx.send({ method: "GET", url, headers: [["Accept", "application/json"]] });
    if (res.status < 400) {
      const meta = JSON.parse(res.text) as Record<string, string>;
      config.tokenEndpoint ??= meta.token_endpoint;
      config.authorizationEndpoint ??= meta.authorization_endpoint;
      config.deviceCodeEndpoint ??= meta.device_authorization_endpoint;
    }
  }
  return config;
}

async function postForm(ctx: AuthContext, url: string, form: Record<string, string | undefined>, config: OAuthConfig): Promise<{ status: number; json: Record<string, any> }> {
  const params = new URLSearchParams();
  const headers: [string, string][] = [["Content-Type", "application/x-www-form-urlencoded"], ["Accept", "application/json"]];
  const header = config.clientSecret !== undefined && config.useAuthorizationHeader !== false;
  if (header) {
    const enc = (s: string) => encodeURIComponent(s);
    headers.push(["Authorization", `Basic ${Buffer.from(`${enc(config.clientId ?? "")}:${enc(config.clientSecret ?? "")}`).toString("base64")}`]);
  } else {
    if (config.clientId) params.set("client_id", config.clientId);
    if (config.clientSecret !== undefined) params.set("client_secret", config.clientSecret);
  }
  for (const [k, val] of Object.entries({ ...config.extra, ...form })) if (val !== undefined && val !== "") params.set(k, val);
  const res = await ctx.send({ method: "POST", url, headers, body: Buffer.from(params.toString()) });
  let json: Record<string, any> = {};
  try { json = JSON.parse(res.text); } catch { json = Object.fromEntries(new URLSearchParams(res.text)); }
  return { status: res.status, json };
}

function toToken(json: Record<string, any>, previous?: Token): Token {
  if (!json.access_token) throw new Error(`token endpoint returned no access_token${json.error ? `: ${json.error}${json.error_description ? ` (${json.error_description})` : ""}` : ""}`);
  const expiresIn = Number(json.expires_in ?? 3600);
  return {
    access_token: String(json.access_token),
    refresh_token: json.refresh_token ?? previous?.refresh_token,
    id_token: json.id_token,
    expires: Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000,
  };
}

async function tokenRequest(ctx: AuthContext, config: OAuthConfig, form: Record<string, string | undefined>): Promise<Token> {
  if (!config.tokenEndpoint) throw new Error("OAuth2 needs a token endpoint (<prefix>_tokenEndpoint or <prefix>_issuer)");
  const { status, json } = await postForm(ctx, config.tokenEndpoint, form, config);
  if (status >= 400) throw new Error(`token request failed (${status}): ${json.error ?? ""} ${json.error_description ?? ""}`.trim());
  return toToken(json);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait for a browser redirect to a local callback. `fragment` serves a page that posts location.hash back. */
async function callback(
  ctx: AuthContext, redirectUri: string | undefined, fragment: boolean,
  buildUrl: (redirectUri: string) => string,
): Promise<URLSearchParams> {
  const wanted = redirectUri ? new URL(redirectUri) : undefined;
  const local = !wanted || ["localhost", "127.0.0.1", "[::1]"].includes(wanted.hostname);
  if (!local) throw new Error(`redirect URI ${redirectUri} is not local; r3q can only receive callbacks on localhost`);
  const path = wanted?.pathname && wanted.pathname !== "/" ? wanted.pathname : "/callback";
  let server: Server | undefined;
  try {
    return await new Promise<URLSearchParams>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for the OAuth2 redirect (5 minutes)")), 300_000);
      server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname === `${path}/fragment`) {
          clearTimeout(timer);
          res.end("Signed in. You can close this window and return to r3q.");
          resolve(new URLSearchParams(url.search));
          return;
        }
        if (url.pathname !== path) { res.statusCode = 404; res.end(); return; }
        if (fragment) {
          res.setHeader("Content-Type", "text/html");
          res.end(`<!doctype html><meta charset="utf-8"><title>r3q</title><p>Finishing sign-in…</p><script>location.replace(${JSON.stringify(`${path}/fragment`)} + "?" + location.hash.slice(1))</script>`);
          return;
        }
        clearTimeout(timer);
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Signed in. You can close this window and return to r3q.");
        resolve(url.searchParams);
      });
      server.on("error", (error) => { clearTimeout(timer); reject(error); });
      server.listen(wanted?.port ? Number(wanted.port) : 0, "127.0.0.1", () => {
        const address = server?.address();
        const port = typeof address === "object" && address ? address.port : 0;
        const uri = wanted ? wanted.toString() : `http://127.0.0.1:${port}${path}`;
        const url = buildUrl(uri);
        ctx.interaction.log(`Open this URL to sign in: ${url}`);
        ctx.openUrl?.(url);
      });
    });
  } finally {
    server?.close();
  }
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function authorizationCode(ctx: AuthContext, config: OAuthConfig): Promise<Token> {
  if (!config.authorizationEndpoint) throw new Error("authorization_code needs <prefix>_authorizationEndpoint");
  const state = randomBytes(16).toString("hex");
  const challenge = config.usePkce ? pkce() : undefined;
  let redirect = "";
  const params = await callback(ctx, config.redirectUri, false, (uri) => {
    redirect = uri;
    const url = new URL(config.authorizationEndpoint as string);
    url.searchParams.set("response_type", "code");
    if (config.clientId) url.searchParams.set("client_id", config.clientId);
    url.searchParams.set("redirect_uri", uri);
    url.searchParams.set("state", state);
    if (config.scope) url.searchParams.set("scope", config.scope);
    if (config.audience) url.searchParams.set("audience", config.audience);
    if (config.resource) url.searchParams.set("resource", config.resource);
    if (challenge) { url.searchParams.set("code_challenge", challenge.challenge); url.searchParams.set("code_challenge_method", "S256"); }
    return url.toString();
  });
  if (params.get("error")) throw new Error(`authorization failed: ${params.get("error")} ${params.get("error_description") ?? ""}`.trim());
  if (params.get("state") !== state) throw new Error("authorization callback state did not match");
  const code = params.get("code");
  if (!code) throw new Error("authorization callback had no code");
  return tokenRequest(ctx, config, { grant_type: "authorization_code", code, redirect_uri: redirect, code_verifier: challenge?.verifier });
}

async function implicit(ctx: AuthContext, config: OAuthConfig): Promise<Token> {
  if (!config.authorizationEndpoint) throw new Error("implicit needs <prefix>_authorizationEndpoint");
  const state = randomBytes(16).toString("hex");
  const params = await callback(ctx, config.redirectUri, true, (uri) => {
    const url = new URL(config.authorizationEndpoint as string);
    url.searchParams.set("response_type", "token");
    if (config.clientId) url.searchParams.set("client_id", config.clientId);
    url.searchParams.set("redirect_uri", uri);
    url.searchParams.set("state", state);
    if (config.scope) url.searchParams.set("scope", config.scope);
    if (config.audience) url.searchParams.set("audience", config.audience);
    return url.toString();
  });
  if (params.get("error")) throw new Error(`authorization failed: ${params.get("error")}`);
  if (params.get("state") !== state) throw new Error("authorization callback state did not match");
  return toToken(Object.fromEntries(params));
}

/** RFC 8628, plus the AAD v1 variant (verification_url, grant_type=device_code, code=). */
async function deviceCode(ctx: AuthContext, config: OAuthConfig, v1 = false): Promise<Token> {
  if (!config.deviceCodeEndpoint) throw new Error("device_code needs <prefix>_deviceCodeEndpoint");
  const start = await postForm(ctx, config.deviceCodeEndpoint, { scope: config.scope, audience: config.audience, client_id: config.clientId }, { ...config, clientSecret: undefined });
  if (start.status >= 400) throw new Error(`device authorization failed (${start.status}): ${start.json.error ?? ""} ${start.json.error_description ?? ""}`.trim());
  const d = start.json;
  const uri = d.verification_uri_complete ?? d.verification_uri ?? d.verification_url;
  ctx.interaction.log(d.message ?? `To sign in, open ${uri} and enter the code ${d.user_code}`);
  if (d.verification_uri_complete) ctx.openUrl?.(d.verification_uri_complete);
  let interval = Number(d.interval ?? 5) * 1000;
  const deadline = Date.now() + Number(d.expires_in ?? 900) * 1000;
  while (Date.now() < deadline) {
    await sleep(interval);
    const form = v1
      ? { grant_type: "device_code", code: d.device_code, client_id: config.clientId }
      : { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: d.device_code, client_id: config.clientId };
    const { status, json } = await postForm(ctx, config.tokenEndpoint ?? "", form, config);
    if (status < 400 && json.access_token) return toToken(json);
    if (json.error === "authorization_pending") continue;
    if (json.error === "slow_down") { interval += 5000; continue; }
    throw new Error(`device code sign-in failed: ${json.error ?? status} ${json.error_description ?? ""}`.trim());
  }
  throw new Error("device code expired before sign-in finished");
}

async function runFlow(flow: string, ctx: AuthContext, config: OAuthConfig): Promise<Token> {
  switch (flow) {
    case "client_credentials":
      return tokenRequest(ctx, config, { grant_type: "client_credentials", scope: config.scope, audience: config.audience, resource: config.resource });
    case "password":
      return tokenRequest(ctx, config, { grant_type: "password", username: config.username, password: config.password, scope: config.scope, audience: config.audience, resource: config.resource });
    case "authorization_code": return authorizationCode(ctx, config);
    case "implicit": return implicit(ctx, config);
    case "device_code": return deviceCode(ctx, config);
    case "token_exchange":
      if (!config.subjectToken) throw new Error("token_exchange needs <prefix>_subjectToken");
      return tokenRequest(ctx, config, {
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: config.subjectToken,
        subject_token_type: config.subjectTokenType ?? "urn:ietf:params:oauth:token-type:access_token",
        audience: config.audience, resource: config.resource, scope: config.scope,
      });
    default: throw new Error(`unknown OAuth2 flow ${flow}`);
  }
}

/** Cached token for a key: fresh, refreshed, or newly obtained. */
async function cachedToken(key: string, ctx: AuthContext, config: OAuthConfig, obtain: () => Promise<Token>, force = false): Promise<Token> {
  const cached = ctx.cache.get(key) as Token | undefined;
  if (!force && cached && cached.expires > Date.now() + 30_000) return cached;
  if (!force && cached?.refresh_token && config.tokenEndpoint) {
    try {
      const { status, json } = await postForm(ctx, config.tokenEndpoint, { grant_type: "refresh_token", refresh_token: cached.refresh_token, scope: config.scope }, config);
      if (status < 400 && json.access_token) {
        const token = toToken(json, cached);
        ctx.cache.set(key, token);
        return token;
      }
    } catch { /* fall through to a fresh sign-in */ }
  }
  const token = await obtain();
  ctx.cache.set(key, token);
  return token;
}

/** httpyac `openid <flow> <prefix>`: returns the access token. */
export async function oauth2Token(flowName: string, prefix: string, ctx: AuthContext): Promise<string> {
  const flow = FLOWS[flowName.toLowerCase()];
  if (!flow) throw new Error(`unknown OAuth2 flow ${flowName} (client_credentials, password, authorization_code, implicit, device_code, token_exchange)`);
  const config = await readConfig(prefix, ctx);
  const token = await cachedToken(`oauth2:${flow}:${prefix}`, ctx, config, () => runFlow(flow, ctx, config));
  return token.access_token;
}

// ── VS Code token variables ─────────────────────────────────────────────────

/** Azure CLI's public client id: a first-party app every tenant accepts for device code. */
const AZURE_CLI_CLIENT = "04b07795-8ddb-461a-bbee-02f9e1bf7b46";
const AAD_CLOUDS: Record<string, string> = {
  public: "https://login.microsoftonline.com",
  cn: "https://login.chinacloudapi.cn",
  de: "https://login.microsoftonline.de",
  us: "https://login.microsoftonline.us",
  ppe: "https://login.windows-ppe.net",
};
const AAD_RESOURCES: Record<string, string> = {
  public: "https://management.core.windows.net/",
  cn: "https://management.core.chinacloudapi.cn/",
  de: "https://management.core.cloudapi.de/",
  us: "https://management.core.usgovcloudapi.net/",
  ppe: "https://umapi-preview.core.windows-ppe.net/",
};

export async function tokenVariable(name: "$aadToken" | "$aadV2Token" | "$oidcAccessToken", args: string, ctx: AuthContext): Promise<string> {
  const { positional, named } = options(words(args));
  const force = positional.includes("new");
  const rest = positional.filter((p) => p !== "new");

  if (name === "$aadV2Token") {
    const appOnly = rest.includes("appOnly") || rest.includes("apponly");
    const tenant = named.tenantid ?? ctx.variable("aadV2TenantId") ?? (appOnly ? undefined : "common");
    if (!tenant) throw new Error("$aadV2Token appOnly needs tenantId:<id> or an aadV2TenantId variable");
    const cloud = AAD_CLOUDS[rest.find((p) => p in AAD_CLOUDS) ?? "public"] as string;
    const clientId = named.clientid ?? ctx.variable("aadV2ClientId") ?? (appOnly ? undefined : AZURE_CLI_CLIENT);
    if (!clientId) throw new Error("$aadV2Token appOnly needs clientId:<id> or an aadV2ClientId variable");
    const scopes = named.scopes?.split(",").join(" ") ?? (appOnly ? "https://graph.microsoft.com/.default" : "openid profile offline_access");
    const config: OAuthConfig = {
      clientId, scope: scopes,
      tokenEndpoint: `${cloud}/${tenant}/oauth2/v2.0/token`,
      deviceCodeEndpoint: `${cloud}/${tenant}/oauth2/v2.0/devicecode`,
      useAuthorizationHeader: false,
    };
    if (appOnly) {
      config.clientSecret = ctx.variable("aadV2ClientSecret");
      if (config.clientSecret === undefined) throw new Error("$aadV2Token appOnly needs an aadV2ClientSecret variable");
    }
    const key = `aadV2:${tenant}:${clientId}:${scopes}:${appOnly}`;
    const token = await cachedToken(key, ctx, config, () =>
      appOnly ? tokenRequest(ctx, config, { grant_type: "client_credentials", scope: scopes }) : deviceCode(ctx, config), force);
    return `Bearer ${token.access_token}`;
  }

  if (name === "$aadToken") {
    const cloudName = rest.find((p) => p in AAD_CLOUDS) ?? "public";
    const cloud = AAD_CLOUDS[cloudName] as string;
    const tenant = rest.find((p) => !(p in AAD_CLOUDS)) ?? "common";
    const resource = named.aud ?? AAD_RESOURCES[cloudName] as string;
    const resolvedResource = /^https?:/.test(resource) ? resource : `https://${resource}/`;
    const config: OAuthConfig = {
      clientId: AZURE_CLI_CLIENT,
      tokenEndpoint: `${cloud}/${tenant}/oauth2/token`,
      deviceCodeEndpoint: `${cloud}/${tenant}/oauth2/devicecode?api-version=1.0`,
      extra: { resource: resolvedResource },
    };
    const token = await cachedToken(`aad:${cloud}:${tenant}:${resolvedResource}`, ctx, config, () => deviceCode(ctx, config, true), force);
    return `Bearer ${token.access_token}`;
  }

  // $oidcAccessToken: authorization code + PKCE on a local callback port.
  const port = named.callbackport ?? "7777";
  const config: OAuthConfig = {
    clientId: named.clientid,
    authorizationEndpoint: named.authorizeendpoint,
    tokenEndpoint: named.tokenendpoint,
    scope: named.scopes?.split(",").join(" ") ?? "openid profile",
    audience: named.audience,
    redirectUri: named.callbackdomain ? `http://${named.callbackdomain}:${port}/callback` : `http://localhost:${port}/callback`,
    usePkce: true,
  };
  if (!config.clientId || !config.authorizationEndpoint || !config.tokenEndpoint) {
    throw new Error("$oidcAccessToken needs clientId:, authorizeEndpoint: and tokenEndpoint:");
  }
  const key = `oidc:${config.authorizationEndpoint}:${config.clientId}:${config.scope}`;
  const token = await cachedToken(key, ctx, config, () => authorizationCode(ctx, config), force);
  return `Bearer ${token.access_token}`;
}

// ── OAuth 1.0a (RFC 5849) ───────────────────────────────────────────────────

const OAUTH1_HASH: Record<string, string> = { "HMAC-SHA1": "sha1", "HMAC-SHA256": "sha256", "HMAC-SHA512": "sha512" };

/**
 * `OAuth1 consumerKey consumerSecret [token tokenSecret]` with optional
 * `method:` `realm:` `callback:` `verifier:` `nonce:` `timestamp:` `body:false`.
 * Form bodies are signed (RFC 5849 3.4.1.3) unless `body:false`.
 */
export function oauth1Header(req: PreparedRequest, spec: string, now: Date = new Date()): string {
  const { positional, named } = options(words(spec));
  const [consumerKey, consumerSecret = "", token, tokenSecret = ""] = positional;
  if (!consumerKey) throw new Error("OAuth1: expected `OAuth1 consumerKey consumerSecret [token tokenSecret]`");
  const method = (named.method ?? "HMAC-SHA1").toUpperCase();
  if (method !== "PLAINTEXT" && !OAUTH1_HASH[method]) throw new Error(`OAuth1: unsupported signature method ${method} (HMAC-SHA1, HMAC-SHA256, HMAC-SHA512, PLAINTEXT)`);
  const oauth: [string, string][] = [
    ["oauth_consumer_key", consumerKey],
    ["oauth_nonce", named.nonce ?? randomBytes(16).toString("hex")],
    ["oauth_signature_method", method],
    ["oauth_timestamp", named.timestamp ?? String(Math.floor(now.getTime() / 1000))],
    ["oauth_version", "1.0"],
  ];
  if (token) oauth.push(["oauth_token", token]);
  if (named.callback) oauth.push(["oauth_callback", named.callback]);
  if (named.verifier) oauth.push(["oauth_verifier", named.verifier]);

  const key = `${rfc3986(consumerSecret)}&${rfc3986(tokenSecret)}`;
  let signature: string;
  if (method === "PLAINTEXT") signature = key;
  else {
    const url = new URL(req.url);
    const params: [string, string][] = [...oauth];
    for (const [k, v] of url.searchParams) params.push([k, v]);
    const contentType = getHeader(req.headers, "Content-Type") ?? "";
    if (named.body !== "false" && req.body && /application\/x-www-form-urlencoded/i.test(contentType)) {
      for (const [k, v] of new URLSearchParams(req.body.toString("utf8"))) params.push([k, v]);
    }
    const normalized = params
      .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
      .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)
      .map(([k, v]) => `${k}=${v}`).join("&");
    const scheme = url.protocol.toLowerCase();
    const base = `${scheme}//${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ""}${url.pathname}`;
    const baseString = `${req.method.toUpperCase()}&${rfc3986(base)}&${rfc3986(normalized)}`;
    signature = createHmac(OAUTH1_HASH[method]!, key).update(baseString).digest("base64");
  }
  oauth.push(["oauth_signature", signature]);
  const fields = oauth.map(([k, v]) => `${k}="${rfc3986(v)}"`);
  if (named.realm !== undefined) fields.unshift(`realm="${named.realm.replace(/"/g, '\\"')}"`);
  return `OAuth ${fields.join(", ")}`;
}

// ── NTLMv2 (MS-NLMP) ────────────────────────────────────────────────────────

/** MD4 (RFC 1320), in JavaScript because OpenSSL 3 moved it to the legacy provider. */
export function md4(input: Buffer | string): Buffer {
  const msg = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  const padLen = ((msg.length + 8) >> 6 << 6) + 64 - msg.length;
  const data = Buffer.alloc(msg.length + padLen);
  msg.copy(data);
  data[msg.length] = 0x80;
  data.writeBigUInt64LE(BigInt(msg.length) * 8n, data.length - 8);
  let a = 0x67452301, b = 0xefcdab89 | 0, c = 0x98badcfe | 0, d = 0x10325476;
  const rotl = (x: number, n: number): number => (x << n) | (x >>> (32 - n));
  const F = (p: number, q: number, r: number): number => (p & q) | (~p & r);
  const G = (p: number, q: number, r: number): number => (p & q) | (p & r) | (q & r);
  const H = (p: number, q: number, r: number): number => p ^ q ^ r;
  const x = new Array<number>(16);
  for (let off = 0; off < data.length; off += 64) {
    for (let i = 0; i < 16; i++) x[i] = data.readInt32LE(off + i * 4);
    const aa = a, bb = b, cc = c, dd = d;
    for (const k of [0, 4, 8, 12]) {
      a = rotl((a + F(b, c, d) + x[k]!) | 0, 3);
      d = rotl((d + F(a, b, c) + x[k + 1]!) | 0, 7);
      c = rotl((c + F(d, a, b) + x[k + 2]!) | 0, 11);
      b = rotl((b + F(c, d, a) + x[k + 3]!) | 0, 19);
    }
    for (const k of [0, 1, 2, 3]) {
      a = rotl((a + G(b, c, d) + x[k]! + 0x5a827999) | 0, 3);
      d = rotl((d + G(a, b, c) + x[k + 4]! + 0x5a827999) | 0, 5);
      c = rotl((c + G(d, a, b) + x[k + 8]! + 0x5a827999) | 0, 9);
      b = rotl((b + G(c, d, a) + x[k + 12]! + 0x5a827999) | 0, 13);
    }
    for (const k of [0, 2, 1, 3]) {
      a = rotl((a + H(b, c, d) + x[k]! + 0x6ed9eba1) | 0, 3);
      d = rotl((d + H(a, b, c) + x[k + 8]! + 0x6ed9eba1) | 0, 9);
      c = rotl((c + H(d, a, b) + x[k + 4]! + 0x6ed9eba1) | 0, 11);
      b = rotl((b + H(c, d, a) + x[k + 12]! + 0x6ed9eba1) | 0, 15);
    }
    a = (a + aa) | 0; b = (b + bb) | 0; c = (c + cc) | 0; d = (d + dd) | 0;
  }
  const out = Buffer.alloc(16);
  out.writeInt32LE(a, 0); out.writeInt32LE(b, 4); out.writeInt32LE(c, 8); out.writeInt32LE(d, 12);
  return out;
}

const NTLM_SIGNATURE = Buffer.from("NTLMSSP\0", "latin1");
const NTLM_FLAGS = (0x00000001 /* unicode */ | 0x00000004 /* request target */ | 0x00000200 /* NTLM */
  | 0x00008000 /* always sign */ | 0x00080000 /* extended session security */ | 0x00800000 /* target info */
  | 0x20000000 /* 128-bit */ | 0x80000000 /* 56-bit */) >>> 0;
const utf16 = (s: string): Buffer => Buffer.from(s, "utf16le");
const hmacMd5 = (key: Buffer, ...data: Buffer[]): Buffer => { const h = createHmac("md5", key); for (const d of data) h.update(d); return h.digest(); };

/** Type 1 (negotiate), base64. */
export function ntlmType1(): string {
  const msg = Buffer.alloc(32);
  NTLM_SIGNATURE.copy(msg, 0);
  msg.writeUInt32LE(1, 8);
  msg.writeUInt32LE(NTLM_FLAGS, 12);
  msg.writeUInt32LE(32, 20); // empty domain, offset past the header
  msg.writeUInt32LE(32, 28); // empty workstation
  return msg.toString("base64");
}

export interface NtlmChallenge { flags: number; challenge: Buffer; targetName: string; targetInfo: Buffer; timestamp?: Buffer }

/** Type 2 (challenge), from a `WWW-Authenticate: NTLM <base64>` value or the bare base64. */
export function parseType2(value: string): NtlmChallenge {
  const msg = Buffer.from(value.trim().replace(/^NTLM\s+/i, ""), "base64");
  if (msg.length < 32 || !msg.subarray(0, 8).equals(NTLM_SIGNATURE) || msg.readUInt32LE(8) !== 2) throw new Error("NTLM: the server's challenge is not an NTLM type 2 message");
  const field = (at: number): Buffer => {
    if (msg.length < at + 8) return Buffer.alloc(0);
    const len = msg.readUInt16LE(at), off = msg.readUInt32LE(at + 4);
    return Buffer.from(msg.subarray(off, off + len));
  };
  const flags = msg.readUInt32LE(20);
  const targetInfo = field(40);
  let timestamp: Buffer | undefined;
  for (let i = 0; i + 4 <= targetInfo.length;) {
    const id = targetInfo.readUInt16LE(i), len = targetInfo.readUInt16LE(i + 2);
    if (id === 0) break;
    if (id === 7) timestamp = Buffer.from(targetInfo.subarray(i + 4, i + 4 + len));
    i += 4 + len;
  }
  const name = field(12);
  return { flags, challenge: Buffer.from(msg.subarray(24, 32)), targetName: flags & 1 ? name.toString("utf16le") : name.toString("latin1"), targetInfo, timestamp };
}

/** NTOWFv2: HMAC-MD5(MD4(UTF-16LE password), UTF-16LE(UPPER(user) + domain)). */
export function ntowfv2(user: string, password: string, domain: string): Buffer {
  return hmacMd5(md4(utf16(password)), utf16(user.toUpperCase() + domain));
}

/** The NTLMv2 and LMv2 responses to a server challenge. */
export function ntlmv2Response(input: { user: string; password: string; domain: string; serverChallenge: Buffer; clientChallenge: Buffer; timestamp: Buffer; targetInfo: Buffer }): { nt: Buffer; lm: Buffer; ntProof: Buffer } {
  const key = ntowfv2(input.user, input.password, input.domain);
  const temp = Buffer.concat([
    Buffer.from([1, 1, 0, 0, 0, 0, 0, 0]), input.timestamp, input.clientChallenge,
    Buffer.alloc(4), input.targetInfo, Buffer.alloc(4),
  ]);
  const ntProof = hmacMd5(key, input.serverChallenge, temp);
  const lm = Buffer.concat([hmacMd5(key, input.serverChallenge, input.clientChallenge), input.clientChallenge]);
  return { nt: Buffer.concat([ntProof, temp]), lm, ntProof };
}

/** Windows FILETIME (100 ns ticks since 1601), 8 bytes little-endian. */
function filetime(now: Date): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE((BigInt(now.getTime()) + 11644473600000n) * 10000n);
  return out;
}

/** Type 3 (authenticate), base64. */
export function ntlmType3(challenge: NtlmChallenge, creds: { user: string; password: string; domain: string; workstation?: string }, opts: { clientChallenge?: Buffer; now?: Date } = {}): string {
  const clientChallenge = opts.clientChallenge ?? randomBytes(8);
  const timestamp = challenge.timestamp ?? filetime(opts.now ?? new Date());
  const { nt, lm } = ntlmv2Response({ ...creds, serverChallenge: challenge.challenge, clientChallenge, timestamp, targetInfo: challenge.targetInfo });
  // When the server sends a timestamp, MS-NLMP 3.1.5.1.2 sends a zero LMv2 response.
  const lmResponse = challenge.timestamp ? Buffer.alloc(24) : lm;
  const fields = [lmResponse, nt, utf16(creds.domain), utf16(creds.user), utf16(creds.workstation ?? ""), Buffer.alloc(0)];
  const header = Buffer.alloc(64);
  NTLM_SIGNATURE.copy(header, 0);
  header.writeUInt32LE(3, 8);
  let offset = 64;
  fields.forEach((f, i) => {
    const at = 12 + i * 8;
    header.writeUInt16LE(f.length, at);
    header.writeUInt16LE(f.length, at + 2);
    header.writeUInt32LE(offset, at + 4);
    offset += f.length;
  });
  header.writeUInt32LE(((NTLM_FLAGS & challenge.flags) | 0x00000201) >>> 0, 60);
  return Buffer.concat([header, ...fields]).toString("base64");
}

/** `user password [domain]` or `DOMAIN\user password`. */
export function ntlmCredentials(rest: string): { user: string; password: string; domain: string } {
  const [who = "", password = "", domainArg] = words(rest);
  if (!who) throw new Error("NTLM: expected `NTLM user password [domain]`");
  const slash = who.indexOf("\\");
  if (slash > 0) return { user: who.slice(slash + 1), password, domain: domainArg ?? who.slice(0, slash) };
  return { user: who, password, domain: domainArg ?? "" };
}

function ntlm(req: PreparedRequest, rest: string): AuthResult {
  const creds = ntlmCredentials(rest);
  // NTLM authenticates the connection, so the negotiate and the authenticate must share one socket.
  const agent = new URL(req.url).protocol === "https:" ? new https.Agent({ keepAlive: true, maxSockets: 1 }) : new http.Agent({ keepAlive: true, maxSockets: 1 });
  return {
    agent,
    request: withHeader(req, "Authorization", `NTLM ${ntlmType1()}`),
    onChallenge: async (res) => {
      const offer = res.headers.filter(([k]) => k.toLowerCase() === "www-authenticate").map(([, v]) => v.trim()).find((v) => /^NTLM\s+\S/i.test(v));
      if (!offer) return undefined;
      return withHeader(req, "Authorization", `NTLM ${ntlmType3(parseType2(offer), creds)}`);
    },
  };
}
