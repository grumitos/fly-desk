export function providerDisplayName(providerId?: string | null): string {
  const normalized = String(providerId ?? "").trim().toLowerCase()

  if (!normalized) return "Proveedor"
  if (normalized.includes("costamar")) return "Click and Book Plus"
  if (normalized.includes("agil")) return "Agilsmart"

  return String(providerId).trim()
}

export type SearchProvider = {
  id: string
  label: string
  icon: string
}

/**
 * The providers the rail on the idle screen lists (plate 1a).
 *
 * Appearing in the list means "this is where the search will go", and that is
 * the whole contract — a provider that is not configured simply is not listed.
 * It deliberately says nothing about health: reporting which provider is *down*
 * before a search has run would need a loopback surface that does not exist yet,
 * and a rail that implies a status it cannot verify is worse than one that only
 * lists names.
 */
export function configuredSearchProviders(): SearchProvider[] {
  return [
    { id: "agil-local", label: "Agilsmart", icon: "/assets/provider-icons/agilsmart-128.png" },
    { id: "costamar", label: "Click and Book Plus", icon: "/assets/provider-icons/click-and-book-plus-128.png" },
  ]
}
