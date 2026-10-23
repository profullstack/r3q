/**
 * Reading values out of responses: JSONPath for JSON bodies, a small XML DOM
 * and an XPath subset for XML ones. Enough for request variables
 * (`{{login.response.body.$.token}}`, `body.//token`) and assertions.
 */

// ---------- JSONPath ----------

type Segment =
  | { kind: "key"; key: string }
  | { kind: "index"; index: number }
  | { kind: "slice"; start?: number; end?: number; step?: number }
  | { kind: "wild" }
  | { kind: "deep"; key: string | "*" }
  | { kind: "filter"; expr: string }
  | { kind: "union"; keys: (string | number)[] };

function parsePath(path: string): Segment[] {
  let p = path.trim();
  if (p.startsWith("$")) p = p.slice(1);
  const out: Segment[] = [];
  let i = 0;
  const ident = (): string => {
    const m = /^[^.[\]\s]+/.exec(p.slice(i));
    const s = m?.[0] ?? "";
    i += s.length;
    return s;
  };
  while (i < p.length) {
    if (p.startsWith("..", i)) {
      i += 2;
      if (p[i] === "[") {
        const close = p.indexOf("]", i);
        const inner = p.slice(i + 1, close).trim().replace(/^['"]|['"]$/g, "");
        out.push({ kind: "deep", key: inner === "*" ? "*" : inner });
        i = close + 1;
      } else out.push({ kind: "deep", key: ident() || "*" });
    } else if (p[i] === ".") {
      i++;
      const key = ident();
      out.push(key === "*" ? { kind: "wild" } : { kind: "key", key });
    } else if (p[i] === "[") {
      let depth = 0;
      let close = i;
      for (; close < p.length; close++) {
        if (p[close] === "[") depth++;
        else if (p[close] === "]" && --depth === 0) break;
      }
      const inner = p.slice(i + 1, close).trim();
      i = close + 1;
      if (inner === "*") out.push({ kind: "wild" });
      else if (inner.startsWith("?")) out.push({ kind: "filter", expr: inner.replace(/^\?\s*\(?/, "").replace(/\)$/, "") });
      else if (/^-?\d*:-?\d*(:-?\d+)?$/.test(inner)) {
        const [a, b, c] = inner.split(":");
        out.push({ kind: "slice", start: a ? Number(a) : undefined, end: b ? Number(b) : undefined, step: c ? Number(c) : undefined });
      } else if (inner.includes(",")) {
        out.push({ kind: "union", keys: inner.split(",").map((k) => k.trim()).map((k) => /^-?\d+$/.test(k) ? Number(k) : k.replace(/^['"]|['"]$/g, "")) });
      } else if (/^-?\d+$/.test(inner)) out.push({ kind: "index", index: Number(inner) });
      else out.push({ kind: "key", key: inner.replace(/^['"]|['"]$/g, "") });
    } else {
      const key = ident();
      if (!key) break;
      out.push({ kind: "key", key });
    }
  }
  return out;
}

function children(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value);
  return [];
}

function filterMatches(item: unknown, expr: string): boolean {
  // @.a.b op literal | @.a (exists)
  const m = /^@((?:\.[\w$-]+|\[[^\]]+\])*)\s*(==|!=|>=|<=|>|<|=~)?\s*(.*)$/.exec(expr.trim());
  if (!m) return false;
  const left = jsonPath(item, `$${m[1]}`)[0];
  if (!m[2]) return left !== undefined;
  let right: unknown = m[3]!.trim();
  if (m[2] === "=~") {
    const re = /^\/(.*)\/(\w*)$/.exec(String(right));
    return re ? new RegExp(re[1]!, re[2]).test(String(left)) : false;
  }
  try { right = JSON.parse(String(right).replace(/^'(.*)'$/, '"$1"')); } catch { /* bare word */ }
  switch (m[2]) {
    case "==": return left === right || String(left) === String(right);
    case "!=": return left !== right && String(left) !== String(right);
    case ">": return Number(left) > Number(right);
    case "<": return Number(left) < Number(right);
    case ">=": return Number(left) >= Number(right);
    case "<=": return Number(left) <= Number(right);
  }
  return false;
}

/** All matches of a JSONPath expression. */
export function jsonPath(root: unknown, path: string): unknown[] {
  let current: unknown[] = [root];
  for (const seg of parsePath(path)) {
    const next: unknown[] = [];
    for (const value of current) {
      switch (seg.kind) {
        case "key":
          if (value && typeof value === "object" && seg.key in (value as object)) next.push((value as Record<string, unknown>)[seg.key]);
          else if (Array.isArray(value) && seg.key === "length") next.push(value.length);
          break;
        case "index":
          if (Array.isArray(value)) {
            const v = value[seg.index < 0 ? value.length + seg.index : seg.index];
            if (v !== undefined) next.push(v);
          }
          break;
        case "slice":
          if (Array.isArray(value)) {
            const step = seg.step ?? 1;
            const len = value.length;
            const norm = (n: number | undefined, d: number): number => n === undefined ? d : n < 0 ? Math.max(0, len + n) : Math.min(len, n);
            for (let k = norm(seg.start, 0); k < norm(seg.end, len); k += step) next.push(value[k]);
          }
          break;
        case "wild": next.push(...children(value)); break;
        case "union":
          for (const key of seg.keys) {
            if (typeof key === "number" && Array.isArray(value)) { const v = value[key < 0 ? value.length + key : key]; if (v !== undefined) next.push(v); }
            else if (value && typeof value === "object" && String(key) in (value as object)) next.push((value as Record<string, unknown>)[String(key)]);
          }
          break;
        case "filter":
          for (const item of children(value)) if (filterMatches(item, seg.expr)) next.push(item);
          break;
        case "deep": {
          const walk = (v: unknown): void => {
            if (v && typeof v === "object") {
              if (seg.key === "*") next.push(...children(v));
              else if (!Array.isArray(v) && seg.key in (v as object)) next.push((v as Record<string, unknown>)[seg.key]);
              for (const c of children(v)) walk(c);
            }
          };
          walk(value);
          break;
        }
      }
    }
    current = next;
  }
  return current;
}

/** The first match, the way request variables use it. */
export function jsonPathFirst(root: unknown, path: string): unknown {
  const all = jsonPath(root, path);
  return all.length === 1 ? all[0] : all.length === 0 ? undefined : (/\[\*\]|\.\.|\[\?|:|,/.test(path) ? all : all[0]);
}

/** Plain dot/bracket access without the `$`: `user.items[0].id`. */
export function dotPath(root: unknown, path: string): unknown {
  return path === "" ? root : jsonPathFirst(root, `$.${path}`.replace(/\.\[/g, "["));
}

// ---------- XML ----------

export interface XmlNode {
  name: string;
  attributes: Record<string, string>;
  children: (XmlNode | string)[];
  parent?: XmlNode;
}

function decode(text: string): string {
  return text.replace(/&(lt|gt|amp|quot|apos|#x[0-9a-f]+|#\d+);/gi, (_, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" } as Record<string, string>)[e.toLowerCase()]!;
  });
}

/** A forgiving XML parser: enough structure for XPath, not a validator. */
export function parseXml(source: string): XmlNode {
  const root: XmlNode = { name: "#document", attributes: {}, children: [] };
  let node = root;
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/\s*([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    if (m[1] !== undefined) node.children.push(m[1]);
    else if (m[2]) { if (node.parent) node = node.parent; }
    else if (m[3]) {
      const attributes: Record<string, string> = {};
      const attrRe = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
      let a: RegExpExecArray | null;
      while ((a = attrRe.exec(m[4] ?? ""))) attributes[a[1]!] = decode(a[2] ?? a[3] ?? a[4] ?? "");
      const child: XmlNode = { name: m[3], attributes, children: [], parent: node };
      node.children.push(child);
      if (!m[5]) node = child;
    } else if (m[6] !== undefined && m[6].trim() !== "") node.children.push(decode(m[6]));
  }
  return root;
}

export function textContent(node: XmlNode | string): string {
  return typeof node === "string" ? node : node.children.map(textContent).join("");
}

const local = (name: string): string => name.includes(":") ? name.slice(name.indexOf(":") + 1) : name;

/** XPath subset: absolute and relative steps, `//`, `*`, `@attr`, `text()`, `[n]`, `[@a='v']`, `[name='v']`, `..`, `.`. */
export function xpath(root: XmlNode, expression: string): (XmlNode | string)[] {
  let expr = expression.trim();
  let current: (XmlNode | string)[] = [root];
  if (!expr.startsWith("/")) expr = `//${expr}`;
  const steps: { deep: boolean; step: string }[] = [];
  const re = /(\/\/?)((?:[^/[\]]|\[[^\]]*\])+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(expr))) steps.push({ deep: m[1] === "//", step: m[2]! });
  const descendants = (n: XmlNode): XmlNode[] => {
    const out: XmlNode[] = [n];
    for (const c of n.children) if (typeof c !== "string") out.push(...descendants(c));
    return out;
  };
  for (const { deep, step } of steps) {
    const sm = /^([^[]+)((?:\[[^\]]*\])*)$/.exec(step);
    const test = sm?.[1] ?? step;
    const predicates = [...(sm?.[2] ?? "").matchAll(/\[([^\]]*)\]/g)].map((p) => p[1]!.trim());
    let next: (XmlNode | string)[] = [];
    for (const item of current) {
      if (typeof item === "string") continue;
      const bases = deep ? descendants(item) : [item];
      for (const base of bases) {
        if (test === "text()") next.push(...base.children.filter((c): c is string => typeof c === "string"));
        else if (test.startsWith("@")) { const v = base.attributes[test.slice(1)]; if (v !== undefined) next.push(v); }
        else if (test === "..") { if (base.parent) next.push(base.parent); }
        else if (test === ".") next.push(base);
        else {
          let matched = base.children.filter((c): c is XmlNode => typeof c !== "string" && (test === "*" || c.name === test || local(c.name) === test));
          for (const pred of predicates) {
            if (/^\d+$/.test(pred)) matched = matched[Number(pred) - 1] ? [matched[Number(pred) - 1]!] : [];
            else if (pred === "last()") matched = matched.length ? [matched[matched.length - 1]!] : [];
            else {
              const pm = /^(@?[\w:.-]+|text\(\))\s*(?:(=|!=)\s*['"](.*)['"])?$/.exec(pred);
              if (pm) matched = matched.filter((c) => {
                const v = pm[1] === "text()" ? textContent(c) : pm[1]!.startsWith("@") ? c.attributes[pm[1]!.slice(1)] : c.children.find((x): x is XmlNode => typeof x !== "string" && x.name === pm[1]) ? textContent(c.children.find((x): x is XmlNode => typeof x !== "string" && x.name === pm[1])!) : undefined;
                if (!pm[2]) return v !== undefined;
                return pm[2] === "=" ? v === pm[3] : v !== pm[3];
              });
            }
          }
          next.push(...matched);
        }
      }
    }
    // Deep steps visit shared descendants more than once.
    next = [...new Set(next)];
    current = next;
  }
  return current;
}

export function xpathText(xml: string, expression: string): string | undefined {
  const found = xpath(parseXml(xml), expression);
  return found.length ? textContent(found[0]!) : undefined;
}

/** A value as it goes into a request: strings bare, everything else as JSON. */
export function stringify(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}
