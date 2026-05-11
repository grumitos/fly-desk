export function parseProviderAmount(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  let cleaned = trimmed
    .replace(/\s+/g, "")
    .replace(/[^\d,.\-()]/g, "");

  if (!/\d/.test(cleaned)) {
    return undefined;
  }

  const negative = cleaned.includes("-") || (cleaned.startsWith("(") && cleaned.endsWith(")"));
  cleaned = cleaned.replace(/[()\-]/g, "");

  const normalized = normalizeProviderAmountString(cleaned);
  if (!normalized) {
    return undefined;
  }

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  return negative ? -parsed : parsed;
}

export function roundProviderAmount(amount: number): number {
  return Number(amount.toFixed(2));
}

export function providerAmountsDiffer(
  left: number | undefined,
  right: number | undefined,
  tolerance = 0.01,
): boolean {
  if (typeof left !== "number" || typeof right !== "number") {
    return false;
  }

  return Math.abs(left - right) > tolerance;
}

function normalizeProviderAmountString(value: string): string | undefined {
  const lastDot = value.lastIndexOf(".");
  const lastComma = value.lastIndexOf(",");
  const decimalSeparator = resolveDecimalSeparator(value, lastDot, lastComma);

  if (!decimalSeparator) {
    const integer = value.replace(/[.,]/g, "");
    return integer || undefined;
  }

  const separatorIndex = value.lastIndexOf(decimalSeparator);
  const integer = value.slice(0, separatorIndex).replace(/[.,]/g, "") || "0";
  const fraction = value.slice(separatorIndex + 1).replace(/[.,]/g, "");

  return fraction ? `${integer}.${fraction}` : integer;
}

function resolveDecimalSeparator(value: string, lastDot: number, lastComma: number): "." | "," | undefined {
  if (lastDot >= 0 && lastComma >= 0) {
    return lastDot > lastComma ? "." : ",";
  }

  if (lastDot >= 0) {
    return isSingleSeparatorDecimal(value, ".") ? "." : undefined;
  }

  if (lastComma >= 0) {
    return isSingleSeparatorDecimal(value, ",") ? "," : undefined;
  }

  return undefined;
}

function isSingleSeparatorDecimal(value: string, separator: "." | ","): boolean {
  const parts = value.split(separator);
  const separatorCount = parts.length - 1;
  const integerLength = parts.slice(0, -1).join("").length;
  const fractionLength = parts[parts.length - 1]?.length ?? 0;
  if (fractionLength === 0) {
    return false;
  }

  if (fractionLength <= 2) {
    return true;
  }

  if (separatorCount === 1) {
    return !(fractionLength === 3 && integerLength <= 3);
  }

  return fractionLength !== 3;
}
