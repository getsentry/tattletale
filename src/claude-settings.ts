// Claude Code's telemetry env vars in its user settings (settings.json "env"), pointed at the local relay.

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { relayUrl } from "./relay.ts";
import type { Config } from "./state.ts";

export function claudeSettingsPath(): string {
  return join(process.env.CLAUDE_CONFIG_DIR ?? join(process.env.HOME ?? "", ".claude"), "settings.json");
}

export function otelEnv(config: Pick<Config, "relayPort" | "content">): Record<string, string> {
  const env: Record<string, string> = {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
    OTEL_TRACES_EXPORTER: "otlp",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_ENDPOINT: relayUrl(config.relayPort),
    OTEL_BSP_SCHEDULE_DELAY: "2000",
    OTEL_LOGS_EXPORT_INTERVAL: "2000",
  };
  if (config.content === "full") {
    Object.assign(env, {
      OTEL_LOG_USER_PROMPTS: "1",
      OTEL_LOG_ASSISTANT_RESPONSES: "1",
      OTEL_LOG_TOOL_DETAILS: "1",
      OTEL_LOG_TOOL_CONTENT: "1",
    });
  }
  return env;
}

const OURS = [
  "CLAUDE_CODE_ENABLE_TELEMETRY",
  "CLAUDE_CODE_ENHANCED_TELEMETRY_BETA",
  "OTEL_TRACES_EXPORTER",
  "OTEL_LOGS_EXPORTER",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_BSP_SCHEDULE_DELAY",
  "OTEL_LOGS_EXPORT_INTERVAL",
  "OTEL_LOG_USER_PROMPTS",
  "OTEL_LOG_ASSISTANT_RESPONSES",
  "OTEL_LOG_TOOL_DETAILS",
  "OTEL_LOG_TOOL_CONTENT",
];

function read(path: string): any {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8"));
}

export interface EnvChange {
  set: string[];
  /** Keys the user already set to something else; nothing is written while any exist (unless forced). */
  conflicts: { key: string; current: string; wanted: string }[];
}

/** Plans (and with write=true applies) the env change. Existing OTel config the user set is never clobbered silently. */
export function applyOtelEnv(
  path: string,
  env: Record<string, string>,
  { write, force = false }: { write: boolean; force?: boolean },
): EnvChange {
  const settings = read(path);
  const current: Record<string, string> = settings.env ?? {};
  const conflicts = Object.entries(env)
    .filter(
      ([k, v]) =>
        current[k] !== undefined &&
        current[k] !== v &&
        !(k.startsWith("OTEL_LOG_") || k.startsWith("OTEL_BSP") || k === "OTEL_LOGS_EXPORT_INTERVAL"),
    )
    .map(([key, wanted]) => ({ key, current: current[key]!, wanted }));
  const set = Object.entries(env)
    .filter(([k, v]) => current[k] !== v)
    .map(([k]) => k);
  if (write && (!conflicts.length || force) && set.length) {
    if (existsSync(path)) copyFileSync(path, `${path}.tattletale.bak`);
    settings.env = { ...current, ...env };
    writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
  }
  return { set, conflicts };
}

/** Removes only the keys whose value is still the one tattletale would have written. */
export function removeOtelEnv(path: string, env: Record<string, string>, write: boolean): string[] {
  const settings = read(path);
  const current: Record<string, string> = settings.env ?? {};
  const removed = OURS.filter((k) => env[k] !== undefined && current[k] === env[k]);
  if (write && removed.length) {
    copyFileSync(path, `${path}.tattletale.bak`);
    for (const k of removed) delete current[k];
    settings.env = current;
    writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
  }
  return removed;
}
