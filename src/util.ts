import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import * as zlib from "node:zlib";

export function hashHex(length: number, ...parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, length);
}

/** Deterministic IDs: re-sending the same transcript always yields the same trace/span IDs. */
export const traceIdFor = (...parts: string[]): string => hashHex(32, "trace", ...parts);
export const spanIdFor = (...parts: string[]): string => hashHex(16, "span", ...parts);

export interface JsonlFile {
  records: any[];
  badLines: number;
  mtimeMs: number;
}

/** Reads JSONL (optionally .zst). A half-written last line is counted as bad and skipped. */
export function readJsonl(path: string): JsonlFile {
  let buf = readFileSync(path);
  if (path.endsWith(".zst")) buf = (zlib as any).zstdDecompressSync(buf);
  const records: any[] = [];
  let badLines = 0;
  for (const line of buf.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      badLines++;
    }
  }
  return { records, badLines, mtimeMs: statSync(path).mtimeMs };
}

export function toMs(value: unknown): number | undefined {
  if (typeof value === "number") return value > 1e12 ? value : value * 1000;
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? undefined : ms;
  }
  return undefined;
}

export function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  return JSON.stringify(value) ?? "";
}

export function byteLength(value: unknown): number {
  return Buffer.byteLength(asString(value));
}

export function truncate(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const cut = Buffer.from(text).subarray(0, maxBytes).toString("utf8").replace(/�$/, "");
  return `${cut}…[truncated ${Buffer.byteLength(text) - Buffer.byteLength(cut)} bytes]`;
}

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bsntr[ysu]_[A-Za-z0-9_=+/-]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /(?<=\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)["']?\s*[:=]\s*["']?)[^\s"'`,;]{8,}/gi,
];

export function scrub(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[REDACTED]");
  return out;
}

export function countKey(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

export function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
