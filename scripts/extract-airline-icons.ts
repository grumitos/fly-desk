import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { AIRLINE_LOGO_CODES, normalizeAirlineAssetCode } from "../src/core/airline-assets";

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
  const dimensions = pngDimensions(bytes);
  if (!contentType.includes("image/png") || !dimensions || dimensions.width !== dimensions.height) {
    console.warn(`${code}: skipped (not square PNG)`);
    continue;
  }

  await Bun.write(join(TARGET_DIR, `${code}.png`), bytes);
  console.log(`${code}: ${dimensions.width}x${dimensions.height}`);
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (
    bytes.length < 24
    || bytes[0] !== 0x89
    || bytes[1] !== 0x50
    || bytes[2] !== 0x4e
    || bytes[3] !== 0x47
  ) {
    return null;
  }

  return {
    width: readUint32BE(bytes, 16),
    height: readUint32BE(bytes, 20),
  };
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] * 0x1000000
    + bytes[offset + 1] * 0x10000
    + bytes[offset + 2] * 0x100
    + bytes[offset + 3]
  );
}
