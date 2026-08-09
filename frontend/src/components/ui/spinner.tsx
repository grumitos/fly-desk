import { AppIcon } from "@/components/ui/app-icon"

/**
 * Plate 9b closes the catalogue at twelve movements, and only one of them
 * rotates: the loading indicator. So there is one spinner in the application,
 * in the two sizes the plate draws — 14px inside the search CTA, 12px inside
 * the "Parcial" pill — and `rotate` appears nowhere else.
 *
 * With reduced motion the loop stops (07 §0 rule 5), which is why the partial
 * state also has to read as text next to it.
 */
export function Spinner({ size = 14 }: { size?: 12 | 14 }) {
  return <AppIcon name="loading" size={size} spin />
}
