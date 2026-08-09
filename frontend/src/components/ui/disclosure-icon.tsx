import { AppIcon, type AppIconSize } from "@/components/ui/app-icon"
import { cn } from "@/lib/utils"

/**
 * A chevron means "this opens or closes in place" (01 §5). It does **not**
 * rotate: rotation is movement, and movement is what an arrow means. Opening
 * swaps the glyph for `chevron-up` with a 90ms cross-fade (07 §4, movement 9).
 *
 * Both glyphs are always mounted in the same grid cell so the swap costs no
 * layout and the box never changes size.
 */
export function DisclosureIcon({
  open,
  size = 16,
  className,
}: {
  open: boolean
  size?: AppIconSize
  className?: string
}) {
  return (
    <span className={cn("fd-disclosure", className)} data-open={open} aria-hidden="true">
      <AppIcon name="chevronDown" size={size} />
      <AppIcon name="chevronUp" size={size} />
    </span>
  )
}
