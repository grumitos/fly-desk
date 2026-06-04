export function providerDisplayName(providerId?: string | null): string {
  const normalized = String(providerId ?? "").trim().toLowerCase()

  if (!normalized) return "Proveedor"
  if (normalized.includes("costamar")) return "Click and Book Plus"
  if (normalized.includes("agil")) return "Agilsmart"

  return String(providerId).trim()
}
