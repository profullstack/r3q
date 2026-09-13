#!/usr/bin/env node
// `main` is called here rather than by an `import.meta.main` guard inside
// main.js: that guard is false for a module something else imported, which
// is exactly what this file does, so the installed command used to do nothing.
import { main } from "../dist/main.js";

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
