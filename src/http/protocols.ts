/**
 * The protocols `.http` files reach beyond plain HTTP (http-files.org/spec/protocols):
 * WebSocket (JetBrains `WEBSOCKET`, httpyac `WS`/`WSS`), Server-Sent Events
 * (`SSE`/`EVENTSOURCE`), gRPC, MQTT and AMQP.
 *
 * WebSocket and SSE use what the runtime already has. gRPC, MQTT and AMQP use
 * optional dependencies, loaded only when such a request runs, so a plain REST
 * collection never pays for them.
 */
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { HttpResponse, Interaction, PreparedRequest, StreamMessage, TlsOptions } from "./types.ts";

export type StreamKind = "websocket" | "sse" | "grpc" | "mqtt" | "amqp";

const KINDS: Record<string, StreamKind> = {
  WEBSOCKET: "websocket", WS: "websocket", WSS: "websocket",
  SSE: "sse", EVENTSOURCE: "sse",
  GRPC: "grpc", MQTT: "mqtt", AMQP: "amqp",
};

/** Method keyword → kind. undefined for HTTP methods. */
export function streamKind(method: string): StreamKind | undefined {
  return KINDS[method.toUpperCase()];
}

export interface StreamContext {
  interaction: Interaction;
  signal: AbortSignal;
  /** Called for every message received (and sent, prefixed "> "), so the UI can show it live. */
  onMessage(text: string): void;
  /** `# @keepStreaming`: stay open until `signal` aborts. */
  keepStreaming: boolean;
  /** Otherwise close once the last message is answered, or after this long without traffic. */
  timeoutMs: number;
  /** Proto files resolve relative to the `.http` file. */
  baseDir: string;
  tls?: TlsOptions;
  /** `proto`, `proto-include`, `grpc-reflection` and other `grpc-*` flags. */
  metadata: Map<string, string[]>;
  /** httpyac `{{@streaming}}`: called with a send/close API; resolves when the script is done. */
  streaming?: (api: { send(data: string): void; close(): void; [k: string]: unknown }) => Promise<void>;
}

/** After the last message, a reply followed by this much quiet ends the exchange. */
const QUIET_MS = 300;

/**
 * Run a streaming exchange. The response's `text` is the transcript: sent
 * messages prefixed `> `, received ones as they arrived, one block each.
 */
export async function runStream(
  kind: StreamKind,
  req: PreparedRequest,
  messages: StreamMessage[] | undefined,
  ctx: StreamContext,
): Promise<HttpResponse> {
  const transcript = new Transcript(ctx);
  switch (kind) {
    case "websocket": return runWebSocket(req, messages, ctx, transcript);
    case "sse": return runSse(req, ctx, transcript);
    case "grpc": return runGrpc(req, messages, ctx, transcript);
    case "mqtt": return runMqtt(req, ctx, transcript);
    case "amqp": return runAmqp(req, ctx, transcript);
  }
}

/** Every message in order, also forwarded to the UI as it happens. */
class Transcript {
  readonly lines: string[] = [];
  readonly started = performance.now();
  constructor(private readonly ctx: StreamContext) {}
  sent(text: string): void { this.add(`> ${text}`); }
  received(text: string): void { this.add(text); }
  private add(text: string): void { this.lines.push(text); this.ctx.onMessage(text); }
  response(fields: Partial<HttpResponse> & { url: string }): HttpResponse {
    const text = this.lines.join("\n");
    return {
      status: 200, statusText: "OK", httpVersion: "", headers: [], contentType: "text/plain",
      redirects: [], ...fields,
      body: Buffer.from(text), text, duration: performance.now() - this.started,
    };
  }
}

function header(req: PreparedRequest, name: string): string | undefined {
  return headerAll(req, name)[0];
}
function headerAll(req: PreparedRequest, name: string): string[] {
  const lower = name.toLowerCase();
  return req.headers.filter(([k]) => k.toLowerCase() === lower).map(([, v]) => v);
}

function bodyText(req: PreparedRequest): string {
  return req.bodyText ?? req.body?.toString("utf8") ?? "";
}

/** Resolves after `ms`, or at once when the signal aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((done) => {
    if (signal.aborted) return done();
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    function finish(): void { clearTimeout(timer); signal.removeEventListener("abort", finish); done(); }
  });
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise((done) => {
    if (signal.aborted) done();
    else signal.addEventListener("abort", () => done(), { once: true });
  });
}

/**
 * Tracks traffic so the caller can wait for "answered, then quiet" or the
 * idle timeout, whichever the exchange reaches first.
 */
class Activity {
  private last = performance.now();
  private count = 0;
  private waiters: (() => void)[] = [];
  closed = false;
  bump(): void {
    this.last = performance.now();
    this.count++;
    for (const wake of this.waiters.splice(0)) wake();
  }
  close(): void { this.closed = true; this.bump(); }
  /** The next received message, or false on timeout/abort/close. */
  async next(timeoutMs: number, signal: AbortSignal): Promise<boolean> {
    if (this.closed) return false;
    const before = this.count;
    const stop = new AbortController();
    const abort = (): void => stop.abort();
    signal.addEventListener("abort", abort, { once: true });
    await Promise.race([
      new Promise<void>((wake) => this.waiters.push(wake)),
      sleep(timeoutMs, stop.signal),
    ]);
    stop.abort();
    signal.removeEventListener("abort", abort);
    return this.count > before && !this.closed;
  }
  /** Until closed, aborted, or idle for long enough after at least one reply. */
  async settle(ctx: StreamContext, sinceCount = 0): Promise<void> {
    if (ctx.keepStreaming) {
      while (!this.closed && !ctx.signal.aborted) await this.next(60_000, ctx.signal);
      return;
    }
    const deadline = performance.now() + ctx.timeoutMs;
    while (!this.closed && !ctx.signal.aborted) {
      const answered = this.count > sinceCount;
      const wait = answered
        ? QUIET_MS - (performance.now() - this.last)
        : deadline - performance.now();
      if (wait <= 0) return;
      await this.next(wait, ctx.signal);
    }
  }
  get received(): number { return this.count; }
}

// ---------------------------------------------------------------- WebSocket

/**
 * JetBrains message syntax: `===` separates messages; a message whose
 * separator was `=== wait-for-server` (`waitForServer: true`) is sent only
 * after the server has sent something since the previous message.
 */
async function runWebSocket(
  req: PreparedRequest, messages: StreamMessage[] | undefined, ctx: StreamContext, transcript: Transcript,
): Promise<HttpResponse> {
  const url = req.url.replace(/^http(s?):/i, "ws$1:");
  const headers: Record<string, string> = {};
  let protocols: string[] | undefined;
  for (const [name, value] of req.headers) {
    if (name.toLowerCase() === "sec-websocket-protocol") protocols = value.split(",").map((p) => p.trim()).filter(Boolean);
    else headers[name] = value;
  }
  // Bun and Node (undici) both accept an init object with headers; the DOM
  // typing only knows protocols.
  const init: Record<string, unknown> = { headers };
  if (protocols) init.protocols = protocols;
  if (ctx.tls && "Bun" in globalThis) init.tls = { ...ctx.tls };
  const WS = WebSocket as unknown as new (url: string, init: unknown) => WebSocket;

  const activity = new Activity();
  let failure: string | undefined;
  const socket = new WS(url, init);
  socket.binaryType = "arraybuffer";
  socket.addEventListener("message", (event) => {
    const data = event.data;
    transcript.received(typeof data === "string" ? data : Buffer.from(data as ArrayBuffer).toString("utf8"));
    activity.bump();
  });
  socket.addEventListener("close", () => activity.close());
  socket.addEventListener("error", (event) => {
    failure = (event as unknown as { message?: string }).message || "WebSocket error";
    activity.close();
  });
  const onAbort = (): void => socket.close();
  ctx.signal.addEventListener("abort", onAbort, { once: true });

  try {
    const opened = await new Promise<boolean>((done) => {
      if (socket.readyState === WebSocket.OPEN) return done(true);
      socket.addEventListener("open", () => done(true), { once: true });
      socket.addEventListener("close", () => done(false), { once: true });
      socket.addEventListener("error", () => done(false), { once: true });
      ctx.signal.addEventListener("abort", () => done(false), { once: true });
    });
    if (!opened) {
      return transcript.response({ url, status: 0, statusText: failure ?? "connection failed" });
    }

    const send = (text: string): void => {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(text);
      transcript.sent(text);
    };
    let mark = activity.received;
    for (const message of messages ?? []) {
      if (message.waitForServer && activity.received === mark) {
        const got = await activity.next(ctx.timeoutMs, ctx.signal);
        if (!got) break;
      }
      mark = activity.received;
      send(message.text);
    }
    if (ctx.streaming) {
      await ctx.streaming({ send, close: () => socket.close(), ws: socket });
    }
    await activity.settle(ctx, mark);
  } finally {
    ctx.signal.removeEventListener("abort", onAbort);
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
  }
  return transcript.response({
    url, status: failure ? 0 : 101, statusText: failure ?? "Switching Protocols",
    headers: socket.protocol ? [["sec-websocket-protocol", socket.protocol]] : [],
  });
}

// ---------------------------------------------------------------- SSE

export interface SseEvent { event?: string; data: string; id?: string; retry?: number }

/** Incremental `text/event-stream` parser (WHATWG HTML §9.2.6). */
export class SseParser {
  private buffer = "";
  private data: string[] = [];
  private event?: string;
  private id?: string;
  private retry?: number;
  constructor(private readonly emit: (event: SseEvent) => void) {}
  push(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.search(/\r\n|\r|\n/)) >= 0) {
      const line = this.buffer.slice(0, newline);
      const width = this.buffer.startsWith("\r\n", newline) ? 2 : 1;
      // A lone \r at the end of a chunk may be the first half of \r\n.
      if (width === 1 && this.buffer[newline] === "\r" && newline === this.buffer.length - 1) break;
      this.buffer = this.buffer.slice(newline + width);
      this.line(line);
    }
  }
  end(): void { if (this.buffer) this.line(this.buffer); this.buffer = ""; this.line(""); }
  private line(line: string): void {
    if (line === "") {
      if (this.data.length > 0 || this.event !== undefined) {
        const event: SseEvent = { data: this.data.join("\n") };
        if (this.event !== undefined) event.event = this.event;
        if (this.id !== undefined) event.id = this.id;
        if (this.retry !== undefined) event.retry = this.retry;
        this.emit(event);
      }
      this.data = []; this.event = undefined; this.retry = undefined;
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.data.push(value);
    else if (field === "event") this.event = value;
    else if (field === "id" && !value.includes("\0")) this.id = value;
    else if (field === "retry" && /^\d+$/.test(value)) this.retry = Number(value);
  }
}

export function formatSseEvent(event: SseEvent): string {
  const lines: string[] = [];
  if (event.event !== undefined) lines.push(`event: ${event.event}`);
  if (event.id !== undefined) lines.push(`id: ${event.id}`);
  if (event.retry !== undefined) lines.push(`retry: ${event.retry}`);
  for (const line of event.data.split("\n")) lines.push(`data: ${line}`);
  return lines.join("\n");
}

async function runSse(req: PreparedRequest, ctx: StreamContext, transcript: Transcript): Promise<HttpResponse> {
  const url = req.url.replace(/^sse:/i, "https:");
  const headers = new Headers(req.headers);
  if (!headers.has("accept")) headers.set("accept", "text/event-stream");
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  ctx.signal.addEventListener("abort", onAbort, { once: true });
  const activity = new Activity();
  const init: RequestInit & Record<string, unknown> = {
    method: req.body ? "POST" : "GET", headers, signal: controller.signal,
  };
  if (req.body) init.body = new Uint8Array(req.body);
  if (ctx.tls && "Bun" in globalThis) init.tls = { ...ctx.tls };

  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    ctx.signal.removeEventListener("abort", onAbort);
    return transcript.response({ url, status: 0, statusText: error instanceof Error ? error.message : String(error) });
  }
  const parser = new SseParser((event) => { transcript.received(formatSseEvent(event)); activity.bump(); });
  const reading = (async () => {
    if (!response.body) return;
    const decoder = new TextDecoder();
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        parser.push(decoder.decode(chunk, { stream: true }));
      }
      parser.end();
    } catch {
      // Aborted by us when the exchange settled; whatever arrived is kept.
    } finally {
      activity.close();
    }
  })();
  try {
    if (!response.ok) {
      await reading;
    } else if (ctx.keepStreaming) {
      await Promise.race([reading, waitForAbort(ctx.signal)]);
    } else {
      // An event stream has no "answered": it ends when the server closes it
      // or after timeoutMs without an event.
      while (!activity.closed && !ctx.signal.aborted) {
        if (!(await activity.next(ctx.timeoutMs, ctx.signal))) break;
      }
    }
  } finally {
    controller.abort();
    await reading;
    ctx.signal.removeEventListener("abort", onAbort);
  }
  return transcript.response({
    url, status: response.status, statusText: response.statusText,
    headers: [...response.headers.entries()],
    contentType: response.headers.get("content-type") ?? "text/event-stream",
  });
}

// ---------------------------------------------------------------- optional modules

/** Dynamic import of an optional dependency, with an error that says what to install. */
async function optional<T = any>(name: string, purpose: string): Promise<T> {
  try {
    const mod = await import(name);
    return (mod.default ?? mod) as T;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND" || /Cannot find (module|package)/.test(String(error))) {
      throw new Error(`${purpose} needs the optional package ${name}. Install it with: npm install ${name}`);
    }
    throw error;
  }
}

// ---------------------------------------------------------------- gRPC

export interface GrpcTarget { address: string; tls: boolean; service: string; method: string }

/**
 * `GRPC host:port/package.Service/Method`, optionally with a `grpc://`,
 * `grpcs://`, `http://` or `https://` scheme. TLS for grpcs/https.
 */
export function grpcTarget(url: string): GrpcTarget {
  const match = /^(?:([a-z][a-z0-9+.-]*):\/\/)?([^/]+)\/(.+)\/([^/]+)$/i.exec(url.trim());
  if (!match) throw new Error(`gRPC URL must be host:port/package.Service/Method, got ${url}`);
  const scheme = (match[1] ?? "").toLowerCase();
  return {
    address: match[2] as string,
    tls: scheme === "grpcs" || scheme === "https",
    service: (match[3] as string).replace(/^\/+/, ""),
    method: match[4] as string,
  };
}

const GRPC_HTTP_STATUS = [200, 499, 500, 400, 504, 404, 409, 403, 429, 400, 409, 400, 501, 500, 503, 500, 401];
const GRPC_CODES = [
  "OK", "CANCELLED", "UNKNOWN", "INVALID_ARGUMENT", "DEADLINE_EXCEEDED", "NOT_FOUND", "ALREADY_EXISTS",
  "PERMISSION_DENIED", "RESOURCE_EXHAUSTED", "FAILED_PRECONDITION", "ABORTED", "OUT_OF_RANGE",
  "UNIMPLEMENTED", "INTERNAL", "UNAVAILABLE", "DATA_LOSS", "UNAUTHENTICATED",
];

const REFLECTION_PROTO = `
syntax = "proto3";
package grpc.reflection.REF;
service ServerReflection {
  rpc ServerReflectionInfo(stream ServerReflectionRequest) returns (stream ServerReflectionResponse);
}
message ServerReflectionRequest {
  string host = 1;
  oneof message_request {
    string file_by_filename = 3;
    string file_containing_symbol = 4;
    string list_services = 7;
  }
}
message FileDescriptorResponse { repeated bytes file_descriptor_proto = 1; }
message ServiceResponse { string name = 1; }
message ListServiceResponse { repeated ServiceResponse service = 1; }
message ErrorResponse { int32 error_code = 1; string error_message = 2; }
message ServerReflectionResponse {
  string valid_host = 1;
  ServerReflectionRequest original_request = 2;
  oneof message_response {
    FileDescriptorResponse file_descriptor_response = 4;
    ListServiceResponse list_services_response = 6;
    ErrorResponse error_response = 7;
  }
}`;

type PbType = {
  fromObject(o: unknown): unknown;
  toObject(m: unknown, o?: unknown): Record<string, unknown>;
  encode(m: unknown): { finish(): Uint8Array };
  decode(b: Uint8Array): unknown;
  verify(o: unknown): string | null;
};
type PbMethod = { requestType: string; responseType: string; requestStream?: boolean; responseStream?: boolean; resolve(): PbMethod; resolvedRequestType: PbType | null; resolvedResponseType: PbType | null };
type PbRoot = { lookupService(name: string): { methods: Record<string, PbMethod> }; resolveAll(): PbRoot };

const TO_OBJECT = { longs: String, enums: String, bytes: String, defaults: true, oneofs: true };

async function loadProtoRoot(ctx: StreamContext): Promise<PbRoot> {
  const protobuf = await optional("protobufjs", "gRPC");
  const files = (ctx.metadata.get("proto") ?? []).map((p) => (isAbsolute(p) ? p : resolve(ctx.baseDir, p)));
  const includes = (ctx.metadata.get("proto-include") ?? []).map((p) => (isAbsolute(p) ? p : resolve(ctx.baseDir, p)));
  const root = new protobuf.Root();
  root.resolvePath = (origin: string, target: string): string => {
    if (isAbsolute(target)) return target;
    for (const dir of includes) {
      const candidate = resolve(dir, target);
      if (existsSync(candidate)) return candidate;
    }
    return protobuf.util.path.resolve(origin, target);
  };
  await root.load(files, { keepCase: true });
  return root.resolveAll();
}

/** Ask the server for the descriptors of `symbol` (grpc.reflection v1, then v1alpha). */
async function reflectRoot(grpc: any, client: any, symbol: string, metadata: any, signal: AbortSignal): Promise<PbRoot> {
  const protobuf = await optional("protobufjs", "gRPC reflection");
  const descriptorModule = await import("protobufjs/ext/descriptor/index.js");
  const descriptor = ((descriptorModule as { default?: unknown }).default ?? descriptorModule) as { FileDescriptorProto: PbType; FileDescriptorSet: PbType };
  let lastError: unknown;
  for (const version of ["v1", "v1alpha"]) {
    const root = protobuf.parse(REFLECTION_PROTO.replace("REF", version), { keepCase: true }).root;
    const Request = root.lookupType(`grpc.reflection.${version}.ServerReflectionRequest`) as PbType;
    const Response = root.lookupType(`grpc.reflection.${version}.ServerReflectionResponse`) as PbType;
    const files = new Map<string, Uint8Array>();
    try {
      const call = client.makeBidiStreamRequest(
        `/grpc.reflection.${version}.ServerReflection/ServerReflectionInfo`,
        (m: unknown) => Buffer.from(Request.encode(Request.fromObject(m)).finish()),
        (b: Buffer) => Response.toObject(Response.decode(b), { bytes: Buffer }),
        metadata,
      );
      const abort = (): void => call.cancel();
      signal.addEventListener("abort", abort, { once: true });
      const pending = new Set<string>();
      await new Promise<void>((done, fail) => {
        const ask = (request: Record<string, string>, key: string): void => {
          if (pending.has(key)) return;
          pending.add(key);
          call.write(request);
        };
        call.on("data", (response: Record<string, any>) => {
          if (response.error_response) {
            fail(new Error(`reflection: ${response.error_response.error_message || "error " + response.error_response.error_code}`));
            call.cancel();
            return;
          }
          const original = response.original_request ?? {};
          pending.delete(original.file_by_filename ? `f:${original.file_by_filename}` : `s:${original.file_containing_symbol}`);
          for (const bytes of response.file_descriptor_response?.file_descriptor_proto ?? []) {
            const file = descriptor.FileDescriptorProto.decode(bytes) as { name: string; dependency?: string[] };
            if (files.has(file.name)) continue;
            files.set(file.name, bytes);
            for (const dep of file.dependency ?? []) {
              if (!files.has(dep)) ask({ file_by_filename: dep }, `f:${dep}`);
            }
          }
          // Dependencies that arrived inside another response are no longer pending.
          for (const key of [...pending]) if (key.startsWith("f:") && files.has(key.slice(2))) pending.delete(key);
          if (pending.size === 0) call.end();
        });
        call.on("error", (error: Error) => fail(error));
        call.on("end", () => done());
        ask({ file_containing_symbol: symbol }, `s:${symbol}`);
      }).finally(() => signal.removeEventListener("abort", abort));
      const set = descriptor.FileDescriptorSet.fromObject({
        file: [...files.values()].map((bytes) => descriptor.FileDescriptorProto.decode(bytes)),
      });
      return (protobuf.Root as unknown as { fromDescriptor(set: unknown): PbRoot }).fromDescriptor(set).resolveAll();
    } catch (error) {
      lastError = error;
      if ((error as { code?: number }).code !== grpc.status.UNIMPLEMENTED) break;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function grpcCredentials(grpc: any, target: GrpcTarget, tls: TlsOptions | undefined): any {
  if (!target.tls && !tls?.cert && !tls?.ca) return grpc.credentials.createInsecure();
  const options = tls?.rejectUnauthorized === false ? { checkServerIdentity: () => undefined } : undefined;
  return grpc.credentials.createSsl(tls?.ca ?? null, tls?.key ?? null, tls?.cert ?? null, options);
}

async function runGrpc(
  req: PreparedRequest, messages: StreamMessage[] | undefined, ctx: StreamContext, transcript: Transcript,
): Promise<HttpResponse> {
  const grpc = await optional("@grpc/grpc-js", "gRPC");
  const target = grpcTarget(req.url);
  const metadata = new grpc.Metadata();
  for (const [name, value] of req.headers) {
    const key = name.toLowerCase();
    if (key === "content-type" || key === "proto") continue;
    metadata.add(key, value);
  }
  const options: Record<string, unknown> = {};
  for (const [key, values] of ctx.metadata) {
    // `# @grpc-max-receive-message-length 1000` → grpc.max_receive_message_length
    if (key.startsWith("grpc-") && key !== "grpc-reflection" && values[0] !== undefined) {
      const option = `grpc.${key.slice(5).replace(/-/g, "_")}`;
      options[option] = /^\d+$/.test(values[0]) ? Number(values[0]) : values[0];
    }
  }
  const client = new grpc.Client(target.address, grpcCredentials(grpc, target, ctx.tls), options);
  const url = `${target.tls ? "grpcs" : "grpc"}://${target.address}/${target.service}/${target.method}`;
  try {
    const root = ctx.metadata.has("grpc-reflection") || !ctx.metadata.get("proto")?.length
      ? await reflectRoot(grpc, client, target.service, metadata, ctx.signal)
      : await loadProtoRoot(ctx);
    let service;
    try { service = root.lookupService(target.service); }
    catch { throw new Error(`service ${target.service} is not in the proto definitions`); }
    const method = service.methods[target.method] ?? Object.entries(service.methods)
      .find(([name]) => name.toLowerCase() === target.method.toLowerCase())?.[1];
    if (!method) throw new Error(`${target.service} has no method ${target.method}`);
    method.resolve();
    const RequestType = method.resolvedRequestType as PbType;
    const ResponseType = method.resolvedResponseType as PbType;
    const path = `/${target.service}/${(Object.entries(service.methods).find(([, m]) => m === method) as [string, PbMethod])[0]}`;
    const serialize = (value: unknown): Buffer => {
      const problem = RequestType.verify(value);
      if (problem) throw new Error(`request message: ${problem}`);
      return Buffer.from(RequestType.encode(RequestType.fromObject(value)).finish());
    };
    const deserialize = (bytes: Buffer): unknown => ResponseType.toObject(ResponseType.decode(bytes), TO_OBJECT);
    const parse = (text: string): unknown => (text.trim() === "" ? {} : JSON.parse(text));
    const outgoing = messages?.length ? messages.map((m) => m.text) : [bodyText(req)];

    const deadline = ctx.keepStreaming ? undefined : Date.now() + Math.max(ctx.timeoutMs, 1);
    const callOptions = deadline ? { deadline } : {};
    const headers: [string, string][] = [];
    const onMetadata = (meta: any): void => {
      for (const [k, v] of Object.entries(meta.getMap() as Record<string, unknown>)) headers.push([k, String(v)]);
    };
    const show = (message: unknown): void => transcript.received(JSON.stringify(message, null, 2));

    const status = await new Promise<{ code: number; details: string; trailers: [string, string][] }>((done) => {
      let call: any;
      const finish = (s: { code: number; details: string; metadata?: any }): void => {
        const trailers: [string, string][] = s.metadata
          ? Object.entries(s.metadata.getMap() as Record<string, unknown>).map(([k, v]) => [k, String(v)])
          : [];
        done({ code: s.code, details: s.details, trailers });
      };
      const unaryCallback = (error: any, value: unknown): void => {
        if (!error && value !== undefined) show(value);
      };
      const requests = outgoing.map(parse);
      if (!method.requestStream && !method.responseStream) {
        transcript.sent(JSON.stringify(requests[0]));
        call = client.makeUnaryRequest(path, serialize, deserialize, requests[0], metadata, callOptions, unaryCallback);
      } else if (!method.requestStream) {
        transcript.sent(JSON.stringify(requests[0]));
        call = client.makeServerStreamRequest(path, serialize, deserialize, requests[0], metadata, callOptions);
        call.on("data", show);
      } else if (!method.responseStream) {
        call = client.makeClientStreamRequest(path, serialize, deserialize, metadata, callOptions, unaryCallback);
      } else {
        call = client.makeBidiStreamRequest(path, serialize, deserialize, metadata, callOptions);
        call.on("data", show);
      }
      call.on("metadata", onMetadata);
      call.on("status", finish);
      call.on("error", () => { /* reported through status */ });
      const abort = (): void => call.cancel();
      ctx.signal.addEventListener("abort", abort, { once: true });
      if (method.requestStream) {
        const write = (text: string): void => { transcript.sent(text); call.write(parse(text)); };
        void (async () => {
          for (const request of requests) write(JSON.stringify(request));
          if (ctx.streaming) await ctx.streaming({ send: write, close: () => call.end(), call });
          call.end();
        })().catch((error) => { call.cancel(); transcript.received(`error: ${error instanceof Error ? error.message : error}`); });
      }
    });
    headers.push(["grpc-status", String(status.code)]);
    if (status.details) headers.push(["grpc-message", status.details]);
    headers.push(...status.trailers);
    const code = GRPC_CODES[status.code] ?? String(status.code);
    return transcript.response({
      url, httpVersion: "2", headers, contentType: "application/json",
      status: GRPC_HTTP_STATUS[status.code] ?? 500,
      statusText: status.code === 0 ? "OK" : `${code}${status.details ? `: ${status.details}` : ""}`,
    });
  } catch (error) {
    return transcript.response({ url, status: 0, statusText: error instanceof Error ? error.message : String(error) });
  } finally {
    client.close();
  }
}

// ---------------------------------------------------------------- MQTT

export interface MqttPlan {
  url: string;
  subscribe: string[];
  publish: string[];
  qos: 0 | 1 | 2;
  retain: boolean;
  options: Record<string, unknown>;
  payload: string;
}

const MQTT_OPTION_HEADERS: Record<string, string> = {
  username: "username", password: "password", clientid: "clientId", keepalive: "keepalive",
  clean: "clean", protocolversion: "protocolVersion", reconnectperiod: "reconnectPeriod",
  connecttimeout: "connectTimeout",
};

/**
 * httpyac MQTT headers: `Topic` (repeatable) both subscribes and publishes;
 * `Subscribe`/`Publish` do one of the two. `QoS`, `Retain`, and connection
 * options (`Username`, `Password`, `ClientId`, `Keepalive`, …).
 */
export function mqttPlan(req: PreparedRequest): MqttPlan {
  const topics = headerAll(req, "topic").flatMap(splitList);
  const payload = bodyText(req);
  const subscribe = [...topics, ...headerAll(req, "subscribe").flatMap(splitList)];
  const publish = payload !== "" ? [...topics, ...headerAll(req, "publish").flatMap(splitList)] : headerAll(req, "publish").flatMap(splitList);
  const qos = Number(header(req, "qos") ?? 0);
  const options: Record<string, unknown> = {};
  for (const [name, value] of req.headers) {
    const key = MQTT_OPTION_HEADERS[name.toLowerCase().replace(/[-_]/g, "")];
    if (!key) continue;
    options[key] = /^\d+$/.test(value) && key !== "password" && key !== "username" && key !== "clientId"
      ? Number(value)
      : key === "clean" ? value !== "false" : value;
  }
  return {
    url: req.url.replace(/^tcp:/i, "mqtt:"),
    subscribe: [...new Set(subscribe)],
    publish: [...new Set(publish)],
    qos: (qos === 1 || qos === 2 ? qos : 0),
    retain: /^(true|1|yes)$/i.test(header(req, "retain") ?? ""),
    options,
    payload,
  };
}

function splitList(value: string): string[] {
  return value.split(",").map((t) => t.trim()).filter(Boolean);
}

async function runMqtt(req: PreparedRequest, ctx: StreamContext, transcript: Transcript): Promise<HttpResponse> {
  const mqtt = await optional("mqtt", "MQTT");
  const plan = mqttPlan(req);
  const activity = new Activity();
  const options: Record<string, unknown> = { ...plan.options, reconnectPeriod: 0 };
  if (ctx.tls) Object.assign(options, ctx.tls);
  let client: any;
  try {
    client = await (mqtt.connectAsync ?? mqtt.default?.connectAsync)(plan.url, options);
  } catch (error) {
    return transcript.response({ url: plan.url, status: 0, statusText: error instanceof Error ? error.message : String(error) });
  }
  const onAbort = (): void => { activity.close(); };
  ctx.signal.addEventListener("abort", onAbort, { once: true });
  try {
    client.on("message", (topic: string, payload: Buffer) => {
      transcript.received(`${topic}: ${payload.toString("utf8")}`);
      activity.bump();
    });
    client.on("close", () => activity.close());
    if (plan.subscribe.length) await client.subscribeAsync(plan.subscribe, { qos: plan.qos });
    const publish = async (text: string, topics = plan.publish): Promise<void> => {
      for (const topic of topics) {
        await client.publishAsync(topic, text, { qos: plan.qos, retain: plan.retain });
        transcript.sent(`${topic}: ${text}`);
      }
    };
    // Our own publish echoes back on a subscribed topic; only replies after it count.
    if (plan.payload !== "") await publish(plan.payload);
    if (ctx.streaming) await ctx.streaming({ send: (text) => void publish(text), close: () => activity.close(), client });
    if (plan.subscribe.length || ctx.keepStreaming) {
      if (ctx.keepStreaming) await activity.settle(ctx);
      else {
        // Collect until timeoutMs passes without a message.
        while (!activity.closed && !ctx.signal.aborted) {
          if (!(await activity.next(ctx.timeoutMs, ctx.signal))) break;
        }
      }
    }
  } catch (error) {
    transcript.received(`error: ${error instanceof Error ? error.message : String(error)}`);
    return transcript.response({ url: plan.url, status: 0, statusText: error instanceof Error ? error.message : String(error) });
  } finally {
    ctx.signal.removeEventListener("abort", onAbort);
    await client.endAsync().catch(() => {});
  }
  return transcript.response({ url: plan.url, status: 200, statusText: "OK" });
}

// ---------------------------------------------------------------- AMQP

export const AMQP_METHODS = ["publish", "consume", "ack", "nack", "cancel", "purge", "declare", "bind", "unbind", "delete"] as const;
export type AmqpMethod = typeof AMQP_METHODS[number];

export interface AmqpPlan {
  url: string;
  method: AmqpMethod;
  exchange?: string;
  queue?: string;
  routingKey: string;
  exchangeType: string;
  tag?: string;
  /** Options for assertQueue/assertExchange/deleteQueue/consume/nack. */
  flags: {
    durable?: boolean; exclusive?: boolean; autoDelete?: boolean; noAck?: boolean;
    requeue?: boolean; allUpTo?: boolean; ifUnused?: boolean; ifEmpty?: boolean; prefetch?: number;
  };
  /** Options for publish/sendToQueue. */
  publishOptions: Record<string, unknown>;
  payload: string;
}

const AMQP_PUBLISH_OPTIONS: Record<string, string> = {
  correlation_id: "correlationId", reply_to: "replyTo", message_id: "messageId", content_type: "contentType",
  content_encoding: "contentEncoding", expiration: "expiration", priority: "priority", persistent: "persistent",
  type: "type", user_id: "userId", app_id: "appId", timestamp: "timestamp", mandatory: "mandatory",
  cc: "CC", bcc: "BCC",
};

/**
 * httpyac AMQP headers: `amqp_method`, `amqp_exchange`, `amqp_queue`,
 * `amqp_routing_key`, `amqp_tag`, `amqp_exchange_type`, boolean flags
 * (`amqp_durable`, `amqp_exclusive`, `amqp_auto_delete`, `amqp_no_ack`,
 * `amqp_requeue`, `amqp_all_up_to`, `amqp_if_unused`, `amqp_if_empty`),
 * `amqp_prefetch`, message properties (`amqp_correlation_id`, `amqp_reply_to`,
 * …); any other header is sent as a message header. Hyphens and underscores
 * are interchangeable.
 */
export function amqpPlan(req: PreparedRequest): AmqpPlan {
  const flags: AmqpPlan["flags"] = {};
  const publishOptions: Record<string, unknown> = {};
  const messageHeaders: Record<string, string> = {};
  const fields: Record<string, string> = {};
  const truthy = (v: string): boolean => /^(true|1|yes|on|)$/i.test(v.trim());
  for (const [name, value] of req.headers) {
    const key = name.toLowerCase().replace(/-/g, "_");
    if (!key.startsWith("amqp_")) {
      if (key !== "content_type") messageHeaders[name] = value;
      else publishOptions.contentType = value;
      continue;
    }
    const field = key.slice(5);
    switch (field) {
      case "durable": flags.durable = truthy(value); break;
      case "exclusive": flags.exclusive = truthy(value); break;
      case "auto_delete": flags.autoDelete = truthy(value); break;
      case "no_ack": flags.noAck = truthy(value); break;
      case "requeue": flags.requeue = truthy(value); break;
      case "all_up_to": flags.allUpTo = truthy(value); break;
      case "if_unused": flags.ifUnused = truthy(value); break;
      case "if_empty": flags.ifEmpty = truthy(value); break;
      case "prefetch": flags.prefetch = Number(value); break;
      default: {
        const option = AMQP_PUBLISH_OPTIONS[field];
        if (option) {
          publishOptions[option] = option === "persistent" || option === "mandatory" ? truthy(value)
            : option === "priority" || option === "timestamp" ? Number(value)
            : option === "CC" || option === "BCC" ? splitList(value) : value;
        } else if (field.startsWith("header_")) {
          messageHeaders[field.slice(7)] = value;
        } else fields[field] = value;
      }
    }
  }
  if (Object.keys(messageHeaders).length) publishOptions.headers = messageHeaders;
  const method = (fields.method ?? "publish").toLowerCase() as AmqpMethod;
  if (!AMQP_METHODS.includes(method)) throw new Error(`amqp_method must be one of ${AMQP_METHODS.join(", ")}`);
  const plan: AmqpPlan = {
    url: req.url,
    method,
    routingKey: fields.routing_key ?? fields.routingkey ?? "",
    exchangeType: fields.exchange_type ?? "direct",
    flags, publishOptions,
    payload: bodyText(req),
  };
  if (fields.exchange !== undefined) plan.exchange = fields.exchange;
  if (fields.queue !== undefined) plan.queue = fields.queue;
  if (fields.tag !== undefined || fields.consumer_tag !== undefined) plan.tag = fields.tag ?? fields.consumer_tag;
  return plan;
}

async function runAmqp(req: PreparedRequest, ctx: StreamContext, transcript: Transcript): Promise<HttpResponse> {
  let plan: AmqpPlan;
  try { plan = amqpPlan(req); }
  catch (error) { return transcript.response({ url: req.url, status: 0, statusText: (error as Error).message }); }
  const amqp = await optional("amqplib", "AMQP");
  const url = plan.url;
  let connection: any;
  try {
    connection = await amqp.connect(url, ctx.tls ? { ...ctx.tls } : undefined);
  } catch (error) {
    return transcript.response({ url, status: 0, statusText: error instanceof Error ? error.message : String(error) });
  }
  const need = (value: string | undefined, header: string): string => {
    if (value === undefined) throw new Error(`amqp_method ${plan.method} needs an ${header} header`);
    return value;
  };
  const show = (message: any): void => {
    const properties = Object.entries(message.properties ?? {}).filter(([, v]) => v !== undefined && !(typeof v === "object" && v && !Object.keys(v).length));
    transcript.received([
      `routing key: ${message.fields?.routingKey ?? ""}${message.fields?.exchange ? `  exchange: ${message.fields.exchange}` : ""}`,
      ...properties.map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`),
      message.content.toString("utf8"),
    ].join("\n"));
  };
  try {
    const channel = await connection.createConfirmChannel();
    const abort = (): void => { void connection.close().catch(() => {}); };
    ctx.signal.addEventListener("abort", abort, { once: true });
    try {
      switch (plan.method) {
        case "publish": {
          const send = async (text: string): Promise<void> => {
            const content = Buffer.from(text);
            if (plan.exchange !== undefined) channel.publish(plan.exchange, plan.routingKey || plan.queue || "", content, plan.publishOptions);
            else channel.sendToQueue(need(plan.queue, "amqp_queue or amqp_exchange"), content, plan.publishOptions);
            await channel.waitForConfirms();
            transcript.sent(text);
          };
          await send(plan.payload);
          if (ctx.streaming) await ctx.streaming({ send: (text) => void send(text), close: () => {}, channel });
          break;
        }
        case "consume": {
          const queue = need(plan.queue, "amqp_queue");
          const activity = new Activity();
          if (plan.flags.prefetch) await channel.prefetch(plan.flags.prefetch);
          const noAck = plan.flags.noAck ?? false;
          const consumer = await channel.consume(queue, (message: any) => {
            if (!message) { activity.close(); return; }
            show(message);
            if (!noAck) channel.ack(message);
            activity.bump();
          }, { noAck, exclusive: plan.flags.exclusive, consumerTag: plan.tag });
          if (ctx.keepStreaming) await activity.settle(ctx);
          else while (!activity.closed && !ctx.signal.aborted) {
            if (!(await activity.next(ctx.timeoutMs, ctx.signal))) break;
          }
          await channel.cancel(consumer.consumerTag).catch(() => {});
          break;
        }
        case "ack":
        case "nack": {
          // A delivery tag belongs to the channel that received it, so a
          // separate request cannot ack another's delivery: take the next
          // message from the queue and settle it here.
          const message = await channel.get(need(plan.queue, "amqp_queue"), { noAck: false });
          if (!message) { transcript.received("queue is empty"); break; }
          show(message);
          if (plan.method === "ack") channel.ack(message, plan.flags.allUpTo ?? false);
          else channel.nack(message, plan.flags.allUpTo ?? false, plan.flags.requeue ?? true);
          break;
        }
        case "cancel":
          await channel.cancel(need(plan.tag, "amqp_tag"));
          transcript.received(`cancelled consumer ${plan.tag}`);
          break;
        case "purge": {
          const result = await channel.purgeQueue(need(plan.queue, "amqp_queue"));
          transcript.received(`purged ${result.messageCount} messages from ${plan.queue}`);
          break;
        }
        case "declare": {
          if (plan.exchange === undefined && plan.queue === undefined) need(undefined, "amqp_queue or amqp_exchange");
          const options = { durable: plan.flags.durable, exclusive: plan.flags.exclusive, autoDelete: plan.flags.autoDelete };
          if (plan.exchange !== undefined) {
            await channel.assertExchange(plan.exchange, plan.exchangeType, options);
            transcript.received(`declared ${plan.exchangeType} exchange ${plan.exchange}`);
          }
          if (plan.queue !== undefined) {
            const result = await channel.assertQueue(plan.queue, options);
            transcript.received(`declared queue ${result.queue} (${result.messageCount} messages, ${result.consumerCount} consumers)`);
          }
          break;
        }
        case "bind":
          await channel.bindQueue(need(plan.queue, "amqp_queue"), need(plan.exchange, "amqp_exchange"), plan.routingKey);
          transcript.received(`bound ${plan.queue} to ${plan.exchange} with "${plan.routingKey}"`);
          break;
        case "unbind":
          await channel.unbindQueue(need(plan.queue, "amqp_queue"), need(plan.exchange, "amqp_exchange"), plan.routingKey);
          transcript.received(`unbound ${plan.queue} from ${plan.exchange}`);
          break;
        case "delete":
          if (plan.queue !== undefined) {
            const result = await channel.deleteQueue(plan.queue, { ifUnused: plan.flags.ifUnused, ifEmpty: plan.flags.ifEmpty });
            transcript.received(`deleted queue ${plan.queue} (${result.messageCount} messages)`);
          } else {
            await channel.deleteExchange(need(plan.exchange, "amqp_queue or amqp_exchange"), { ifUnused: plan.flags.ifUnused });
            transcript.received(`deleted exchange ${plan.exchange}`);
          }
          break;
      }
    } finally {
      ctx.signal.removeEventListener("abort", abort);
    }
    await channel.close().catch(() => {});
  } catch (error) {
    return transcript.response({ url, status: 0, statusText: error instanceof Error ? error.message : String(error) });
  } finally {
    await connection.close().catch(() => {});
  }
  return transcript.response({ url, status: 200, statusText: "OK" });
}
