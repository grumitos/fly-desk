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
