/**
 * Sending a request and describing what came back.
 *
 * The whole exchange is kept — status, headers, timing, body — because the
 * point of a terminal REST client is inspecting the response, not just getting
 * an exit code.
 */
import type { RequestFile } from "./collection.ts";

export interface Exchange {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: string;
  /** Round trip in milliseconds. */
  ms: number;
  bytes: number;
  contentType: string;
  error?: string;
}

export async function send(request: RequestFile, timeoutMs = 30_000): Promise<Exchange> {
  const started = performance.now();
  const empty = (error: string): Exchange => ({
    status: 0, statusText: "", headers: [], body: "",
    ms: performance.now() - started, bytes: 0, contentType: "", error,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: controller.signal,
      redirect: "follow",
    });
    const body = await response.text();
    return {
      status: response.status,
      statusText: response.statusText,
      headers: [...response.headers.entries()].sort((a, b) => a[0].localeCompare(b[0])),
      body,
      ms: performance.now() - started,
      bytes: new TextEncoder().encode(body).length,
      contentType: response.headers.get("content-type") ?? "",
    };
  } catch (error) {
    if (controller.signal.aborted) return empty(`timed out after ${timeoutMs}ms`);
    return empty(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
  }
}

/** Pretty-print JSON, leaving anything else exactly as it arrived. */
export function formatBody(body: string, contentType: string): string {
  if (!/\bjson\b/i.test(contentType)) return body;
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    // A content-type that lies is common enough not to be an error.
    return body;
  }
}

/** The colour family for a status code, as a theme key. */
export function statusKind(status: number): "success" | "accent" | "warning" | "danger" | "muted" {
  if (status === 0) return "danger";
  if (status < 200) return "muted";
  if (status < 300) return "success";
  if (status < 400) return "accent";
  if (status < 500) return "warning";
  return "danger";
}
