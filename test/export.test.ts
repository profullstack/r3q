import { describe, expect, test } from "bun:test";
import { exportOpenApi, exportPostman, importInsomnia, importInsomniaEnvironments, importOpenApi, importPostman } from "../src/http/convert.ts";
import { parseHttpFile } from "../src/http/parse.ts";

const v4 = {
  _type: "export", __export_format: 4,
  resources: [
    { _id: "wrk_1", _type: "workspace", name: "Shop API" },
    { _id: "env_base", _type: "environment", parentId: "wrk_1", name: "Base", data: { base: "https://api.test", nested: { key: "v" } } },
    { _id: "env_dev", _type: "environment", parentId: "env_base", name: "dev", data: { token: "dev-token" } },
    { _id: "fld_1", _type: "request_group", parentId: "wrk_1", name: "Orders", environment: { page: "1" },
      authentication: { type: "bearer", token: "{{ _.token }}" }, headers: [{ name: "X-Team", value: "core" }] },
    { _id: "req_1", _type: "request", parentId: "wrk_1", name: "Health", method: "GET", url: "{{ _.base }}/health", metaSortKey: 1 },
    { _id: "req_2", _type: "request", parentId: "fld_1", name: "Create order", method: "POST", url: "{{ _.base }}/orders",
      body: { mimeType: "application/json", text: "{\"id\": \"{% uuid 'v4' %}\"}" },
      headers: [{ name: "Accept", value: "application/json" }, { name: "X-Off", value: "1", disabled: true }],
      parameters: [{ name: "dry", value: "true" }], authentication: { type: "inherit" } },
    { _id: "req_3", _type: "request", parentId: "fld_1", name: "Login", method: "POST", url: "{{base}}/login",
      body: { mimeType: "application/x-www-form-urlencoded", params: [{ name: "user", value: "a b" }, { name: "pw", value: "{{ _.pw }}" }] },
      authentication: { type: "basic", username: "u", password: "p" } },
    { _id: "req_4", _type: "request", parentId: "fld_1", name: "Key", method: "GET", url: "{{base}}/k",
      authentication: { type: "apikey", key: "api_key", value: "abc", addTo: "queryParams" } },
    { _id: "req_5", _type: "request", parentId: "fld_1", name: "Odd", method: "GET", url: "{{base}}/o",
      authentication: { type: "hawk", id: "x" } },
  ],
};

describe("Insomnia import", () => {
  test("v4 export: folders, inherited auth and headers, template tags", () => {
    const warnings: string[] = [];
    const files = importInsomnia(v4, warnings);
    expect([...files.keys()].sort()).toEqual(["orders.http", "shop-api.http"]);
    const top = files.get("shop-api.http")!;
    expect(top).toContain("GET {{base}}/health");
    const orders = files.get("orders.http")!;
    expect(orders.startsWith("@page = 1\n")).toBe(true);
    expect(orders).toContain("POST {{base}}/orders?dry=true");
    expect(orders).toContain("Authorization: Bearer {{token}}");
    expect(orders).toContain("X-Team: core");
    expect(orders).not.toContain("X-Off");
    expect(orders).toContain('{"id": "{{$uuid}}"}');
    expect(orders).toContain("Authorization: Basic u p");
    expect(orders).toContain("user=a%20b\n&pw={{pw}}");
    expect(orders).toContain("GET {{base}}/k?api_key=abc");
    expect(orders).toContain("# hawk auth was not converted");
    expect(warnings.some((w) => w.includes("hawk"))).toBe(true);
    // Each request block parses.
    const parsed = parseHttpFile(orders, "orders.http");
    expect(parsed.errors).toEqual([]);
    expect(parsed.requests.map((r) => r.name)).toEqual(["create-order", "login", "key", "odd"]);
  });

  test("v4 environments: base is $shared, sub-environments by name, nested flattened", () => {
    expect(importInsomniaEnvironments(v4)).toEqual({
      $shared: { base: "https://api.test", "nested.key": "v" },
      dev: { token: "dev-token" },
    });
  });

  const v5 = `type: collection.insomnia.rest/5.0
name: Pets
meta:
  id: wrk_x
collection:
  - name: Ping
    url: "{{ _.host }}/ping"
    method: GET
    headers:
      - name: Accept
        value: text/plain
  - name: Animals
    authentication:
      type: ntlm
      username: dom\\\\me
      password: pw
    children:
      - name: List
        url: "{{ _.host }}/pets"
        method: GET
        parameters:
          - name: limit
            value: "10"
        scripts:
          preRequest: insomnia.environment.set("a", 1);
          afterResponse: insomnia.test("ok", () => {});
      - name: Deep
        children:
          - name: Gql
            url: "{{ _.host }}/graphql"
            method: POST
            body:
              mimeType: application/graphql
              text: '{"query":"{ pets { id } }","variables":{"a":1}}'
environments:
  name: Base Environment
  data:
    host: https://pets.test
  subEnvironments:
    - name: prod
      data:
        host: https://pets.example
`;

  test("v5 YAML: children tree, scripts kept as JetBrains blocks, graphql", () => {
    const warnings: string[] = [];
    const files = importInsomnia(v5, warnings);
    expect([...files.keys()].sort()).toEqual(["animals.http", "animals/deep.http", "pets.http"]);
    expect(files.get("pets.http")).toContain("GET {{host}}/ping\nAccept: text/plain");
    const animals = files.get("animals.http")!;
    expect(animals).toContain("GET {{host}}/pets?limit=10");
    expect(animals).toContain("Authorization: NTLM");
    expect(animals).toContain("# r3q: imported Insomnia script, check the API calls\n< {%");
    expect(animals).toContain("> {%");
    expect(warnings.some((w) => w.includes("script"))).toBe(true);
    const parsed = parseHttpFile(animals, "animals.http");
    expect(parsed.requests[0]!.preScripts.length).toBe(1);
    expect(parsed.requests[0]!.postScripts.length).toBe(1);
    const deep = files.get("animals/deep.http")!;
    expect(deep).toContain("X-REQUEST-TYPE: GraphQL");
    expect(deep).toContain("{ pets { id } }\n\n{\n  \"a\": 1\n}");
    expect(importInsomniaEnvironments(v5)).toEqual({ $shared: { host: "https://pets.test" }, prod: { host: "https://pets.example" } });
  });

  test("rejects other documents", () => {
    expect(() => importInsomnia({ foo: 1 })).toThrow(/not an Insomnia export/);
  });
});

describe("Postman import warnings", () => {
  test("scripts are reported through the optional warnings list", () => {
    const warnings: string[] = [];
    importPostman({ info: { name: "c" }, item: [{ name: "a", request: { method: "GET", url: "https://x.test" }, event: [{ listen: "test", script: { exec: ["pm.test('x')"] } }] }] }, warnings);
    expect(warnings).toEqual(["a: Postman script kept verbatim; port pm.* calls"]);
  });
});

describe("OpenAPI import edge cases", () => {
  test("Swagger 2.0: host/basePath/schemes, body param, consumes, x-example", () => {
    const files = importOpenApi({
      swagger: "2.0", host: "api.test:8080", basePath: "/v1", schemes: ["http"], consumes: ["application/json"],
      paths: {
        "/pets/{id}": {
          put: {
            tags: ["pets"], operationId: "updatePet",
            parameters: [
              { name: "id", in: "path", required: true, type: "integer", "x-example": 7 },
              { name: "body", in: "body", schema: { type: "object", properties: { name: { type: "string", example: "rex" } } } },
            ],
          },
        },
      },
    });
    const pets = files.get("pets.http")!;
    expect(pets).toContain("@baseUrl = http://api.test:8080/v1");
    expect(pets).toContain("@id = 7");
    expect(pets).toContain("PUT {{baseUrl}}/pets/{{id}}");
    expect(pets).toContain("Content-Type: application/json");
    expect(pets).toContain('"name": "rex"');
  });

  test("OpenAPI 3.1: type arrays and examples arrays", () => {
    const files = importOpenApi({
      openapi: "3.1.0", servers: [{ url: "https://api.test" }],
      paths: {
        "/items": {
          post: {
            parameters: [{ name: "q", in: "query", schema: { type: "string", examples: ["shoes"] } }],
            requestBody: { content: { "application/json": { schema: { type: "object", properties: {
              note: { type: ["string", "null"], examples: ["hello"] },
              count: { type: ["null", "integer"] },
            } } } } },
          },
        },
      },
    });
    const text = files.get("default.http")!;
    expect(text).toContain("POST {{baseUrl}}/items?q=shoes");
    expect(text).toContain('"note": "hello"');
    expect(text).toContain('"count": 0');
  });
});

const source = `@base = https://api.test/v2
@id = 42

### List users
# @name listUsers
# @tag users, smoke
GET {{base}}/users?limit=10&q={{query}}
Accept: application/json
Authorization: Bearer {{token}}
X-Trace: on

### Create user
# @tag users
POST {{base}}/users/{{id}}/roles
Content-Type: application/json
Authorization: Basic alice secret

{"name": "{{name}}", "count": {{count}}}

### Login form
POST https://auth.test/login
Content-Type: application/x-www-form-urlencoded

user=a
&pw=b

### Plain
PUT {{host}}/notes
Content-Type: text/plain

hello {{world
`;

describe("export", () => {
  const file = parseHttpFile(source, "/c/api/users.http");
  const other = parseHttpFile("GET https://api.test/v2/health\n", "/c/health.http");
  const inputs = [{ path: "/c/api/users.http", file }, { path: "/c/health.http", file: other }];

  test("OpenAPI 3.0.3: servers, path params, query/header params, security, bodies, tags", () => {
    const doc = exportOpenApi(inputs, { title: "Users", version: "2.0.0", root: "/c" }) as any;
    expect(doc.openapi).toBe("3.0.3");
    expect(doc.info).toEqual({ title: "Users", version: "2.0.0" });
    expect(doc.servers.map((s: any) => s.url)).toEqual(["https://api.test", "https://auth.test", "{host}"]);
    expect(doc.servers[2].variables.host.default).toBeTruthy();
    const list = doc.paths["/v2/users"].get;
    expect(list.summary).toBe("List users");
    expect(list.operationId).toBe("listusers");
    expect(list.tags).toEqual(["users", "smoke"]);
    expect(list.parameters).toEqual([
      { name: "limit", in: "query", schema: { type: "string" }, example: "10" },
      { name: "q", in: "query", schema: { type: "string" } },
      { name: "Accept", in: "header", schema: { type: "string" }, example: "application/json" },
      { name: "X-Trace", in: "header", schema: { type: "string" }, example: "on" },
    ]);
    expect(list.security).toEqual([{ bearerAuth: [] }]);
    const create = doc.paths["/v2/users/{id}/roles"].post;
    expect(create.parameters[0]).toEqual({ name: "id", in: "path", required: true, schema: { type: "string" }, example: "42" });
    expect(create.requestBody.content["application/json"].example).toEqual({ name: "{{name}}", count: "{{count}}" });
    expect(create.security).toEqual([{ basicAuth: [] }]);
    expect(doc.paths["/login"].post.requestBody.content["application/x-www-form-urlencoded"].example).toContain("user=a");
    expect(doc.paths["/notes"].put.requestBody.content["text/plain"].example).toBe("hello {{world");
    expect(doc.paths["/v2/health"].get.responses.default.description).toBeTruthy();
    expect(doc.components.securitySchemes).toEqual({ bearerAuth: { type: "http", scheme: "bearer" }, basicAuth: { type: "http", scheme: "basic" } });
    expect(doc.tags).toEqual([{ name: "users" }, { name: "smoke" }]);
  });

  test("Postman v2.1: folders, url parts, auth, bodies, variables", () => {
    const col = exportPostman(inputs, { name: "Users", root: "/c" }) as any;
    expect(col.info.schema).toContain("v2.1.0");
    expect(col.variable).toEqual([{ key: "base", value: "https://api.test/v2" }, { key: "id", value: "42" }]);
    // health.http at the root, api/ as a folder.
    expect(col.item.map((i: any) => i.name)).toEqual(["api", "GET https://api.test/v2/health"]);
    const [list, create, login, plain] = col.item[0].item;
    expect(list.name).toBe("List users");
    expect(list.request.url.raw).toBe("{{base}}/users?limit=10&q={{query}}");
    expect(list.request.url.host).toEqual(["{{base}}"]);
    expect(list.request.url.path).toEqual(["users"]);
    expect(list.request.url.query).toEqual([{ key: "limit", value: "10" }, { key: "q", value: "{{query}}" }]);
    expect(list.request.auth.type).toBe("bearer");
    expect(list.request.header.map((h: any) => h.key)).toEqual(["Accept", "X-Trace"]);
    expect(create.request.auth.basic).toEqual([{ key: "username", value: "alice", type: "string" }, { key: "password", value: "secret", type: "string" }]);
    expect(create.request.body.options.raw.language).toBe("json");
    expect(login.request.url.protocol).toBe("https");
    expect(login.request.url.host).toEqual(["auth", "test"]);
    expect(login.request.body).toEqual({ mode: "urlencoded", urlencoded: [{ key: "user", value: "a", type: "text" }, { key: "pw", value: "b", type: "text" }] });
    expect(plain.request.body.mode).toBe("raw");
    expect(plain.request.body.options).toBeUndefined();
  });

  test("export then import round-trips through Postman", () => {
    const col = exportPostman(inputs, { name: "Users", root: "/c" });
    const back = importPostman(col);
    const all = [...back.values()].join("\n");
    expect(all).toContain("GET {{base}}/users?limit=10&q={{query}}");
    expect(all).toContain("Authorization: Bearer {{token}}");
    expect(all).toContain("Authorization: Basic alice secret");
  });
});
