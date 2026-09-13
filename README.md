<p align="center">
  <img src="https://raw.githubusercontent.com/profullstack/r3q/main/logo.svg" alt="r3q — a REST client for your terminal" width="800" />
</p>

# r3q

A REST client for your terminal. Requests are files you can commit; the TUI is just a good way to look at them.

```
curl -fsSL https://bun.sh/install | bash   # if you need it
mkdir -p ~/api
bunx @profullstack/r3q ~/api
```

Click **New request** or press `n` in the empty collection. Choose a method, edit the prefilled name, file path, URL, headers and body, then review and save. The new `.http` file is selected immediately. Press `Enter` when you want to send it.

## Create and manage requests

The three-step wizard provides method-specific boilerplate. `Tab` and `Shift+Tab` move between fields and buttons; `Enter` adds a line in Headers or Body. `Ctrl+U` clears a field, `Ctrl+S` saves, and `Esc` cancels. Bracketed paste supports multiline headers and bodies.

Select a saved request and press `v` to read its raw file, `e` to edit, `d` to duplicate, or `x` to delete. New files never overwrite an existing path. Editing preserves comments and variable placeholders, and refuses to replace a file changed by another editor. `Ctrl+D` keeps an unsaved edit as a separately named copy. Deletion asks for confirmation, defaults to Cancel, and moves the file into `.r3q-trash` so you can restore it.

Saving, viewing, editing, duplicating and deleting files do not send network requests. A request is sent only when you press `Enter` on it in the main screen.

## HTTP method examples

These templates use httpbin's echo endpoint: it returns the request you sent, so CRUD examples do not persist or delete real items. Change the URL for your own API. The examples are also included in the npm package.

| Method | Example |
| --- | --- |
| GET | [Read items](examples/methods/get.http) |
| POST | [Create an item with JSON](examples/methods/post.http) |
| PUT | [Replace an item](examples/methods/put.http) |
| PATCH | [Update selected fields](examples/methods/patch.http) |
| DELETE | [Delete an item](examples/methods/delete.http) |
| HEAD | [Inspect response headers](examples/methods/head.http) |
| OPTIONS | [Inspect allowed methods](examples/methods/options.http) |
| TRACE | [Diagnostic template](examples/methods/trace.http), for saving and viewing |

The fetch runtime does not send TRACE or CONNECT. TRACE is supported by the `.http` parser and wizard; CONNECT is not supported by the parser.

```
 r3q  ~/api                                        3 requests  Tab panes  Enter send  r reload  q quit
╭─ Collection ────────────────╮ ╭─ Request ────────────────────────────────────────────────────────────╮
│ ERR     broken.http         │ │  POST    https://httpbin.org/post                                    │
│ GET     httpbin-get.http    │ │                                                                      │
│ POST    httpbin-post.http   │ │ Content-Type:                                       application/json │
│                             │ │ Authorization:                                  Bearer sk-live-xxxxx │
│                             │ │ ─ body ───────────────────────────────────────────────────────────── │
│                             │ │ {"name": "r3q", "ok": true}                                          │
│                             │ ╰──────────────────────────────────────────────────────────────────────╯
│                             │ ╭─ Response ───────────────────────────────────── 200 OK  215ms  168B ─╮
│                             │ │ {                                                                    │
│                             │ │   "args": { "hello": "world" }                                       │
╰─────────────────────────────╯ ╰──────────────────────────────────────────────────────────────────────╯
 Enter Send  Tab Collection  ↑↓ Move  r Reload  q Quit
```

## Requests are files

A request is a `.http` file, the format your editor already understands. Save this as `~/api/example.http`:

```http
# Comments before the request line are ignored.
POST https://api.example.com/things
Content-Type: application/json
Authorization: Bearer {{TOKEN}}

{"name": "thing"}
```

A blank line ends the headers and begins the body. That's the whole format.

Collections load in the background, so the terminal opens immediately even in a large directory.
Requests appear as they are found; `r` restarts the scan and `q` stops it and quits.
Hidden directories, `node_modules`, and symlinks are skipped.

Because a request is a file, it diffs, reviews and merges like everything else in the repository. There is no binary workspace to export from, and no account to sign into.

## Secrets stay out of the files

`{{NAME}}` is filled from a `.env` beside the collection, falling back to the process environment. The file you commit holds the template; the value stays on your machine.

```
TOKEN=sk-live-xxxxx
```

`.env` is gitignored by default.

## Keys

| Key | Does |
|---|---|
| `n` | Create a request with the wizard |
| `v` | View the selected raw `.http` file |
| `e` | Edit the selected request |
| `d` | Duplicate the selected request |
| `x` / `Delete` | Confirm moving the selected file to `.r3q-trash` |
| `Enter` | Send the selected request, or open the wizard when empty |
| `Tab` | Move between the collection and the response |
| `↑` `↓` | Move the selection, or scroll the response body |
| `PgUp` `PgDn` `Home` | Scroll the response body faster |
| `r` | Reload the collection from disk |
| `q` | Quit |

## Status

Early. It creates and manages request files, resolves variables, sends requests, and shows syntax-highlighted JSON responses. Collection runs, assertions, cookie jars, and OpenAPI/Postman import are not implemented yet. The in-app editor handles files up to 1 MiB; larger or malformed request files can still be edited externally.

## Built with

[hqtui](https://hqtui.com) — the terminal UI library. r3q exists partly to keep hqtui honest: a real application finds the gaps that a widget gallery does not.

## Development

Run `bun install`, `bun run typecheck`, `bun test test`, and `bun run build`. The optional real-terminal CRUD check is `python scripts/verify-wizard-pty.py` (requires Python's `pyte` package). It creates an isolated collection and uses a local HTTP server to verify that requests are sent only on explicit Enter.

## Brand assets

[Logo SVG](logo.svg) · [Logo PNG](logo.png) · [Favicon SVG](favicon.svg) · [Favicon PNG](favicon.png)

Both logo banners work on light and dark backgrounds. The favicon PNG has a transparent background. See [asset provenance and generation prompts](docs/branding.md).

## Licence

MIT
