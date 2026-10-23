/**
 * A cookie jar in the RFC 6265 sense: Set-Cookie responses are remembered and
 * sent back to matching requests. Every client in the spec does this by
 * default; `# @no-cookie-jar` opts a request out. JetBrains keeps at most 300.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface Cookie {
  name: string;
  value: string;
  domain: string;
  /** Host-only cookies match the exact host; domain cookies match subdomains. */
  hostOnly: boolean;
  path: string;
  expires?: number;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: string;
  created: number;
}

const LIMIT = 300;

function defaultPath(pathname: string): string {
  if (!pathname.startsWith("/")) return "/";
  const last = pathname.lastIndexOf("/");
  return last <= 0 ? "/" : pathname.slice(0, last);
}

function domainMatch(host: string, domain: string): boolean {
  return host === domain || (host.endsWith(`.${domain}`) && !/^\d+\.\d+\.\d+\.\d+$/.test(host));
}

function pathMatch(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
}

export class CookieJar {
  cookies: Cookie[] = [];
  private readonly file?: string;

  constructor(file?: string) {
    this.file = file;
    if (file) {
      try { this.cookies = JSON.parse(readFileSync(file, "utf8")) as Cookie[]; } catch { /* first run */ }
    }
  }

  /** Remember the cookies in a response. */
  store(url: string, setCookies: string[]): void {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    for (const header of setCookies) {
      const parts = header.split(";");
      const pair = parts.shift() ?? "";
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const cookie: Cookie = {
        name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(),
        domain: host, hostOnly: true, path: defaultPath(u.pathname), secure: false, httpOnly: false, created: Date.now(),
      };
      let maxAge: number | undefined;
      for (const attr of parts) {
        const i = attr.indexOf("=");
        const key = (i === -1 ? attr : attr.slice(0, i)).trim().toLowerCase();
        const value = i === -1 ? "" : attr.slice(i + 1).trim();
        if (key === "domain" && value) {
          const domain = value.replace(/^\./, "").toLowerCase();
          if (!domainMatch(host, domain)) { cookie.name = ""; break; }
          cookie.domain = domain;
          cookie.hostOnly = false;
        } else if (key === "path" && value.startsWith("/")) cookie.path = value;
        else if (key === "expires") { const t = Date.parse(value); if (!Number.isNaN(t)) cookie.expires = t; }
        else if (key === "max-age" && /^-?\d+$/.test(value)) maxAge = Number(value);
        else if (key === "secure") cookie.secure = true;
        else if (key === "httponly") cookie.httpOnly = true;
        else if (key === "samesite") cookie.sameSite = value;
      }
      if (!cookie.name) continue;
      if (maxAge !== undefined) cookie.expires = Date.now() + maxAge * 1000;
      this.cookies = this.cookies.filter((c) => !(c.name === cookie.name && c.domain === cookie.domain && c.path === cookie.path));
      if (cookie.expires === undefined || cookie.expires > Date.now()) this.cookies.push(cookie);
    }
    if (this.cookies.length > LIMIT) this.cookies = this.cookies.sort((a, b) => b.created - a.created).slice(0, LIMIT);
    this.save();
  }

  /** The Cookie header value for a request, or undefined. */
  header(url: string): string | undefined {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const now = Date.now();
    this.cookies = this.cookies.filter((c) => c.expires === undefined || c.expires > now);
    const matching = this.cookies
      .filter((c) => (c.hostOnly ? host === c.domain : domainMatch(host, c.domain)))
      .filter((c) => pathMatch(u.pathname || "/", c.path))
      .filter((c) => !c.secure || u.protocol === "https:" || u.protocol === "wss:" || host === "localhost")
      .sort((a, b) => b.path.length - a.path.length || a.created - b.created);
    return matching.length ? matching.map((c) => `${c.name}=${c.value}`).join("; ") : undefined;
  }

  /** JetBrains `response.cookiesByName` and friends read from here. */
  byName(name: string): Cookie[] { return this.cookies.filter((c) => c.name === name); }

  clear(): void { this.cookies = []; this.save(); }

  private save(): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      writeFileSync(this.file, JSON.stringify(this.cookies, null, 2), { mode: 0o600 });
    } catch { /* a read-only collection still works, it just forgets */ }
  }
}
