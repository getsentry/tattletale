#!/usr/bin/env -S node --no-warnings
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { listClaudeSessions } from "./claude.ts";
import { listCodexSessions } from "./codex.ts";
import type { AgentName } from "./model.ts";
import { fileSink, otlpEndpoint } from "./send.ts";
import { buildSpans } from "./spans.ts";
import { countLines, enqueue, home, loadConfig, log, queueLength, saveConfig } from "./state.ts";
import { detectAgent, parseSession, runWorker, syncMany, syncTranscript } from "./sync.ts";
import type { SyncReport } from "./sync.ts";
import { crossSessionDuplicates, verifyTranscript } from "./verify.ts";
import { reportError } from "./report.ts";
import { applyOtelEnv, claudeSettingsPath, otelEnv, removeOtelEnv } from "./claude-settings.ts";
import { createRelay, relayAlive, serveRelay } from "./relay.ts";
import { loadOtelSessions } from "./state.ts";

const CLI_PATH = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(CLI_PATH), "..");

function parseArgs(argv: string[]): { _: string[]; flags: Record<string, string | boolean | string[]> } {
  const out: { _: string[]; flags: Record<string, string | boolean | string[]> } = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const [k, inline] = a.slice(2).split("=", 2) as [string, string | undefined];
    const next = argv[i + 1];
    const value = inline ?? (next !== undefined && !next.startsWith("--") ? (i++, next) : true);
    const prev = out.flags[k];
    out.flags[k] = prev === undefined ? value : ([] as string[]).concat(prev as string[], value as string);
  }
  return out;
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" ? v : Array.isArray(v) ? v[v.length - 1] : undefined;
const list = (v: unknown): string[] => (typeof v === "string" ? [v] : Array.isArray(v) ? v : []);
const agentFlag = (v: unknown): AgentName | undefined => {
  const s = str(v);
  if (!s) return undefined;
  if (s === "claude" || s === "claude-code") return "claude-code";
  if (s === "codex") return "codex";
  throw new Error(`unknown agent ${s}`);
};

async function readStdin(timeoutMs = 2000): Promise<string> {
  if (process.stdin.isTTY) return "";
  return new Promise((resolveText) => {
    let data = "";
    const timer = setTimeout(() => resolveText(data), timeoutMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => {
      clearTimeout(timer);
      resolveText(data);
    });
  });
}

function printReport(r: SyncReport): void {
  const id = (r.sessionId ?? r.path).slice(0, 12);
  const extra = [
    r.skipped && `skipped: ${r.skipped}`,
    r.error && `error: ${r.error}`,
    r.rejected && `rejected: ${r.rejected}`,
    r.poisoned && `poisoned: ${r.poisoned}`,
  ]
    .filter(Boolean)
    .join(" ");
  console.log(
    `${r.agent.padEnd(11)} ${id}  spans=${r.built} new=${r.sent} already=${r.alreadySent} failed=${r.failed} ${r.settled ? "settled" : "open"} ${extra}`,
  );
}

/** Hook entry point. Must be fast and must never fail the agent: queue the job, spawn a worker, exit 0. */
async function hook(eventArg?: string): Promise<void> {
  try {
    const input = await readStdin();
    const data = input.trim() ? JSON.parse(input) : {};
    const transcriptPath: string | undefined = data.transcript_path ?? data.transcriptPath ?? undefined;
    const event: string | undefined = data.hook_event_name ?? data.hookEventName ?? eventArg;
    enqueue({
      agent: transcriptPath ? detectAgent(transcriptPath) : undefined,
      event,
      sessionId: data.session_id ?? data.sessionId ?? data.conversation_id,
      transcriptPath,
      at: Date.now(),
    });
    const child = spawn(process.execPath, ["--no-warnings", CLI_PATH, "worker"], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
    const config = loadConfig();
    if (
      config.claudeSource === "otel" &&
      !config.disabled &&
      !(transcriptPath && detectAgent(transcriptPath) === "codex")
    )
      await ensureRelay(config.relayPort);
  } catch (err) {
    log(`hook failed: ${(err as Error)?.stack ?? err}`);
    await reportError(err, { stage: "hook" });
  }
  process.exit(0);
}

/** Starts the relay in the background unless one already answers on the port. */
async function ensureRelay(port: number): Promise<boolean> {
  if (await relayAlive(port)) return false;
  const child = spawn(process.execPath, ["--no-warnings", CLI_PATH, "relay"], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  log(`relay: started on port ${port} (pid ${child.pid})`);
  return true;
}

async function runRelay(): Promise<void> {
  const config = loadConfig();
  try {
    await serveRelay(config.relayPort, createRelay());
    log(`relay: listening on 127.0.0.1:${config.relayPort}`);
  } catch (err: any) {
    if (err?.code === "EADDRINUSE") return; // another relay already owns the port
    throw err;
  }
  await new Promise(() => {});
}

/** Switch Claude Code to native OTel: settings env -> local relay. --print shows the change without writing. */
async function installOtel(flags: Record<string, unknown>): Promise<number> {
  const write = flags.print !== true;
  const config = loadConfig();
  const path = claudeSettingsPath();
  const change = applyOtelEnv(path, otelEnv(config), { write, force: flags.force === true });
  if (change.conflicts.length && flags.force !== true) {
    console.log(`${path} already sets OpenTelemetry differently; not changing anything:`);
    for (const c of change.conflicts) console.log(`  ${c.key}: ${c.current} (would be ${c.wanted})`);
    console.log("Re-run with --force to replace them.");
    return 1;
  }
  console.log(`${write ? "set" : "would set"} in ${path} env: ${change.set.join(", ") || "(already set)"}`);
  if (!write) return 0;
  saveConfig({
    claudeSource: "otel",
    otelSince: config.claudeSource === "otel" && config.otelSince ? config.otelSince : Date.now(),
  });
  await ensureRelay(config.relayPort);
  console.log(
    "New Claude Code sessions export to the relay; running sessions keep their current setup until restarted.",
  );
  return 0;
}

async function uninstallOtel(flags: Record<string, unknown>): Promise<number> {
  const write = flags.print !== true;
  const config = loadConfig();
  const removed = removeOtelEnv(claudeSettingsPath(), otelEnv(config), write);
  console.log(
    `${write ? "removed" : "would remove"} from ${claudeSettingsPath()} env: ${removed.join(", ") || "(nothing of ours)"}`,
  );
  if (write) saveConfig({ claudeSource: "transcript" });
  return 0;
}

const PLUGIN = "tattletale";

function run(cmd: string, args: string[], dry: boolean): boolean {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  if (dry) return true;
  const res = spawnSync(cmd, args, { stdio: "inherit" });
  return res.status === 0;
}

const which = (bin: string) => spawnSync("sh", ["-c", `command -v ${bin}`]).status === 0;

const PLUGIN_FILES = [
  ".claude-plugin",
  ".codex-plugin",
  ".agents",
  "hooks",
  "skills",
  "dist",
  "package.json",
  "README.md",
];

/** npx/npm installs live in a disposable node_modules cache; agents get a stable copy under the tattletale home. */
function pluginRoot(dry: boolean): string {
  if (!ROOT.split(sep).includes("node_modules")) return ROOT;
  const target = join(home(), "plugin");
  if (!dry) {
    rmSync(target, { recursive: true, force: true });
    for (const name of PLUGIN_FILES)
      if (existsSync(join(ROOT, name))) cpSync(join(ROOT, name), join(target, name), { recursive: true });
  }
  console.log(`${dry ? "would copy" : "copied"} plugin to ${target}`);
  return target;
}

function install(flags: Record<string, unknown>): void {
  const dry = flags.print === true;
  const root = pluginRoot(dry);
  if (!dry) {
    mkdirSync(home(), { recursive: true });
    // Hooks run under GUI apps whose PATH often lacks node; hooks/run.sh reads this.
    writeFileSync(join(home(), "node-path"), process.execPath);
  }
  const onlyClaude = flags.claude === true;
  const onlyCodex = flags.codex === true;
  if (!onlyCodex && which("claude")) {
    run("claude", ["plugin", "marketplace", "add", root], dry);
    run("claude", ["plugin", "install", `${PLUGIN}@${PLUGIN}`, "--scope", "user"], dry);
  }
  if (!onlyClaude && which("codex")) {
    run("codex", ["plugin", "marketplace", "add", root], dry);
    run("codex", ["plugin", "add", `${PLUGIN}@${PLUGIN}`], dry);
    console.log("Codex asks you to trust new hooks: open Codex and approve them under /hooks.");
  }
}

function uninstall(flags: Record<string, unknown>): void {
  const dry = flags.print === true;
  run("claude", ["plugin", "uninstall", `${PLUGIN}@${PLUGIN}`], dry);
  run("claude", ["plugin", "marketplace", "remove", PLUGIN], dry);
  run("codex", ["plugin", "remove", `${PLUGIN}@${PLUGIN}`], dry);
  run("codex", ["plugin", "marketplace", "remove", PLUGIN], dry);
}

function status(): void {
  const c = loadConfig();
  console.log(`home:        ${home()}`);
  console.log(`dsn:         ${c.dsn ? otlpEndpoint(c.dsn).url : "(not set)"}`);
  console.log(`content:     ${c.content}   environment: ${c.environment}   disabled: ${c.disabled}`);
  console.log(`include:     ${c.include.join(", ") || "(everything)"}   ignore: ${c.ignore.join(", ") || "(none)"}`);
  console.log(
    `sent spans:  ${countLines("sent.log")}   unverified: ${countLines("unverified.log")}   queued jobs: ${queueLength()}`,
  );
  console.log(
    `claude src:  ${c.claudeSource}${c.claudeSource === "otel" ? `   relay port ${c.relayPort}   sessions seen by relay: ${loadOtelSessions().size}` : ""}`,
  );
  const logPath = join(home(), "tattletale.log");
  if (existsSync(logPath)) {
    console.log("recent log:");
    for (const line of readFileSync(logPath, "utf8").trim().split("\n").slice(-8)) console.log(`  ${line}`);
  }
}

function sessionsFor(agent: AgentName | undefined, days: number): { path: string; agent: AgentName }[] {
  const since = Date.now() - days * 86_400_000;
  const out: { path: string; agent: AgentName }[] = [];
  if (agent !== "codex") for (const path of listClaudeSessions(since)) out.push({ path, agent: "claude-code" });
  if (agent !== "claude-code") for (const path of listCodexSessions(since)) out.push({ path, agent: "codex" });
  return out;
}

function verify(paths: string[], flags: Record<string, unknown>): number {
  const agent = agentFlag(flags.agent);
  const items = paths.length
    ? paths.map((p) => ({ path: p, agent: agent ?? detectAgent(p) }))
    : sessionsFor(agent, Number(str(flags.days) ?? 30));
  const results = [];
  let failed = 0;
  for (const item of items) {
    let r;
    try {
      r = verifyTranscript(item.path, item.agent);
    } catch (err) {
      failed++;
      console.log(`✗ ${item.agent} ${item.path}\n    crashed: ${(err as Error).message}`);
      continue;
    }
    results.push(r);
    if (!r.ok) failed++;
    const bad = r.checks.filter((c) => !c.ok);
    if (flags.verbose || bad.length) {
      console.log(`${r.ok ? "✓" : "✗"} ${r.agent} ${r.sessionId}  spans=${r.spans}  ${r.path}`);
      for (const c of flags.verbose ? r.checks : bad)
        console.log(`    ${c.ok ? "ok  " : c.warnOnly ? "warn" : "FAIL"} ${c.name}${c.detail ? `: ${c.detail}` : ""}`);
    }
  }
  const dups = crossSessionDuplicates(results);
  const totalSpans = results.reduce((n, r) => n + r.spans, 0);
  const totalIn = results.reduce((n, r) => n + (r.usage?.input ?? 0), 0);
  const totalOut = results.reduce((n, r) => n + (r.usage?.output ?? 0), 0);
  console.log(
    `\n${items.length} sessions, ${failed} failing, ${totalSpans} spans, ${totalIn} input / ${totalOut} output tokens`,
  );
  // Copies whose lines were rewritten to the new session ID. Span IDs come from the call ID alone, so
  // the ledger sends each of these once, under whichever session syncs first.
  console.log(
    `call IDs present in >1 session (copied history; ledger sends once): ${dups.length}${dups.length ? ` e.g. ${dups[0]!.id} in ${dups[0]!.sessions.join(", ")}` : ""}`,
  );
  return failed ? 1 : 0;
}

const DOCS = "https://github.com/getsentry/tattletale#readme";

const HELP = `tattletale: tattles on your coding agents. It sends Claude Code and Codex sessions to Sentry agent
tracing as gen_ai spans: conversations, model calls, tool calls, exact tokens.

Get started (or ask your agent to "set up tattletale"; the plugin ships a setup skill):
  1. tattletale setup --dsn <SENTRY_DSN>                    the only thing it needs: the Sentry project's DSN
     optional scope: --include ~/code/terra (a folder), --repo getsentry/terra (a repo, any worktree)
  2. tattletale install                                      hook into Claude Code and Codex
  3. tattletale status                                       confirm; Codex then asks you to approve hooks (/hooks)
  Check the data locally first (sends nothing): tattletale verify --days 7

Setup
  setup --dsn <dsn> [--include <path>|repo:<owner/name>]... [--repo <owner/name>]... [--ignore <rule>]...
        [--everything] [--content full|metadata] [--environment <env>]
                                            no --include/--repo: every session; --everything clears the scope
  install [--claude|--codex] [--print]      install the hooks plugin into your agents (--print: show, don't run)
  install --otel [--print] [--force]        Claude Code via its native OpenTelemetry and a local relay
  uninstall [--otel] [--print]
  status                                    config, what was sent, relay, recent log

Data
  verify [<transcript>...] [--days 30] [--agent claude|codex] [--verbose]   token reconciliation, sends nothing
  backfill [--days 7] [--agent claude|codex] [--dry-run] [--limit N]        send past sessions
  sync <transcript> [--final] [--dry-run] [--sink file:<path>]              send one session now
  spans <transcript> [--final]              print the spans that would be sent
  test-error                                send a test error event to the DSN

Internal
  hook [event]    called by agent hooks (JSON on stdin)
  worker          spawned by hooks
  relay           local OTLP relay (started by hooks when Claude Code uses OTel)

State lives in ~/.tattletale (override with TATTLETALE_HOME); log: ~/.tattletale/tattletale.log
Docs: ${DOCS}
`;

async function main(): Promise<number> {
  const { _, flags } = parseArgs(process.argv.slice(2));
  const [cmd, ...rest] = _;
  switch (cmd) {
    case "hook":
      await hook(rest[0]);
      return 0;
    case "worker":
      await runWorker();
      return 0;
    case "setup": {
      const dsn = str(flags.dsn);
      if (dsn) otlpEndpoint(dsn);
      const content = str(flags.content);
      if (content && content !== "full" && content !== "metadata")
        throw new Error("--content must be full or metadata");
      const ignore = list(flags.ignore);
      const include =
        flags.everything === true ? [] : [...list(flags.include), ...list(flags.repo).map((r) => `repo:${r}`)];
      saveConfig({
        ...((include.length || flags.everything === true) && { include }),
        ...(dsn && { dsn }),
        ...(content && { content: content as "full" | "metadata" }),
        ...(str(flags.environment) && { environment: str(flags.environment)! }),
        ...(ignore.length && { ignore }),
      });
      writeFileSync(join(home(), "node-path"), process.execPath);
      status();
      return 0;
    }
    case "install":
      if (flags.otel === true) return installOtel(flags);
      install(flags);
      return 0;
    case "uninstall":
      if (flags.otel === true) return uninstallOtel(flags);
      uninstall(flags);
      return 0;
    case "relay":
      await runRelay();
      return 0;
    case "status":
      status();
      return 0;
    case "sync": {
      if (!rest[0]) throw new Error("usage: sync <transcript>");
      const sinkArg = str(flags.sink);
      const sink = sinkArg?.startsWith("file:") ? fileSink(sinkArg.slice(5)) : undefined;
      const r = await syncTranscript(resolve(rest[0]), {
        agent: agentFlag(flags.agent),
        final: flags.final === true,
        dryRun: flags["dry-run"] === true,
        sink,
      });
      printReport(r);
      return r.error ? 1 : 0;
    }
    case "backfill": {
      let items = sessionsFor(agentFlag(flags.agent), Number(str(flags.days) ?? 7));
      const limit = Number(str(flags.limit) ?? 0);
      if (limit) items = items.slice(0, limit);
      console.log(`${items.length} sessions${flags["dry-run"] ? " (dry run)" : ""}`);
      const reports = await syncMany(items, { dryRun: flags["dry-run"] === true }, printReport);
      const sent = reports.reduce((n, r) => n + r.sent, 0);
      console.log(`${flags["dry-run"] ? "would send" : "sent"} ${sent} spans`);
      return reports.some((r) => r.error) ? 1 : 0;
    }
    case "verify":
      return verify(rest, flags);
    case "test-error": {
      // Sends a real error through the same path worker/hook crashes use.
      const id = await reportError(new Error("tattletale verification error (sent by `tattletale test-error`)"), {
        stage: "test",
      });
      console.log(id ? `sent error event ${id}` : "not sent (no DSN, or Sentry rejected it; see tattletale.log)");
      return id ? 0 : 1;
    }
    case "spans": {
      if (!rest[0]) throw new Error("usage: spans <transcript>");
      const path = resolve(rest[0]);
      const session = parseSession(path, agentFlag(flags.agent), { final: flags.final === true });
      const c = loadConfig();
      console.log(
        JSON.stringify(buildSpans(session, { content: c.content, environment: c.environment, user: c.user }), null, 2),
      );
      return 0;
    }
    default:
      console.log(HELP);
      return cmd ? 1 : 0;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
