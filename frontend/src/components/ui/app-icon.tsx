import { appIconRegistry, type AppIconName } from "@/components/ui/app-icon-registry"
import { cn } from "@/lib/utils"

export type { AppIconName } from "@/components/ui/app-icon-registry"

/**
 * Four sizes, chosen by the control the icon sits in:
 *
 *   18  mobile 40 and 46px controls · sheet headers
 *   16  desktop 32–52px controls · search fields · mobile 34
 *   14  dense desktop rows · card metadata · lists
 *   12  keys, badges and checkboxes
 *
 * One glyph, one meaning: a chevron opens or closes in place, an arrow is
 * direction, a check confirms, and ✗ closes or removes (never "error").
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
