#!/usr/bin/env node
import { main } from "../dist/main.js";

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
