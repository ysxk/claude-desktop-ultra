#!/usr/bin/env node
import { main } from "../src/cli.mjs";

main(process.argv.slice(2)).catch((error) => {
  console.error(`\n[claude-cn] ${error.message}`);
  if (process.env.CLAUDE_CN_DEBUG === "1" && error.stack) {
    console.error(error.stack);
  }
  process.exitCode = 1;
});
