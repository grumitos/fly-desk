export function addDaysIso(value, days) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function enumerateIsoRange(start, end) {
  const values = [];
  let current = start;
  while (current <= end) {
    values.push(current);
    current = addDaysIso(current, 1);
  }
  return values;
}

export function diffDaysIso(from, to) {
  return Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000);
}

function hasFiniteNightValue(value) {
  return Number.isFinite(typeof value === "number" ? value : Number(value));
}

export function normalizeFlexibleNightValue(value, fallback) {
  if (!hasFiniteNightValue(value)) {
    return fallback;
  }

  return Math.max(1, Math.trunc(Number(value)));
}

export function resolveExactStayNights(leg = {}) {
  if (hasFiniteNightValue(leg.stayNights)) {
    return normalizeFlexibleNightValue(leg.stayNights);
  }

  if (hasFiniteNightValue(leg.minNights) && hasFiniteNightValue(leg.maxNights)) {
    const min = Math.trunc(Number(leg.minNights));
    const max = Math.trunc(Number(leg.maxNights));
    if (min === max) {
      return normalizeFlexibleNightValue(min);
    }
  }

  return undefined;
}

function hasLegacyNightRangeConstraints(leg = {}) {
  if (!hasFiniteNightValue(leg.minNights) && !hasFiniteNightValue(leg.maxNights)) {
    return false;
  }

  const exactStayNights = resolveExactStayNights(leg);
  if (exactStayNights == null) {
    return true;
  }

  return normalizeFlexibleNightValue(leg.minNights) !== exactStayNights
    || normalizeFlexibleNightValue(leg.maxNights) !== exactStayNights;
}

export function resolveRoundTripFlexibleMode(request = {}) {
  if (request.tripType !== "round-trip" || request.searchMode !== "roundtrip-grid") {
    return undefined;
  }

  const leg = request.legs?.[0] || {};
  const hasDepartureWindow = Boolean(leg.departureStart && leg.departureEnd);
  const hasReturnWindow = Boolean(leg.returnStart && leg.returnEnd);

  if (request.flexibleMode === "exact-stay" || request.flexibleMode === "fixed-ranges") {
    return request.flexibleMode;
  }

  if (resolveExactStayNights(leg) != null) {
    return "exact-stay";
  }

  if (hasDepartureWindow && hasReturnWindow && !hasLegacyNightRangeConstraints(leg)) {
    return "fixed-ranges";
  }

  if (hasLegacyNightRangeConstraints(leg)) {
    return "legacy-night-range";
  }

  return hasDepartureWindow && hasReturnWindow
    ? "fixed-ranges"
    : undefined;
}

function resolveRoundTripFlexibleSpec(request = {}) {
  const leg = request.legs?.[0] || {};
  if (!leg.departureStart || !leg.departureEnd) {
    throw new Error("Flexible round-trip search requires departureStart and departureEnd.");
  }

  const mode = resolveRoundTripFlexibleMode(request);
  if (mode === "exact-stay") {
    return {
      mode,
      departureStart: leg.departureStart,
      departureEnd: leg.departureEnd,
      returnStart: leg.returnStart || leg.departureStart,
      returnEnd: leg.returnEnd || leg.departureEnd,
      stayNights: resolveExactStayNights(leg),
    };
  }

  if (!leg.returnStart || !leg.returnEnd) {
    throw new Error("Flexible round-trip search requires returnStart and returnEnd.");
  }

  if (mode === "fixed-ranges") {
    return {
      mode,
      departureStart: leg.departureStart,
      departureEnd: leg.departureEnd,
      returnStart: leg.returnStart,
      returnEnd: leg.returnEnd,
    };
  }

  const minNights = normalizeFlexibleNightValue(leg.minNights, 1);
  const rawMaxNights = normalizeFlexibleNightValue(leg.maxNights, minNights);
  return {
    mode: "legacy-night-range",
    departureStart: leg.departureStart,
    departureEnd: leg.departureEnd,
    returnStart: leg.returnStart,
    returnEnd: leg.returnEnd,
    nightBounds: {
      minNights,
      maxNights: Math.max(minNights, rawMaxNights),
    },
  };
}

export function enumerateUsefulRoundTripPairs(request = {}) {
  const spec = resolveRoundTripFlexibleSpec(request);
  const departures = enumerateIsoRange(spec.departureStart, spec.departureEnd);

  if (spec.mode === "exact-stay") {
    const stayNights = spec.stayNights;
    if (!Number.isFinite(stayNights)) {
      return [];
    }

    return departures.flatMap((departureDate) => {
      const returnDate = addDaysIso(departureDate, stayNights);
      return returnDate >= spec.returnStart
        && returnDate <= spec.returnEnd
        && returnDate > departureDate
        ? [{
            departureDate,
            returnDate,
            stayNights,
          }]
        : [];
    });
  }

  const returns = enumerateIsoRange(spec.returnStart, spec.returnEnd);
  return departures.flatMap((departureDate) =>
    returns.flatMap((returnDate) => {
      if (returnDate <= departureDate) {
        return [];
      }

      const stayNights = diffDaysIso(departureDate, returnDate);
      if (spec.mode === "fixed-ranges") {
        return [{
          departureDate,
          returnDate,
          stayNights,
        }];
      }

      return stayNights >= spec.nightBounds.minNights && stayNights <= spec.nightBounds.maxNights
        ? [{
            departureDate,
            returnDate,
            stayNights,
          }]
        : [];
    }),
  );
}

export function enumerateRoundTripFlexibleAxes(
  request = {},
  pairs = enumerateUsefulRoundTripPairs(request),
) {
  const spec = resolveRoundTripFlexibleSpec(request);
  if (spec.mode === "exact-stay") {
    return {
      departureDates: [...new Set(pairs.map((pair) => pair.departureDate))],
      returnDates: [...new Set(pairs.map((pair) => pair.returnDate))],
    };
  }

  return {
    departureDates: enumerateIsoRange(spec.departureStart, spec.departureEnd),
    returnDates: enumerateIsoRange(spec.returnStart, spec.returnEnd),
  };
}

export function todayISO() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function isValidIsoDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
  if (!match) {
    return false;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) {
    return false;
  }

  const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= maxDay;
}

export function createSearchDateHelpers({
  runtimeSearchDatePolicy,
  maxFutureDaysDefault,
  formatDateCompact,
}) {
  function minDateISO() {
    if (runtimeSearchDatePolicy?.minSearchDate) {
      return runtimeSearchDatePolicy.minSearchDate;
    }

    return todayISO();
  }

  function maxDateISO() {
    if (runtimeSearchDatePolicy?.maxSearchDate) {
      return runtimeSearchDatePolicy.maxSearchDate;
    }

    const maxFutureDays = Number.isFinite(runtimeSearchDatePolicy?.maxFutureDays)
      ? runtimeSearchDatePolicy.maxFutureDays
      : maxFutureDaysDefault;
    return addDaysIso(minDateISO(), maxFutureDays);
  }

  function allowedDateWindowText() {
    return `${formatDateCompact(minDateISO())} y ${formatDateCompact(maxDateISO())}`;
  }

  return {
    todayISO,
    minDateISO,
    maxDateISO,
    isValidIsoDate,
    allowedDateWindowText,
  };
}
