# r3q

A REST client for your terminal. Requests are files you can commit; the TUI is just a good way to look at them.

```
curl -fsSL https://bun.sh/install | bash   # if you need it
mkdir -p ~/api
bunx @profullstack/r3q ~/api
```

Put `.http` request files in that directory, then press `r` to reload them.
Use `bunx @profullstack/r3q --help` for usage or `bunx @profullstack/r3q --version` to check the installed release.

![three panes: collection, request, response](#)

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

A request is a `.http` file, the format your editor already understands:

```http
# Comments before the request line are ignored.
POST https://api.example.com/things
Content-Type: application/json
Authorization: Bearer {{TOKEN}}

{"name": "thing"}
```

A blank line ends the headers and begins the body. That's the whole format.

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
| `Enter` | Send the selected request |
| `Tab` | Move between the collection and the response |
| `↑` `↓` | Move the selection, or scroll the response body |
| `PgUp` `PgDn` `Home` | Scroll the response body faster |
| `r` | Reload the collection from disk |
| `q` | Quit |

## Status

Early. It sends requests, resolves variables, and shows you the whole exchange. What it does not do yet:

- **Syntax-highlighted JSON.** The response body is monochrome because styled text spans land in `@profullstack/hqtui` 0.3.0 — see [profullstack/hqtui#60](https://github.com/profullstack/hqtui/issues/60). This is the next thing to change.
- Editing requests in the TUI. Edit the file; press `r`.
- Collection runs, assertions, cookie jars, OpenAPI/Postman import.

## Built with

[hqtui](https://hqtui.com) — the terminal UI library. r3q exists partly to keep hqtui honest: a real application finds the gaps that a widget gallery does not.

## Licence

MIT
