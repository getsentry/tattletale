#!/usr/bin/env node
// Checks the npm tarball before craft publishes it: the right files are in it, versions agree, and the
// CLI runs when installed from npm (Node won't type-strip .ts under node_modules, so it must be the build).
// usage: node scripts/verify-pack.mjs [dir-with-tarball]

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dir = resolve(process.argv[2] ?? ".");
const tarballs = readdirSync(dir).filter((n) => /^sentry-tattletale-\d.*\.tgz$/.test(n));
if (tarballs.length !== 1) fail(`expected exactly one sentry-tattletale-*.tgz in ${dir}, found ${tarballs.length}`);
const tarball = join(dir, tarballs[0]);

const files = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).trim().split("\n");
const required = [
  "package/package.json",
  "package/LICENSE",
  "package/README.md",
  "package/dist/cli.js",
  "package/dist/relay.js",
  "package/hooks/hooks.json",
  "package/hooks/run.sh",
  "package/.claude-plugin/plugin.json",
  "package/.claude-plugin/marketplace.json",
  "package/.codex-plugin/plugin.json",
  "package/.agents/plugins/marketplace.json",
];
for (const f of required) if (!files.includes(f)) fail(`missing from tarball: ${f}`);
const stray = files.filter((f) => /^package\/(src|test|scripts|node_modules)\//.test(f) || f.endsWith(".ts"));
if (stray.length) fail(`unexpected files in tarball: ${stray.slice(0, 5).join(", ")}`);

const read = (f) => JSON.parse(execFileSync("tar", ["-xzOf", tarball, f], { encoding: "utf8" }));
const pkg = read("package/package.json");
const plugin = read("package/.claude-plugin/plugin.json");
if (pkg.name !== "@sentry/tattletale") fail(`package name is ${pkg.name}`);
if (pkg.private) fail("package.json is private");
if (plugin.version !== pkg.version) fail(`plugin.json version ${plugin.version} != package.json ${pkg.version}`);

// Install it the way users will and drive the CLI from node_modules.
const sandbox = mkdtempSync(join(tmpdir(), "tattletale-pack-"));
execFileSync("npm", ["install", "--prefix", sandbox, "--no-audit", "--no-fund", "--loglevel=error", tarball], {
  stdio: "inherit",
});
const bin = join(sandbox, "node_modules", ".bin", "tattletale");
const env = {
  ...process.env,
  HOME: sandbox,
  TATTLETALE_HOME: join(sandbox, ".tattletale"),
  CLAUDE_CONFIG_DIR: join(sandbox, ".claude"),
};
const run = (...args) => execFileSync(bin, args, { encoding: "utf8", env });

if (!run("--help").includes("install --otel")) fail("--help output is missing commands");

const session = "11111111-1111-4111-8111-111111111111";
const project = join(sandbox, ".claude", "projects", "-work");
mkdirSync(project, { recursive: true });
const line = (o) => JSON.stringify({ sessionId: session, cwd: "/work", ...o });
writeFileSync(
  join(project, `${session}.jsonl`),
  [
    line({ type: "user", uuid: "u1", timestamp: "2026-11-01T10:00:00Z", message: { role: "user", content: "hi" } }),
    line({
      type: "assistant",
      uuid: "a1",
      timestamp: "2026-11-01T10:00:02Z",
      message: {
        id: "msg_1",
        model: "m",
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 1, cache_read_input_tokens: 10, cache_creation_input_tokens: 5, output_tokens: 3 },
      },
    }),
  ].join("\n") + "\n",
);
const spans = JSON.parse(run("spans", join(project, `${session}.jsonl`), "--final"));
const chat = spans.find((s) => s.name === "chat m");
const input = chat?.attributes.find((a) => a.key === "gen_ai.usage.input_tokens")?.value.intValue;
if (input !== "16") fail(`installed CLI built wrong spans (input_tokens=${input})`);

const install = run("install", "--print");
if (!install.includes(join(sandbox, ".tattletale", "plugin")))
  fail(`install from node_modules didn't stage the plugin:\n${install}`);

console.log(`verify-pack: ${tarballs[0]} ok (${files.length} files, ${pkg.name}@${pkg.version})`);

function fail(message) {
  console.error(`verify-pack: ${message}`);
  process.exit(1);
}
