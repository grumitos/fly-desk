import type { CanonicalOffer } from "@/types"

type OfferPurchasePath = NonNullable<CanonicalOffer["purchasePaths"]>[number]

export function bestPurchasePath(offer: CanonicalOffer): OfferPurchasePath | undefined {
  const paths = offer.purchasePaths ?? []
  return [...paths].sort((left, right) => purchasePathRank(right) - purchasePathRank(left))[0]
}

export function bestPurchasePathsByProvider(offer: CanonicalOffer): OfferPurchasePath[] {
  const bestByProvider = new Map<string, OfferPurchasePath>()
  for (const path of offer.purchasePaths ?? []) {
    const current = bestByProvider.get(path.provider)
    if (!current || purchasePathRank(path) > purchasePathRank(current)) {
      bestByProvider.set(path.provider, path)
    }
  }

  return [...bestByProvider.values()].sort((left, right) => {
    const providerDiff = providerRank(left.provider) - providerRank(right.provider)
    return providerDiff !== 0 ? providerDiff : purchasePathRank(right) - purchasePathRank(left)
  })
}

function providerRank(provider: string) {
  if (/agil/i.test(provider)) return 0
  if (/costamar/i.test(provider)) return 1
  return 2
}

function purchasePathRank(path: OfferPurchasePath) {
  const precisionScore: Record<string, number> = {
    "exact-offer": 40,
    "exact-search": 30,
    "broad-search": 20,
    manual: 10,
  }
  const stateScore = path.state === "api_bookable" || path.state === "deeplink_exact" ? 20 : 0
  return (precisionScore[path.precision] ?? 0) + stateScore + (path.score ?? 0)
}

export function normalizeSafePurchaseUrl(value: string): string | undefined {
  try {
    const url = new URL(value, window.location.origin)
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined
  } catch {
    return undefined
  }
}
