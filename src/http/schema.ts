/**
 * A JSON Schema draft-07 validator, written for r3q's script `expect(...).toMatchSchema()`
 * and `validateSchema()`. It covers the validation keywords of draft-07 and `$ref`
 * within the same document; it does not fetch remote schemas.
 */

export interface SchemaError { path: string; message: string }
export interface SchemaResult { valid: boolean; errors: SchemaError[] }

type Schema = boolean | Record<string, unknown>;

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return a === b;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((v, i) => deepEqual(v, bb[i]));
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "null": return value === null;
    case "array": return Array.isArray(value);
    case "object": return typeof value === "object" && value !== null && !Array.isArray(value);
    default: return typeof value === type;
  }
}

const FORMATS: Record<string, (s: string) => boolean> = {
  "date-time": (s) => /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.test(s) && !Number.isNaN(Date.parse(s.replace(" ", "T"))),
  date: (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return false;
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
  },
  email: (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s),
  uri: (s) => /^[a-zA-Z][a-zA-Z0-9+.-]*:[^\s]*$/.test(s),
  uuid: (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s),
  ipv4: (s) => /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(s),
  ipv6: (s) => {
    if (!/^[0-9a-fA-F:.]+$/.test(s) || (s.match(/::/g) ?? []).length > 1) return false;
    const groups = s.split(":");
    if (groups.length < 3 || groups.length > 8) return false;
    return groups.every((g) => g === "" || /^[0-9a-fA-F]{1,4}$/.test(g) || FORMATS.ipv4!(g));
  },
};

function unescapePointer(token: string): string {
  return decodeURIComponent(token).replace(/~1/g, "/").replace(/~0/g, "~");
}

function resolveRef(root: Schema, ref: string): Schema {
  if (!ref.startsWith("#")) throw new Error(`$ref ${ref}: only refs within the same schema are supported`);
  let node: unknown = root;
  const pointer = ref.slice(1);
  if (pointer === "" || pointer === "/") return root;
  for (const token of pointer.replace(/^\//, "").split("/")) {
    const key = unescapePointer(token);
    if (node === null || typeof node !== "object" || !(key in (node as object))) throw new Error(`$ref ${ref}: not found`);
    node = (node as Record<string, unknown>)[key];
  }
  return node as Schema;
}

const codePoints = (s: string): number => [...s].length;
const show = (v: unknown): string => JSON.stringify(v) ?? String(v);
const childPath = (path: string, key: string | number): string => `${path}/${String(key).replace(/~/g, "~0").replace(/\//g, "~1")}`;

function validate(value: unknown, schema: Schema, root: Schema, path: string, errors: SchemaError[], depth: number): void {
  if (depth > 200) { errors.push({ path, message: "schema recursion too deep" }); return; }
  if (schema === true) return;
  if (schema === false) { errors.push({ path, message: "no value is allowed here" }); return; }
  if (typeof schema !== "object" || schema === null) return;
  const s = schema;
  const fail = (message: string, at = path): void => { errors.push({ path: at || "/", message }); };
  const sub = (v: unknown, sch: unknown, p: string): SchemaError[] => { const e: SchemaError[] = []; validate(v, sch as Schema, root, p, e, depth + 1); return e; };

  // In draft-07, $ref makes sibling keywords ignored.
  if (typeof s.$ref === "string") {
    let target: Schema;
    try { target = resolveRef(root, s.$ref); } catch (error) { fail((error as Error).message); return; }
    validate(value, target, root, path, errors, depth + 1);
    return;
  }

  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? s.type as string[] : [s.type as string];
    if (!types.some((t) => matchesType(value, t))) fail(`expected ${types.join(" or ")}, got ${typeOf(value)}`);
  }
  if (Array.isArray(s.enum) && !s.enum.some((e) => deepEqual(e, value))) fail(`must be one of ${show(s.enum)}`);
  if ("const" in s && !deepEqual(s.const, value)) fail(`must equal ${show(s.const)}`);

  if (typeof value === "number") {
    if (typeof s.multipleOf === "number") {
      const q = value / s.multipleOf;
      if (Math.abs(q - Math.round(q)) > 1e-9) fail(`must be a multiple of ${s.multipleOf}`);
    }
    if (typeof s.maximum === "number" && value > s.maximum) fail(`must be <= ${s.maximum}`);
    if (typeof s.exclusiveMaximum === "number" && value >= s.exclusiveMaximum) fail(`must be < ${s.exclusiveMaximum}`);
    if (typeof s.minimum === "number" && value < s.minimum) fail(`must be >= ${s.minimum}`);
    if (typeof s.exclusiveMinimum === "number" && value <= s.exclusiveMinimum) fail(`must be > ${s.exclusiveMinimum}`);
  }

  if (typeof value === "string") {
    if (typeof s.maxLength === "number" && codePoints(value) > s.maxLength) fail(`must be at most ${s.maxLength} characters`);
    if (typeof s.minLength === "number" && codePoints(value) < s.minLength) fail(`must be at least ${s.minLength} characters`);
    if (typeof s.pattern === "string" && !new RegExp(s.pattern, "u").test(value)) fail(`must match /${s.pattern}/`);
    if (typeof s.format === "string" && FORMATS[s.format] && !FORMATS[s.format]!(value)) fail(`must be a valid ${s.format}`);
  }

  if (Array.isArray(value)) {
    if (Array.isArray(s.items)) {
      const tuple = s.items as unknown[];
      tuple.forEach((sch, i) => { if (i < value.length) errors.push(...sub(value[i], sch, childPath(path, i))); });
      if (s.additionalItems !== undefined) for (let i = tuple.length; i < value.length; i++) errors.push(...sub(value[i], s.additionalItems, childPath(path, i)));
    } else if (s.items !== undefined) {
      value.forEach((v, i) => errors.push(...sub(v, s.items, childPath(path, i))));
    }
    if (typeof s.maxItems === "number" && value.length > s.maxItems) fail(`must have at most ${s.maxItems} items`);
    if (typeof s.minItems === "number" && value.length < s.minItems) fail(`must have at least ${s.minItems} items`);
    if (s.uniqueItems === true) {
      outer: for (let i = 0; i < value.length; i++) for (let j = i + 1; j < value.length; j++) {
        if (deepEqual(value[i], value[j])) { fail(`items ${i} and ${j} are equal; items must be unique`); break outer; }
      }
    }
    if (s.contains !== undefined && !value.some((v, i) => sub(v, s.contains, childPath(path, i)).length === 0)) fail("must contain a matching item");
  }

  if (matchesType(value, "object")) {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (typeof s.maxProperties === "number" && keys.length > s.maxProperties) fail(`must have at most ${s.maxProperties} properties`);
    if (typeof s.minProperties === "number" && keys.length < s.minProperties) fail(`must have at least ${s.minProperties} properties`);
    if (Array.isArray(s.required)) for (const k of s.required as string[]) if (!(k in obj)) fail(`missing required property "${k}"`);
    const props = (s.properties ?? {}) as Record<string, unknown>;
    const patterns = Object.entries((s.patternProperties ?? {}) as Record<string, unknown>).map(([p, sch]) => [new RegExp(p, "u"), sch] as const);
    for (const k of keys) {
      let matched = false;
      if (Object.prototype.hasOwnProperty.call(props, k)) { matched = true; errors.push(...sub(obj[k], props[k], childPath(path, k))); }
      for (const [re, sch] of patterns) if (re.test(k)) { matched = true; errors.push(...sub(obj[k], sch, childPath(path, k))); }
      if (!matched && s.additionalProperties !== undefined) {
        if (s.additionalProperties === false) fail(`property "${k}" is not allowed`, childPath(path, k));
        else errors.push(...sub(obj[k], s.additionalProperties, childPath(path, k)));
      }
    }
    if (s.dependencies && typeof s.dependencies === "object") {
      for (const [k, dep] of Object.entries(s.dependencies as Record<string, unknown>)) {
        if (!(k in obj)) continue;
        if (Array.isArray(dep)) { for (const need of dep as string[]) if (!(need in obj)) fail(`property "${k}" requires "${need}"`); }
        else errors.push(...sub(obj, dep, path));
      }
    }
    if (s.propertyNames !== undefined) for (const k of keys) {
      const e = sub(k, s.propertyNames, childPath(path, k));
      if (e.length) fail(`property name "${k}" is invalid: ${e[0]!.message}`, childPath(path, k));
    }
  }

  if (s.if !== undefined) {
    const passes = sub(value, s.if, path).length === 0;
    if (passes && s.then !== undefined) errors.push(...sub(value, s.then, path));
    if (!passes && s.else !== undefined) errors.push(...sub(value, s.else, path));
  }
  if (Array.isArray(s.allOf)) for (const sch of s.allOf) errors.push(...sub(value, sch, path));
  if (Array.isArray(s.anyOf) && !s.anyOf.some((sch) => sub(value, sch, path).length === 0)) fail("must match at least one schema in anyOf");
  if (Array.isArray(s.oneOf)) {
    const n = s.oneOf.filter((sch) => sub(value, sch, path).length === 0).length;
    if (n !== 1) fail(`must match exactly one schema in oneOf (matched ${n})`);
  }
  if (s.not !== undefined && sub(value, s.not, path).length === 0) fail("must not match the schema in not");
}

/** Validate `data` against a draft-07 schema. Error paths are JSON pointers ("" is the root, shown as "/"). */
export function validateSchema(data: unknown, schema: object | boolean): SchemaResult {
  const errors: SchemaError[] = [];
  validate(data, schema as Schema, schema as Schema, "", errors, 0);
  return { valid: errors.length === 0, errors: errors.map((e) => ({ ...e, path: e.path || "/" })) };
}
