/**
 * The `r3q` object scripts see: seeded random values, date arithmetic and
 * small crypto helpers. Pure and deterministic when seeded, so a test that
 * generates data can be replayed exactly.
 */
import { createHash, createHmac, randomUUID } from "node:crypto";
import { formatDate } from "./dynamic.ts";

/** mulberry32: a tiny 32-bit PRNG, good enough for test data. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const UNIT_MS: Record<string, number> = { ms: 1, s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 };
const UNIT_ALIASES: Record<string, string> = {
  millisecond: "ms", milliseconds: "ms", second: "s", seconds: "s", sec: "s", minute: "m", minutes: "m", min: "m",
  hour: "h", hours: "h", day: "d", days: "d", week: "w", weeks: "w", month: "M", months: "M", year: "y", years: "y",
};
const unitOf = (unit: string): string => UNIT_ALIASES[unit] ?? unit;
const toDate = (d: Date | string | number): Date => d instanceof Date ? new Date(d.getTime()) : new Date(d);

function addTo(date: Date | string | number, amount: number, unit: string): Date {
  const d = toDate(date);
  const u = unitOf(unit);
  if (u === "y") d.setUTCFullYear(d.getUTCFullYear() + amount);
  else if (u === "M") d.setUTCMonth(d.getUTCMonth() + amount);
  else if (UNIT_MS[u] !== undefined) d.setTime(d.getTime() + amount * UNIT_MS[u]!);
  else throw new Error(`unknown date unit "${unit}" (ms s m h d w M y)`);
  return d;
}

export interface Helpers {
  random: {
    seed(n: number): void;
    int(min?: number, max?: number): number;
    float(min?: number, max?: number): number;
    pick<T>(items: T[]): T | undefined;
    uuid(): string;
    string(length?: number, alphabet?: string): string;
    bool(): boolean;
  };
  date: {
    now(): Date;
    add(date: Date | string | number, amount: number, unit: string): Date;
    subtract(date: Date | string | number, amount: number, unit: string): Date;
    format(date: Date | string | number, format: string, utc?: boolean): string;
    iso(date?: Date | string | number): string;
    unix(date?: Date | string | number): number;
    diff(a: Date | string | number, b: Date | string | number, unit?: string): number;
  };
  crypto: {
    sha256(text: string): string;
    sha1(text: string): string;
    md5(text: string): string;
    hmac(algorithm: string, key: string, text: string, encoding?: "hex" | "base64" | "base64url"): string;
    base64(text: string): string;
    base64Decode(text: string): string;
    uuid(): string;
  };
}

export function makeHelpers(opts: { seed?: number; now?: () => Date } = {}): Helpers {
  let next: () => number = opts.seed === undefined ? Math.random : mulberry32(opts.seed);
  let seeded = opts.seed !== undefined;
  const now = opts.now ?? (() => new Date());
  const hash = (alg: string) => (text: string): string => createHash(alg).update(text, "utf8").digest("hex");

  const random: Helpers["random"] = {
    seed(n: number) { next = mulberry32(n); seeded = true; },
    int(min = 0, max = 100) {
      const lo = Math.ceil(Math.min(min, max));
      const hi = Math.floor(Math.max(min, max));
      return lo + Math.floor(next() * (hi - lo + 1));
    },
    float(min = 0, max = 1) { return min + next() * (max - min); },
    pick(items) { return items.length ? items[Math.floor(next() * items.length)] : undefined; },
    uuid() {
      if (!seeded) return randomUUID();
      const bytes = Array.from({ length: 16 }, () => Math.floor(next() * 256));
      bytes[6] = (bytes[6]! & 0x0f) | 0x40;
      bytes[8] = (bytes[8]! & 0x3f) | 0x80;
      const hex = bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    },
    string(length = 12, alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789") {
      const chars = [...alphabet];
      let out = "";
      for (let i = 0; i < length; i++) out += chars[Math.floor(next() * chars.length)];
      return out;
    },
    bool() { return next() < 0.5; },
  };

  const date: Helpers["date"] = {
    now: () => new Date(now().getTime()),
    add: (d, amount, unit) => addTo(d, amount, unit),
    subtract: (d, amount, unit) => addTo(d, -amount, unit),
    format: (d, format, utc = false) => formatDate(toDate(d), format, utc),
    iso: (d = now()) => toDate(d).toISOString(),
    unix: (d = now()) => Math.floor(toDate(d).getTime() / 1000),
    diff(a, b, unit = "ms") {
      const da = toDate(a);
      const db = toDate(b);
      const u = unitOf(unit);
      if (u === "M" || u === "y") {
        const months = (da.getUTCFullYear() - db.getUTCFullYear()) * 12 + (da.getUTCMonth() - db.getUTCMonth());
        return u === "M" ? months : Math.trunc(months / 12);
      }
      const ms = UNIT_MS[u];
      if (ms === undefined) throw new Error(`unknown date unit "${unit}" (ms s m h d w M y)`);
      return Math.trunc((da.getTime() - db.getTime()) / ms);
    },
  };

  const crypto: Helpers["crypto"] = {
    sha256: hash("sha256"), sha1: hash("sha1"), md5: hash("md5"),
    hmac: (algorithm, key, text, encoding = "hex") => createHmac(algorithm, key).update(text, "utf8").digest(encoding),
    base64: (text) => Buffer.from(text, "utf8").toString("base64"),
    base64Decode: (text) => Buffer.from(text, "base64").toString("utf8"),
    uuid: () => random.uuid(),
  };

  return { random, date, crypto };
}
