# Changelog

## 0.4.0

- Support OpenCode by @gricha in [be0e3e8b](https://github.com/getsentry/tattletale/commit/be0e3e8b6b79fb05427cffd92fc715bcc0635fdc)
- Codex code mode: name the tools an exec script calls by @gricha in [78192601](https://github.com/getsentry/tattletale/commit/7819260136ef8bbdc0bbeabd630e587a82d02c2f)

## 0.3.4

- Relay: don't re-send a batch Sentry may already have by @gricha in [a71cbc39](https://github.com/getsentry/tattletale/commit/a71cbc3900aa5d9891b16792dfa83894c1373b08)

## 0.3.3

- Don't re-send a batch Sentry may already have by @gricha in [aabe0bbc](https://github.com/getsentry/tattletale/commit/aabe0bbc9c20d819dc5d07d8303eb196700d194e)

## 0.3.2

- Make sending safe across processes, and retry what failed by @gricha in [086bee4c](https://github.com/getsentry/tattletale/commit/086bee4ccebb58d982c18cbc419bf44108f39019)
- Don't write spans off as sent when Sentry refuses the DSN by @gricha in [87b29022](https://github.com/getsentry/tattletale/commit/87b29022669722d0100b39a37ed91f3802866ebe)

## 0.3.1

- Hooks pick a node new enough to run tattletale by @gricha in [8b35c71e](https://github.com/getsentry/tattletale/commit/8b35c71ed9c7c8765987191373c6f7fae5755c14)
- Stream transcripts instead of loading them whole by @gricha in [75358227](https://github.com/getsentry/tattletale/commit/75358227b59ca6c7164542c81bc3e1c6905d5ed9)
- Exit only after piped stdout drains by @gricha in [812ec5d2](https://github.com/getsentry/tattletale/commit/812ec5d2d6e4fb005397a4c876dc96b114e76519)
- Setup skill: drop the pre-publish checkout fallback by @gricha in [d2923d7b](https://github.com/getsentry/tattletale/commit/d2923d7bb5f9b789905b46f4bfeaaaa191e7248b)
- Leave CHANGELOG.md to craft (exclude it from oxfmt) by @gricha in [2434bcca](https://github.com/getsentry/tattletale/commit/2434bccabdf33bc369e330940ef2bb8c744a3bca)

## 0.3.0

- Initial release: Claude Code and Codex sessions in Sentry agent tracing, from transcripts or Claude Code native OpenTelemetry.

