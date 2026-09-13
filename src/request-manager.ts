import { wrap, type Container, type KeyEvent, type Theme } from "@profullstack/hqtui";
import type { RequestFile } from "./collection.ts";
import {
  TEMPLATES, changeTemplate, draftFromSource, duplicateFilename, readSnapshot,
  saveDraft, serializeDraft, suggestedFilename, templateDraft, trashRequest,
  type Draft, type Snapshot,
} from "./requests.ts";

const FIELDS = ["name", "file", "url", "headers", "body"] as const;
type Field = typeof FIELDS[number];

export interface Editor {
  kind: "editor";
  mode: "new" | "edit" | "duplicate";
  step: "template" | "details" | "review";
  draft: Draft;
  original?: Snapshot;
  template: number;
  focus: number;
  cursors: Record<Field, number>;
  scroll: number;
  error: string;
  busy: boolean;
  customFile: boolean;
}

type DocumentDialog = {
  kind: "view" | "delete";
  snapshot: Snapshot;
  focus: number;
  scroll: number;
  error: string;
  busy: boolean;
};

export type RequestDialog = Editor | DocumentDialog;

interface ManagerHooks {
  current: () => RequestFile | undefined;
  invalidate: () => void;
  changed: (id: string | undefined, note: string) => Promise<void> | void;
  note: (message: string) => void;
}

function editor(draft: Draft, mode: Editor["mode"], original?: Snapshot): Editor {
  return {
    kind: "editor", mode, draft, original,
    step: mode === "new" ? "template" : "details",
    template: Math.max(0, TEMPLATES.findIndex((t) => t.method === draft.method)),
    focus: 0, scroll: 0, error: "", busy: false, customFile: mode !== "new",
    cursors: Object.fromEntries(FIELDS.map((field) => [field, draft[field].length])) as Record<Field, number>,
  };
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

/** Insert pasted content as text, never as terminal control sequences or key commands. */
export function cleanPaste(text: string, multiline: boolean): string {
  const clean = text.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
  return multiline ? clean.replace(/\t/g, "  ") : clean.replace(/[\n\t]/g, " ");
}

/** Code-point movement keeps non-ASCII characters intact while editing. */
function previousIndex(value: string, cursor: number): number {
  return Math.max(0, cursor - (Array.from(value.slice(0, cursor)).at(-1)?.length ?? 1));
}
function nextIndex(value: string, cursor: number): number {
  return Math.min(value.length, cursor + (Array.from(value.slice(cursor))[0]?.length ?? 1));
}
function linePosition(value: string, cursor: number): { row: number; column: number; start: number } {
  const before = value.slice(0, cursor);
  const start = before.lastIndexOf("\n") + 1;
  return { row: before.split("\n").length - 1, column: cursor - start, start };
}

export class RequestManager {
  dialog?: RequestDialog;
  readonly root: string;
  private readonly hooks: ManagerHooks;

  constructor(root: string, hooks: ManagerHooks) {
    this.root = root;
    this.hooks = hooks;
  }

  create(): void { this.dialog = editor(templateDraft(), "new"); this.hooks.invalidate(); }
  close(): void { if (!this.dialog?.busy) { this.dialog = undefined; this.hooks.invalidate(); } }

  async open(kind: "view" | "edit" | "duplicate" | "delete", id = this.hooks.current()?.id): Promise<void> {
    if (!id) { this.hooks.note("Select a request first, or press n to create one."); return; }
    try {
      const snapshot = await readSnapshot(this.root, id);
      if (kind === "view" || kind === "delete") {
        this.dialog = { kind, snapshot, focus: 0, scroll: 0, error: "", busy: false };
      } else {
        const draft = draftFromSource(snapshot.source, id);
        if (kind === "duplicate") {
          draft.file = await duplicateFilename(this.root, id);
          draft.name += " copy";
        }
        this.dialog = editor(draft, kind, kind === "edit" ? snapshot : undefined);
      }
      this.hooks.invalidate();
    } catch (error) { this.hooks.note(message(error)); }
  }

  private next(): void {
    const dialog = this.dialog;
    if (dialog?.kind !== "editor") return;
    try {
      if (dialog.step === "template") {
        changeTemplate(dialog.draft, dialog.template, dialog.mode === "new");
        for (const field of FIELDS) dialog.cursors[field] = dialog.draft[field].length;
        dialog.step = "details";
      } else {
        serializeDraft(dialog.draft);
        dialog.step = "review";
      }
      dialog.focus = 0;
      dialog.error = "";
      dialog.scroll = 0;
    } catch (error) { dialog.error = message(error); }
    this.hooks.invalidate();
  }

  private back(): void {
    const dialog = this.dialog;
    if (dialog?.kind !== "editor") return;
    dialog.step = dialog.step === "review" ? "details" : "template";
    dialog.focus = 0;
    dialog.error = "";
    this.hooks.invalidate();
  }

  async save(): Promise<void> {
    const dialog = this.dialog;
    if (dialog?.kind !== "editor" || dialog.busy) return;
    dialog.busy = true;
    dialog.error = "";
    this.hooks.invalidate();
    try {
      const id = await saveDraft(this.root, dialog.draft, dialog.original);
      this.dialog = undefined;
      await this.hooks.changed(id, `Saved ${id}. Press Enter to send when ready.`);
    } catch (error) { dialog.error = message(error); }
    finally { dialog.busy = false; this.hooks.invalidate(); }
  }

  /** Keep an unsaved conflicting edit by turning it into a separately named copy. */
  async saveAsCopy(): Promise<void> {
    const dialog = this.dialog;
    if (dialog?.kind !== "editor" || dialog.busy || dialog.mode !== "edit") return;
    try {
      dialog.draft.file = await duplicateFilename(this.root, dialog.draft.file);
      dialog.original = undefined;
      dialog.mode = "duplicate";
      dialog.step = "details";
      dialog.focus = 1;
      dialog.cursors.file = dialog.draft.file.length;
      dialog.customFile = true;
      dialog.error = "";
    } catch (error) { dialog.error = message(error); }
    this.hooks.invalidate();
  }

  async remove(): Promise<void> {
    const dialog = this.dialog;
    if (dialog?.kind !== "delete" || dialog.busy) return;
    dialog.busy = true;
    this.hooks.invalidate();
    try {
      const path = await trashRequest(this.root, dialog.snapshot);
      this.dialog = undefined;
      await this.hooks.changed(undefined, `Moved ${dialog.snapshot.id} to ${path}`);
    } catch (error) { dialog.error = message(error); }
    finally { dialog.busy = false; this.hooks.invalidate(); }
  }

  private setField(field: Field, value: string, cursor: number): void {
    const dialog = this.dialog;
    if (dialog?.kind !== "editor" || (field === "file" && dialog.mode === "edit")) return;
    dialog.draft[field] = value;
    dialog.cursors[field] = cursor;
    if (field === "file") dialog.customFile = true;
    if (field === "name" && !dialog.customFile) {
      dialog.draft.file = suggestedFilename(value);
      dialog.cursors.file = dialog.draft.file.length;
    }
    dialog.error = "";
  }

  paste(text: string): void {
    const dialog = this.dialog;
    if (dialog?.kind !== "editor" || dialog.busy || dialog.step !== "details") return;
    const field = FIELDS[dialog.focus];
    if (!field) return;
    const value = dialog.draft[field];
    const cursor = dialog.cursors[field];
    const inserted = cleanPaste(text, field === "headers" || field === "body");
    this.setField(field, value.slice(0, cursor) + inserted + value.slice(cursor), cursor + inserted.length);
    this.hooks.invalidate();
  }

  key(event: KeyEvent): void {
    const dialog = this.dialog;
    if (!dialog || dialog.busy) return;
    if (event.key === "escape") { this.close(); return; }
    if (dialog.kind === "delete") {
      if (["tab", "shift+tab", "left", "right", "up", "down"].includes(event.key)) dialog.focus = 1 - dialog.focus;
      else if (event.key === "n") this.close();
      else if (event.key === "y" || (event.key === "enter" && dialog.focus === 1)) void this.remove();
      else if (event.key === "enter") this.close();
      this.hooks.invalidate();
      return;
    }
    if (dialog.kind === "view") {
      if (event.name === "tab") dialog.focus = (dialog.focus + (event.shift ? 2 : 1)) % 3;
      else if (event.key === "enter") {
        if (dialog.focus === 2) this.close();
        else void this.open(dialog.focus === 0 ? "edit" : "duplicate", dialog.snapshot.id);
      } else if (event.key === "e") void this.open("edit", dialog.snapshot.id);
      else if (event.key === "d") void this.open("duplicate", dialog.snapshot.id);
      else this.scrollKey(event, dialog);
      this.hooks.invalidate();
      return;
    }
    if (dialog.kind !== "editor") return;
    if (event.key === "ctrl+s" && dialog.step !== "template") { void this.save(); return; }
    if (event.key === "ctrl+d") { void this.saveAsCopy(); return; }
    if (dialog.step === "template") {
      if (["up", "left"].includes(event.key)) { dialog.template = (dialog.template + TEMPLATES.length - 1) % TEMPLATES.length; dialog.focus = 0; }
      else if (["down", "right"].includes(event.key)) { dialog.template = (dialog.template + 1) % TEMPLATES.length; dialog.focus = 0; }
      else if (event.name === "tab") dialog.focus = (dialog.focus + (event.shift ? 2 : 1)) % 3;
      else if (event.key === "enter") { if (dialog.focus === 2) this.close(); else this.next(); }
      this.hooks.invalidate();
      return;
    }
    if (dialog.step === "review") {
      if (event.name === "tab") dialog.focus = (dialog.focus + (event.shift ? 2 : 1)) % 3;
      else if (event.key === "enter") { if (dialog.focus === 0) void this.save(); else if (dialog.focus === 1) this.back(); else this.close(); }
      else this.scrollKey(event, dialog);
      this.hooks.invalidate();
      return;
    }
    if (event.name === "tab") {
      dialog.focus = (dialog.focus + (event.shift ? 7 : 1)) % 8;
    } else if (dialog.focus >= 5) {
      if (event.key === "enter" || event.key === "space") {
        if (dialog.focus === 5) this.back();
        else if (dialog.focus === 6) this.next();
        else this.close();
      } else if (["left", "up"].includes(event.key)) dialog.focus = (dialog.focus + 7) % 8;
      else if (["right", "down"].includes(event.key)) dialog.focus = (dialog.focus + 1) % 8;
    } else {
      const field = FIELDS[dialog.focus]!;
      const value = dialog.draft[field];
      const cursor = dialog.cursors[field];
      const multiline = field === "headers" || field === "body";
      const position = linePosition(value, cursor);
      if (event.key === "left") dialog.cursors[field] = previousIndex(value, cursor);
      else if (event.key === "right") dialog.cursors[field] = nextIndex(value, cursor);
      else if (event.key === "home" || event.key === "ctrl+a") dialog.cursors[field] = position.start;
      else if (event.key === "end" || event.key === "ctrl+e") {
        const end = value.indexOf("\n", cursor);
        dialog.cursors[field] = end < 0 ? value.length : end;
      } else if (event.key === "ctrl+u") this.setField(field, "", 0);
      else if (event.key === "backspace") {
        const before = previousIndex(value, cursor);
        this.setField(field, value.slice(0, before) + value.slice(cursor), before);
      } else if (event.key === "delete") this.setField(field, value.slice(0, cursor) + value.slice(nextIndex(value, cursor)), cursor);
      else if (event.key === "up" || event.key === "down") {
        if (!multiline) dialog.focus = Math.max(0, Math.min(4, dialog.focus + (event.key === "up" ? -1 : 1)));
        else {
          const lines = value.split("\n");
          const row = Math.max(0, Math.min(lines.length - 1, position.row + (event.key === "up" ? -1 : 1)));
          dialog.cursors[field] = lines.slice(0, row).reduce((sum, line) => sum + line.length + 1, 0) + Math.min(position.column, lines[row]!.length);
        }
      } else if (event.key === "enter") {
        if (multiline) this.paste("\n");
        else dialog.focus = Math.min(4, dialog.focus + 1);
      } else if (!event.ctrl && !event.alt && event.char) this.paste(event.char);
    }
    this.hooks.invalidate();
  }

  private scrollKey(event: KeyEvent, dialog: { scroll: number }): void {
    if (event.key === "up") dialog.scroll = Math.max(0, dialog.scroll - 1);
    else if (event.key === "down") dialog.scroll++;
    else if (event.key === "pageup") dialog.scroll = Math.max(0, dialog.scroll - 10);
    else if (event.key === "pagedown") dialog.scroll += 10;
    else if (event.key === "home") dialog.scroll = 0;
  }

  render(ui: Container, theme: Theme, width: number, height: number): void {
    const dialog = this.dialog;
    if (!dialog) return;
    const common = { width: Math.min(100, width - 2), onDismiss: () => this.close(), onKey: (event: KeyEvent) => this.key(event) };
    const action = (label: string, focus: number, onPress: () => void, variant: "primary" | "ghost" | "danger" = "primary") => ({ label, focused: dialog.focus === focus, variant, onPress: () => { if (!dialog.busy) onPress(); } });
    if (dialog.kind === "delete") {
      ui.modal({
        ...common, title: "Delete request?", height: Math.min(height - 2, 13),
        buttons: [action("Cancel", 0, () => this.close(), "ghost"), action("Delete", 1, () => void this.remove(), "danger")],
      }, (body) => {
        body.text(dialog.snapshot.id, { size: 2, wrap: true, bold: true });
        body.text("Move this file to .r3q-trash? You can restore it from that folder.", { size: 2, wrap: true });
        body.text(dialog.error || (dialog.busy ? "Moving request…" : "Tab / arrows choose · Enter confirms · Esc cancels"), { size: 2, wrap: true, fg: dialog.error ? theme.danger : theme.muted });
      });
      return;
    }
    if (dialog.kind === "view") {
      ui.modal({
        ...common, title: `View ${dialog.snapshot.id}`, height: Math.max(12, height - 2),
        buttons: [action("Edit", 0, () => void this.open("edit", dialog.snapshot.id)), action("Duplicate", 1, () => void this.open("duplicate", dialog.snapshot.id)), action("Close", 2, () => this.close(), "ghost")],
      }, (body) => {
        body.label("Raw .http file · ↑↓ / PgUp / PgDn scroll · Esc closes", { size: 1 });
        this.source(body, dialog.snapshot.source, dialog, Math.max(1, height - 11), theme, common.width - 6);
      });
      return;
    }
    if (dialog.kind !== "editor") return;
    const title = dialog.mode === "edit" ? "Edit request" : dialog.mode === "duplicate" ? "Duplicate request" : "New request";
    if (dialog.step === "template") {
      ui.modal({
        ...common, title: `${title} · 1/3 · Template`, height: Math.min(height - 2, 21),
        buttons: [action("Next", 1, () => this.next()), action("Cancel", 2, () => this.close(), "ghost")],
      }, (body) => {
        body.label("Choose a method · ↑↓ select · Enter continues", { size: 1 });
        body.table({
          rows: TEMPLATES.map((template) => ({ method: template.method, name: template.name })),
          columns: [{ key: "method", title: "Method", width: 10 }, { key: "name", title: "Boilerplate" }],
          selected: dialog.template, header: false, size: 8,
          onSelectRow: (index) => { dialog.template = index; dialog.focus = 0; this.hooks.invalidate(); },
          onActivateRow: () => this.next(),
        });
        body.text(TEMPLATES[dialog.template]!.description, { fg: theme.muted, size: 2, wrap: true });
        body.label("Files are saved locally. Sending is a separate action.", { size: 1 });
      });
      return;
    }
    if (dialog.step === "review") {
      ui.modal({
        ...common, title: `${title} · 3/3 · Review`, height: Math.max(12, height - 2),
        buttons: [action(dialog.busy ? "Saving…" : "Save", 0, () => void this.save()), action("Back", 1, () => this.back(), "ghost"), action("Cancel", 2, () => this.close(), "ghost")],
      }, (body) => {
        body.text(`File: ${dialog.draft.file}`, { size: 1 });
        body.label("Enter saves · ↑↓ scroll · Ctrl+D keeps an edit as a copy", { size: 1 });
        this.source(body, serializeDraft(dialog.draft), dialog, Math.max(1, height - 14), theme, common.width - 6);
        body.text(dialog.error || "Saving does not send this request.", { size: 2, wrap: true, fg: dialog.error ? theme.danger : theme.muted });
      });
      return;
    }
    ui.modal({
      ...common, title: `${title} · 2/3 · ${dialog.draft.method}`, height: Math.min(height - 2, 27),
      buttons: [action("Back", 5, () => this.back(), "ghost"), action("Review", 6, () => this.next()), action("Cancel", 7, () => this.close(), "ghost")],
    }, (body) => {
      body.label("Tab fields · Ctrl+U clears · Ctrl+S saves · Esc cancels", { size: 1 });
      this.field(body, dialog, "name", "Name", 1, width);
      this.field(body, dialog, "file", dialog.mode === "edit" ? "File (fixed)" : "File", 1, width);
      this.field(body, dialog, "url", "URL", 1, width);
      this.field(body, dialog, "headers", "Headers (one Name: value per line)", 3, width);
      this.field(body, dialog, "body", "Body (Enter adds a line)", Math.max(2, Math.min(5, height - 21)), width);
      body.text(dialog.error || (dialog.busy ? "Saving…" : "Boilerplate is editable. No request is sent when you save."), { size: 2, wrap: true, fg: dialog.error ? theme.danger : theme.muted });
    });
  }

  private source(body: Container, source: string, dialog: { scroll: number }, rows: number, theme: Theme, width: number): void {
    const lines = source.split("\n").flatMap((line) => wrap(line || " ", Math.max(1, width)));
    dialog.scroll = Math.min(dialog.scroll, Math.max(0, lines.length - rows));
    body.column({ size: rows }, (column) => {
      for (const line of lines.slice(dialog.scroll, dialog.scroll + rows)) column.text(line || " ", { size: 1, fg: theme.foreground });
    });
  }

  private field(body: Container, dialog: Editor, field: Field, label: string, rows: number, width: number): void {
    const index = FIELDS.indexOf(field);
    const active = dialog.focus === index;
    const value = dialog.draft[field];
    const cursor = dialog.cursors[field];
    const position = linePosition(value, cursor);
    const multiline = field === "headers" || field === "body";
    if (multiline) body.label(label, { size: 1 });
    const lines = value.split("\n");
    const first = active ? Math.max(0, position.row - rows + 1) : 0;
    body.panel({
      size: rows, border: "none", padding: 0,
      onClick: (_x, y) => {
        dialog.focus = index;
        const row = Math.min(lines.length - 1, first + y);
        dialog.cursors[field] = lines.slice(0, row).reduce((sum, line) => sum + line.length + 1, 0) + lines[row]!.length;
        this.hooks.invalidate();
      },
    }, (panel) => {
      for (let offset = 0; offset < rows; offset++) {
        const row = first + offset;
        const focused = active && row === position.row;
        const available = Math.max(8, Math.min(100, width - 2) - 12 - (multiline ? 0 : label.length));
        const horizontal = focused ? Math.max(0, position.column - available + 1) : 0;
        panel.textInput({
          label: multiline ? undefined : `${label}:`, value: (lines[row] ?? "").slice(horizontal),
          cursor: Math.max(0, position.column - horizontal), focused,
          placeholder: field === "body" && !value && row === 0 ? "(no body)" : "", size: 1,
        });
      }
    });
  }
}
