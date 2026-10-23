import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import * as grpc from "@grpc/grpc-js";
import protobuf from "protobufjs";
import {
  SseParser, amqpPlan, grpcTarget, mqttPlan, runStream, streamKind, type StreamContext,
} from "../src/http/protocols.ts";
import type { PreparedRequest } from "../src/http/types.ts";

const FIXTURES = resolve(import.meta.dirname, "fixtures", "protocols");

function context(overrides: Partial<StreamContext> = {}): StreamContext & { seen: string[] } {
  const seen: string[] = [];
  return {
    interaction: { prompt: async () => undefined, pick: async () => undefined, confirm: async () => true, log: () => {} },
    signal: new AbortController().signal,
    onMessage: (text) => seen.push(text),
    keepStreaming: false,
    timeoutMs: 1500,
    baseDir: FIXTURES,
    metadata: new Map(),
    ...overrides,
    seen,
  };
}

const request = (method: string, url: string, headers: [string, string][] = [], body?: string): PreparedRequest => ({
  method, url, headers, ...(body === undefined ? {} : { body: Buffer.from(body), bodyText: body }),
});

test("method keywords map to stream kinds", () => {
  assert.equal(streamKind("WEBSOCKET"), "websocket");
  assert.equal(streamKind("ws"), "websocket");
  assert.equal(streamKind("WSS"), "websocket");
  assert.equal(streamKind("EVENTSOURCE"), "sse");
  assert.equal(streamKind("SSE"), "sse");
  assert.equal(streamKind("GRPC"), "grpc");
  assert.equal(streamKind("MQTT"), "mqtt");
  assert.equal(streamKind("AMQP"), "amqp");
  assert.equal(streamKind("GET"), undefined);
});

test("websocket sends messages in order and waits for the server when asked", async () => {
  const received: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      return srv.upgrade(req, { data: { auth: req.headers.get("authorization") } }) ? undefined : new Response("no", { status: 400 });
    },
    websocket: {
      open(ws) { ws.send(`auth=${(ws.data as { auth: string | null }).auth}`); },
      message(ws, message) {
        received.push(String(message));
        // Reply late to the second message, so a client that does not wait
        // would have sent the third one first.
        if (String(message) === "two") setTimeout(() => ws.send("reply-two"), 150);
        else ws.send(`echo:${message}`);
      },
    },
  });
  try {
    const ctx = context();
    const res = await runStream(
      "websocket",
      request("WEBSOCKET", `ws://localhost:${server.port}/ws`, [["Authorization", "Bearer t"]]),
      [
        { text: "one", waitForServer: false },
        { text: "two", waitForServer: false },
        { text: "three", waitForServer: true },
      ],
      ctx,
    );
    assert.equal(res.status, 101);
    assert.deepEqual(received, ["one", "two", "three"]);
    const sentThree = ctx.seen.indexOf("> three");
    assert.ok(sentThree > 0);
    // wait-for-server: something arrived after "two" was sent and before "three".
    const sentTwo = ctx.seen.indexOf("> two");
    assert.ok(ctx.seen.slice(sentTwo + 1, sentThree).some((line) => !line.startsWith("> ")));
    assert.ok(res.text.includes("auth=Bearer t"));
    assert.ok(res.text.includes("echo:three"));
  } finally {
    server.stop(true);
  }
});

test("websocket streaming hook can send and close", async () => {
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) { return srv.upgrade(req) ? undefined : new Response("no", { status: 400 }); },
    websocket: { message(ws, message) { ws.send(`echo:${message}`); } },
  });
  try {
    const ctx = context({
      streaming: async (api) => {
        api.send("hello");
        await new Promise((r) => setTimeout(r, 100));
        api.close();
      },
    });
    const res = await runStream("websocket", request("WS", `ws://localhost:${server.port}`), undefined, ctx);
    assert.equal(res.text, "> hello\necho:hello");
  } finally {
    server.stop(true);
  }
});

test("websocket connection failure is reported, not thrown", async () => {
  const res = await runStream("websocket", request("WS", "ws://127.0.0.1:1/"), [], context());
  assert.equal(res.status, 0);
});

test("SSE parser handles fields, comments, multi-line data and split chunks", () => {
  const events: unknown[] = [];
  const parser = new SseParser((e) => events.push(e));
  parser.push(": comment\nevent: tick\nid: 7\nretry: 100\ndata: a\nda");
  parser.push("ta: b\r");
  parser.push("\n\r\ndata:x\n\n");
  parser.end();
  assert.deepEqual(events, [
    { event: "tick", id: "7", retry: 100, data: "a\nb" },
    { id: "7", data: "x" },
  ]);
});

test("SSE collects events until the server closes the stream", async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "x-seen-accept": req.headers.accept ?? "" });
    res.write("event: greet\ndata: hi\n\n");
    setTimeout(() => { res.write("data: second\n\n"); res.end(); }, 50);
  });
  await new Promise<void>((r) => server.listen(0, r));
  try {
    const port = (server.address() as AddressInfo).port;
    const ctx = context();
    const res = await runStream("sse", request("SSE", `http://localhost:${port}/events`), undefined, ctx);
    assert.equal(res.status, 200);
    assert.equal(res.text, "event: greet\ndata: hi\ndata: second");
    assert.ok(res.headers.some(([k, v]) => k === "x-seen-accept" && v === "text/event-stream"));
    assert.equal(ctx.seen.length, 2);
  } finally {
    server.close();
  }
});

test("SSE stops after the idle timeout on a stream that stays open", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: only\n\n");
  });
  await new Promise<void>((r) => server.listen(0, r));
  try {
    const port = (server.address() as AddressInfo).port;
    const started = Date.now();
    const res = await runStream("sse", request("SSE", `http://localhost:${port}/`), undefined, context({ timeoutMs: 200 }));
    assert.equal(res.text, "data: only");
    assert.ok(Date.now() - started < 1500);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("gRPC targets parse with and without a scheme", () => {
  assert.deepEqual(grpcTarget("localhost:50051/test.greeter.Greeter/SayHello"),
    { address: "localhost:50051", tls: false, service: "test.greeter.Greeter", method: "SayHello" });
  assert.equal(grpcTarget("grpcs://api.example.com/a.B/C").tls, true);
  assert.throws(() => grpcTarget("localhost:50051"));
});

/** A Greeter server built from the fixture proto, with server reflection (v1). */
async function greeterServer(): Promise<{ port: number; server: grpc.Server; seenMetadata: string[] }> {
  const root = await protobuf.load(resolve(FIXTURES, "greeter.proto"));
  const type = (name: string) => root.lookupType(`test.greeter.${name}`);
  const codec = (t: protobuf.Type) => ({
    serialize: (v: object) => Buffer.from(t.encode(t.fromObject(v)).finish()),
    deserialize: (b: Buffer) => t.toObject(t.decode(b)),
  });
  const HelloRequest = codec(type("HelloRequest"));
  const HelloReply = codec(type("HelloReply"));
  const CountRequest = codec(type("CountRequest"));
  const CountReply = codec(type("CountReply"));
  const seenMetadata: string[] = [];
  const definition = {
    SayHello: {
      path: "/test.greeter.Greeter/SayHello", requestStream: false, responseStream: false,
      requestSerialize: HelloRequest.serialize, requestDeserialize: HelloRequest.deserialize,
      responseSerialize: HelloReply.serialize, responseDeserialize: HelloReply.deserialize,
    },
    Count: {
      path: "/test.greeter.Greeter/Count", requestStream: false, responseStream: true,
      requestSerialize: CountRequest.serialize, requestDeserialize: CountRequest.deserialize,
      responseSerialize: CountReply.serialize, responseDeserialize: CountReply.deserialize,
    },
    Join: {
      path: "/test.greeter.Greeter/Join", requestStream: true, responseStream: false,
      requestSerialize: HelloRequest.serialize, requestDeserialize: HelloRequest.deserialize,
      responseSerialize: HelloReply.serialize, responseDeserialize: HelloReply.deserialize,
    },
  } as grpc.ServiceDefinition;
  const server = new grpc.Server();
  server.addService(definition, {
    SayHello: (call: grpc.ServerUnaryCall<{ name: string }, unknown>, done: grpc.sendUnaryData<unknown>) => {
      seenMetadata.push(String(call.metadata.get("x-token")[0]));
      if (call.request.name === "fail") done({ code: grpc.status.NOT_FOUND, details: "no such person" });
      else done(null, { message: `hello ${call.request.name}` });
    },
    Count: (call: grpc.ServerWritableStream<{ to: number }, unknown>) => {
      for (let n = 1; n <= call.request.to; n++) call.write({ n });
      call.end();
    },
    Join: (call: grpc.ServerReadableStream<{ name: string }, unknown>, done: grpc.sendUnaryData<unknown>) => {
      const names: string[] = [];
      call.on("data", (m: { name: string }) => names.push(m.name));
      call.on("end", () => done(null, { message: names.join("+") }));
    },
  } as grpc.UntypedServiceImplementation);

  // Reflection: answer file_containing_symbol with the fixture's descriptor.
  const descriptorModule = await import("protobufjs/ext/descriptor/index.js");
  const descriptor = ((descriptorModule as { default?: unknown }).default ?? descriptorModule) as { FileDescriptorProto: protobuf.Type };
  const set = (root as unknown as { toDescriptor(s: string): { file: object[] } }).toDescriptor("proto3");
  const fileBytes = set.file.map((f) => descriptor.FileDescriptorProto.encode(f).finish());
  const reflection = protobuf.parse(`
    syntax = "proto3"; package grpc.reflection.v1;
    message Req { string host = 1; string file_by_filename = 3; string file_containing_symbol = 4; }
    message Fdr { repeated bytes file_descriptor_proto = 1; }
    message Res { Req original_request = 2; Fdr file_descriptor_response = 4; }`, { keepCase: true }).root;
  const Req = reflection.lookupType("grpc.reflection.v1.Req");
  const Res = reflection.lookupType("grpc.reflection.v1.Res");
  server.addService({
    ServerReflectionInfo: {
      path: "/grpc.reflection.v1.ServerReflection/ServerReflectionInfo", requestStream: true, responseStream: true,
      requestSerialize: (v: object) => Buffer.from(Req.encode(v).finish()),
      requestDeserialize: (b: Buffer) => Req.toObject(Req.decode(b)),
      responseSerialize: (v: object) => Buffer.from(Res.encode(Res.fromObject(v)).finish()),
      responseDeserialize: (b: Buffer) => Res.decode(b),
    },
  } as grpc.ServiceDefinition, {
    ServerReflectionInfo: (call: grpc.ServerDuplexStream<Record<string, string>, object>) => {
      call.on("data", (req: Record<string, string>) => {
        call.write({ original_request: req, file_descriptor_response: { file_descriptor_proto: fileBytes } });
      });
      call.on("end", () => call.end());
    },
  } as grpc.UntypedServiceImplementation);

  const port = await new Promise<number>((done, fail) =>
    server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (error, p) => (error ? fail(error) : done(p))));
  return { port, server, seenMetadata };
}

test("gRPC unary, server-streaming, client-streaming and errors with a proto file", async () => {
  const { port, server, seenMetadata } = await greeterServer();
  const withProto = () => context({ metadata: new Map([["proto", ["greeter.proto"]]]) });
  try {
    const unary = await runStream("grpc",
      request("GRPC", `localhost:${port}/test.greeter.Greeter/SayHello`, [["x-token", "abc"]], '{"name": "r3q"}'),
      undefined, withProto());
    assert.equal(unary.status, 200, unary.statusText);
    assert.deepEqual(JSON.parse(unary.text.split("\n").slice(1).join("\n")), { message: "hello r3q" });
    assert.deepEqual(seenMetadata, ["abc"]);
    assert.ok(unary.headers.some(([k, v]) => k === "grpc-status" && v === "0"));

    const stream = await runStream("grpc",
      request("GRPC", `grpc://localhost:${port}/test.greeter.Greeter/Count`, [], '{"to": 3}'),
      undefined, withProto());
    assert.equal(stream.status, 200, stream.statusText);
    const replies = stream.text.split("\n> ").join("").match(/"n": \d/g);
    assert.deepEqual(replies, ['"n": 1', '"n": 2', '"n": 3']);

    const client = await runStream("grpc",
      request("GRPC", `localhost:${port}/test.greeter.Greeter/Join`),
      [{ text: '{"name":"a"}', waitForServer: false }, { text: '{"name":"b"}', waitForServer: false }],
      withProto());
    assert.ok(client.text.includes('"message": "a+b"'), client.text);

    const failed = await runStream("grpc",
      request("GRPC", `localhost:${port}/test.greeter.Greeter/SayHello`, [], '{"name": "fail"}'),
      undefined, withProto());
    assert.equal(failed.status, 404);
    assert.match(failed.statusText, /NOT_FOUND: no such person/);

    const missing = await runStream("grpc",
      request("GRPC", `localhost:${port}/test.greeter.Greeter/Nope`), undefined, withProto());
    assert.equal(missing.status, 0);
    assert.match(missing.statusText, /no method Nope/);
  } finally {
    server.forceShutdown();
  }
});

test("gRPC resolves the service through server reflection", async () => {
  const { port, server } = await greeterServer();
  try {
    const res = await runStream("grpc",
      request("GRPC", `localhost:${port}/test.greeter.Greeter/SayHello`, [], '{"name": "mirror"}'),
      undefined, context({ metadata: new Map([["grpc-reflection", [""]]]) }));
    assert.equal(res.status, 200, res.statusText);
    assert.ok(res.text.includes("hello mirror"));
  } finally {
    server.forceShutdown();
  }
});

test("MQTT headers become a publish/subscribe plan", () => {
  const plan = mqttPlan(request("MQTT", "tcp://broker.example:1883", [
    ["Topic", "a/b"], ["Topic", "c, d"], ["Subscribe", "replies/#"], ["QoS", "1"], ["Retain", "true"],
    ["Username", "u"], ["Password", "123"], ["ClientId", "r3q"], ["Keepalive", "30"],
  ], "Hello, World"));
  assert.equal(plan.url, "mqtt://broker.example:1883");
  assert.deepEqual(plan.subscribe, ["a/b", "c", "d", "replies/#"]);
  assert.deepEqual(plan.publish, ["a/b", "c", "d"]);
  assert.equal(plan.qos, 1);
  assert.equal(plan.retain, true);
  assert.deepEqual(plan.options, { username: "u", password: "123", clientId: "r3q", keepalive: 30 });
  assert.equal(plan.payload, "Hello, World");

  const listen = mqttPlan(request("MQTT", "mqtt://b", [["Topic", "t"]]));
  assert.deepEqual(listen.publish, []);
  assert.deepEqual(listen.subscribe, ["t"]);
});

test("AMQP headers become a plan, with message headers and properties", () => {
  const plan = amqpPlan(request("AMQP", "amqp://guest:guest@localhost", [
    ["amqp_method", "publish"], ["amqp_exchange", "my_exchange"], ["amqp-routing-key", "rk"],
    ["amqp_correlation_id", "c1"], ["amqp_persistent", "true"], ["amqp_priority", "5"],
    ["x-trace", "t1"], ["Content-Type", "application/json"],
  ], '{"event": "test"}'));
  assert.equal(plan.method, "publish");
  assert.equal(plan.exchange, "my_exchange");
  assert.equal(plan.routingKey, "rk");
  assert.deepEqual(plan.publishOptions, {
    correlationId: "c1", persistent: true, priority: 5, contentType: "application/json", headers: { "x-trace": "t1" },
  });
  assert.equal(plan.payload, '{"event": "test"}');

  const declare = amqpPlan(request("AMQP", "amqp://h", [
    ["amqp_method", "declare"], ["amqp_queue", "q"], ["amqp_durable", "true"], ["amqp_exchange_type", "topic"],
  ]));
  assert.equal(declare.method, "declare");
  assert.equal(declare.flags.durable, true);
  assert.equal(declare.exchangeType, "topic");

  assert.equal(amqpPlan(request("AMQP", "amqp://h")).method, "publish");
  assert.throws(() => amqpPlan(request("AMQP", "amqp://h", [["amqp_method", "explode"]])), /amqp_method/);
});

test("AMQP and MQTT connection failures are reported, not thrown", async () => {
  const amqp = await runStream("amqp", request("AMQP", "amqp://127.0.0.1:1", [["amqp_queue", "q"]], "x"), undefined, context());
  assert.equal(amqp.status, 0);
  const mqtt = await runStream("mqtt", request("MQTT", "mqtt://127.0.0.1:1", [["Topic", "t"]], "x"), undefined, context({ timeoutMs: 300 }));
  assert.equal(mqtt.status, 0);
});
