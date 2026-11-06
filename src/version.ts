import { readFileSync } from "node:fs";

/** From package.json (one level up from both src/ and dist/), so the bump script is the only source of truth. */
export const VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
