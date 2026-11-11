import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import * as zlib from "node:zlib";

export function hashHex(length: number, ...parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, length);
}

/** Deterministic IDs: re-sending the same transcript always yields the same trace/span IDs. */
export const traceIdFor = (...parts: string[]): string => hashHex(32, "trace", ...parts);
export const spanIdFor = (...parts: string[]): string => hashHex(16, "span", ...parts);

const CHUNK = 4 * 1024 * 1024;

function* splitLines(buf: Buffer): Generator<Buffer> {
  let start = 0;
  for (let nl = buf.indexOf(10); nl !== -1; nl = buf.indexOf(10, start)) {
    yield buf.subarray(start, nl);
    start = nl + 1;
  }
  if (start < buf.length) yield buf.subarray(start);
}

/** Lines as buffers, read in chunks: transcripts outgrow V8's ~512MB string limit. Decode before resuming. */
function* lineBuffers(path: string): Generator<Buffer> {
  if (path.endsWith(".zst")) {
    yield* splitLines((zlib as any).zstdDecompressSync(readFileSync(path)));
    return;
  }
  const fd = openSync(path, "r");
  try {
    const chunk = Buffer.allocUnsafe(CHUNK);
    let carry: Buffer[] = [];
    for (;;) {
      const n = readSync(fd, chunk, 0, CHUNK, null);
      if (n <= 0) break;
      let start = 0;
      for (let nl = chunk.indexOf(10); nl !== -1 && nl < n; nl = chunk.indexOf(10, start)) {
        const piece = chunk.subarray(start, nl);
        yield carry.length ? Buffer.concat([...carry, piece]) : piece;
        carry = [];
        start = nl + 1;
      }
      if (start < n) carry.push(Buffer.from(chunk.subarray(start, n)));
    }
    if (carry.length) yield Buffer.concat(carry);
  } finally {
    closeSync(fd);
  }
}

const DATA_PREFIX = /data:[\w.+-]+\/[\w.+-]+;base64,/y;
const isBase64 = (c: number) =>
  (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47;

/**
 * Replaces every JSON string that is one long base64 run (4096+ chars, optionally a data: URI), i.e. an image,
 * with "[base64 N chars]". Images are never sent, so never parsed. A loop, because V8's regex overflows the
 * stack on runs of several million characters.
 */
function stripBase64(line: string): string {
  let out = "";
  let from = 0;
  let i = line.indexOf('"');
  while (i !== -1) {
    let j = i + 1;
    DATA_PREFIX.lastIndex = j;
    if (DATA_PREFIX.test(line)) j = DATA_PREFIX.lastIndex;
    const start = j;
    while (j < line.length && isBase64(line.charCodeAt(j))) j++;
    const run = j - start;
    if (line.charCodeAt(j) === 61) j++;
    if (line.charCodeAt(j) === 61) j++;
    if (run >= 4096 && line.charCodeAt(j) === 34) {
      out += `${line.slice(from, i)}"[base64 ${j - i - 1} chars]"`;
      from = j + 1;
      i = line.indexOf('"', from);
    } else i = line.indexOf('"', i + 1);
  }
  return from ? out + line.slice(from) : line;
}

export interface JsonlStats {
  badLines: number;
}

/**
 * Streams JSONL records (optionally .zst), one line in memory at a time, with image data replaced by
 * "[base64 N chars]". A half-written last line is counted as bad and skipped.
 */
export function* jsonlRecords(path: string, stats: JsonlStats = { badLines: 0 }): Generator<any> {
  for (const buf of lineBuffers(path)) {
    let line = buf.toString("utf8");
    if (line.length > 4096) line = stripBase64(line);
    if (!line.trim()) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      stats.badLines++;
      continue;
    }
    yield rec;
  }
}

/** The first `bytes` of a file, without reading the rest. */
export function readHead(path: string, bytes: number): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(bytes);
    return buf.subarray(0, readSync(fd, buf, 0, bytes, 0)).toString("utf8");
  } finally {
    closeSync(fd);
  }
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
