#!/usr/bin/env node
import("../dist/cli.js").catch((error) => {
  console.error("ppro: could not load the CLI build.");
  console.error("If you are developing locally, run `npm run build` first.");
  console.error(String(error?.message ?? error));
  process.exit(1);
});
