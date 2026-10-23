/**
 * The shapes shared by the `.http` parser, the variable resolver and the
 * runner. The format is the union described at http-files.org/spec: the
 * universal core (VS Code REST Client, JetBrains, httpyac, Visual Studio,
 * kulala.nvim agree) plus each client's extensions, so a file written for any
 * of them runs here.
 */

/** A line range in the source file, 0-based, end exclusive. */
export interface Span { start: number; end: number }

/** `# @key value` and `// @key value`. Repeated keys keep every value in order. */
export type Metadata = Map<string, string[]>;

/** `@name = value` (eager) and `@name := value` (lazy, httpyac). */
export interface FileVariable { name: string; value: string; lazy: boolean; line: number }

/** A script block, inline (`{% %}`, `{{ }}`) or a path to a `.js` file. */
export interface Script {
  /** `jetbrains` scripts see `client`/`request`/`response`; `httpyac` scripts see exports, require, test, sleep. */
  dialect: "jetbrains" | "httpyac";
  code?: string;
  file?: string;
  /** httpyac event hook: `{{@response ... }}`; absent means the default for its position. */
  event?: "request" | "streaming" | "response" | "responseLogging" | "after";
  /** httpyac `{{+ }}` / `{{+after }}`: registered for every request in the file. */
  global?: boolean;
  line: number;
}

/** httpyac `?? kind args operator expected`. */
export interface Assertion {
  kind: "status" | "header" | "body" | "duration" | "js" | "xpath";
  /** The header name, JSONPath or xpath the assertion reads; the JS expression for `js`. */
  target: string;
  operator: string;
  expected: string;
  source: string;
  line: number;
}

/** One piece of a body: literal text or the contents of a file (`< path`, `<@enc path`). */
export type BodyPart =
  | { kind: "text"; text: string }
  | { kind: "file"; path: string; substitute: boolean; encoding?: BufferEncoding };

/** `>> path` (unique name), `>>! path` (overwrite). */
export interface SaveTarget { path: string; overwrite: boolean }

/** JetBrains WebSocket body: messages split by `===`, optionally waiting for the server. */
export interface StreamMessage { text: string; waitForServer: boolean }

export interface HttpRequest {
  /** Position in the file, 0-based, counting only real requests. */
  index: number;
  /** `# @name`, `### name` (httpyac/kulala), or undefined. */
  name?: string;
  /** Text after `###`, used as the display title. */
  title?: string;
  method: string;
  /** The URL as written, continuation lines joined, variables unresolved. */
  url: string;
  httpVersion?: string;
  /** Headers in order; a header may repeat. `...name` spreads are kept as `{ spread: name }`. */
  headers: ({ name: string; value: string } | { spread: string })[];
  body: BodyPart[];
  metadata: Metadata;
  /** Variables defined inside this request block (apply from here on). */
  variables: FileVariable[];
  preScripts: Script[];
  postScripts: Script[];
  assertions: Assertion[];
  save?: SaveTarget;
  /** JetBrains `<> path`: compare the response with a saved file. */
  compareWith?: string;
  /** httpyac `gql Name < ./query.gql` before the body. */
  graphqlFile?: string;
  messages?: StreamMessage[];
  /** The block was a pasted curl command rather than a request line. */
  fromCurl?: boolean;
  span: Span;
  /** Line of the request line, for error messages. */
  line: number;
  /** A problem that makes this request unsendable. */
  error?: string;
}

/** JetBrains `run ./file.http#name (@var=value)`. */
export interface RunDirective { path: string; name?: string; overrides: Record<string, string>; line: number }

export interface HttpFile {
  path: string;
  requests: HttpRequest[];
  /** Variables at file level, in order, including those in global regions. */
  variables: FileVariable[];
  /** Metadata from global regions (a `###` block with no request line), applied to every request. */
  metadata: Metadata;
  /** Scripts from global regions and `{{+ }}` blocks. */
  globalScripts: Script[];
  /** `# @import` and JetBrains `import` lines. */
  imports: string[];
  runs: RunDirective[];
  /** Problems found while parsing; requests that parsed are still usable. */
  errors: { line: number; message: string }[];
}

/** A request with every variable resolved, ready for the wire. */
export interface PreparedRequest {
  method: string;
  url: string;
  httpVersion?: string;
  headers: [string, string][];
  body?: Buffer;
  /** Display form of the body (text bodies only). */
  bodyText?: string;
}

export interface HttpResponse {
  status: number;
  statusText: string;
  httpVersion: string;
  headers: [string, string][];
  body: Buffer;
  /** Decoded text per the response charset. */
  text: string;
  contentType: string;
  /** Milliseconds from start to last byte. */
  duration: number;
  /** Final URL after redirects. */
  url: string;
  redirects: string[];
}

/** How the runner asks the person something: the TUI and the CLI each provide one. */
export interface Interaction {
  prompt(message: string, options?: { default?: string; secret?: boolean }): Promise<string | undefined>;
  pick(message: string, options: string[]): Promise<string | undefined>;
  confirm(message: string): Promise<boolean>;
  /** Print an informational line (client.log, OAuth device-code instructions, open-this-URL). */
  log(message: string): void;
}

/** TLS material for a host, merged from every config format the spec lists. */
export interface TlsOptions {
  cert?: Buffer;
  key?: Buffer;
  pfx?: Buffer;
  passphrase?: string;
  ca?: Buffer;
  rejectUnauthorized?: boolean;
}
