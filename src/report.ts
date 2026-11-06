// The tool's own failures (a parser crashing on a new transcript format, a hook failing) go to Sentry as
// error events on the same DSN, so format drift shows up as an issue instead of a silent gap in the data.

import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, log } from "./state.ts";

const VERSION = "0.2.1";
/** Install root (repo checkout or an agent's plugin cache copy): frames under it are in-app. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..") + "/";

interface Frame {
  function?: string;
  filename?: string;
  abs_path?: string;
  lineno?: number;
  colno?: number;
  in_app: boolean;
}

/** V8 stack lines -> Sentry frames, oldest first. Line numbers match the .ts sources (node strips types in place). */
export function parseStack(stack: string | undefined): Frame[] {
  const frames: Frame[] = [];
  for (const line of (stack ?? "").split("\n").slice(1)) {
    const m = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(line);
    if (!m) continue;
    const abs = m[2]!.replace(/^file:\/\//, "");
    frames.push({
      function: m[1],
      filename: abs.startsWith(ROOT) ? abs.slice(ROOT.length) : abs,
      abs_path: abs,
      lineno: Number(m[3]),
      colno: Number(m[4]),
      in_app: abs.startsWith(ROOT),
    });
  }
  return frames.toReversed();
}

export async function reportError(
  err: unknown,
  context: Record<string, string | undefined> = {},
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  const config = loadConfig();
  if (!config.dsn || config.disabled) return undefined;
  const error = err instanceof Error ? err : new Error(String(err));
  const dsn = new URL(config.dsn);
  const projectId = dsn.pathname.replace(/^\/+|\/+$/g, "");
  const eventId = randomBytes(16).toString("hex");
  const event = {
    event_id: eventId,
    timestamp: Date.now() / 1000,
    platform: "node",
    level: "error",
    logger: "tattletale",
    release: `tattletale@${VERSION}`,
    environment: config.environment,
    user: config.user ? { username: config.user } : undefined,
    tags: Object.fromEntries(Object.entries(context).filter(([, v]) => v !== undefined)),
    contexts: { runtime: { name: "node", version: process.version } },
    exception: {
      values: [{ type: error.name, value: error.message, stacktrace: { frames: parseStack(error.stack) } }],
    },
  };
  const body = [
    JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString(), dsn: config.dsn }),
    JSON.stringify({ type: "event" }),
    JSON.stringify(event),
  ].join("\n");
  try {
    const res = await fetchImpl(`${dsn.protocol}//${dsn.host}/api/${projectId}/envelope/`, {
      method: "POST",
      headers: {
        "content-type": "application/x-sentry-envelope",
        "x-sentry-auth": `sentry sentry_version=7, sentry_key=${dsn.username}, sentry_client=tattletale/${VERSION}`,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      log(`error report rejected: ${res.status}`);
      return undefined;
    }
    return eventId;
  } catch (e) {
    log(`error report failed: ${e}`);
    return undefined;
  }
}
