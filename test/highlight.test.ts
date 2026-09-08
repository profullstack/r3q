import { test } from "node:test";
import assert from "node:assert/strict";
import { highlightBody, highlightJson, tokenizeJson } from "../src/highlight.ts";

const P = {
  key: 1, string: 2, number: 3, boolean: 4,
  null: 5, punctuation: 6, plain: 7,
};

const kinds = (src: string) => tokenizeJson(src).filter((t) => t.text.trim() !== "")
  .map((t) => `${t.kind}:${t.text}`);

test("a key is told apart from a string value", () => {
  // The whole reason for a tokeniser: both are quoted, only one precedes a colon.
  assert.deepEqual(kinds('{"a":"b"}'), [
    "punctuation:{", "key:\"a\"", "punctuation::", "string:\"b\"", "punctuation:}",
  ]);
});

test("whitespace between a key and its colon does not fool the lookahead", () => {
  assert.deepEqual(kinds('{"a"  :  1}'), [
    "punctuation:{", "key:\"a\"", "punctuation::", "number:1", "punctuation:}",
  ]);
});

test("a brace inside a string is not punctuation", () => {
  const found = kinds('{"msg":"a { b } c"}');
  assert.ok(found.includes('string:"a { b } c"'), found.join(" "));
  // Only the two real braces are punctuation.
  assert.equal(found.filter((k) => k === "punctuation:{").length, 1);
  assert.equal(found.filter((k) => k === "punctuation:}").length, 1);
});

test("an escaped quote does not end the string early", () => {
  assert.deepEqual(kinds('"a\\"b"'), ['string:"a\\"b"']);
});

test("literals and numbers get their own colours", () => {
  assert.deepEqual(kinds("[true,false,null,-1.5e3]"), [
    "punctuation:[", "boolean:true", "punctuation:,", "boolean:false",
    "punctuation:,", "null:null", "punctuation:,", "number:-1.5e3", "punctuation:]",
  ]);
});

test("a negative number is one token, not a minus and a number", () => {
  assert.deepEqual(kinds("-42"), ["number:-42"]);
});

test("malformed input is emitted rather than swallowed", () => {
  const out = tokenizeJson("{oops}");
  assert.equal(out.map((t) => t.text).join(""), "{oops}", "nothing is lost");
});

test("an unterminated string does not hang or lose the rest", () => {
  const out = tokenizeJson('{"a": "unterminated');
  assert.equal(out.map((t) => t.text).join(""), '{"a": "unterminated');
});

test("every character survives the round trip, for any input", () => {
  for (const source of [
    "{}", "[]", '{"a":[1,2,{"b":null}]}', "  ", "", "not json at all",
    '{"unicode":"日本語 👍"}', '{"nested":{"deep":{"deeper":true}}}',
  ]) {
    assert.equal(tokenizeJson(source).map((t) => t.text).join(""), source, source);
  }
});

test("highlightJson splits on newlines and keeps colours", () => {
  const lines = highlightJson('{\n  "a": 1\n}', P);
  assert.equal(lines.length, 3);
  assert.equal(lines[0]?.[0]?.text, "{");
  assert.equal(lines[0]?.[0]?.fg, P.punctuation);
  const keySpan = lines[1]?.find((s) => s.text === '"a"');
  assert.equal(keySpan?.fg, P.key, "the key is coloured as a key");
  const numberSpan = lines[1]?.find((s) => s.text === "1");
  assert.equal(numberSpan?.fg, P.number);
});

test("the rendered text of every line matches the source line", () => {
  const source = '{\n  "name": "r3q",\n  "ok": true\n}';
  const lines = highlightJson(source, P);
  assert.deepEqual(lines.map((l) => l.map((s) => s.text).join("")), source.split("\n"));
});

test("non-JSON bodies are passed through as plain lines", () => {
  const lines = highlightBody("<html>\n<body>", "text/html", P);
  assert.deepEqual(lines.map((l) => l.map((s) => s.text).join("")), ["<html>", "<body>"]);
  assert.equal(lines[0]?.[0]?.fg, P.plain);
});

test("a content-type that lies still yields readable output", () => {
  const lines = highlightBody("plain text", "application/json", P);
  assert.equal(lines.map((l) => l.map((s) => s.text).join("")).join("\n"), "plain text");
});

test("a blank line stays a blank line", () => {
  const lines = highlightBody("a\n\nb", "text/plain", P);
  assert.equal(lines.length, 3);
  assert.deepEqual(lines[1], []);
});
