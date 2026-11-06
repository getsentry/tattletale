import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetSentCache } from "../src/state.ts";

export function freshHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "tattletale-test-"));
  process.env.TATTLETALE_HOME = join(dir, "home");
  process.env.TATTLETALE_DSN = "https://abc123@o1.ingest.example.com/42";
  resetSentCache();
  return dir;
}

const clock = Date.parse("2026-11-01T10:00:00.000Z");
export const at = (secondsFromStart: number) => new Date(clock + secondsFromStart * 1000).toISOString();

export interface ClaudeOpts {
  sessionId: string;
  cwd?: string;
}

export const usage = (input: number, read: number, write: number, output: number) => ({
  input_tokens: input,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write,
  output_tokens: output,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: write },
});

/** Claude Code-shaped records. */
export const cc = {
  prompt: (sessionId: string, uuid: string, t: number, text: string) => ({
    type: "user",
    sessionId,
    uuid,
    timestamp: at(t),
    cwd: "/work/repo",
    version: "2.1.318",
    gitBranch: "main",
    message: { role: "user", content: text },
  }),
  assistant: (
    sessionId: string,
    uuid: string,
    t: number,
    id: string,
    block: any,
    u: any,
    model = "claude-opus-5-5",
  ) => ({
    type: "assistant",
    sessionId,
    uuid,
    timestamp: at(t),
    message: {
      id,
      model,
      role: "assistant",
      content: [block],
      usage: u,
      stop_reason: block.type === "tool_use" ? "tool_use" : "end_turn",
    },
  }),
  toolResult: (sessionId: string, uuid: string, t: number, toolId: string, text: string, extra: any = {}) => ({
    type: "user",
    sessionId,
    uuid,
    timestamp: at(t),
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: text }] },
    ...extra,
  }),
  stopMarker: (sessionId: string, uuid: string, t: number) => ({
    type: "system",
    subtype: "stop_hook_summary",
    sessionId,
    uuid,
    timestamp: at(t),
  }),
};

export function claudeProject(root: string): string {
  const dir = join(root, "claude", "projects", "-work-repo");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeJsonl(path: string, records: any[]): string {
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return path;
}

export function appendJsonl(path: string, records: any[]): void {
  appendFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}
