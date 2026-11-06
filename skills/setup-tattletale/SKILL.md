---
name: setup-tattletale
description: Set up, scope, verify or remove tattletale, which sends Claude Code and Codex sessions to Sentry agent tracing. Use when the user asks to set up, install, configure, scope, check or uninstall tattletale, or to send their coding-agent sessions to Sentry.
---

# Set up tattletale

tattletale sends the user's Claude Code and Codex sessions to a Sentry project as agent traces: one
conversation per session, model calls with exact token usage, tool calls, and subagents. Everything below runs
on the user's machine.

**The only thing it needs is the DSN of the Sentry project the data goes to.** Everything else has a default.

## 1. Get the DSN

Use, in order:

1. A DSN the user gave you (`https://<key>@o<org>.ingest.<region>.sentry.io/<project>`).
2. The Sentry MCP, if it is connected and the user named an org or project. `find_dsns` returns an existing
   project's DSN; `create_project` creates one (suggest `coding-agents`) and returns its DSN.
3. Ask for it. It's under Sentry → Project Settings → Client Keys (DSN).

## 2. Decide the scope

By default every session is sent. Ask once which sessions should go, unless the user already said. The choice
decides what leaves their machine (prompts, code and tool output, scrubbed of common secret patterns).

| The user wants                      | Flags                                                      |
| ----------------------------------- | ---------------------------------------------------------- |
| Everything                          | (none)                                                     |
| One repo, in any folder or worktree | `--repo getsentry/terra` (or `--repo terra` for any owner) |
| One folder and everything below it  | `--include ~/code/terra`                                   |
| Several                             | repeat `--include` / `--repo`                              |
| Everything except something         | `--ignore ~/personal` or `--ignore repo:<owner/name>`      |
| Counts and timings only, no text    | `--content metadata`                                       |

## 3. Install

Use the published package. Until it is published, run the same commands from a checkout instead:
`git clone git@github.com:getsentry/tattletale.git ~/code/tattletale`, then `node ~/code/tattletale/src/cli.ts`
in place of `npx @sentry/tattletale`.

```bash
npx @sentry/tattletale setup --dsn '<DSN>' [scope flags from step 2]
npx @sentry/tattletale install
```

`install` adds a plugin with lightweight hooks to Claude Code and Codex. It shells out to
`claude plugin …` and `codex plugin …` for whichever of the two is installed. Hooks never block the agent.
Tell the user that Codex asks them, once, to approve the new hooks under `/hooks`. You can't approve them for
them. Until then, Codex sessions are still sent, in batches whenever a Claude Code session starts.

Optional, for Claude Code only: `npx @sentry/tattletale install --otel`. This switches Claude Code to its own
OpenTelemetry through a local relay. It adds request timing and model calls that never reach the transcript.
It writes telemetry variables into `~/.claude/settings.json`, and refuses if the user already configured
OpenTelemetry differently. Mention that it applies to sessions started afterwards.

## 4. Verify

```bash
npx @sentry/tattletale status            # DSN, scope, what was sent, relay, recent log
npx @sentry/tattletale verify --days 1   # local token reconciliation; sends nothing
npx @sentry/tattletale test-error        # optional: proves the DSN accepts events
```

Data appears in Sentry under Explore → Conversations, usually within a few minutes. To send past sessions,
always look before sending:

```bash
npx @sentry/tattletale backfill --days 7 --dry-run   # shows sessions and span counts
npx @sentry/tattletale backfill --days 7
```

Re-running any of these is safe. Every span is sent at most once.

## Change or remove

- Change the scope or DSN: run `setup` again with new flags. `--everything` clears the scope.
- Pause: `TATTLETALE_DISABLED=1` in the environment, or `"disabled": true` in `~/.tattletale/config.json`.
- Remove: `npx @sentry/tattletale uninstall --otel` (if OTel was installed), then `npx @sentry/tattletale uninstall`.

## Troubleshooting

- The log is `~/.tattletale/tattletale.log`. Lines show `sync <agent> <session>: built=… sent=…` and why a
  session was skipped: `ignored path` (outside the scope) or `waiting for OTel relay` (it resolves by itself
  within about 10 minutes).
- tattletale's own errors go to the same Sentry project as issues.
- "no DSN configured": `setup --dsn` was not run, or ran with a different `TATTLETALE_HOME`.
