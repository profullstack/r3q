import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, getDiffieHellman } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  applyAuth, basicHeader, cognitoTimestamp, digestHeader, inferAwsScope, oauth2Token, padHex,
  parseChallenges, signAwsV4, srpPasswordClaim, type AuthContext,
} from "../src/http/auth.ts";
import type { HttpResponse, PreparedRequest } from "../src/http/types.ts";

async function fetchSend(req: PreparedRequest): Promise<HttpResponse> {
  const started = Date.now();
  const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
  const body = Buffer.from(await res.arrayBuffer());
  return {
    status: res.status, statusText: res.statusText, httpVersion: "1.1",
    headers: [...res.headers.entries()], body, text: body.toString("utf8"),
    contentType: res.headers.get("content-type") ?? "", duration: Date.now() - started, url: req.url, redirects: [],
  };
}

function context(vars: Record<string, string> = {}, logs: string[] = []): AuthContext {
  return {
    variable: (name) => vars[name],
    interaction: {
      prompt: async () => undefined, pick: async () => undefined, confirm: async () => true,
      log: (m) => { logs.push(m); },
    },
    send: fetchSend,
    cache: new Map(),
  };
}

async function server(handler: (req: IncomingMessage, body: string, res: ServerResponse) => void): Promise<{ url: string; close: () => void }> {
  const s = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => handler(req, body, res));
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, close: () => s.close() };
}

const header = (req: PreparedRequest, name: string) => req.headers.find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

test("Basic: user password, user:password, and a pre-encoded token", async () => {
  const encoded = `Basic ${Buffer.from("alice:s3cret pass").toString("base64")}`;
  assert.equal(basicHeader("alice s3cret pass"), encoded);
  assert.equal(basicHeader("alice:s3cret pass"), encoded);
  assert.equal(basicHeader("YWxpY2U6czNjcmV0"), "Basic YWxpY2U6czNjcmV0");
  const { request } = await applyAuth({ method: "GET", url: "https://x.test", headers: [["authorization", "basic a b"]] }, context());
  assert.equal(header(request, "authorization"), `Basic ${Buffer.from("a:b").toString("base64")}`);
});

test("Bearer and unknown schemes pass through", async () => {
  const req: PreparedRequest = { method: "GET", url: "https://x.test", headers: [["Authorization", "Bearer abc"]] };
  assert.equal((await applyAuth(req, context())).request, req);
});

// RFC 7616 section 3.9.1
const RFC7616 = {
  realm: "http-auth@example.org", qop: "auth, auth-int",
  nonce: "7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v",
  opaque: "FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS",
};
const RFC_INPUT = { username: "Mufasa", password: "Circle of Life", method: "GET", uri: "/dir/index.html", cnonce: "f2/wE4q74E6zIJEtWaHKaf5wv/H5QzzpXusqGemxURZJ", nc: 1 };

test("Digest matches the RFC 7616 MD5 and SHA-256 vectors", () => {
  assert.match(digestHeader({ ...RFC7616, algorithm: "MD5" }, RFC_INPUT), /response="8ca523f5e9506fed4657c9700eebdbec"/);
  const sha = digestHeader({ ...RFC7616, algorithm: "SHA-256" }, RFC_INPUT);
  assert.match(sha, /response="753927fa0e85d155564e2e272a28d1802ca10daf4496794697cf8db5856cb6c1"/);
  assert.match(sha, /qop=auth, nc=00000001/);
  assert.match(sha, /opaque="FQhe/);
});

test("Digest challenge parsing handles several challenges in one header", () => {
  const c = parseChallenges('Digest realm="a, b", qop="auth", algorithm=SHA-256, nonce="n1", Digest realm="a", algorithm=MD5, nonce="n2", Basic realm="x"');
  assert.deepEqual(c.map((x) => [x.scheme, x.params.algorithm, x.params.nonce]), [["digest", "SHA-256", "n1"], ["digest", "MD5", "n2"], ["basic", undefined, undefined]]);
  assert.equal(c[0]?.params.realm, "a, b");
});

test("Digest round trip against a server that checks the response", async () => {
  const nonce = "abc123";
  const srv = await server((req, _body, res) => {
    const auth = req.headers.authorization;
    if (!auth) {
      res.statusCode = 401;
      res.setHeader("WWW-Authenticate", `Digest realm="r3q", qop="auth", algorithm=SHA-256, nonce="${nonce}", opaque="o"`);
      res.end();
      return;
    }
    const p = parseChallenges(auth)[0]?.params ?? {};
    const H = (s: string) => createHash("sha256").update(s).digest("hex");
    const expected = H(`${H("u:r3q:p w")}:${nonce}:${p.nc}:${p.cnonce}:auth:${H(`GET:${p.uri}`)}`);
    res.statusCode = p.response === expected && p.uri === "/x?y=1" ? 200 : 403;
    res.end();
  });
  try {
    const ctx = context();
    const { request, onChallenge } = await applyAuth({ method: "GET", url: `${srv.url}/x?y=1`, headers: [["Authorization", "Digest u p w"]] }, ctx);
    assert.equal(header(request, "authorization"), undefined);
    const first = await ctx.send(request);
    assert.equal(first.status, 401);
    const retry = await onChallenge?.(first);
    assert.ok(retry);
    assert.equal((await ctx.send(retry)).status, 200);
  } finally { srv.close(); }
});

test("SigV4 matches the AWS get-vanilla test vector", () => {
  const signed = signAwsV4(
    { method: "GET", url: "https://example.amazonaws.com/", headers: [] },
    { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", region: "us-east-1", service: "service" },
    new Date("2015-08-30T12:36:00Z"),
  );
  assert.equal(header(signed, "authorization"),
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
  assert.equal(header(signed, "x-amz-date"), "20150830T123600Z");
});

test("SigV4 matches the AWS get-vanilla-query-order-key-case vector", () => {
  const signed = signAwsV4(
    { method: "GET", url: "https://example.amazonaws.com/?Param2=value2&Param1=value1", headers: [] },
    { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", region: "us-east-1", service: "service" },
    new Date("2015-08-30T12:36:00Z"),
  );
  assert.match(header(signed, "authorization") ?? "", /Signature=b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500$/);
});

test("AWS header form adds the session token and infers scope from the host", async () => {
  assert.deepEqual(inferAwsScope("dynamodb.eu-west-1.amazonaws.com"), { region: "eu-west-1", service: "dynamodb" });
  assert.deepEqual(inferAwsScope("bucket.s3.us-west-2.amazonaws.com"), { region: "us-west-2", service: "s3" });
  assert.deepEqual(inferAwsScope("s3-ap-south-1.amazonaws.com"), { region: "ap-south-1", service: "s3" });
  assert.deepEqual(inferAwsScope("abc.execute-api.us-east-2.amazonaws.com"), { region: "us-east-2", service: "execute-api" });
  assert.deepEqual(inferAwsScope("iam.amazonaws.com"), { region: "us-east-1", service: "iam" });
  const { request } = await applyAuth({
    method: "GET", url: "https://bucket.s3.us-west-2.amazonaws.com/key",
    headers: [["Authorization", "AWS AKID SECRET token:TOK"]],
  }, context());
  assert.match(header(request, "authorization") ?? "", /^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/us-west-2\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token/);
  assert.equal(header(request, "x-amz-security-token"), "TOK");
});

test("Cognito SRP claim agrees with a simulated server", () => {
  const N = BigInt(`0x${getDiffieHellman("modp15").getPrime("hex")}`);
  const g = 2n;
  const pow = (b: bigint, e: bigint): bigint => { let r = 1n; b %= N; while (e > 0n) { if (e & 1n) r = r * b % N; b = b * b % N; e >>= 1n; } return r; };
  const hh = (hex: string) => createHash("sha256").update(Buffer.from(hex, "hex")).digest("hex");
  const k = BigInt(`0x${hh(`${padHex(N)}${padHex(g)}`)}`);
  const poolId = "us-east-1_Pool42";
  const user = "user-uuid";
  const password = "Hunter2!";
  const salt = "5c3a7e";
  const x = BigInt(`0x${hh(`${padHex(BigInt(`0x${salt}`))}${createHash("sha256").update(`Pool42${user}:${password}`).digest("hex")}`)}`);
  const v = pow(g, x);
  const a = 123456789123456789n;
  const b = 987654321987654321n;
  const A = pow(g, a);
  const B = (k * v + pow(g, b)) % N;
  const u = BigInt(`0x${hh(`${padHex(A)}${padHex(B)}`)}`);
  const S = pow(A * pow(v, u), b);
  const prk = createHmac("sha256", Buffer.from(padHex(u), "hex")).update(Buffer.from(padHex(S), "hex")).digest();
  const key = createHmac("sha256", prk).update(Buffer.concat([Buffer.from("Caldera Derived Key"), Buffer.from([1])])).digest().subarray(0, 16);
  const secretBlock = Buffer.from("secret-block").toString("base64");
  const timestamp = cognitoTimestamp(new Date("2022-02-01T03:04:05Z"));
  assert.equal(timestamp, "Tue Feb 1 03:04:05 UTC 2022");
  const expected = createHmac("sha256", key).update(Buffer.concat([
    Buffer.from("Pool42"), Buffer.from(user), Buffer.from(secretBlock, "base64"), Buffer.from(timestamp),
  ])).digest("base64");
  assert.equal(srpPasswordClaim({ a, poolId, userIdForSrp: user, password, srpB: B.toString(16), salt, secretBlock, timestamp }), expected);
});

test("openid client_credentials posts the grant, sends Basic client auth, and caches", async () => {
  let calls = 0;
  const srv = await server((req, body, res) => {
    calls++;
    const form = new URLSearchParams(body);
    assert.equal(form.get("grant_type"), "client_credentials");
    assert.equal(form.get("scope"), "read write");
    assert.equal(req.headers.authorization, `Basic ${Buffer.from("cid:csecret").toString("base64")}`);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ access_token: `tok${calls}`, expires_in: 3600 }));
  });
  try {
    const ctx = context({ auth_tokenEndpoint: `${srv.url}/token`, auth_clientId: "cid", auth_clientSecret: "csecret", auth_scope: "read write" });
    const req: PreparedRequest = { method: "GET", url: "https://api.test", headers: [["Authorization", "openid client_credentials auth"]] };
    assert.equal(header((await applyAuth(req, ctx)).request, "authorization"), "Bearer tok1");
    assert.equal(header((await applyAuth(req, ctx)).request, "authorization"), "Bearer tok1");
    assert.equal(calls, 1);
    assert.equal(await oauth2Token("client", "auth", { ...ctx, cache: new Map() }), "tok2");
  } finally { srv.close(); }
});

test("openid device_code logs the code and polls until the token arrives", async () => {
  let polls = 0;
  const srv = await server((req, body, res) => {
    res.setHeader("Content-Type", "application/json");
    const form = new URLSearchParams(body);
    if (req.url === "/device") {
      assert.equal(form.get("client_id"), "pub");
      res.end(JSON.stringify({ device_code: "dc", user_code: "WXYZ", verification_uri: "https://example.test/device", interval: 0, expires_in: 60 }));
      return;
    }
    assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:device_code");
    assert.equal(form.get("device_code"), "dc");
    polls++;
    if (polls < 3) { res.statusCode = 400; res.end(JSON.stringify({ error: "authorization_pending" })); return; }
    res.end(JSON.stringify({ access_token: "device-token", expires_in: 60 }));
  });
  try {
    const logs: string[] = [];
    const ctx = context({ d_tokenEndpoint: `${srv.url}/token`, d_deviceCodeEndpoint: `${srv.url}/device`, d_clientId: "pub" }, logs);
    const { request } = await applyAuth({ method: "GET", url: "https://api.test", headers: [["Authorization", "oauth2 device_code d"]] }, ctx);
    assert.equal(header(request, "authorization"), "Bearer device-token");
    assert.equal(polls, 3);
    assert.match(logs.join("\n"), /WXYZ/);
  } finally { srv.close(); }
});

test("an expired token is refreshed with the refresh_token grant", async () => {
  const grants: string[] = [];
  const srv = await server((_req, body, res) => {
    const form = new URLSearchParams(body);
    grants.push(form.get("grant_type") ?? "");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(form.get("grant_type") === "refresh_token"
      ? { access_token: "refreshed", expires_in: 3600 }
      : { access_token: "first", refresh_token: "rt", expires_in: 0 }));
  });
  try {
    const ctx = context({ p_tokenEndpoint: `${srv.url}/token`, p_clientId: "c", p_username: "u", p_password: "pw" });
    assert.equal(await oauth2Token("password", "p", ctx), "first");
    assert.equal(await oauth2Token("password", "p", ctx), "refreshed");
    assert.deepEqual(grants, ["password", "refresh_token"]);
  } finally { srv.close(); }
});
