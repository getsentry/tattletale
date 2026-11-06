import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { freshHome } from "./helpers.ts";

const runSh = fileURLToPath(new URL("../hooks/run.sh", import.meta.url));

/** A fake node that reports `version` and records that it ran. */
function fakeNode(path: string, version: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n[ "$1" = "--version" ] && echo ${version} && exit 0\necho ${version} > "$MARKER"\n`);
  chmodSync(path, 0o755);
  return path;
}

function setup() {
  const root = freshHome();
  const home = join(root, "user");
  const nvm = (v: string) => fakeNode(join(home, ".nvm/versions/node", v, "bin/node"), v);
  const nodes = { v18: nvm("v18.20.3"), v22old: nvm("v22.17.1"), v99: nvm("v99.0.0") };
  // A PATH with the shell tools run.sh uses and no node.
  const bin = join(root, "bin");
  mkdirSync(bin);
  for (const tool of ["awk", "cat", "date", "dirname", "mkdir"]) {
    const real = spawnSync("/bin/sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
    symlinkSync(real, join(bin, tool));
  }
  const tattletaleHome = join(root, "tt");
  const marker = join(root, "ran");
  const run = (env: Record<string, string> = {}) => {
    rmSync(marker, { force: true });
    const r = spawnSync("/bin/sh", [runSh, "hook"], {
      env: { HOME: home, PATH: bin, TATTLETALE_HOME: tattletaleHome, MARKER: marker, ...env },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    return existsSync(marker) ? readFileSync(marker, "utf8").trim() : undefined;
  };
  return { root, nodes, tattletaleHome, run };
}

test("hook launcher: with no usable node on PATH it takes the newest install, not the first alphabetically", () => {
  const { run } = setup();
  assert.equal(run(), "v99.0.0");
});

test("hook launcher: a remembered or configured node that is too old is skipped; a new enough one is preferred", () => {
  const { root, nodes, tattletaleHome, run } = setup();
  mkdirSync(tattletaleHome, { recursive: true });
  writeFileSync(join(tattletaleHome, "node-path"), nodes.v22old);
  assert.equal(run(), "v99.0.0", "node-path below 22.18");
  assert.equal(run({ TATTLETALE_NODE: nodes.v18 }), "v99.0.0", "TATTLETALE_NODE below 22.18");
  const ok = fakeNode(join(root, "custom/bin/node"), "v22.18.0");
  writeFileSync(join(tattletaleHome, "node-path"), ok);
  assert.equal(run(), "v22.18.0", "a new enough remembered node wins over newer installs");
});
