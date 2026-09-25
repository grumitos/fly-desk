import { PROVIDER_LABELS } from "../../../src/core/offer-grouping"
import type { ProviderId } from "../../../src/core/types"

const PROVIDER_ICONS: Record<ProviderId, string> = {
  "agil-local": "/assets/provider-icons/agilsmart-128.png",
  costamar: "/assets/provider-icons/click-and-book-plus-128.png",
}

function isProviderId(value: string): value is ProviderId {
  return Object.hasOwn(PROVIDER_LABELS, value)
}

export function providerDisplayName(providerId?: string | null): string {
  const id = String(providerId ?? "").trim()
  if (!id) return "Proveedor"
  return isProviderId(id) ? PROVIDER_LABELS[id] : id
}

/** "" for an id with no icon, which the badge reads as «draw the short label». */
export function providerIconPath(providerId?: string | null): string {
  const id = String(providerId ?? "").trim()
  return isProviderId(id) ? PROVIDER_ICONS[id] : ""
}

/** The providers this desk searches, for the idle rail. Coverage, not health. */
export const SEARCH_PROVIDERS = (Object.keys(PROVIDER_LABELS) as ProviderId[]).map((id) => ({
  id,
  label: PROVIDER_LABELS[id],
  icon: PROVIDER_ICONS[id],
}))
