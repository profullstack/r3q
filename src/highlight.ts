/**
 * JSON syntax highlighting, as spans.
 *
 * A tokeniser rather than a set of regexes over each line: a regex cannot tell
 * a key from a string value, and it colours the inside of a string that happens
 * to contain a brace. Both look fine on the example you tested and wrong on
 * real API output.
 */
import type { Span, SpanLine } from "@profullstack/hqtui";

export interface JsonPalette {
  key: number;
  string: number;
  number: number;
  boolean: number;
  null: number;
  punctuation: number;
  plain: number;
}

type Kind = keyof JsonPalette;

export interface Token {
  text: string;
  kind: Kind;
}

const WHITESPACE = /\s/;

/**
 * Split JSON into coloured tokens. Anything unparseable is emitted verbatim as
 * `plain`, so malformed output stays readable rather than being swallowed.
 */
export function tokenizeJson(source: string): Token[] {
  const out: Token[] = [];
  let i = 0;

  const push = (text: string, kind: Kind): void => {
    if (text !== "") out.push({ text, kind });
  };

  while (i < source.length) {
    const ch = source[i] as string;

    if (WHITESPACE.test(ch)) {
      let j = i;
      while (j < source.length && WHITESPACE.test(source[j] as string)) j++;
      push(source.slice(i, j), "plain");
      i = j;
      continue;
    }

    if (ch === '"') {
      let j = i + 1;
      while (j < source.length) {
        const c = source[j] as string;
        if (c === "\\") { j += 2; continue; }
        if (c === '"') { j++; break; }
        j++;
      }
      const text = source.slice(i, j);
      // A string is a key when the next non-space character is a colon. This is
      // the whole reason for tokenising rather than pattern matching.
      let k = j;
      while (k < source.length && WHITESPACE.test(source[k] as string)) k++;
      push(text, source[k] === ":" ? "key" : "string");
      i = j;
      continue;
    }

    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      let j = i;
      if (source[j] === "-") j++;
      while (j < source.length && /[0-9.eE+\-]/.test(source[j] as string)) j++;
      push(source.slice(i, j), "number");
      i = j;
      continue;
    }

    if (source.startsWith("true", i) || source.startsWith("false", i)) {
      const word = source.startsWith("true", i) ? "true" : "false";
      push(word, "boolean");
      i += word.length;
      continue;
    }

    if (source.startsWith("null", i)) {
      push("null", "null");
      i += 4;
      continue;
    }

    if ("{}[],:".includes(ch)) {
      push(ch, "punctuation");
      i++;
      continue;
    }

    // Something unexpected: emit one character and keep going rather than
    // giving up on the rest of the document.
    push(ch, "plain");
    i++;
  }
  return out;
}

/** Highlighted JSON, one SpanLine per line, ready for ui.text(). */
export function highlightJson(source: string, palette: JsonPalette): SpanLine[] {
  const lines: SpanLine[] = [];
  let current: SpanLine = [];
  for (const token of tokenizeJson(source)) {
    const parts = token.text.split("\n");
    parts.forEach((part, index) => {
      if (index > 0) { lines.push(current); current = []; }
      if (part !== "") current.push({ text: part, fg: palette[token.kind] } satisfies Span);
    });
  }
  lines.push(current);
  return lines;
}

/** Body text as span lines: highlighted when it is JSON, plain otherwise. */
export function highlightBody(
  body: string,
  contentType: string,
  palette: JsonPalette,
): SpanLine[] {
  if (!/\bjson\b/i.test(contentType)) {
    return body.split("\n").map((line) => (line === "" ? [] : [{ text: line, fg: palette.plain }]));
  }
  return highlightJson(body, palette);
}
