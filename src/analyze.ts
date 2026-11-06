import type { Compaction, ModelCall } from "./model.ts";

/** Fills `analysis` for one thread (main session or one subagent), in call order. */
export function analyzeThread(calls: ModelCall[], compactions: Compaction[]): void {
  let prev: ModelCall | undefined;
  for (const call of calls) {
    const usage = call.usage;
    if (!usage) continue;
    // Transcript order, not timestamps: precomputed (idle) compaction summaries are stamped before the previous call ends.
    const compactedBefore =
      call.afterCompaction === true ||
      (prev !== undefined && compactions.some((c) => c.end > prev!.end && c.end <= call.start));
    const analysis: ModelCall["analysis"] = {
      uncachedInput: usage.input - usage.cacheRead,
      cacheBreak: false,
      compactedBefore: compactedBefore || undefined,
    };
    if (prev?.usage) {
      analysis.idleMs = Math.max(0, call.start - prev.end);
      analysis.contextGrowth = usage.input - (prev.usage.input + prev.usage.output);
      // A prompt cache hit should re-read at least the previous call's cached prefix.
      const drop = prev.usage.cacheRead - usage.cacheRead;
      if (!compactedBefore && drop > Math.max(1024, prev.usage.cacheRead * 0.1)) {
        analysis.cacheBreak = true;
        analysis.cacheReadDrop = drop;
      }
    }
    call.analysis = analysis;
    prev = call;
  }
}
