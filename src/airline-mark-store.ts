import { mkdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { normalizeAirlineAssetCode } from "./core/airline-assets";
import { resolvePersistPath } from "./runtime-paths";

/*
 * The marks the providers draw, kept once and served from here.
 *
 * Eight ordinary routes return 38 distinct carriers and the release ships marks
 * for 23 of them: British Airways, Vueling, Turkish, Alitalia, TAP and Emirates
 * were all drawn as their bare two letters. That gap is not a list anybody can
 * keep by hand — every new route adds carriers — and it does not have to be,
 * because the provider that serves the results also serves the artwork, at a
 * path derived from the code.
 *
 * So a code with no bundled mark is fetched once, checked, and written next to
 * the other mutable state. Everything after that is a local file. Nothing here
 * runs during a search: the harvest happens when the card asks for the image,
 * which is the moment the code is known to be worth drawing.
 */
const MARK_SOURCE_BASE_URL = "https://static.costamar.com.pe/web/airlines";
const MARK_FETCH_TIMEOUT_MS = 4_000;
/* A square mark is a few KiB. The ceiling is a guard against a CDN that starts
   answering with something else, not a size anybody should reach. */
const MARK_MAX_BYTES = 256 * 1024;
const MARK_MIN_EDGE = 16;
const MARK_MAX_EDGE = 512;
/*
 * A code the source does not have answers `403`, and it will answer `403` again
 * tomorrow. Remembering that is what keeps a cargo carrier nobody has artwork
 * for from costing a request per card, for ever.
 */
const MARK_NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000;

type FetchImpl = typeof fetch;

interface AirlineMarkStoreOptions {
  /** Overridden in tests; production resolves it from the app data directory. */
  directory?: string;
  fetchImpl?: FetchImpl;
  sourceBaseUrl?: string;
  now?: () => number;
}

const missingUntil = new Map<string, number>();
const inFlight = new Map<string, Promise<string | undefined>>();

export function airlineMarkDirectory(override?: string): string | undefined {
  if (override) {
    return override;
  }

  const path = resolvePersistPath("FLY_DESK_AIRLINE_MARK_DIR", "airline-marks");
  return path;
}

export function resetAirlineMarkStoreForTests(): void {
  missingUntil.clear();
  inFlight.clear();
}

/**
 * The local file for a harvested mark, fetching it once if this is the first
 * time the code has been asked for. `undefined` when there is no artwork to be
 * had — the card falls back to the two letters, which is a supported state.
 */
export function ensureAirlineMark(
  code: unknown,
  options: AirlineMarkStoreOptions = {},
): Promise<string | undefined> {
  const normalized = normalizeAirlineAssetCode(code);
  const directory = airlineMarkDirectory(options.directory);
  if (!normalized || !directory) {
    return Promise.resolve(undefined);
  }

  const now = options.now ?? Date.now;
  const filePath = join(directory, `${normalized}.png`);

  /* One fetch per code even when a list of cards asks at once: the promise is
     shared, not the request repeated. */
  const pending = inFlight.get(normalized);
  if (pending) {
    return pending;
  }

  const run = (async () => {
    if (await Bun.file(filePath).exists()) {
      return filePath;
    }

    const blockedUntil = missingUntil.get(normalized);
    if (typeof blockedUntil === "number" && blockedUntil > now()) {
      return undefined;
    }

    const harvested = await harvestAirlineMark(normalized, filePath, directory, options);
    if (!harvested) {
      missingUntil.set(normalized, now() + MARK_NEGATIVE_TTL_MS);
    }
    return harvested;
  })().finally(() => {
    inFlight.delete(normalized);
  });

  inFlight.set(normalized, run);
  return run;
}

async function harvestAirlineMark(
  code: string,
  filePath: string,
  directory: string,
  options: AirlineMarkStoreOptions,
): Promise<string | undefined> {
  const base = options.sourceBaseUrl ?? MARK_SOURCE_BASE_URL;
  const fetchImpl = options.fetchImpl ?? fetch;

  let bytes: Uint8Array;
  try {
    const response = await fetchImpl(`${base}/${code}_sq.png`, {
      signal: AbortSignal.timeout(MARK_FETCH_TIMEOUT_MS),
      redirect: "error",
    });
    if (!response.ok || !(response.headers.get("content-type") ?? "").includes("image/png")) {
      return undefined;
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength === 0 || buffer.byteLength > MARK_MAX_BYTES) {
      return undefined;
    }
    bytes = new Uint8Array(buffer);
  } catch {
    /* A source that is unreachable is the same as a source with nothing: the
       card draws the code and the next call tries again after the window. */
    return undefined;
  }

  /* Checked, not trusted. What arrives here is served from this origin
     afterwards, so it has to be a square PNG and nothing else — the same bar
     `scripts/extract-airline-icons.ts` applies to a mark entering the repo. */
  const size = await readSquarePngSize(bytes);
  if (!size || size < MARK_MIN_EDGE || size > MARK_MAX_EDGE) {
    return undefined;
  }

  try {
    await mkdir(directory, { recursive: true });
    /* Written aside and renamed, so a reader never opens a half-written mark
       and two harvests of the same code cannot interleave into one file. */
    const staging = `${filePath}.${process.pid}.${Math.trunc(performance.now())}.part`;
    await Bun.write(staging, bytes);
    try {
      await rename(staging, filePath);
    } catch (error) {
      await unlink(staging).catch(() => undefined);
      throw error;
    }
    return filePath;
  } catch {
    return undefined;
  }
}

/**
 * The edge of a square PNG, or `undefined` for anything else.
 *
 * The one check that decides whether bytes off a provider CDN may be written
 * next to the marks that shipped with the release and served from this origin
 * afterwards. Shared with `scripts/extract-airline-icons.ts` so a mark entering
 * the repository and a mark entering the cache clear the same bar.
 *
 * It used to read the signature and the two IHDR numbers by hand, which
 * answered for the header and nothing else: bytes that announced 70x70 and then
 * stopped — a truncated response, a CDN error page with a PNG magic number, a
 * corrupt body — passed, were written, and left the card drawing a broken image
 * instead of the two letters it is supposed to fall back to. `Bun.Image`
 * reads the same header and stops in the same place (`metadata()` is documented
 * as decoding just enough for width, height and format), so the decode below is
 * the part that is new. It is what proves there are pixels behind the header.
 *
 * The decode costs about a millisecond and is paid once per carrier, ever —
 * afterwards the mark is a local file. It runs on a worker thread, so it is not
 * a millisecond of the request either.
 *
 * This lives here rather than in `core/`, where it sat next to the code the
 * browser bundle imports. `Bun.Image` has no meaning in a browser, and both
 * callers are server-side.
 */
export async function readSquarePngSize(bytes: Uint8Array): Promise<number | undefined> {
  try {
    const image = new Bun.Image(bytes);
    const { width, height, format } = await image.metadata();
    if (format !== "png" || width <= 0 || width !== height) {
      return undefined;
    }

    await image.bytes();
    return width;
  } catch {
    /* `Bun.Image` throws both for bytes that are no image at all and for an
       image whose body will not decode. Here those are the same answer. */
    return undefined;
  }
}
