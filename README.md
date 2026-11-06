# tattletale

Tattles on your coding agents. It ships Claude Code and Codex sessions to Sentry agent tracing as
`gen_ai` spans:

- one conversation per session and one trace per turn;
- a `chat` span per model call, with exact token usage;
- `execute_tool` spans;
- subagents nested under the tool call that launched them.

The goal is data an agent can mine for token savings.

It has no runtime dependencies and needs Node 22.18 or later, which runs the TypeScript directly.

> Private, experimental. Will be published as `@sentry/tattletale`.

## Install (local)

```bash
git clone git@github.com:getsentry/tattletale.git ~/code/tattletale
cd ~/code/tattletale
node src/cli.ts setup --dsn <your DSN> [--include ~/code] [--content metadata]
node src/cli.ts install          # Claude Code + Codex plugins (hooks)
node src/cli.ts install --otel   # optional: Claude Code via native OpenTelemetry
node src/cli.ts status
```

Codex asks you to approve the new hooks once, under `/hooks`. To check the data without sending anything:

```bash
node src/cli.ts verify --days 30
node src/cli.ts backfill --days 7 --dry-run
```

## Development

```bash
pnpm install
pnpm check   # tsc (strict) + oxlint + oxfmt --check + tests
```

## How it works

```
agent hook (SessionStart / Stop / SubagentStop / SessionEnd, async)
  └─ hooks/run.sh → cli.ts hook    queue a job, spawn a detached worker, exit 0 (never blocks the agent)
       worker: lock session → parse whole transcript → build spans with deterministic IDs
               → drop IDs already in ~/.tattletale/sent.log → send new ones (OTLP/HTTP JSON) → append to ledger
```

`SessionStart` also sweeps recently modified transcripts that aren't settled yet, catching sessions whose
hooks never fired.

The tool's own failures (a parser crashing on a new transcript format, a hook failing) are sent to the
same DSN as Sentry error events. Format drift shows up as an issue instead of a silent gap in the data.
`tattletale test-error` sends one through the same path.

- A model call is sent once it's known to be complete, tool calls once they have a result, and the turn
  root once the turn ends. Long sessions grow over many traces in a single conversation.
- Each `chat` span carries only that call's new input messages, never the full history.
- Turn totals use `agent.turn.*`, not `gen_ai.usage.*`, so summing `gen_ai.usage.*` never double counts.

## Claude Code via native OpenTelemetry (optional)

`install --otel` switches Claude Code from transcripts to its own OpenTelemetry export. Codex always uses
transcripts, because its OTel is mostly internal tracing. The command:

1. Writes Claude Code's telemetry variables into `~/.claude/settings.json` under `env`: enhanced traces on,
   logs on, OTLP/HTTP JSON, endpoint `http://127.0.0.1:43181`, and content flags when `content` is `full`.
   It refuses if you already set OTel differently, unless you pass `--force`, and keeps a
   `settings.json.tattletale.bak` backup.
2. Starts the relay. After that, the `SessionStart` hook starts it whenever it isn't running.

The relay (`src/relay.ts`):

- Holds each trace until it has gone quiet.
- Rewrites it to Sentry's `gen_ai` conventions together with Claude Code's log events (`src/otel-claude.ts`):
  - usage is renamed, and input includes cache;
  - messages are rebuilt from the `user_prompt`, `assistant_response` and `tool_result` events;
  - tool output comes from `tool.output` span events;
  - subagents move into the session's conversation;
  - personal fields are dropped.
- Applies `include` and `ignore` using the session's working directory, read from its local transcript.
- Forwards to the DSN.

Compared with transcripts, it adds model calls that never reach the transcript (for example, the
`agent_classifier` side calls), time to first token and real request timing.

**One source per session.** Sentry's conversation view doesn't deduplicate, so a session must never be sent
twice:

- Once the relay has seen a session, transcript sync sends only turns that started more than 2 minutes before
  the relay's first span.
- A session touched since the switch that the relay never saw waits, then falls back to its transcript after
  30 idle minutes.

`uninstall --otel` removes only the variables it wrote and switches back to transcripts.

## Guarantees and how they're checked

| Guarantee                                | Mechanism                                                                                                                                                                             | Check                                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Each API response counted once           | Claude: dedup by `message.id` (one response spans several lines). Codex: `token_usage_record` per response, else deltas of the cumulative `token_count` (repeats ignored)             | `verify`: parser vs a naive count over the raw files, on every local session                                   |
| Resumed/forked history not re-sent       | Claude copies keep the parent's `sessionId` and are skipped. Fork subagents' copies are claimed by the first file. Codex: everything before the first own `task_started` is inherited | tests; `verify` session-wide union check                                                                       |
| Copies with rewritten IDs not re-sent    | Span IDs come only from globally unique call/tool/prompt IDs, so the ledger dedups across sessions                                                                                    | test `rewritten copy`                                                                                          |
| Tokens match Sentry's convention         | `input` includes cache reads and writes (Anthropic's doesn't). Claude cache writes split 5m/1h. Claude thinking tokens and Codex reasoning tokens reported separately                 | `verify`: chat-span sums = parser; E2E: Sentry aggregates = transcript = Claude's own cost-state, to the token |
| Never double sent after a crash          | The batch in flight is written to `pending/`; on recovery its IDs are marked unverified and never re-sent (at-most-once)                                                              | test `crash between send and ledger write`                                                                     |
| Failures don't lose data or loop forever | Retryable errors leave the ledger untouched. A span Sentry permanently rejects is isolated by bisecting and skipped                                                                   | tests                                                                                                          |

Results on this machine: `verify` passes on all 1,124 local sessions (Claude and Codex, Apr–Nov 2026).
The E2E run against Sentry matched to the token.

## Token-analysis attributes

- `chat` spans:
  - `agent.call.context_growth_tokens`: tokens added since the previous call
  - `agent.call.uncached_input_tokens`
  - `agent.call.cache_break`, `agent.call.cache_read_drop_tokens`
  - `agent.call.idle_seconds`: gaps longer than the cache TTL show up here
  - `agent.call.hidden`: usage with no persisted output, e.g. Codex background checks
  - `agent.usage.cache_write_5m` / `agent.usage.cache_write_1h`
- `execute_tool` spans:
  - `agent.tool.result_bytes`, `agent.tool.result_tokens_est`
  - `agent.tool.file_path`, `agent.tool.command`, `agent.tool.mcp_server`
- Turn and subagent roots: `agent.turn.*` / `agent.subagent.*` totals. Compactions get `compact` spans
  with pre- and post-compaction token counts.

## Known gaps

- Agents: only Claude Code and Codex. Cursor transcripts have no tokens or timestamps, so it would need
  hook payloads. OpenCode and Copilot aren't done.
- Model calls an agent makes without writing them to the transcript (titles, safety checks) are invisible.
  `verify` reports the gap against Claude's `cost-state` record when one exists.
- Sentry's computed cost has a single cache-write price. Claude's 1h cache writes cost more, so Sentry
  undercounts. The 5m/1h split is sent for your own math.
- Sentry's timeline shows `tool`-role messages as user messages.
- Sentry's conversation view looks up a conversation across the whole org. If the same session is
  sent to two projects in one org, the view merges both copies and doubles every count. Send a
  session to one project only.
- Claude Code stores thinking without its text, and Codex keeps reasoning encrypted, so reasoning
  shows up only as token counts.
- Every sync re-parses the whole transcript. That's fine locally (a 2,000-call session takes about a
  second); a byte-offset checkpoint would remove it.
- Secret scrubbing is a regex pass. `--content metadata` drops all message content.
