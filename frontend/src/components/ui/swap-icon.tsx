import { AppIcon, type AppIconSize } from "@/components/ui/app-icon"
import { cn } from "@/lib/utils"

/* The exchange arrow follows the fields' axis: horizontal on a desk, vertical
   on a phone. Both glyphs are mounted and CSS shows one. */
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
