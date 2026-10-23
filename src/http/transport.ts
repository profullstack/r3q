/**
 * The wire. Built on node:http/https/http2 rather than fetch, because the spec
 * needs what fetch hides: client certificates and `@no-reject-unauthorized`,
 * proxies (`@proxy`, `request_proxy`, HTTP(S)_PROXY, socks5), HTTP/2 on request
 * (`GET url HTTP/2`), connect and read timeouts, `@no-redirect` with cookies
 * applied on every hop, and methods fetch refuses (TRACE, CONNECT, WebDAV).
 */
import http from "node:http";
import https from "node:https";
import http2 from "node:http2";
import net from "node:net";
import tls from "node:tls";
import zlib from "node:zlib";
import type { CookieJar } from "./cookies.ts";
import type { HttpResponse, PreparedRequest, TlsOptions } from "./types.ts";

export interface TransportOptions {
  followRedirects?: boolean;
  maxRedirects?: number;
  /** Read timeout: no response bytes for this long aborts. */
  timeoutMs?: number;
  connectTimeoutMs?: number;
  tls?: (host: string, port: string) => TlsOptions | undefined;
  /** False accepts self-signed certificates (`@no-reject-unauthorized`). */
  rejectUnauthorized?: boolean;
  /** Skip client certificates (`@no-client-cert`). */
  noClientCert?: boolean;
  proxy?: string;
  noProxy?: string[];
  cookies?: CookieJar;
  signal?: AbortSignal;
  /** Called with each hop for `@debug`/`@verbose`. */
  log?: (line: string) => void;
}

/** HTTP(S)_PROXY / NO_PROXY from the environment, the way curl reads them. */
export function environmentProxy(url: URL): string | undefined {
  const env = process.env;
  const noProxy = (env.NO_PROXY ?? env.no_proxy ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (bypass(url.hostname, noProxy)) return undefined;
  if (url.protocol === "https:" || url.protocol === "wss:") return env.HTTPS_PROXY ?? env.https_proxy ?? env.ALL_PROXY ?? env.all_proxy;
  return env.HTTP_PROXY ?? env.http_proxy ?? env.ALL_PROXY ?? env.all_proxy;
}

function bypass(host: string, list: string[]): boolean {
  return list.some((entry) => {
    if (entry === "*") return true;
    const e = entry.replace(/^\*?\./, "").toLowerCase();
    return host === e || host.endsWith(`.${e}`);
  });
}

function connectTimeout<T extends net.Socket>(socket: T, ms: number | undefined, reject: (e: Error) => void): T {
  if (!ms) return socket;
  const timer = setTimeout(() => { socket.destroy(); reject(new Error(`connection timed out after ${ms}ms`)); }, ms);
  socket.once("connect", () => clearTimeout(timer));
  socket.once("secureConnect", () => clearTimeout(timer));
  socket.once("error", () => clearTimeout(timer));
  socket.once("close", () => clearTimeout(timer));
  return socket;
}

/** Open a raw socket to host:port through a proxy (HTTP CONNECT or SOCKS5). */
export async function tunnel(proxyUrl: string, host: string, port: number, opts: TransportOptions): Promise<net.Socket> {
  const proxy = new URL(proxyUrl);
  const proxyPort = Number(proxy.port || (proxy.protocol === "https:" ? 443 : proxy.protocol.startsWith("socks") ? 1080 : 80));
  if (proxy.protocol.startsWith("socks")) return socks5(proxy, proxyPort, host, port, opts);
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: `${host}:${port}` };
    if (proxy.username) headers["proxy-authorization"] = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`;
    const lib = proxy.protocol === "https:" ? https : http;
    const req = lib.request({ host: proxy.hostname, port: proxyPort, method: "CONNECT", path: `${host}:${port}`, headers, rejectUnauthorized: opts.rejectUnauthorized });
    req.once("connect", (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); reject(new Error(`proxy CONNECT ${host}:${port} failed: ${res.statusCode} ${res.statusMessage}`)); return; }
      resolve(socket);
    });
    req.once("error", reject);
    req.end();
  });
}

function socks5(proxy: URL, proxyPort: number, host: string, port: number, opts: TransportOptions): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = connectTimeout(net.connect(proxyPort, proxy.hostname), opts.connectTimeoutMs, reject);
    const user = decodeURIComponent(proxy.username);
    const pass = decodeURIComponent(proxy.password);
    let stage = 0;
    let buffer = Buffer.alloc(0);
    socket.once("error", reject);
    socket.on("connect", () => socket.write(Buffer.from(user ? [5, 2, 0, 2] : [5, 1, 0])));
    const sendConnect = (): void => {
      const name = Buffer.from(host);
      socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([port >> 8, port & 255])]));
      stage = 2;
    };
    socket.on("data", function onData(chunk: Buffer) {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 0 && buffer.length >= 2) {
        const method = buffer[1];
        buffer = buffer.subarray(2);
        if (method === 2) {
          const u = Buffer.from(user);
          const p = Buffer.from(pass);
          socket.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
          stage = 1;
        } else if (method === 0) sendConnect();
        else { socket.destroy(); reject(new Error("SOCKS5 proxy refused every authentication method")); }
      } else if (stage === 1 && buffer.length >= 2) {
        if (buffer[1] !== 0) { socket.destroy(); reject(new Error("SOCKS5 proxy rejected the username/password")); return; }
        buffer = buffer.subarray(2);
        sendConnect();
      } else if (stage === 2 && buffer.length >= 5) {
        if (buffer[1] !== 0) { socket.destroy(); reject(new Error(`SOCKS5 connect to ${host}:${port} failed (code ${buffer[1]})`)); return; }
        const atyp = buffer[3];
        const len = atyp === 1 ? 10 : atyp === 4 ? 22 : 7 + buffer[4]!;
        if (buffer.length < len) return;
        socket.removeListener("data", onData);
        const rest = buffer.subarray(len);
        if (rest.length) socket.unshift(rest);
        resolve(socket);
      }
    });
  });
}

function decompress(body: Buffer, encoding: string): Buffer {
  const list = encoding.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean).reverse();
  let out = body;
  for (const enc of list) {
    try {
      if (enc === "gzip" || enc === "x-gzip") out = zlib.gunzipSync(out, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
      else if (enc === "deflate") { try { out = zlib.inflateSync(out); } catch { out = zlib.inflateRawSync(out); } }
      else if (enc === "br") out = zlib.brotliDecompressSync(out);
      else if (enc === "zstd" && "zstdDecompressSync" in zlib) out = (zlib as unknown as { zstdDecompressSync(b: Buffer): Buffer }).zstdDecompressSync(out);
    } catch { return body; }
  }
  return out;
}

/** Decode a body per the charset in Content-Type (UTF-8 by default). */
export function decodeText(body: Buffer, contentType: string): string {
  const charset = /charset\s*=\s*"?([\w-]+)/i.exec(contentType)?.[1] ?? "utf-8";
  try { return new TextDecoder(charset).decode(body); } catch { return body.toString("utf8"); }
}

const ACCEPT_ENCODING = "gzip, deflate, br";

function tlsFor(url: URL, opts: TransportOptions): tls.ConnectionOptions {
  const port = url.port || "443";
  const material = opts.noClientCert ? undefined : opts.tls?.(url.hostname, port);
  const out: tls.ConnectionOptions = { servername: net.isIP(url.hostname) ? undefined : url.hostname };
  if (material?.cert) out.cert = material.cert;
  if (material?.key) out.key = material.key;
  if (material?.pfx) out.pfx = material.pfx;
  if (material?.passphrase) out.passphrase = material.passphrase;
  if (material?.ca) out.ca = material.ca;
  const reject = opts.rejectUnauthorized ?? material?.rejectUnauthorized;
  if (reject === false) out.rejectUnauthorized = false;
  return out;
}

interface Hop { status: number; statusText: string; httpVersion: string; headers: [string, string][]; body: Buffer }

async function once(req: PreparedRequest, opts: TransportOptions): Promise<Hop> {
  const url = new URL(req.url);
  const proxy = opts.proxy && !bypass(url.hostname, opts.noProxy ?? []) ? opts.proxy : environmentProxy(url);
  if (/^HTTP\/2/i.test(req.httpVersion ?? "")) return once2(req, url, proxy, opts);
  const secure = url.protocol === "https:";
  const port = Number(url.port || (secure ? 443 : 80));
  const headers: [string, string][] = [...req.headers];
  const has = (name: string): boolean => headers.some(([k]) => k.toLowerCase() === name);
  if (!has("host")) headers.unshift(["Host", url.host]);
  if (req.body && !has("content-length") && !has("transfer-encoding")) headers.push(["Content-Length", String(req.body.length)]);

  let path = `${url.pathname}${url.search}`;
  let createConnection: ((o: object, cb: (err: Error | null, s: net.Socket) => void) => net.Socket | undefined) | undefined;
  let host = url.hostname;
  let reqPort = port;
  if (proxy) {
    const p = new URL(proxy);
    if (!secure && p.protocol.startsWith("http")) {
      // Plain HTTP through an HTTP proxy: absolute-form request line.
      path = url.href;
      host = p.hostname;
      reqPort = Number(p.port || (p.protocol === "https:" ? 443 : 80));
      if (p.username && !has("proxy-authorization")) headers.push(["Proxy-Authorization", `Basic ${Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString("base64")}`]);
    } else {
      const socket = await tunnel(proxy, url.hostname, port, opts);
      createConnection = (_o, cb) => {
        const s = secure ? tls.connect({ socket, ...tlsFor(url, opts) }) : socket;
        if (secure) s.once("secureConnect", () => cb(null, s)); else cb(null, s);
        return undefined;
      };
    }
  }

  const lib = secure ? https : http;
  const headerObject: http.OutgoingHttpHeaders = {};
  for (const [k, v] of headers) {
    const prev = headerObject[k];
    headerObject[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [String(prev), v];
  }
  return new Promise<Hop>((resolve, reject) => {
    const options: https.RequestOptions = {
      method: req.method, host, port: reqPort, path, agent: false,
      headers: headerObject,
      signal: opts.signal,
      ...(secure && !createConnection ? tlsFor(url, opts) : {}),
    };
    if (createConnection) (options as { createConnection?: unknown }).createConnection = createConnection;
    const request = lib.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const raw = res.rawHeaders;
        const list: [string, string][] = [];
        for (let i = 0; i < raw.length; i += 2) list.push([raw[i]!, raw[i + 1]!]);
        const encoding = res.headers["content-encoding"];
        resolve({
          status: res.statusCode ?? 0, statusText: res.statusMessage ?? "", httpVersion: `HTTP/${res.httpVersion}`,
          headers: list, body: decompress(Buffer.concat(chunks), typeof encoding === "string" ? encoding : ""),
        });
      });
      res.on("error", reject);
    });
    if (opts.connectTimeoutMs) {
      request.once("socket", (socket) => {
        if (socket.connecting || (socket as tls.TLSSocket).encrypted === undefined) connectTimeout(socket, opts.connectTimeoutMs, (e) => request.destroy(e));
      });
    }
    if (opts.timeoutMs) request.setTimeout(opts.timeoutMs, () => request.destroy(new Error(`timed out after ${opts.timeoutMs}ms with no response`)));
    request.once("error", reject);
    if (req.method === "CONNECT") {
      request.once("connect", (res, socket) => {
        socket.destroy();
        const list: [string, string][] = [];
        for (let i = 0; i < res.rawHeaders.length; i += 2) list.push([res.rawHeaders[i]!, res.rawHeaders[i + 1]!]);
        resolve({ status: res.statusCode ?? 0, statusText: res.statusMessage ?? "", httpVersion: `HTTP/${res.httpVersion}`, headers: list, body: Buffer.alloc(0) });
      });
    }
    request.end(req.body);
  });
}

async function once2(req: PreparedRequest, url: URL, proxy: string | undefined, opts: TransportOptions): Promise<Hop> {
  const secure = url.protocol === "https:";
  const port = Number(url.port || (secure ? 443 : 80));
  const connectOpts: http2.SecureClientSessionOptions = { ...tlsFor(url, opts), ALPNProtocols: ["h2"] };
  if (proxy) {
    const socket = await tunnel(proxy, url.hostname, port, opts);
    connectOpts.createConnection = () => secure ? tls.connect({ socket, ...tlsFor(url, opts), ALPNProtocols: ["h2"] }) : socket;
  }
  const session = http2.connect(url.origin, connectOpts);
  return new Promise<Hop>((resolve, reject) => {
    const fail = (e: Error): void => { session.destroy(); reject(e); };
    session.once("error", fail);
    const headers: http2.OutgoingHttpHeaders = { ":method": req.method, ":path": `${url.pathname}${url.search}`, ":scheme": url.protocol.slice(0, -1), ":authority": url.host };
    for (const [k, v] of req.headers) {
      const key = k.toLowerCase();
      if (["host", "connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection"].includes(key)) continue;
      const prev = headers[key];
      headers[key] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [String(prev), v];
    }
    const stream = session.request(headers, { signal: opts.signal });
    if (opts.timeoutMs) stream.setTimeout(opts.timeoutMs, () => fail(new Error(`timed out after ${opts.timeoutMs}ms with no response`)));
    const chunks: Buffer[] = [];
    let status = 0;
    const list: [string, string][] = [];
    stream.on("response", (h) => {
      status = Number(h[":status"]);
      for (const [k, v] of Object.entries(h)) if (!k.startsWith(":")) for (const one of Array.isArray(v) ? v : [v]) list.push([k, String(one)]);
    });
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", () => {
      session.close();
      const encoding = list.find(([k]) => k === "content-encoding")?.[1] ?? "";
      resolve({ status, statusText: http.STATUS_CODES[status] ?? "", httpVersion: "HTTP/2", headers: list, body: decompress(Buffer.concat(chunks), encoding) });
    });
    stream.on("error", fail);
    stream.end(req.body);
  });
}

/** Send a request, following redirects (unless told not to) with cookies on every hop. */
export async function transmit(input: PreparedRequest, opts: TransportOptions = {}): Promise<HttpResponse> {
  const started = performance.now();
  let req: PreparedRequest = { ...input, headers: [...input.headers] };
  const has = (name: string): boolean => req.headers.some(([k]) => k.toLowerCase() === name);
  if (!has("accept-encoding")) req.headers.push(["Accept-Encoding", ACCEPT_ENCODING]);
  const redirects: string[] = [];
  const max = opts.maxRedirects ?? 20;
  for (;;) {
    const hopReq = { ...req, headers: [...req.headers] };
    const userCookie = hopReq.headers.findIndex(([k]) => k.toLowerCase() === "cookie");
    const jar = opts.cookies?.header(req.url);
    if (jar) {
      if (userCookie === -1) hopReq.headers.push(["Cookie", jar]);
      else hopReq.headers[userCookie] = ["Cookie", `${hopReq.headers[userCookie]![1]}; ${jar}`];
    }
    opts.log?.(`> ${hopReq.method} ${hopReq.url}`);
    const hop = await once(hopReq, opts);
    opts.log?.(`< ${hop.status} ${hop.statusText}`);
    const setCookies = hop.headers.filter(([k]) => k.toLowerCase() === "set-cookie").map(([, v]) => v);
    if (setCookies.length) opts.cookies?.store(req.url, setCookies);
    const location = hop.headers.find(([k]) => k.toLowerCase() === "location")?.[1];
    if (opts.followRedirects !== false && location && [301, 302, 303, 307, 308].includes(hop.status) && redirects.length < max) {
      const next = new URL(location, req.url);
      redirects.push(next.href);
      const crossOrigin = next.origin !== new URL(req.url).origin;
      const keepBody = hop.status === 307 || hop.status === 308;
      const method = keepBody ? req.method : (hop.status === 303 || req.method === "POST") && req.method !== "HEAD" ? "GET" : req.method;
      req = {
        ...req, url: next.href, method,
        body: keepBody ? req.body : undefined,
        headers: req.headers.filter(([k]) => {
          const key = k.toLowerCase();
          if (key === "host") return false;
          if (!keepBody && (key === "content-type" || key === "content-length")) return false;
          if (crossOrigin && (key === "authorization" || key === "cookie" || key === "proxy-authorization")) return false;
          return true;
        }),
      };
      continue;
    }
    const contentType = hop.headers.find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "";
    return {
      status: hop.status, statusText: hop.statusText, httpVersion: hop.httpVersion, headers: hop.headers, body: hop.body,
      text: decodeText(hop.body, contentType), contentType, duration: performance.now() - started, url: req.url, redirects,
    };
  }
}
