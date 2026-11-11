# Releasing

`@sentry/tattletale` is published to npm by [craft](https://github.com/getsentry/craft), the same way as
dotagents and warden.

1. Run the **Release** workflow from the Actions tab. Pick a version: `auto` (from commit messages), `patch`,
   `minor`, `major`, or an exact semver.
2. craft runs `node scripts/bump-version.mjs <old> <new>`. That updates `package.json` and
   `.claude-plugin/plugin.json` together, because `claude plugin update` only picks up a release when the plugin
   version changes. craft then opens the release in getsentry/publish.
3. **CI** on the release branch builds the package (`prepack` → `pnpm build` → `dist/`) and packs it. It runs
   `scripts/verify-pack.mjs`, which:
   - checks the file list and that the versions agree;
   - installs the tarball into a sandbox the way npm users get it;
   - drives the installed CLI.

   It then uploads the tarball as the `npm-package` artifact.

4. Approve the publish request by labelling the getsentry/publish issue `accepted`. That can happen right away:
   the publisher waits for the release branch's CI. craft then publishes the tarball to npm with public access,
   creates the GitHub release and merges the release branch back to main.

The repo is private while this is experimental. **Publishing makes the package, and therefore its compiled
source, public on npm.** The release workflow needs the org's `SENTRY_RELEASE_BOT_CLIENT_ID` variable and
`SENTRY_RELEASE_BOT_PRIVATE_KEY` secret to be available to this repo.

## By hand

```bash
node scripts/bump-version.mjs 0.3.0          # never edit versions by hand
pnpm pack && node scripts/verify-pack.mjs .  # what CI checks before publishing
```

## Local installs (this machine)

The plugins are installed from the GitHub repo:
`claude plugin marketplace add getsentry/tattletale` and `codex plugin marketplace add getsentry/tattletale`.

After a release has merged back to main, update both:

```bash
claude plugin marketplace update tattletale && claude plugin update tattletale@tattletale
codex plugin marketplace upgrade tattletale && codex plugin add tattletale@tattletale
```
