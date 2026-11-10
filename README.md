# tattletale

Tattles on your coding agents. tattletale sends your Claude Code and Codex sessions to a Sentry project as
agent traces:

- one conversation per session;
- a span per model call, with exact input, cache and output tokens;
- tool calls, with arguments, results and sizes;
- subagents nested under the tool call that launched them;
- compactions.

Then you, or an agent, can find where tokens go in Sentry's Explore → Conversations and span queries.

**All it needs is the DSN of the Sentry project to send to.** It runs on Node 22.18 or later and has no
runtime dependencies.

> Private and experimental for now. It will be published as `@sentry/tattletale`. Until then, clone the repo and
> use `node ~/code/tattletale/src/cli.ts` wherever this page says `npx @sentry/tattletale`.

## Quick start

```bash
npx @sentry/tattletale setup --dsn '<SENTRY_DSN>'   # optionally scope it, see below
npx @sentry/tattletale install                     # hook into Claude Code and Codex
npx @sentry/tattletale status
```

Codex asks you, once, to approve the new hooks under `/hooks`. New sessions show up in Sentry within minutes.

### Or let your agent do it

The plugin ships a setup skill ([skills/setup-tattletale/SKILL.md](skills/setup-tattletale/SKILL.md)). Tell
Claude Code or Codex: _"set up tattletale, send to <DSN or Sentry project>, only for the terra repo"_. The skill
covers getting a DSN (including through the Sentry MCP), choosing the scope, installing and verifying.

## Choose which sessions are sent

By default every session is sent. Narrow it with `setup`; matching uses each session's working directory.

| You want                                       | Run                                    |
| ---------------------------------------------- | -------------------------------------- |
| Only the terra repo, in any folder or worktree | `setup --dsn … --repo getsentry/terra` |
| Only sessions under a folder                   | `setup --dsn … --include ~/code/terra` |
| A few repos or folders                         | repeat `--repo` / `--include`          |
| Everything except personal stuff               | `setup --dsn … --ignore ~/personal`    |
| Only counts and timings, no prompts or code    | add `--content metadata`               |
| Back to everything                             | `setup --everything`                   |

Rules:

- **Folder rules** match that folder and everything below it; `~/code/terra` does not match `~/code/terraform`.
- **Repo rules** (`--repo` or `--include repo:owner/name`) match on the folder's git `origin` remote, so
  worktrees anywhere count. `--repo terra` matches any owner.
- **Ignore rules** always win.

Spans carry `vcs.repository.name`, so you can also slice by repo in Sentry.

## Replay past sessions

New sessions are sent automatically. To send older ones, use `replay` (alias `backfill`). Do a dry run first:

```bash
npx @sentry/tattletale verify --days 7                        # local token reconciliation, sends nothing
npx @sentry/tattletale replay --days 7 --dry-run              # what would be sent from the last week
npx @sentry/tattletale replay --since 2026-10-01 --until 2026-10-15
npx @sentry/tattletale replay --session 4d64aace              # one session (ID or prefix)
npx @sentry/tattletale replay ~/Downloads/old-transcripts     # files or folders, e.g. from another machine
```

- **Never doubles.** Spans already in Sentry are skipped, so replaying the same range twice sends nothing new.
- **Your scope still applies.** Sessions outside your folder and repo rules are skipped.
- **Oldest first.** Sessions are replayed in age order, so an original session claims history that a later
  fork copied.
- **Files and folders count as finished.** Explicit files or folders are treated as complete sessions. Folders
  are searched for `*.jsonl` and `*.jsonl.zst`, with Codex archives included.

**Limits:**

- **Sentry retention.** Sentry drops spans older than the project's retention at ingest.
- **Claude Code cleanup.** Claude Code deletes transcripts after 30 days by default. Set `cleanupPeriodDays`
  higher in `~/.claude/settings.json` to keep more history replayable.

`npx @sentry/tattletale --help` lists every command.

## Development

```bash
pnpm install
pnpm check   # tsc (strict) + oxlint + oxfmt --check + tests
pnpm build   # dist/ (what npm ships; Node won't strip types under node_modules)
```

Releases go through craft. See [RELEASING.md](RELEASING.md).

## How it works

```
agent hook (SessionStart / Stop / SubagentStop / SessionEnd, async)
  └─ hooks/run.sh → cli.ts hook    queue a job, spawn a detached worker, exit 0 (never blocks the agent)
       worker: parse whole transcript → build spans with deterministic IDs → take the send lock
               → drop IDs already in ~/.tattletale/sent.log → send new ones (OTLP/HTTP JSON) → append to ledger
```

The queue is only a wake-up signal: the transcripts and the ledger are the state, so a lost job loses
nothing. On a hook, at most every 5 minutes, the worker also sweeps:

- recently modified transcripts that aren't settled yet, which catches sessions whose hooks never fired;
- any transcript with spans still unsent, however old, which retries sends that failed.

A transcript that crashes tattletale is reported as an error and left alone until it changes or tattletale is
upgraded.

Only one process sends at a time on a machine (hook workers, `replay`, `sync`). Each re-reads the ledger
under that lock, so two of them never send the same span.

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

| Guarantee                                | Mechanism                                                                                                                                                                                                                                                                                           | Check                                                                                                          |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Each API response counted once           | Claude: dedup by `message.id` (one response spans several lines). Codex: `token_usage_record` per response, else deltas of the cumulative `token_count` (repeats ignored)                                                                                                                           | `verify`: parser vs a naive count over the raw files, on every local session                                   |
| Resumed/forked history not re-sent       | Claude copies keep the parent's `sessionId` and are skipped. Fork subagents' copies are claimed by the first file. Codex: everything before the first own `task_started` is inherited                                                                                                               | tests; `verify` session-wide union check                                                                       |
| Copies with rewritten IDs not re-sent    | Span IDs come only from globally unique call/tool/prompt IDs, so the ledger dedups across sessions                                                                                                                                                                                                  | test `rewritten copy`                                                                                          |
| Tokens match Sentry's convention         | `input` includes cache reads and writes (Anthropic's doesn't). Claude cache writes split 5m/1h. Claude thinking tokens and Codex reasoning tokens reported separately                                                                                                                               | `verify`: chat-span sums = parser; E2E: Sentry aggregates = transcript = Claude's own cost-state, to the token |
| Never double sent after a crash          | The batch in flight is written to `pending/`; on recovery its IDs are marked unverified and never re-sent (at-most-once)                                                                                                                                                                            | test `crash between send and ledger write`                                                                     |
| Never double sent after a lost answer    | A request that may have reached Sentry (timeout, connection dropped after the upload) is treated like a crash: its spans are marked unverified and never re-sent, because Sentry only folds a repeated span into the first for seconds. One that can't have left (offline, DNS, refused) is retried | test `real sockets`                                                                                            |
| Never double sent by two processes       | One send lock per machine; the ledger is re-read under it, so a `replay` next to the hook worker can't re-send what the other sent                                                                                                                                                                  | test `two processes`                                                                                           |
| Failures don't lose data or loop forever | A failed send (network, outage, rate limit, refused DSN) leaves the ledger untouched and the session unsettled; the sweep retries it on a later hook, however old it is by then. Only a payload Sentry rejects (400, 413, 422) is bisected, and the one bad span skipped                            | tests                                                                                                          |

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
- A batch whose send got no answer, or was in flight during a crash, is never re-sent. If it had not arrived,
  those spans (up to 200) are missing. `status` counts them as unverified.
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
