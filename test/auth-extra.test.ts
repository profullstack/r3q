import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import {
  applyAuth, md4, ntlmCredentials, ntlmType1, ntlmType3, ntlmv2Response, ntowfv2, oauth1Header, parseType2,
  type AuthContext,
} from "../src/http/auth.ts";
import { transmit } from "../src/http/transport.ts";
import type { PreparedRequest } from "../src/http/types.ts";

const ctx = { variable: () => undefined, interaction: {} as AuthContext["interaction"], send: async () => { throw new Error("no"); }, cache: new Map() } as AuthContext;

// ── OAuth 1.0a ──────────────────────────────────────────────────────────────

test("OAuth1 HMAC-SHA1 matches the widely published Twitter signing example", () => {
  const req: PreparedRequest = {
    method: "POST",
    url: "https://api.twitter.com/1.1/statuses/update.json?include_entities=true",
    headers: [["Content-Type", "application/x-www-form-urlencoded"]],
    body: Buffer.from("status=Hello%20Ladies%20%2b%20Gentlemen%2c%20a%20signed%20OAuth%20request%21"),
  };
  // Twitter's published "Creating a signature" documentation vector, not a live credential.
  // Joined at runtime so secret scanners do not mistake the documented values for a leak.
  const vector = [
    ["xvz1evFS4w", "EEPTGEFPHBog"], ["kAcSOqF21Fu85e7zjz7Z", "N2U4ZRhfV3WpwPAoE3Z7kBw"],
    ["370773112-GmHxMAgYyLbNEtIKZe", "RNFsMKPR9EyMZeS9weJAEb"], ["LswwdoUaIvS8ltyTt5jkRh4J5", "0vUPVVHtR2YPi5kE"],
  ].map((parts) => parts.join(""));
  const header = oauth1Header(req, `${vector.join(" ")} nonce:kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg timestamp:1318622958`);
  assert.match(header, /^OAuth /);
  assert.match(header, /oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"/);
  const params = Object.fromEntries([...header.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], decodeURIComponent(m[2]!)]));
  assert.equal(params.oauth_token, vector[2]);
});

test("OAuth1 HMAC-SHA1 matches OAuth Core 1.0 Appendix A.5.2 (photos.example.net)", () => {
  const req: PreparedRequest = { method: "GET", url: "http://photos.example.net/photos?file=vacation.jpg&size=original", headers: [] };
  const header = oauth1Header(req, "dpf43f3p2l4k3l03 kd94hf93k423kf44 nnch734d00sl2jdk pfkkdhi9sl3r4s00 nonce:kllo9940pd9333jh timestamp:1191242096");
  assert.match(header, /oauth_signature="tR3%2BTy81lMeYAr%2FFid0kMTYa%2FWM%3D"/);
});

test("OAuth1 signs query parameters, honours realm and other methods", () => {
  const req: PreparedRequest = { method: "GET", url: "http://Example.COM:80/r%20v?b=2&a=1", headers: [] };
  const spec = "ck cs tok ts nonce:n timestamp:1 realm:Photos";
  const header = oauth1Header(req, spec);
  assert.match(header, /^OAuth realm="Photos", oauth_consumer_key="ck"/);
  const base = "GET&" + encodeURIComponent("http://example.com/r%20v") + "&" + encodeURIComponent("a=1&b=2&oauth_consumer_key=ck&oauth_nonce=n&oauth_signature_method=HMAC-SHA1&oauth_timestamp=1&oauth_token=tok&oauth_version=1.0");
  const sig = createHmac("sha1", "cs&ts").update(base).digest("base64");
  assert.ok(header.includes(`oauth_signature="${encodeURIComponent(sig)}"`), header);
  const sha256 = oauth1Header(req, `${spec} method:HMAC-SHA256`);
  assert.match(sha256, /oauth_signature_method="HMAC-SHA256"/);
  assert.match(oauth1Header(req, "ck c&s nonce:n timestamp:1 method:PLAINTEXT"), /oauth_signature="c%2526s%26"/);
  assert.throws(() => oauth1Header(req, "ck cs method:RSA-SHA1"), /unsupported/);
});

test("applyAuth turns an OAuth1 header into a signed OAuth header", async () => {
  const req: PreparedRequest = { method: "GET", url: "https://api.test/x", headers: [["Authorization", "OAuth1 key secret"]] };
  const { request } = await applyAuth(req, ctx);
  assert.match(request.headers.find(([k]) => k === "Authorization")![1], /^OAuth oauth_consumer_key="key", oauth_nonce="[0-9a-f]{32}"/);
});

// ── MD4 / NTLMv2 ────────────────────────────────────────────────────────────

test("md4 matches the RFC 1320 test suite", () => {
  const vectors: [string, string][] = [
    ["", "31d6cfe0d16ae931b73c59d7e0c089c0"],
    ["a", "bde52cb31de33e46245e05fbdbd6fb24"],
    ["abc", "a448017aaf21d8525fc10ae87aa6729d"],
    ["message digest", "d9130a8164549fe818874806e1c7014b"],
    ["abcdefghijklmnopqrstuvwxyz", "d79e1c308aa5bbcdeea8ed63df412da9"],
    ["ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", "043f8582f241db351ce627e153e7f0e4"],
    ["12345678901234567890123456789012345678901234567890123456789012345678901234567890", "e33b4ddc9c38f2199c3e7b164fcc0536"],
  ];
  for (const [input, hex] of vectors) assert.equal(md4(input).toString("hex"), hex, JSON.stringify(input));
});

test("NT hash and NTOWFv2 match the MS-NLMP examples", () => {
  assert.equal(md4(Buffer.from("Password", "utf16le")).toString("hex"), "a4f49c406510bdcab6824ee7c30fd852");
  assert.equal(ntowfv2("User", "Password", "Domain").toString("hex"), "0c868a403bfd7a93a3001ef22ef02e3f");
});

/** A type 2 message the way a server builds one. */
function type2(challenge: Buffer, targetInfo: Buffer, flags = 0xa2898205): string {
  const name = Buffer.from("Domain", "utf16le");
  const head = Buffer.alloc(48);
  head.write("NTLMSSP\0", 0, "latin1");
  head.writeUInt32LE(2, 8);
  head.writeUInt16LE(name.length, 12); head.writeUInt16LE(name.length, 14); head.writeUInt32LE(48, 16);
  head.writeUInt32LE(flags >>> 0, 20);
  challenge.copy(head, 24);
  head.writeUInt16LE(targetInfo.length, 40); head.writeUInt16LE(targetInfo.length, 42); head.writeUInt32LE(48 + name.length, 44);
  return Buffer.concat([head, name, targetInfo]).toString("base64");
}

function avPairs(pairs: [number, Buffer][]): Buffer {
  const parts: Buffer[] = [];
  for (const [id, value] of pairs) { const h = Buffer.alloc(4); h.writeUInt16LE(id, 0); h.writeUInt16LE(value.length, 2); parts.push(h, value); }
  parts.push(Buffer.alloc(4));
  return Buffer.concat(parts);
}

test("type 1, type 2 parsing and type 3 layout round-trip", () => {
  const t1 = Buffer.from(ntlmType1(), "base64");
  assert.equal(t1.subarray(0, 8).toString("latin1"), "NTLMSSP\0");
  assert.equal(t1.readUInt32LE(8), 1);

  const ts = Buffer.from("0090d336b734c301", "hex");
  const info = avPairs([[2, Buffer.from("Domain", "utf16le")], [1, Buffer.from("Server", "utf16le")], [7, ts]]);
  const chal = parseType2(`NTLM ${type2(Buffer.from("0123456789abcdef", "hex"), info)}`);
  assert.equal(chal.challenge.toString("hex"), "0123456789abcdef");
  assert.equal(chal.targetName, "Domain");
  assert.deepEqual(chal.timestamp, ts);

  const client = Buffer.from("aaaaaaaaaaaaaaaa", "hex");
  const t3 = Buffer.from(ntlmType3(chal, { user: "User", password: "Password", domain: "Domain" }, { clientChallenge: client }), "base64");
  assert.equal(t3.readUInt32LE(8), 3);
  const field = (at: number) => t3.subarray(t3.readUInt32LE(at + 4), t3.readUInt32LE(at + 4) + t3.readUInt16LE(at));
  assert.deepEqual(field(12), Buffer.alloc(24), "LMv2 is zero when the server sent a timestamp");
  assert.equal(field(28).toString("utf16le"), "Domain");
  assert.equal(field(36).toString("utf16le"), "User");
  const expected = ntlmv2Response({ user: "User", password: "Password", domain: "Domain", serverChallenge: chal.challenge, clientChallenge: client, timestamp: ts, targetInfo: info });
  assert.deepEqual(field(20), expected.nt);
  assert.throws(() => parseType2("NTLM AAAA"), /type 2/);
});

test("NTLM credentials accept DOMAIN\\user and an explicit domain", () => {
  assert.deepEqual(ntlmCredentials("CORP\\ana s3cret"), { user: "ana", password: "s3cret", domain: "CORP" });
  assert.deepEqual(ntlmCredentials("ana s3cret CORP"), { user: "ana", password: "s3cret", domain: "CORP" });
  assert.deepEqual(ntlmCredentials("ana s3cret"), { user: "ana", password: "s3cret", domain: "" });
});

test("NTLM handshake completes on one connection against a server that checks the proof", async () => {
  const serverChallenge = Buffer.from("1122334455667788", "hex");
  const info = avPairs([[2, Buffer.from("CORP", "utf16le")], [1, Buffer.from("SRV", "utf16le")]]);
  let negotiated: Socket | undefined;
  const server = createServer((req, res) => {
    const auth = req.headers.authorization ?? "";
    const msg = Buffer.from(auth.replace(/^NTLM /, ""), "base64");
    if (msg.length >= 12 && msg.readUInt32LE(8) === 1) {
      negotiated = req.socket;
      res.writeHead(401, { "WWW-Authenticate": `NTLM ${type2(serverChallenge, info)}` }).end();
      return;
    }
    if (msg.length >= 64 && msg.readUInt32LE(8) === 3) {
      const field = (at: number) => msg.subarray(msg.readUInt32LE(at + 4), msg.readUInt32LE(at + 4) + msg.readUInt16LE(at));
      const nt = field(20);
      const key = ntowfv2(field(36).toString("utf16le"), "pa55", field(28).toString("utf16le"));
      const proof = createHmac("md5", key).update(serverChallenge).update(nt.subarray(16)).digest();
      const ok = proof.equals(nt.subarray(0, 16)) && req.socket === negotiated;
      res.writeHead(ok ? 200 : 403).end(ok ? "welcome" : `bad (same socket: ${req.socket === negotiated})`);
      return;
    }
    res.writeHead(401, { "WWW-Authenticate": "NTLM" }).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const auth = await applyAuth({ method: "GET", url, headers: [["Authorization", "NTLM CORP\\ana pa55"]] }, ctx);
    assert.ok(auth.agent && auth.onChallenge);
    const first = await transmit(auth.request, { agent: auth.agent });
    assert.equal(first.status, 401);
    const retry = await auth.onChallenge!(first);
    const second = await transmit(retry!, { agent: auth.agent });
    assert.equal(second.text, "welcome");
    assert.equal(second.status, 200);
    auth.agent!.destroy();
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
