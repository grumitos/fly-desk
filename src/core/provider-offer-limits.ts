export const PROVIDER_OFFER_VARIANT_LIMIT = 50;

export function takeProviderOfferVariants<T>(variants: T[]): T[] {
  return variants.length > PROVIDER_OFFER_VARIANT_LIMIT
    ? variants.slice(0, PROVIDER_OFFER_VARIANT_LIMIT)
    : variants;
}
