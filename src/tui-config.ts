/**
 * TUI preferences and helpers that do not need a terminal: fuzzy matching for
 * request search, and `~/.config/r3q/config.json` (theme, layout, extra key
 * bindings).
 *
 *   { "theme": "dracula", "keys": { "ctrl+r": "run", "f5": "send" } }
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const THEME_NAMES = ["dark", "dracula", "nord", "tokyoNight", "gruvbox", "matrix", "monochrome", "highContrast", "light"] as const;

/** Every action the palette lists; keys and config bindings refer to these names. */
export const ACTIONS: Record<string, string> = {
  send: "Send the selected request",
  find: "Find a request (fuzzy)",
  run: "Run requests (file, folder or tag) with live results",
  filter: "Filter the response with JSONPath",
  timeline: "Reopen an earlier send from the timeline",
  cookies: "Inspect or clear the cookie jar",
  environment: "Choose the environment",
  theme: "Next colour theme",
  new: "New request",
  view: "View the raw file",
  edit: "Edit the request",
  duplicate: "Duplicate the request",
  delete: "Delete the request (to .r3q-trash)",
  reload: "Reload the collection",
  "save-response": "Save the response body",
  "copy-curl": "Copy the last request as curl",
  "save-bundle": "Save the workspace bundle",
  "load-bundle": "Load a workspace bundle",
  project: "New org and project",
  quit: "Quit",
};

export interface TuiConfig { theme?: string; keys?: Record<string, string> }

export function configPath(): string {
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "r3q", "config.json");
}

export function readConfig(path = configPath()): TuiConfig {
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as TuiConfig;
    return v && typeof v === "object" ? v : {};
  } catch { return {}; }
}

export function writeConfig(update: Partial<TuiConfig>, path = configPath()): void {
  const next = { ...readConfig(path), ...update };
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  } catch { /* preferences are best effort */ }
}

/** Config bindings: key name (as hqtui reports it, lower-cased) to action, ignoring unknown actions. */
export function keyBindings(config: TuiConfig): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, action] of Object.entries(config.keys ?? {})) if (action in ACTIONS) out.set(key.toLowerCase(), action);
  return out;
}

/**
 * Subsequence fuzzy score: every query character must appear in order. Matches
 * at word starts and consecutive runs score higher; undefined means no match.
 */
export function fuzzyScore(query: string, text: string): number | undefined {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return 0;
  const t = text.toLowerCase();
  let score = 0;
  let ti = 0;
  let run = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found === -1) return undefined;
    const boundary = found === 0 || /[\s/#._-]/.test(t[found - 1]!);
    run = found === ti ? run + 1 : 0;
    score += 1 + (boundary ? 3 : 0) + run * 2 - Math.min(found - ti, 5) * 0.1;
    ti = found + 1;
  }
  // Prefer shorter texts when scores tie.
  return score - t.length * 0.001;
}

export function fuzzyFilter<T>(query: string, items: T[], text: (item: T) => string): T[] {
  return items
    .map((item) => ({ item, score: fuzzyScore(query, text(item)) }))
    .filter((x): x is { item: T; score: number } => x.score !== undefined)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.item);
}
