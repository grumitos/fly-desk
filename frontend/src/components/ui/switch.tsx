import * as React from "react"

import { cn } from "@/lib/utils"

/* A native checkbox with switch semantics: the label, Space and form reset all
   behave as the platform's own control does. */
function Switch({
  className,
  onCheckedChange,
  onChange,
  ...props
}: Omit<React.ComponentProps<"input">, "type" | "role"> & {
  onCheckedChange?: (checked: boolean) => void
}) {
  return (
    <input
      type="checkbox"
      role="switch"
      data-slot="switch"
      className={cn("fd-switch fd-focus-ring", className)}
      onChange={(event) => {
        onChange?.(event)
        onCheckedChange?.(event.target.checked)
      }}
      {...props}
    />
  )
}

export { Switch }
