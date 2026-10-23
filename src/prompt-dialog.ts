/**
 * Questions the runner asks while a request is being prepared (`@prompt`,
 * `{{$input}}`, `{{$pick}}`, `@note`) and the TUI's own save/load path
 * prompts, as modals. Each question is a promise the runner awaits.
 */
import type { Container, KeyEvent, Theme } from "@profullstack/hqtui";
import type { Interaction } from "./http/types.ts";

type Question =
  | { kind: "prompt"; message: string; value: string; secret: boolean; resolve(v: string | undefined): void }
  | { kind: "pick"; message: string; options: string[]; selected: number; resolve(v: string | undefined): void }
  | { kind: "confirm"; message: string; focus: number; resolve(v: boolean): void };

export class PromptDialog implements Interaction {
  private queue: Question[] = [];
  private readonly invalidate: () => void;
  private readonly onLog: (line: string) => void;

  constructor(invalidate: () => void, onLog: (line: string) => void) {
    this.invalidate = invalidate;
    this.onLog = onLog;
  }

  get open(): boolean { return this.queue.length > 0; }

  prompt(message: string, options?: { default?: string; secret?: boolean }): Promise<string | undefined> {
    return new Promise((resolve) => { this.queue.push({ kind: "prompt", message, value: options?.default ?? "", secret: Boolean(options?.secret), resolve }); this.invalidate(); });
  }

  pick(message: string, options: string[]): Promise<string | undefined> {
    return new Promise((resolve) => { this.queue.push({ kind: "pick", message, options, selected: 0, resolve }); this.invalidate(); });
  }

  confirm(message: string): Promise<boolean> {
    return new Promise((resolve) => { this.queue.push({ kind: "confirm", message, focus: 1, resolve }); this.invalidate(); });
  }

  log(message: string): void { this.onLog(message); }

  private finish(value: unknown): void {
    const q = this.queue.shift();
    if (!q) return;
    (q.resolve as (v: unknown) => void)(value);
    this.invalidate();
  }

  paste(text: string): void {
    const q = this.queue[0];
    if (q?.kind === "prompt") { q.value += text.replace(/[\r\n]+/g, " "); this.invalidate(); }
  }

  key(event: KeyEvent): void {
    const q = this.queue[0];
    if (!q) return;
    if (event.key === "escape") { this.finish(q.kind === "confirm" ? false : undefined); return; }
    if (q.kind === "prompt") {
      if (event.key === "enter") this.finish(q.value);
      else if (event.key === "backspace") q.value = Array.from(q.value).slice(0, -1).join("");
      else if (event.key === "ctrl+u") q.value = "";
      else if (event.char && event.char.length >= 1 && !event.ctrl && !event.alt) q.value += event.char;
    } else if (q.kind === "pick") {
      if (event.key === "up") q.selected = (q.selected + q.options.length - 1) % q.options.length;
      else if (event.key === "down" || event.key === "tab") q.selected = (q.selected + 1) % q.options.length;
      else if (event.key === "enter") this.finish(q.options[q.selected]);
    } else {
      if (["tab", "left", "right", "shift+tab"].includes(event.key)) q.focus = 1 - q.focus;
      else if (event.key === "y") this.finish(true);
      else if (event.key === "n") this.finish(false);
      else if (event.key === "enter") this.finish(q.focus === 0);
    }
    this.invalidate();
  }

  render(ui: Container, theme: Theme, width: number, height: number): void {
    const q = this.queue[0];
    if (!q) return;
    const common = { width: Math.min(80, width - 2), onDismiss: () => this.finish(q.kind === "confirm" ? false : undefined), onKey: (event: KeyEvent) => this.key(event) };
    if (q.kind === "prompt") {
      ui.modal({ ...common, title: "r3q asks", height: 9, buttons: [{ label: "OK", onPress: () => this.finish(q.value) }, { label: "Cancel", onPress: () => this.finish(undefined), variant: "ghost" }] }, (body) => {
        body.text(q.message, { size: 2, wrap: true, bold: true });
        body.textInput({ value: q.secret ? "•".repeat(Array.from(q.value).length) : q.value, cursor: Array.from(q.value).length, focused: true, size: 1 });
        body.label("Enter accepts · Ctrl+U clears · Esc cancels", { size: 1 });
      });
    } else if (q.kind === "pick") {
      ui.modal({ ...common, title: "r3q asks", height: Math.min(height - 2, q.options.length + 7) }, (body) => {
        body.text(q.message, { size: 1, bold: true });
        body.table({
          rows: q.options.map((o) => ({ o })), columns: [{ key: "o", title: "" }], header: false, selected: q.selected,
          size: Math.min(q.options.length, height - 9), onSelectRow: (i) => { q.selected = i; this.invalidate(); }, onActivateRow: (i) => this.finish(q.options[i]),
        });
        body.label("↑↓ choose · Enter picks · Esc cancels", { size: 1 });
      });
    } else {
      ui.modal({
        ...common, title: "Confirm", height: 9,
        buttons: [
          { label: "Yes", onPress: () => this.finish(true), focused: q.focus === 0 },
          { label: "No", onPress: () => this.finish(false), variant: "ghost", focused: q.focus === 1 },
        ],
      }, (body) => {
        body.text(q.message, { size: 3, wrap: true });
        body.label("y / n · Tab chooses · Enter confirms", { size: 1 });
      });
    }
  }
}
