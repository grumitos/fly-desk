import type { ReactNode } from "react"
import { AppIcon, type AppIconName } from "@/components/ui/app-icon"
import { cn } from "@/lib/utils"

/* A 20px key. Glyph keys draw icons from the set; literal keys (`esc`, `/`)
   stay text. */
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

/** A key (or key pair) and the action it performs. */
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
