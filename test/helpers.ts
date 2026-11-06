import { appendFileSync, closeSync, mkdirSync, mkdtempSync, openSync, writeFileSync, writeSync } from "node:fs";
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

export interface HeavyOpts {
  turns: number;
  /** Base64 characters per image. Claude Code stores each image twice per line (content and toolUseResult). */
  imageChars: number;
  subagents?: number;
}

const write = (fd: number, rec: any) => writeSync(fd, JSON.stringify(rec) + "\n");

/** A gamedev-style Claude Code session that Reads an image every turn, written one line at a time. */
export function writeImageHeavyClaude(dir: string, sessionId: string, opts: HeavyOpts): string {
  const data = Buffer.alloc(Math.ceil((opts.imageChars * 3) / 4), 7)
    .toString("base64")
    .slice(0, opts.imageChars);
  const image = { type: "image", source: { type: "base64", data, media_type: "image/png" } };
  const toolUseResult = { type: "image", file: { base64: data, type: "image/png", originalSize: opts.imageChars } };
  const path = join(dir, `${sessionId}.jsonl`);
  const fd = openSync(path, "w");
  const subagents = opts.subagents ?? 0;
  for (let i = 0; i < opts.turns; i++) {
    const t = i * 60;
    const prompt = cc.prompt(sessionId, `p${i}`, t, `tweak sprite ${i} ✓ — 日本`);
    if (i % 10 === 0) prompt.message.content = [{ type: "text", text: `like this one? ${i}` }, image] as any;
    write(fd, prompt);
    const read = {
      type: "tool_use",
      id: `toolu_r${i}`,
      name: "Read",
      input: { file_path: `/work/repo/sprite-${i}.png` },
    };
    write(fd, cc.assistant(sessionId, `a${i}`, t + 2, `msg_${i}_a`, read, usage(3, 1000 + i, 200, 40)));
    write(fd, {
      ...cc.toolResult(sessionId, `r${i}`, t + 3, `toolu_r${i}`, ""),
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_r${i}`, content: [image] }] },
      toolUseResult,
    });
    if (i < subagents) {
      const spawn = { type: "tool_use", id: `toolu_s${i}`, name: "Agent", input: { prompt: `render ${i}` } };
      write(fd, cc.assistant(sessionId, `s${i}`, t + 4, `msg_${i}_s`, spawn, usage(2, 1100 + i, 10, 20)));
      const sub = join(dir, sessionId, "subagents");
      mkdirSync(sub, { recursive: true });
      const sfd = openSync(join(sub, `agent-sub${i}.jsonl`), "w");
      write(sfd, { ...cc.prompt(sessionId, `sp${i}`, t + 5, `render ${i}`), isSidechain: true });
      const sread = { type: "tool_use", id: `toolu_sr${i}`, name: "Read", input: { file_path: `/tmp/out-${i}.png` } };
      write(sfd, {
        ...cc.assistant(sessionId, `sa${i}`, t + 6, `msg_${i}_sa`, sread, usage(1, 500, 50, 10)),
        isSidechain: true,
      });
      write(sfd, {
        ...cc.toolResult(sessionId, `sr${i}`, t + 7, `toolu_sr${i}`, ""),
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_sr${i}`, content: [image] }] },
        toolUseResult,
        isSidechain: true,
      });
      write(sfd, {
        ...cc.assistant(
          sessionId,
          `sb${i}`,
          t + 8,
          `msg_${i}_sb`,
          { type: "text", text: "rendered" },
          usage(1, 600, 0, 5),
        ),
        isSidechain: true,
      });
      closeSync(sfd);
      writeFileSync(
        join(sub, `agent-sub${i}.meta.json`),
        JSON.stringify({ agentType: "general-purpose", toolUseId: `toolu_s${i}` }),
      );
      write(
        fd,
        cc.toolResult(sessionId, `sx${i}`, t + 9, `toolu_s${i}`, "rendered", {
          toolUseResult: { agentId: `sub${i}`, status: "completed" },
        }),
      );
    }
    write(
      fd,
      cc.assistant(
        sessionId,
        `b${i}`,
        t + 10,
        `msg_${i}_b`,
        { type: "text", text: `sprite ${i} looks good` },
        usage(1, 1300 + i, 0, 12),
      ),
    );
    write(fd, cc.stopMarker(sessionId, `m${i}`, t + 11));
  }
  closeSync(fd);
  return path;
}
