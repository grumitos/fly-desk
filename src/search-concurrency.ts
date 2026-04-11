function readIntegerEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return undefined;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  return Math.trunc(parsed);
}

function atLeast(value: number | undefined, minimum: number): number {
  return Math.max(minimum, Math.trunc(value ?? minimum));
}

export const SHARED_SEARCH_CONCURRENCY = Object.freeze({
  get providerSubrequestDefault() {
    return atLeast(readIntegerEnv("SEARCH_PROVIDER_SUBREQUEST_CONCURRENCY"), 4);
  },
  matrixMinimum: 4,
  get matrixCellDefault() {
    return atLeast(readIntegerEnv("SEARCH_MATRIX_CELL_CONCURRENCY"), 6);
  },
  rangeMinimum: 2,
  get rangeSearchDefault() {
    return atLeast(readIntegerEnv("SEARCH_RANGE_SEARCH_CONCURRENCY"), 4);
  },
});

export function resolveProviderSubrequestConcurrency(
  providerEnvName: string,
  providerDefault: number,
  minimum = 1,
): number {
  const sharedCap = atLeast(SHARED_SEARCH_CONCURRENCY.providerSubrequestDefault, minimum);
  const providerValue = atLeast(readIntegerEnv(providerEnvName) ?? providerDefault, minimum);
  return Math.max(minimum, Math.min(providerValue, sharedCap));
}

export function resolveMatrixCellConcurrency(providerEnvName: string): number {
  const minimum = SHARED_SEARCH_CONCURRENCY.matrixMinimum;
  const sharedCap = atLeast(SHARED_SEARCH_CONCURRENCY.matrixCellDefault, minimum);
  const providerValue = atLeast(readIntegerEnv(providerEnvName) ?? sharedCap, minimum);
  return Math.max(minimum, Math.min(providerValue, sharedCap));
}

export function resolveRangeSearchConcurrency(providerEnvName: string): number {
  const minimum = SHARED_SEARCH_CONCURRENCY.rangeMinimum;
  const sharedCap = atLeast(SHARED_SEARCH_CONCURRENCY.rangeSearchDefault, minimum);
  const providerValue = atLeast(readIntegerEnv(providerEnvName) ?? sharedCap, minimum);
  return Math.max(minimum, Math.min(providerValue, sharedCap));
}
