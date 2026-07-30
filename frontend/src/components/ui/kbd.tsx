import type { ReactNode } from "react"
import { AppIcon, type AppIconName } from "@/components/ui/app-icon"
import { cn } from "@/lib/utils"

/**
 * The key from plate 7b: one 20px component, radius 6, with a 12px icon inside.
 *
 * The suggestion footer used to draw enter and the arrows as glyphs from the
 * mono font — a different stroke weight and a different optical box from every
 * other mark in the interface. Glyph keys now carry icons from the same set;
 * only literal keys (`esc`, `/`) stay as text.
 */
export function Kbd({
  icon,
  children,
  className,
}: {
  icon?: AppIconName
  children?: ReactNode
  className?: string
}) {
  return (
    <kbd className={cn("fd-key", !icon && "fd-key-text", className)}>
      {icon ? <AppIcon name={icon} size={12} /> : children}
    </kbd>
  )
}

/** A key (or key pair) with the action it performs, as used in the 2a footer. */
export function KbdHint({
  keys,
  label,
  className,
}: {
  keys: ReactNode
  label: string
  className?: string
}) {
  return (
    <span className={cn("fd-key-hint", className)}>
      {keys}
      {label}
    </span>
  )
}
