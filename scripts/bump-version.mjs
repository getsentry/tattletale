#!/usr/bin/env node
// Sets the release version everywhere it lives. Craft's preReleaseCommand calls it with
// `<old> <new>`; by hand: `node scripts/bump-version.mjs <new>`. The plugin manifest version must move
// with it, or `claude plugin update` won't pick the release up.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const version = args.length === 2 ? args[1] : args[0];

if (!version || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) {
  console.error(`usage: bump-version.mjs [old] <new>; got ${JSON.stringify(args)}`);
  process.exit(1);
}

for (const rel of ["package.json", ".claude-plugin/plugin.json"]) {
  const path = join(root, rel);
  const json = JSON.parse(readFileSync(path, "utf8"));
  const previous = json.version;
  json.version = version;
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
  console.log(`${rel}: ${previous} -> ${version}`);
}
