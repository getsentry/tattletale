import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inScope, matchesRule, repoOf } from "../src/scope.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });

test("path rules match the folder and below, never a sibling with the same prefix", () => {
  assert.ok(matchesRule("/work/terra", "/work/terra"));
  assert.ok(matchesRule("/work/terra/", "/work/terra/src"));
  assert.ok(!matchesRule("/work/terra", "/work/terraform"));
  const home = process.env.HOME;
  process.env.HOME = "/home/me";
  assert.ok(matchesRule("~/code", "/home/me/code/x"));
  process.env.HOME = home;
});

test("repo rules match by origin remote, including worktrees outside the repo folder", () => {
  const root = mkdtempSync(join(tmpdir(), "tattletale-scope-"));
  const repo = join(root, "terra");
  mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "remote", "add", "origin", "git@github.com:getsentry/terra.git");
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  const worktree = join(root, "elsewhere", "terra-wt");
  git(repo, "worktree", "add", "-q", worktree);

  assert.equal(repoOf(repo), "getsentry/terra");
  assert.equal(repoOf(worktree), "getsentry/terra");
  assert.ok(matchesRule("repo:getsentry/terra", worktree));
  assert.ok(matchesRule("repo:terra", worktree), "bare repo name matches any owner");
  assert.ok(!matchesRule("repo:getsentry/sentry", worktree));
  assert.ok(!matchesRule("repo:terra", join(root, "not-a-repo")), "unknown repo never matches a repo rule");

  assert.ok(inScope(worktree, { include: ["repo:terra"], ignore: [] }));
  assert.ok(!inScope("/somewhere/else", { include: ["repo:terra"], ignore: [] }));
  assert.ok(!inScope(worktree, { include: [], ignore: ["repo:getsentry/terra"] }), "ignore wins");
  assert.ok(inScope(undefined, { include: [], ignore: [] }), "no rules: everything");
});
