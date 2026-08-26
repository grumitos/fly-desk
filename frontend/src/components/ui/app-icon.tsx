import { appIconRegistry, type AppIconName } from "@/components/ui/app-icon-registry"
import { cn } from "@/lib/utils"

export type { AppIconName } from "@/components/ui/app-icon-registry"

/**
 * Plate 7b closes the pictogram system at four sizes, each bound to a control
 * height so the icon is chosen by where it sits and never by taste:
 *
 *   18  mobile 40 and 46px controls · sheet headers
 *   16  desktop 32–52px controls · search fields · mobile 34
 *   14  dense desktop rows · card metadata · lists
 *   12  keys, badges and 20px checkboxes
 *
 * The mobile row read 44 and 52 for as long as the touch heights did. They
 * became 34/40/46 in `design-system.css`, whose own copy of this table was
 * corrected then and this one was not — so a caller sizing an icon on a phone
 * was deriving it from a row the catalogue no longer has.
 *
 * The other half of the system is meaning: one glyph, one job. A chevron only
 * ever means "this opens or closes in place" — never movement; an arrow only
 * means direction or travel; a check only means confirmation; an ✗ only means
 * close or remove, never "error" (errors carry their own colour and words).
 */
export type AppIconSize = 12 | 14 | 16 | 18

/* Tailwind's own `size-*` so tailwind-merge can still dedupe a caller override. */
const sizeClassName: Record<AppIconSize, string> = {
  12: "size-3",
  14: "size-3.5",
  16: "size-4",
  18: "size-[18px]",
}

export function AppIcon({
  name,
  className,
  size = 16,
  spin = false,
}: {
  name: AppIconName
  className?: string
  size?: AppIconSize
  spin?: boolean
}) {
  const Icon = appIconRegistry[name]
  return (
    <Icon
      aria-hidden="true"
      className={cn("shrink-0", sizeClassName[size], spin && "fd-motion-giro", className)}
      strokeWidth={2}
    />
  )
}
