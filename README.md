<p align="center">
  <img src="https://raw.githubusercontent.com/profullstack/r3q/main/logo.svg" alt="r3q — a REST client for your terminal" width="800" />
</p>

# r3q

A REST client for your terminal. Requests are files you can commit; the TUI is just a good way to look at them.

```sh
curl -fsSL https://raw.githubusercontent.com/profullstack/r3q/main/install.sh | sh
mkdir -p ~/api
r3q ~/api
```

The installer puts the `r3q` command in `~/.local` (no root). It uses your Node 22+ if you have one,
otherwise it fetches an official Node build (checksum verified) into `~/.local/share/r3q`. Re-run it
to upgrade; remove it with `sh ~/.local/share/r3q/uninstall.sh`. Without installing: `bunx @profullstack/r3q ~/api`.

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

A blank line ends the headers and begins the body. `###` separates requests, so one file can hold a whole flow; each request is its own row in the collection.

r3q implements the full [http-files.org spec](https://http-files.org/spec/basics/): the universal core plus the extensions of VS Code REST Client, JetBrains HTTP Client, httpyac, Visual Studio 2022 and kulala.nvim, so a file written for any of them runs here.

| Spec page | Supported |
|---|---|
| Basics, Requests | `.http` and `.rest`, UTF-8, `###` blocks and titles, method defaults to GET, `HTTP/1.1`/`HTTP/2`, every WebDAV and httpyac method, indented URL continuation and `?`/`&` lines, indented header values, `...spread` headers, multi-line urlencoded forms, non-ASCII URLs percent-encoded once |
| Separators & comments | `#`, `//`, `/* */`, `### title`, global regions (a block with no request applies its variables, metadata and scripts to every request) |
| Variables | `@name = value`, lazy `@name := value`, `{{name}}`, `{{%name}}`, request variables `{{login.response.body.$.token}}`, `.body.//xpath`, `.body.*`, `.headers.X`, `.request.body.*`, httpyac `@ref` + `{{login.token}}`, JavaScript in `{{ }}` |
| Dynamic variables | `$guid` `$uuid` `$random.uuid` `$randomInt [min max]` `$random.integer/float/alphabetic/alphanumeric/hexadecimal/email` and the Faker categories (`$random.name.fullName`, `$random.address.city`, …), `$timestamp`/`$datetime`/`$localDatetime` with offsets and Day.js formats, `$isoTimestamp`, `$processEnv`, `$dotenv`, `$env.X`, `$projectRoot`, `$input`, `$password`, `$pick`, `$input-askonce`, `$aadToken`, `$aadV2Token`, `$oidcAccessToken` |
| Environments | `http-client.env.json` + `.private.env.json` + `.env.json.user`, `.vscode/settings.json` (`$shared`), `.env`, `.env.<name>`, `<name>.env`, `.env.local`, `httpyac.config.js`/`.httpyac.json`/`package.json`, `env/` dirs, `$HTTPYAC_ENV`, nested values, Visual Studio secret providers (User Secrets, Azure Key Vault via `az`); several environments at once |
| Metadata | `@name` `@no-redirect` `@no-cookie-jar` `@note` `@no-log` `@timeout` `@connection-timeout` `@no-auto-encoding` `@ref` `@forceRef` `@import` `@disabled` `@loop` `@sleep` `@jwt` `@save` `@ratelimit` `@proxy` `@no-reject-unauthorized` `@no-client-cert` `@keepStreaming` `@injectVariables` `@debug` `@verbose` `@prompt` `@secret` `@delay` `@curl-*` `@grpc-*` `@jq` `@env-json-key` `@env-header-key` |
| Authentication | Basic (`user password`, `user:password`, pre-encoded), Digest (challenge/response, MD5/SHA-256, `-sess`, `auth-int`), AWS Signature v4, AWS Cognito (SRP), OAuth2/OpenID (`client_credentials`, `password`, `authorization_code` + PKCE, `implicit`, `device_code`, token exchange), OAuth 1.0a (`OAuth1 key secret [token tokenSecret]`, HMAC-SHA1/256/512 or PLAINTEXT), NTLMv2 (`NTLM user password [domain]`, one connection for the handshake) |
| Cookies | a jar for every request (kept in `.r3q/cookies.json`, 300 max), `@no-cookie-jar` |
| File operations | `< file`, `<@ file`, `<@latin1 file`, multipart with file parts, JetBrains `import`/`run file#name (@var=value)`, `>>` and `>>!`, `<>` compare |
| GraphQL | `GRAPHQL` method (also over `ws://`), `X-REQUEST-TYPE: GraphQL`, httpyac `gql Name < ./query.gql` and auto-detection |
| Scripts | JetBrains `< {% %}` / `> {% %}` / `> handler.js` with `client`, `request`, `response`, `crypto`; httpyac `{{ }}` blocks with `exports`, `require`, `test.*`, `sleep`, `@request`/`@response`/`@after` hooks and `{{+ }}` global scripts; `??` assertions (`status`, `header`, `body`, `duration`, `js`, `xpath`) |
| Protocols | WebSocket (`===`, `=== wait-for-server`), SSE, gRPC (proto files or reflection, all four call types), MQTT, AMQP |
| Proxy, SSL | `@proxy`, `request_proxy`, VS Code `http.proxy`, `HTTP(S)_PROXY`/`NO_PROXY`, SOCKS5; client certificates from VS Code, JetBrains `SSLConfiguration`, httpyac config and the `ClientCert:` header |
| cURL, import, export | paste a curl command as a request, copy as curl (`c`), `r3q curl`, code generation in 20 languages; import Postman, Insomnia (v4 JSON and v5 YAML, with environments), OpenAPI 3.0/3.1, Swagger 2.0 and Bruno; export to OpenAPI 3.0.3 or Postman v2.1 |

Not possible from a terminal program: `@use-os-credentials` (NTLM/Kerberos through the operating system) fails with an explanation. Scripts are your own code and run with your permissions when you send, as in every client that supports them.

Collections load in the background, so the terminal opens immediately even in a large directory.
Requests appear as they are found; `r` restarts the scan and `q` stops it and quits.
Hidden directories, `node_modules`, and symlinks are skipped.

Because a request is a file, it diffs, reviews and merges like everything else in the repository. There is no binary workspace to export from, and no account to sign into.

## Secrets stay out of the files

`{{NAME}}` is filled from a `.env` beside the collection, falling back to the process environment. The file you commit holds the template; the value stays on your machine.

```
TOKEN=sk-live-xxxxx
```

`.env` is gitignored by default. Press `E` to switch between environments from `http-client.env.json` and the other formats above.

Values you never want in a file at all go in the operating system's credential store: libsecret (`secret-tool`) on Linux, the Keychain on macOS, DPAPI on Windows.

```sh
r3q secret set TOKEN          # prompts; the value goes to the OS store
r3q secret list               # names only
```

`{{TOKEN}}` then resolves from the store when no environment defines it. The collection keeps only the list of names, in `.r3q/secrets.json`.

## Folders share headers and auth

An `r3q.folder.json` applies to every request in its folder and below it. The one at the root is the collection's settings, and a nearer folder overrides a farther one. A request's own headers always win, and folder variables are defaults that an environment, a secret or the file can override.

```json
{
  "headers": { "Accept": "application/json" },
  "auth": "Bearer {{TOKEN}}",
  "variables": { "base": "https://api.example.com" },
  "tags": ["billing"],
  "pre": ["./scripts/sign.js"],
  "post": ["./scripts/check.js"],
  "timeout": "10s"
}
```

`auth` is an Authorization header, so every scheme in the table above works there. `pre` and `post` scripts run before and after each request in the folder.

## Checks, captures and tests

Checks need no JavaScript:

```http
# @name Create order
# @tag smoke
# @capture orderId = body.$.id
POST {{base}}/orders
Content-Type: application/json

{"sku": "A1"}

?? status == 201
?? body $.id isString
?? duration < 500
```

`@capture name = expression` hands a value from one response to every later request in the run (`{{orderId}}`). `@capture-env` also writes it to `http-client.private.env.json`, and `@capture-secret` to the credential store. An expression is `status`, `header Name`, `body`, `body.$.path` or `xpath //node`.

Scripts can test with `test` and `expect`, validate against JSON Schema draft-07, and call another saved request:

```http
> {%
  test("returns the order", async () => {
    expect(response.status).to.equal(201);
    expect(response.body).toMatchSchema({ type: "object", required: ["id"], properties: { id: { type: "string" } } });
    const again = await r3q.send("orders.http#Get order", { id: response.body.id });
    expect(again.status).toBe(200);
  });
%}
```

`r3q` also has seeded random values (`r3q.random.seed(7); r3q.random.int(1, 10)`), date arithmetic (`r3q.date.add(new Date(), 2, "d")`, `r3q.date.format(d, "YYYY-MM-DD")`) and hashing (`r3q.crypto.hmac("sha256", key, text)`).

## Organizations, projects and sharing

There is no server. A workspace is the collection directory: `<org>/<project>/` folders for the requests and an `r3q.json` holding names, descriptions and team members.

```sh
r3q org add "Acme"
r3q project add acme billing --team ana@acme.test,bo@acme.test
r3q tree
```

In the TUI, `p` creates an org and project and opens the wizard inside it; `n` on a request in a project creates the new one beside it.

To share, save the workspace to one file, copy it, and load it on the other side:

```sh
r3q save team.json                 # or --org acme --project billing for part of it
scp team.json other-host:
ssh other-host r3q load team.json --root ~/api
```

`S` and `L` do the same from the TUI. A bundle is JSON with the requests, body files, `r3q.json` and shared environment files. `.env` files, private env files and keys are left out unless you pass `--secrets` (the bundle is then written mode 0600). Loading never overwrites a file that differs locally: it lists the conflicts, and `--force` (or confirming in the TUI) replaces them after moving the local copy to `.r3q-trash`.

## From a script or CI

```sh
r3q run api/flow.http --all --env dev    # every request in order; exits 1 if a test or ?? fails
r3q run 'api/flow.http#login' -o token.json
r3q curl 'api/flow.http#login'
r3q code python-requests 'api/flow.http#login'
r3q import curl 'curl -X POST https://api.test/x -d a=1' -o x.http
r3q import postman collection.json --out api/
r3q import insomnia insomnia.yaml --out api/
r3q export openapi api -o openapi.json
```

### Run a collection

Give `r3q run` a folder (or several paths) to run everything in it, in file order:

```sh
r3q run api --tag smoke --dry-run                    # list what would run; nothing is sent
r3q run api --tag smoke --exclude-tag slow --env ci  # select by tag
r3q run api/orders --name 'create*'                  # or by name
r3q run api --data customers.csv --setup 'api/auth.http#login' --teardown 'api/auth.http#logout'
r3q run api --delay 250 --fail-fast
r3q run api --tag smoke --reporter junit --output results.xml   # or --reporter json / --json
```

Tags come from `# @tag a, b` on a request, a file's global region, or a folder's `r3q.folder.json`. With `--data`, the run repeats once per CSV or JSON row and each column is a variable; setup and teardown requests wrap every row. A failed check exits 1. Ctrl+C stops after the current request and keeps the results so far. `--cookie-jar` keeps cookies in the collection's jar between runs (CLI runs use a fresh jar otherwise).

### Collection housekeeping

```sh
r3q collection create api      # example request, environments, folder settings, .gitignore
r3q inspect api                # every request with its method, URL and tags
r3q audit api                  # parse errors, undefined {{variables}}, missing body files, tokens written into files
r3q format api --check         # normalised formatting; without --check it rewrites
```

### GitHub Actions

The repository is also an action that installs the CLI after checking the npm tarball against the registry's integrity hash:

```yaml
- uses: profullstack/r3q@v0.3.0
  with:
    version: 0.3.0
- run: r3q run ./api --tag smoke --reporter junit --output results.xml
```

[examples/github-workflow.yml](examples/github-workflow.yml) is a complete workflow that passes a repository secret and keeps the report even when a check fails.

### Coding agents

`r3q agent install` writes an r3q skill for the coding agents on this machine (Claude Code, Codex, and the shared `~/.agents/skills`). It covers writing, auditing, importing and running collections. Add `--project .` to install it into a repository instead, and re-run it after upgrading r3q.

## Timeline and cookies

Every send, from the TUI or `r3q run`, is kept in `.r3q/history.jsonl` with secrets redacted: values from the credential store, private env files and `.env`, credentials in Authorization, Cookie and API-key headers, and password- or token-like JSON fields. `H` in the TUI reopens one; `r3q history` lists them and `r3q history show 3` prints a whole exchange, redirects included.

`C` shows the collection's cookie jar, where you can edit or delete a cookie or clear them all. From the shell: `r3q cookies`, `r3q cookies rm example.com`, `r3q cookies clear`.

`r3q --help` lists every command.

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
| `s` | Save the last response body to a file |
| `S` / `L` | Save the workspace to a bundle / load one |
| `E` | Choose the environment |
| `p` | Create an org and project, then a request in it |
| `c` | Copy the last request as curl (OSC 52, works over ssh) |
| `/` | Find a request (fuzzy over method, path and name) |
| `f` | Filter the response with JSONPath (empty clears) |
| `R` | Run this file, this folder, the collection or a tag, with results as they arrive |
| `H` | Reopen an earlier send from the timeline |
| `C` | Inspect, edit or clear the cookie jar |
| `t` | Next colour theme (remembered) |
| `:` | Command palette |
| `Esc` | Cancel a request that is running, or stop a run (finished results stay) |
| `q` | Quit |

Extra key bindings go in `~/.config/r3q/config.json`, mapping a key to a palette action:

```json
{ "theme": "dracula", "keys": { "ctrl+r": "run", "f5": "send" } }
```

## Status

The http-files.org spec is implemented (see the table above), plus collection runs, folder settings, the credential store, captures, the timeline and the housekeeping commands. The in-app wizard edits files that hold one request; a file with several requests is edited in your editor, and `v` shows it. The wizard handles files up to 1 MiB.

## Built with

[hqtui](https://hqtui.com) — the terminal UI library. r3q exists partly to keep hqtui honest: a real application finds the gaps that a widget gallery does not.

## Development

Run `bun install`, `bun run typecheck`, `bun test test`, and `bun run build`. The optional real-terminal CRUD check is `python scripts/verify-wizard-pty.py` (requires Python's `pyte` package). It creates an isolated collection and uses a local HTTP server to verify that requests are sent only on explicit Enter.

## Brand assets

[Logo SVG](logo.svg) · [Logo PNG](logo.png) · [Favicon SVG](favicon.svg) · [Favicon PNG](favicon.png)

Both logo banners work on light and dark backgrounds. The favicon PNG has a transparent background. See [asset provenance and generation prompts](docs/branding.md).

## Licence

MIT
