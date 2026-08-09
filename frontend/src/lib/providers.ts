export function providerDisplayName(providerId?: string | null): string {
  const id = String(providerId ?? "").trim().toLowerCase()
  if (!id) return "Proveedor"
  if (id === "agil-local" || id === "agil") return "Agilsmart"
  if (id === "costamar" || id === "cbplus" || id === "click-and-book-plus") return "Click and Book Plus"
  return providerId ?? "Proveedor"
}

const PROVIDER_DEFINITIONS = [
  {
    id: "agil-local",
    label: "Agilsmart",
    icon: "/assets/provider-icons/agilsmart-128.png",
  },
  {
    id: "costamar",
    label: "Click and Book Plus",
    icon: "/assets/provider-icons/click-and-book-plus-128.png",
  },
] as const

export type SearchProviderId = (typeof PROVIDER_DEFINITIONS)[number]["id"]

export type SearchProvider = {
  id: SearchProviderId
  label: string
  icon: string
}

/**
 * The providers the rail on the idle screen lists (plate 1a).
 *
 * It is a statement of coverage — «Buscando en» — not a health widget. It used
 * to be filtered by a live readiness observation, and the effect was the
 * opposite of informative: Click and Book Plus can only reach `ready` after a
 * real search has come back, so on the screen where this rail lives it was
 * never listed at all and the desk looked like it searched one provider.
 *
 * Health belongs to the authenticated `/api/provider-status` surface, which the
 * backend keeps for diagnosis. A failure in a search is already said in one
 * line above the list (04 §8).
 */
export function configuredSearchProviders(): SearchProvider[] {
  return PROVIDER_DEFINITIONS.map((provider) => ({ ...provider }))
}
