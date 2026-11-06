// Map captured Claude Code OTel (OTLP/JSON files from a receiver) to gen_ai spans; print a summary or send.
// usage: node --no-warnings scripts/otel-map-claude.ts <capture-dir> [--send <dsn>]
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mapClaudeOtel } from "../src/otel-claude.ts";
import { sentrySink } from "../src/send.ts";
import { spanAttr } from "../src/spans.ts";

const dir = process.argv[2]!;
const dsn = process.argv[process.argv.indexOf("--send") + 1];
const files = readdirSync(dir).toSorted();
const read = (kind: string) =>
  files.filter((f) => f.endsWith(`${kind}.json`)).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
const spans = mapClaudeOtel({ traces: read("traces"), logs: read("logs") });

const byName = new Map<string, number>();
for (const s of spans) byName.set(s.name.split(" ")[0]!, (byName.get(s.name.split(" ")[0]!) ?? 0) + 1);
console.log("mapped spans:", Object.fromEntries(byName));
let input = 0,
  cacheRead = 0,
  write = 0,
  output = 0,
  withIn = 0,
  withOut = 0,
  chats = 0;
for (const s of spans.filter((x) => spanAttr(x, "gen_ai.operation.name") === "chat")) {
  chats++;
  input += Number(spanAttr(s, "gen_ai.usage.input_tokens") ?? 0);
  cacheRead += Number(spanAttr(s, "gen_ai.usage.cache_read.input_tokens") ?? 0);
  write += Number(spanAttr(s, "gen_ai.usage.cache_creation.input_tokens") ?? 0);
  output += Number(spanAttr(s, "gen_ai.usage.output_tokens") ?? 0);
  if (spanAttr(s, "gen_ai.input.messages")) withIn++;
  if (spanAttr(s, "gen_ai.output.messages")) withOut++;
}
console.log(
  `chat spans ${chats}: in=${input} read=${cacheRead} write=${write} out=${output}; with input messages ${withIn}, with output messages ${withOut}`,
);
const tools = spans.filter((x) => spanAttr(x, "gen_ai.operation.name") === "execute_tool");
console.log(
  `tool spans ${tools.length}: with arguments ${tools.filter((t) => spanAttr(t, "gen_ai.tool.call.arguments")).length}, with result ${tools.filter((t) => spanAttr(t, "gen_ai.tool.call.result")).length}`,
);
console.log(
  "leaked email:",
  spans.some((s) => s.attributes.some((a) => a.key === "user.email")),
);
const first = spans.find((x) => spanAttr(x, "gen_ai.operation.name") === "chat");
console.log("first chat input:", String(spanAttr(first!, "gen_ai.input.messages")).slice(0, 160));
console.log("first chat output:", String(spanAttr(first!, "gen_ai.output.messages")).slice(0, 220));
if (dsn && process.argv.includes("--send")) console.log("send:", await sentrySink(dsn).send(spans));
