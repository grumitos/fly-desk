import { appIconRegistry, type AppIconName } from "@/components/ui/app-icon-registry"
import { cn } from "@/lib/utils"

export type { AppIconName } from "@/components/ui/app-icon-registry"

/**
 * 18 for touch controls, 16 for desktop controls and fields, 14 for dense rows,
 * 12 for keys and badges. One glyph, one meaning: a chevron opens in place, an
 * arrow is direction, a check confirms, ✗ closes or removes (never "error").
 */
export type AppIconSize = 12 | 14 | 16 | 18

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
      className={cn("fd-icon", `fd-icon-${size}`, spin && "fd-motion-giro", className)}
      strokeWidth={2}
    />
  )
}
