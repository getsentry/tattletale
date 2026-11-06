// Which sessions get sent. Rules are folder paths ("~/code/terra": that folder and below) or git repos
// ("repo:getsentry/terra", or "repo:terra" for any owner), matched on the session's working directory so
// worktrees of a repo count wherever they live. A session whose repo can't be determined only matches paths.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { Config } from "./state.ts";

const repoCache = new Map<string, string | undefined>();

/** "owner/name" from the folder's git origin remote, if any. */
export function repoOf(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  if (repoCache.has(cwd)) return repoCache.get(cwd);
  let repo: string | undefined;
  if (existsSync(cwd)) {
    try {
      const url = execFileSync("git", ["-C", cwd, "config", "--get", "remote.origin.url"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2000,
      }).trim();
      repo = /[/:]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(url)?.[1];
    } catch {
      repo = undefined;
    }
  }
  repoCache.set(cwd, repo);
  return repo;
}

const expand = (p: string) => p.replace(/^~(?=\/|$)/, process.env.HOME ?? "~").replace(/\/+$/, "");

export function matchesRule(rule: string, cwd: string | undefined): boolean {
  if (rule.startsWith("repo:")) {
    const want = rule.slice(5).toLowerCase();
    const repo = repoOf(cwd)?.toLowerCase();
    if (!repo) return false;
    return want.includes("/") ? repo === want : repo.split("/")[1] === want;
  }
  if (!cwd) return false;
  const dir = expand(rule);
  return cwd === dir || cwd.startsWith(`${dir}/`);
}

/** Included (or no include rules) and not ignored. */
export function inScope(cwd: string | undefined, config: Pick<Config, "include" | "ignore">): boolean {
  if (config.include.length && !config.include.some((r) => matchesRule(r, cwd))) return false;
  return !config.ignore.some((r) => matchesRule(r, cwd));
}
