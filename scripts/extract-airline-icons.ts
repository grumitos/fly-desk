import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { AIRLINE_LOGO_CODES, normalizeAirlineAssetCode, readSquarePngSize } from "../src/core/airline-assets";

const SOURCE_BASE_URL = "https://static.costamar.com.pe/web/airlines";
const TARGET_DIR = join("frontend", "public", "assets", "airline-icons");

const inputCodes = process.argv.slice(2)
  .flatMap((value) => value.split(","))
  .map(normalizeAirlineAssetCode)
  .filter(Boolean);
const codes = Array.from(new Set(inputCodes.length > 0 ? inputCodes : AIRLINE_LOGO_CODES));

await mkdir(TARGET_DIR, { recursive: true });

for (const code of codes) {
  const response = await fetch(`${SOURCE_BASE_URL}/${code}_sq.png`);
  if (!response.ok) {
    console.warn(`${code}: skipped (${response.status})`);
    continue;
  }

  const contentType = response.headers.get("content-type") ?? "";
  const bytes = new Uint8Array(await response.arrayBuffer());
  const size = readSquarePngSize(bytes);
  if (!contentType.includes("image/png") || !size) {
    console.warn(`${code}: skipped (not square PNG)`);
    continue;
  }

  await Bun.write(join(TARGET_DIR, `${code}.png`), bytes);
  console.log(`${code}: ${size}x${size}`);
}
