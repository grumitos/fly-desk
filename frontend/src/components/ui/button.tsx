import * as React from "react"

import { cn } from "@/lib/utils"

type ButtonVariant = "default" | "secondary" | "ghost"
/** chip 26 · sm 32 · default 36 · xl 52 · icon 32 square (`design-system.css`). */
type ButtonSize = "chip" | "sm" | "default" | "xl" | "icon"

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  default: "fd-btn-primary",
  secondary: "fd-btn-secondary",
  ghost: "fd-btn-ghost",
}

const SIZE_CLASS: Record<ButtonSize, string> = {
  chip: "fd-btn-chip",
  sm: "fd-btn-sm",
  default: "fd-btn-md",
  xl: "fd-btn-xl",
  icon: "fd-btn-icon",
}

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: React.ComponentProps<"button"> & {
  variant?: ButtonVariant
  size?: ButtonSize
}) {
  return (
    <button
      data-slot="button"
      className={cn("fd-btn fd-focus-ring", VARIANT_CLASS[variant], SIZE_CLASS[size], className)}
      {...props}
    />
  )
}

export { Button }
