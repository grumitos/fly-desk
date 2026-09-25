import { AppIcon, type AppIconSize } from "@/components/ui/app-icon"
import { cn } from "@/lib/utils"

/* Opens or closes in place: the glyph cross-fades to `chevronUp` instead of
   rotating, both mounted in one cell so the box never changes size. */
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
