import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  resolveItineraryDurationMinutes,
  resolveSegmentDurationMinutes,
  wallClockMinutesBetween,
  zonedMinutesBetween,
} from "../src/core/flight-duration";
import { IATA_LOCATION_CODES_WITHOUT_TIME_ZONE, timeZoneForIataCode } from "../src/core/airport-time-zones";
import { IATA_LOCATION_CODES } from "../src/core/location-display";

/*
 * The four itineraries here are real answers to LIM-MAD 21 Sep 2026 / 30 Sep,
 * read off production while the desk was reporting a two-hour flight to Madrid.
 * They are the four shapes the fix has to get right at once: a leg that crosses
 * midnight twice, one that lands on 24h exactly, one whose provider stamped a
 * Lima offset on Madrid, and one that was already correct and must not move.
 */

test("a leg the provider truncated at 24h is the whole leg", () => {
  const segments = [
    { origin: "LIM", destination: "SCL", departureAt: "2026-09-21T01:10:00", arrivalAt: "2026-09-21T06:45:00" },
    { origin: "SCL", destination: "MAD", departureAt: "2026-09-21T17:05:00", arrivalAt: "2026-09-22T11:00:00" },
  ].map((segment) => ({ ...segment, durationMinutes: resolveSegmentDurationMinutes(segment) }));

  // 3h35m of flying, 10h20m at Santiago, 12h55m to Madrid.
  assert.deepEqual(segments.map((segment) => segment.durationMinutes), [215, 775]);

  // Agil sent `0250` for this leg — 26h50m with the day dropped.
  assert.equal(resolveItineraryDurationMinutes(segments, [620], 170), 1610);
});

test("a leg exactly a day and fifty minutes long is not fifty minutes", () => {
  const segments = [
    { origin: "MAD", destination: "SCL", departureAt: "2026-09-30T13:15:00", arrivalAt: "2026-09-30T21:45:00" },
    { origin: "SCL", destination: "LIM", departureAt: "2026-10-01T05:10:00", arrivalAt: "2026-10-01T07:05:00" },
  ].map((segment) => ({ ...segment, durationMinutes: resolveSegmentDurationMinutes(segment) }));

  assert.equal(resolveItineraryDurationMinutes(segments, [445], 50), 1490);
});

test("a Lima offset stamped on Madrid does not shorten the trip", () => {
  const segments = [
    {
      origin: "MAD",
      destination: "BOG",
      departureAt: "2026-09-30T12:10:00.000-0500",
      arrivalAt: "2026-09-30T15:40:00.000-0500",
    },
    {
      origin: "BOG",
      destination: "LIM",
      departureAt: "2026-09-30T17:15:00.000-0500",
      arrivalAt: "2026-09-30T20:20:00.000-0500",
    },
  ].map((segment) => ({ ...segment, durationMinutes: resolveSegmentDurationMinutes(segment) }));

  assert.deepEqual(segments.map((segment) => segment.durationMinutes), [630, 185]);

  // The wall clocks say 8h10m; Madrid to Lima is 15h10m.
  assert.equal(wallClockMinutesBetween(segments[0].departureAt, segments[1].arrivalAt), 490);
  assert.equal(resolveItineraryDurationMinutes(segments, [95], 490), 910);
});

test("a leg that was already right does not move", () => {
  const segments = [
    {
      origin: "LIM",
      destination: "CDG",
      departureAt: "2026-09-21T20:20:00.000-0500",
      arrivalAt: "2026-09-22T15:45:00.000-0500",
    },
    {
      origin: "CDG",
      destination: "MAD",
      departureAt: "2026-09-22T21:00:00.000-0500",
      arrivalAt: "2026-09-22T23:15:00.000-0500",
    },
  ].map((segment) => ({ ...segment, durationMinutes: resolveSegmentDurationMinutes(segment) }));

  assert.deepEqual(segments.map((segment) => segment.durationMinutes), [745, 135]);
  assert.equal(resolveItineraryDurationMinutes(segments, [315], 1195), 1195);
});

test("Santiago in September is read on summer time", () => {
  // Chile moves to UTC-3 in the first days of September; in July it is UTC-4,
  // and reading the same flight under the wrong one costs an hour.
  assert.equal(zonedMinutesBetween("LIM", "2026-09-21T01:10:00", "SCL", "2026-09-21T06:45:00"), 215);
  assert.equal(zonedMinutesBetween("LIM", "2026-07-21T01:10:00", "SCL", "2026-07-21T06:45:00"), 275);
});

test("a code outside the catalogue says nothing rather than something false", () => {
  assert.equal(zonedMinutesBetween("ZZZ", "2026-09-21T01:10:00", "MAD", "2026-09-21T06:45:00"), undefined);

  // With no clock for either end the provider's own figure is what stands.
  const segment = { origin: "ZZZ", destination: "YYY", departureAt: "2026-09-21T01:10:00", arrivalAt: "2026-09-21T06:45:00" };
  assert.equal(resolveSegmentDurationMinutes(segment, 300), 300);
  assert.equal(resolveSegmentDurationMinutes(segment), 335);
});

test("every airport the catalogue names keeps a clock", () => {
  assert.deepEqual(IATA_LOCATION_CODES_WITHOUT_TIME_ZONE, []);
  for (const code of IATA_LOCATION_CODES) {
    const zone = timeZoneForIataCode(code);
    assert.ok(zone, `${code} has no time zone`);
    assert.doesNotThrow(() => new Intl.DateTimeFormat("en-US", { timeZone: zone }));
  }
});
