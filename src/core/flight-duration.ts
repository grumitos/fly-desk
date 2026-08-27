import { timeZoneForIataCode } from "./airport-time-zones";

/*
 * How long a flight and a journey actually take.
 *
 * Everything here exists because a provider's timestamps are wall clocks, not
 * instants — see `airport-time-zones.ts`. Three rules follow from that, and
 * every duration in the product is one of them:
 *
 *  - Between two *different* airports, only the clock catalogue can answer.
 *    Subtracting the digits measures the calendar, not the flight.
 *  - Between an arrival and the next departure at the *same* airport the digits
 *    are enough: one clock, so whatever it is, it cancels. That is a layover,
 *    and it is why the layover figures were right all along.
 *  - A provider's own elapsed time is a fact worth keeping when we have it, but
 *    it is carried in fields that cannot hold a day — Agil sends `HHMM`, so
 *    26h50m reaches us as `0250` and a Lima-Madrid connection reads as under
 *    three hours. A figure that only has to be right under 24h is not a figure
 *    to prefer over a clock that is right always.
 *
 * So: the catalogue first, the provider second, the digits last — and the last
 * one only because a code outside the catalogue has to say *something*.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/;

/**
 * The digits a traveller reads, with any offset the provider stamped on them
 * deliberately ignored: Click and Book writes `-0500` on Madrid, and believing
 * it is the whole bug.
 */
function wallClockMs(value?: string): number | undefined {
  const match = WALL_CLOCK.exec(String(value ?? "").trim());
  if (!match) {
    return undefined;
  }

  return Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
  );
}

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();
const zoneOffsets = new Map<string, number>();

function formatterFor(timeZone: string): Intl.DateTimeFormat | undefined {
  const cached = zoneFormatters.get(timeZone);
  if (cached) {
    return cached;
  }

  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    zoneFormatters.set(timeZone, formatter);
    return formatter;
  } catch {
    /* A zone the runtime does not know answers nothing rather than wrongly. */
    return undefined;
  }
}

/** Minutes the zone runs ahead of UTC at that instant, daylight saving included. */
function offsetMinutesAt(timeZone: string, instantMs: number): number | undefined {
  const key = `${timeZone}|${Math.floor(instantMs / HOUR_MS)}`;
  const cached = zoneOffsets.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const formatter = formatterFor(timeZone);
  if (!formatter) {
    return undefined;
  }

  const parts = formatter.formatToParts(new Date(instantMs));
  const field = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    return part ? Number(part.value) : Number.NaN;
  };

  const local = Date.UTC(
    field("year"),
    field("month") - 1,
    field("day"),
    field("hour"),
    field("minute"),
  );
  if (!Number.isFinite(local)) {
    return undefined;
  }

  const offset = Math.round((local - instantMs) / MINUTE_MS);
  zoneOffsets.set(key, offset);
  return offset;
}

/**
 * The instant a wall clock names in its own zone.
 *
 * Read twice: the first offset is the one in force at the *guessed* instant,
 * which is the wrong one for a clock read within an hour of a daylight-saving
 * step. The second read is taken at the corrected instant and settles it.
 */
function instantOf(value: string | undefined, timeZone: string): number | undefined {
  const wall = wallClockMs(value);
  if (wall === undefined) {
    return undefined;
  }

  const first = offsetMinutesAt(timeZone, wall);
  if (first === undefined) {
    return undefined;
  }

  const candidate = wall - (first * MINUTE_MS);
  const second = offsetMinutesAt(timeZone, candidate);
  if (second === undefined || second === first) {
    return candidate;
  }

  return wall - (second * MINUTE_MS);
}

/**
 * Minutes between two wall clocks read at two catalogued airports, or
 * `undefined` when either code is outside the catalogue.
 */
export function zonedMinutesBetween(
  fromCode: string | undefined,
  fromAt: string | undefined,
  toCode: string | undefined,
  toAt: string | undefined,
): number | undefined {
  const fromZone = timeZoneForIataCode(fromCode);
  const toZone = timeZoneForIataCode(toCode);
  if (!fromZone || !toZone) {
    return undefined;
  }

  const from = instantOf(fromAt, fromZone);
  const to = instantOf(toAt, toZone);
  if (from === undefined || to === undefined) {
    return undefined;
  }

  const minutes = Math.round((to - from) / MINUTE_MS);
  return minutes > 0 ? minutes : undefined;
}

/** The plain difference of the digits: right at one airport, nowhere else. */
export function wallClockMinutesBetween(
  fromAt: string | undefined,
  toAt: string | undefined,
): number | undefined {
  const from = wallClockMs(fromAt);
  const to = wallClockMs(toAt);
  if (from === undefined || to === undefined) {
    return undefined;
  }

  const minutes = Math.round((to - from) / MINUTE_MS);
  return minutes > 0 ? minutes : undefined;
}

export interface SegmentTiming {
  origin?: string;
  destination?: string;
  departureAt?: string;
  arrivalAt?: string;
  durationMinutes?: number;
}

/**
 * One flight's elapsed time. The clock catalogue answers first; a provider's
 * own figure stands in for the codes it does not carry; the digits are the
 * last resort and the only answer that can be wrong by a whole time zone.
 */
export function resolveSegmentDurationMinutes(
  segment: SegmentTiming,
  providerMinutes?: number,
): number {
  const zoned = zonedMinutesBetween(
    segment.origin,
    segment.departureAt,
    segment.destination,
    segment.arrivalAt,
  );
  if (zoned !== undefined) {
    return zoned;
  }

  if (typeof providerMinutes === "number" && Number.isFinite(providerMinutes) && providerMinutes > 0) {
    return Math.trunc(providerMinutes);
  }

  return wallClockMinutesBetween(segment.departureAt, segment.arrivalAt) ?? 0;
}

/**
 * A whole leg, gate to gate. The catalogue answers straight from the first
 * departure to the last arrival when it can; otherwise the leg is the flights
 * plus the connections, which is the same sum written the long way and needs no
 * clock — every layover is one airport, and the segments already resolved.
 */
export function resolveItineraryDurationMinutes(
  segments: SegmentTiming[],
  layoverMinutes: number[],
  providerMinutes?: number,
): number {
  const first = segments[0];
  const last = segments[segments.length - 1];

  const zoned = zonedMinutesBetween(
    first?.origin,
    first?.departureAt,
    last?.destination,
    last?.arrivalAt,
  );
  if (zoned !== undefined) {
    return zoned;
  }

  const flown = segments.reduce(
    (total, segment) => total + (Number(segment.durationMinutes) || 0),
    0,
  );
  if (flown > 0 && segments.every((segment) => Number(segment.durationMinutes) > 0)) {
    const connected = layoverMinutes.reduce(
      (total, minutes) => total + (Number(minutes) || 0),
      0,
    );
    return flown + connected;
  }

  if (typeof providerMinutes === "number" && Number.isFinite(providerMinutes) && providerMinutes > 0) {
    return Math.trunc(providerMinutes);
  }

  return wallClockMinutesBetween(first?.departureAt, last?.arrivalAt) ?? 0;
}
