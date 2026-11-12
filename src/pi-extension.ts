// The Pi side of the hooks: an extension file Pi auto-discovers in its extensions folder. It only wakes tattletale's
// usual hook with the session file; tattletale reads the session itself.

import { join } from "node:path";
import { piAgentDir } from "./pi.ts";

export const piExtensionPath = (): string => join(piAgentDir(), "extensions", "tattletale.ts");

export function piExtensionSource(runSh: string): string {
  return `// Written by \`tattletale install\`; removed by \`tattletale uninstall\`.
// Wakes tattletale when a session starts, finishes a run or ends. Never blocks or fails Pi.
import { spawn } from "node:child_process";

const RUN = ${JSON.stringify(runSh)};

function wake(name, ctx) {
  try {
    const file = ctx?.sessionManager?.getSessionFile?.();
    if (!file) return;
    const child = spawn("sh", [RUN, "hook"], { detached: true, stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", () => {});
    child.stdin.on("error", () => {});
    child.stdin.end(
      JSON.stringify({
        hook_event_name: name,
        session_id: ctx.sessionManager.getSessionId?.(),
        transcript_path: file,
        agent: "pi",
      }),
    );
    child.unref();
  } catch {}
}

export default function tattletale(pi) {
  const events = { session_start: "SessionStart", agent_settled: "Stop", session_shutdown: "SessionEnd" };
  for (const [event, name] of Object.entries(events)) {
    try {
      pi.on(event, (_event, ctx) => wake(name, ctx));
    } catch {}
  }
}
`;
}
