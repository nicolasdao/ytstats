#!/usr/bin/env node
import { main } from '../src/cli.js';

main().catch(err => {
  // Last-resort guard: never let a stack trace land on stdout, which is reserved
  // for the JSON document.
  process.stderr.write(`ytstats: ${err?.message ?? err}\n`);
  process.exitCode = 1;
});
