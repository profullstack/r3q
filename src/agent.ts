/**
 * `r3q agent install`: give coding agents a skill that explains how to write,
 * check, import and run r3q collections, so they edit `.http` files and call
 * the CLI instead of guessing.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { VERSION } from "./http/runner.ts";

export const SKILL_NAME = "r3q";

export function skillText(): string {
  return `---
name: r3q
description: Write, check, import and run HTTP API requests as .http files with the r3q CLI (REST, GraphQL, WebSocket, gRPC). Use when asked to call or test an API, add API smoke tests, convert curl/Postman/Insomnia/OpenAPI into requests, or run a request collection in CI.
---

# r3q (v${VERSION})

r3q keeps every request in a plain \`.http\` file inside a collection directory, so requests diff and review like code.
Install: \`npm i -g @profullstack/r3q\` (or \`bunx @profullstack/r3q\`).

## Write a request

\`\`\`http
# @name Create order
# @tag smoke, orders
POST {{base}}/orders
Content-Type: application/json
Authorization: Bearer {{TOKEN}}

{"sku": "A1", "qty": 1}

# @capture orderId = body.$.id
?? status == 201
?? body $.id isString

> {%
  test("returns the order", () => {
    expect(response.body).to.have.property("id");
    expect(response.body).toMatchSchema({ type: "object", required: ["id"] });
  });
%}
\`\`\`

- \`###\` separates requests in one file. \`@name\` lets later requests read \`{{name.response.body.$.field}}\`.
- \`??\` assertions need no JavaScript: \`status\`, \`header X\`, \`body <jsonpath>\`, \`duration\`, with \`== != > < >= <= contains startsWith endsWith matches exists isString isNumber isArray isBoolean\`.
- Captures: \`@capture name = body.$.id\` (later requests in the run), \`@capture-env\` (private env file), \`@capture-secret\` (OS credential store). Expressions: \`status\`, \`header X\`, \`body\`, \`body.$.path\`, \`xpath //node\`.
- Scripts: \`< {% ... %}\` before, \`> {% ... %}\` after (or \`> ./check.js\`). Globals: \`client\`, \`request\`, \`response\`, \`test\`, \`expect\`, \`validateSchema\`, and \`r3q\` (\`r3q.random.seed(1)\`, \`r3q.date.add(d, 1, "d")\`, \`r3q.crypto.hmac(...)\`, \`await r3q.send("other.http#name")\`).
- Variables come from \`http-client.env.json\` (+ \`.private.env.json\`), \`.env\`, \`@name = value\` lines, and folder files. Dynamic: \`{{$uuid}}\`, \`{{$timestamp}}\`, \`{{$randomInt 1 10}}\`, \`{{$random.email}}\`.
- Never write a real token into a \`.http\` file. Store it with \`r3q secret set TOKEN\` and use \`{{TOKEN}}\`.
- Auth by header: \`Basic user pass\`, \`Bearer {{t}}\`, \`Digest user pass\`, \`AWS key secret\`, \`OAuth1 ck cs [token tokenSecret]\`, \`NTLM user pass [domain]\`, \`OAuth2 client_credentials\` (settings in env vars).
- Shared headers, auth, variables, tags and scripts for a folder go in \`r3q.folder.json\` in that folder (the root one applies to the whole collection).

## Commands

\`\`\`sh
r3q collection create api                         # scaffold a collection
r3q inspect api                                   # list requests with tags
r3q audit api                                     # parse errors, undefined {{vars}}, leaked secrets (exit 1 on errors)
r3q format api [--check]                          # normalise formatting
r3q run api/orders.http#"Create order" --env dev  # one request
r3q run api --tag smoke --dry-run                 # preview the order, send nothing
r3q run api --tag smoke --reporter junit --output results.xml   # CI; exits 1 on failure
r3q run api --data rows.csv --setup api/auth.http#login --fail-fast --delay 200
r3q import curl|postman|insomnia|openapi|bruno <source> --out api/
r3q export openapi|postman api -o out.json
r3q history                                       # recent sends (secrets redacted)
\`\`\`

After writing or editing requests, run \`r3q audit\` and fix what it reports, then \`r3q run ... --dry-run\` before sending anything that changes data.
`;
}

export interface AgentTarget { agent: string; dir: string }

export function agentTargets(options: { project?: string; agents?: string[] } = {}): AgentTarget[] {
  const home = homedir();
  const base = options.project ? resolve(options.project) : home;
  const all: AgentTarget[] = [
    { agent: "claude", dir: join(base, ".claude", "skills", SKILL_NAME) },
    { agent: "codex", dir: join(base, ".codex", "skills", SKILL_NAME) },
    { agent: "agents", dir: join(base, ".agents", "skills", SKILL_NAME) },
  ];
  const wanted = options.agents?.length && !options.agents.includes("all") ? options.agents : undefined;
  if (wanted) return all.filter((t) => wanted.includes(t.agent));
  // By default, only agents that are present (their config directory exists), plus the shared .agents location.
  return all.filter((t) => t.agent === "agents" || existsSync(join(base, `.${t.agent}`)));
}

export async function installSkill(options: { project?: string; agents?: string[] } = {}): Promise<{ installed: string[]; unchanged: string[] }> {
  const text = skillText();
  const installed: string[] = [];
  const unchanged: string[] = [];
  for (const t of agentTargets(options)) {
    const path = join(t.dir, "SKILL.md");
    const current = await readFile(path, "utf8").catch(() => undefined);
    if (current === text) { unchanged.push(path); continue; }
    await mkdir(t.dir, { recursive: true });
    await writeFile(path, text);
    installed.push(path);
  }
  return { installed, unchanged };
}

export async function uninstallSkill(options: { project?: string; agents?: string[] } = {}): Promise<string[]> {
  const removed: string[] = [];
  for (const t of agentTargets({ ...options, agents: options.agents?.length ? options.agents : ["all"] })) {
    const path = join(t.dir, "SKILL.md");
    if (!existsSync(path)) continue;
    const text = await readFile(path, "utf8");
    if (!/^name: r3q$/m.test(text)) continue; // not ours
    await rm(t.dir, { recursive: true, force: true });
    removed.push(t.dir);
  }
  return removed;
}
