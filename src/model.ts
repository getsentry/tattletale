// Agent-agnostic session model. Parsers map each agent's transcript onto it; spans.ts maps it onto Sentry.

export type AgentName = "claude-code" | "codex" | "opencode" | "pi";

/** Token usage in Sentry's convention: `input` includes cache reads and cache writes, `output` includes reasoning. */
export interface Usage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning?: number;
  /** Agent-specific counters, e.g. Claude's 5m vs 1h cache writes. */
  extra?: Record<string, number>;
}

export type Part =
  | { type: "text"; content: string }
  | { type: "reasoning"; content: string }
  | { type: "tool_call"; id: string; name: string; arguments: unknown }
  | { type: "tool_call_response"; id: string; result: unknown }
  | { type: "blob"; mime_type: string };

export interface Message {
  id: string;
  role: "user" | "assistant" | "tool";
  parts: Part[];
}

export interface ModelCall {
  /** Provider response/message ID. Globally unique, so it doubles as the dedup key. */
  id: string;
  start: number;
  end: number;
  model: string;
  provider: string;
  usage?: Usage;
  /** Only the messages added since the previous call in this thread, never the full history. */
  input: Message[];
  output: Message[];
  finishReason?: string;
  complete: boolean;
  /** Old Claude Code versions inline subagent calls in the main transcript. */
  sidechain?: boolean;
  /** Usage was recorded but the agent persisted no output for it (e.g. Codex background checks). */
  hidden?: boolean;
  /** A compaction record sits between the previous call and this one in the transcript. */
  afterCompaction?: boolean;
  analysis?: CallAnalysis;
}

/** Derived per-call signals for token analysis. */
export interface CallAnalysis {
  idleMs?: number;
  /** Input growth since the previous call: input(n) - (input(n-1) + output(n-1)). */
  contextGrowth?: number;
  /** Input tokens not served from cache (fresh input + cache writes). */
  uncachedInput: number;
  /** Cache reads dropped compared with the previous call. */
  cacheBreak: boolean;
  cacheReadDrop?: number;
  compactedBefore?: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  start: number;
  end?: number;
  arguments?: unknown;
  result?: unknown;
  argsBytes: number;
  resultBytes?: number;
  isError?: boolean;
  /** Model call that requested this tool. */
  callId: string;
  complete: boolean;
  /** Executed by the provider (e.g. web search); no tool result appears in the transcript. */
  serverSide?: boolean;
}

export interface Compaction {
  id: string;
  start: number;
  end: number;
  trigger?: string;
  preTokens?: number;
  postTokens?: number;
  summaryBytes?: number;
}

export interface Run {
  calls: ModelCall[];
  tools: ToolCall[];
  compactions: Compaction[];
}

export interface Turn extends Run {
  id: string;
  index: number;
  start: number;
  end: number;
  complete: boolean;
  prompt?: string;
  /** `user`, or `notification` for turns started by background-task notices. */
  trigger: string;
  apiErrors: number;
}

export interface SubagentRun extends Run {
  agentId: string;
  agentType: string;
  description?: string;
  start: number;
  end: number;
  complete: boolean;
  /** Tool call (in the main thread or another subagent) that launched it. */
  parentToolId?: string;
}

export interface Diagnostics {
  badLines: number;
  inheritedLines: number;
  syntheticMessages: number;
  sidechainCalls: number;
  unknownRecords: Record<string, number>;
  /** Codex: usage that could not be attached to a call. */
  unattributedUsage?: Usage;
  notes: string[];
}

export interface Session {
  agent: AgentName;
  /** Becomes gen_ai.conversation.id. */
  sessionId: string;
  path: string;
  cwd?: string;
  gitBranch?: string;
  agentVersion?: string;
  entrypoint?: string;
  /** Session this one was forked/resumed from (its history is not re-sent). */
  parentSessionId?: string;
  /** "owner/name" of the git repo the session ran in, when known. */
  repo?: string;
  turns: Turn[];
  subagents: SubagentRun[];
  diagnostics: Diagnostics;
  /** Agent's own accounting, used by `verify` only. */
  reference?: {
    /** Codex: cumulative total at the end minus the inherited baseline. */
    cumulative?: Usage;
    /** OpenCode's own token totals per session, summed over the session and its subagents. */
    opencodeTotals?: Usage;
    /** Claude Code `cost-state` record, when present. */
    claudeCostState?: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>;
  };
}

export interface ParseOptions {
  /** The last turn is known to be finished (Stop / SessionEnd hook). */
  final?: boolean;
  now?: number;
  /** Treat the last turn as finished once the file has been idle this long. */
  idleMs?: number;
}

export function emptyDiagnostics(): Diagnostics {
  return { badLines: 0, inheritedLines: 0, syntheticMessages: 0, sidechainCalls: 0, unknownRecords: {}, notes: [] };
}

export function addUsage(a: Usage | undefined, b: Usage | undefined): Usage | undefined {
  if (!a) return b && { ...b, extra: b.extra && { ...b.extra } };
  if (!b) return a;
  const extra: Record<string, number> = { ...a.extra };
  for (const [k, v] of Object.entries(b.extra ?? {})) extra[k] = (extra[k] ?? 0) + v;
  return {
    input: a.input + b.input,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    output: a.output + b.output,
    reasoning:
      a.reasoning === undefined && b.reasoning === undefined ? undefined : (a.reasoning ?? 0) + (b.reasoning ?? 0),
    extra: Object.keys(extra).length ? extra : undefined,
  };
}

export function sumCalls(calls: ModelCall[]): Usage | undefined {
  let total: Usage | undefined;
  for (const c of calls) total = addUsage(total, c.usage);
  return total;
}

export function allRuns(session: Session): Run[] {
  return [...session.turns, ...session.subagents];
}
