import type { SearchRequest } from "@/types"

type PassengerMix = Pick<SearchRequest, "adults" | "children" | "infants">

export function passengerCount(request?: PassengerMix): number {
  if (!request) return 1
  const adults = Number.isFinite(request.adults) ? request.adults : 1
  const children = Number.isFinite(request.children) ? request.children : 0
  const infants = Number.isFinite(request.infants) ? request.infants : 0
  return Math.max(1, adults + children + infants)
}

/* A per-person figure is only honest for an all-adult group: providers price
   children and infants differently and send the total alone. */
export function showsPerPersonPrice(request?: PassengerMix): boolean {
  return Boolean(request && request.children === 0 && request.infants === 0)
}
