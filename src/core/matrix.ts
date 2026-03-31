import { MatrixCell, MatrixResponse, SearchRequest } from "./types";

export type LoadingMatrixCell = MatrixCell & {
  derivedRequest: SearchRequest;
  confidence: "loading";
};

export function buildMatrixConfidenceSummary(cells: MatrixCell[]): Record<string, number> {
  return cells.reduce<Record<string, number>>((acc, cell) => {
    acc[cell.confidence] = (acc[cell.confidence] ?? 0) + 1;
    return acc;
  }, {});
}

export function prioritizeMatrixLoadingCells(
  cells: MatrixCell[],
  axes: MatrixResponse["axes"],
  tripType: SearchRequest["tripType"],
): LoadingMatrixCell[] {
  const departureOrder = new Map(axes.departureDates.map((date, index) => [date, index]));
  const returnOrder = new Map(axes.returnDates.map((date, index) => [date, index]));

  return cells
    .filter((cell): cell is LoadingMatrixCell => cell.confidence === "loading" && Boolean(cell.derivedRequest))
    .sort((left, right) => {
      const leftDeparture = departureOrder.get(left.departureDate) ?? Number.MAX_SAFE_INTEGER;
      const rightDeparture = departureOrder.get(right.departureDate) ?? Number.MAX_SAFE_INTEGER;

      if (tripType === "one-way") {
        return leftDeparture - rightDeparture;
      }

      const leftReturn = returnOrder.get(left.returnDate ?? "") ?? Number.MAX_SAFE_INTEGER;
      const rightReturn = returnOrder.get(right.returnDate ?? "") ?? Number.MAX_SAFE_INTEGER;
      const leftWave = leftDeparture + leftReturn;
      const rightWave = rightDeparture + rightReturn;

      if (leftWave !== rightWave) {
        return leftWave - rightWave;
      }

      if (leftDeparture !== rightDeparture) {
        return leftDeparture - rightDeparture;
      }

      return leftReturn - rightReturn;
    });
}

export async function mapConcurrent<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  if (values.length === 0) {
    return [];
  }

  const results: R[] = new Array(values.length);
  const workerCount = Math.min(values.length, Math.max(1, Math.trunc(concurrency) || 1));
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(values[index]);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
