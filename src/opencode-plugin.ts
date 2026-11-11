// The OpenCode side of the hooks: a plugin file OpenCode loads from its config folder. It only wakes tattletale's
// usual hook with the session's ID; tattletale reads the session itself from OpenCode's database.

import { homedir } from "node:os";
import { join } from "node:path";

export function opencodePluginPath(): string {
  const config = process.env.XDG_CONFIG_HOME || join(process.env.HOME ?? homedir(), ".config");
  return join(config, "opencode", "plugins", "tattletale.js");
}

export function opencodePluginSource(runSh: string): string {
  return `// Written by \`tattletale install\`; removed by \`tattletale uninstall\`.
// Wakes tattletale when a session starts or finishes a turn. Never blocks or fails OpenCode.
import { spawn } from "node:child_process";

const RUN = ${JSON.stringify(runSh)};
const EVENTS = { "session.created": "SessionStart", "session.idle": "Stop" };

export const Tattletale = async () => ({
  event: async ({ event }) => {
    const name = EVENTS[event?.type];
    const sessionId = event?.properties?.sessionID ?? event?.properties?.info?.id;
    if (!name || !sessionId) return;
    try {
      const child = spawn("sh", [RUN, "hook"], { detached: true, stdio: ["pipe", "ignore", "ignore"] });
      child.on("error", () => {});
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify({ hook_event_name: name, session_id: sessionId, agent: "opencode" }));
      child.unref();
    } catch {}
  },
});
`;
}
