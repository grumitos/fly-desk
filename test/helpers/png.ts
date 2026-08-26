/*
 * The two kinds of PNG the mark guard has to tell apart.
 *
 * `src/airline-mark-store.ts` decides whether bytes off a provider CDN may be
 * written next to the marks that ship with the release. It used to read the
 * signature and the IHDR by hand, so a header was all a fixture needed to pass
 * — and all an error page or a truncated download needed either. It decodes
 * now, which means the fixtures have to be real images and the old ones are
 * worth keeping as the thing that must be turned away.
 *
 * Both live here because two suites need them: `airline-mark-store` for the
 * guard itself and `server.integration` for the route that harvests through it.
 */

/* A real 1x1 PNG, 70 bytes of it, so a fixture of any size can be minted
   without a binary asset living in the repository. */
const SEED_PNG_BASE64
  = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** A PNG that really decodes, at the size asked for. */
export async function realPng(width: number, height = width): Promise<Uint8Array> {
  const seed = new Uint8Array(Buffer.from(SEED_PNG_BASE64, "base64"));
  return new Bun.Image(seed).resize(width, height).png().bytes();
}

/**
 * Eight signature bytes and an IHDR announcing a square, with nothing behind
 * them.
 *
 * A mark whose header promises pixels its body never delivers. This is what the
 * fixtures used to be made of, and what used to reach the directory this origin
 * serves and leave the card drawing a broken image.
 */
export function headerOnlyPng(size: number): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const writeUint32BE = (offset: number, value: number) => {
    bytes[offset] = (value >>> 24) & 0xff;
    bytes[offset + 1] = (value >>> 16) & 0xff;
    bytes[offset + 2] = (value >>> 8) & 0xff;
    bytes[offset + 3] = value & 0xff;
  };
  writeUint32BE(16, size);
  writeUint32BE(20, size);
  return bytes;
}
