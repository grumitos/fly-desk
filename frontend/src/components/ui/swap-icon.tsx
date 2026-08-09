import { AppIcon, type AppIconSize } from "@/components/ui/app-icon"
import { cn } from "@/lib/utils"

/**
 * The exchange arrow follows the axis it exchanges along: side by side on a
 * desk (plate 1a), stacked on a phone (plate 1c). It does **not** rotate to get
 * there — rotation is reserved for the one spinner in the system (07 §4), so
 * both glyphs are mounted in the same cell and the container query picks one.
 */
export function SwapIcon({
  size = 16,
  className,
}: {
  size?: AppIconSize
  className?: string
}) {
  return (
    <span className={cn("fd-swap-icon", className)} aria-hidden="true">
      <AppIcon name="swap" size={size} />
      <AppIcon name="swapVertical" size={size} />
    </span>
  )
}
