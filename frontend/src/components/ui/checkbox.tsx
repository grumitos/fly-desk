import * as React from "react"

import { cn } from "@/lib/utils"

function Checkbox({
  className,
  onCheckedChange,
  onChange,
  ...props
}: Omit<React.ComponentProps<"input">, "type"> & {
  onCheckedChange?: (checked: boolean) => void
}) {
  return (
    <input
      type="checkbox"
      data-slot="checkbox"
      className={cn("fd-checkbox fd-focus-ring", className)}
      onChange={(event) => {
        onChange?.(event)
        onCheckedChange?.(event.target.checked)
      }}
      {...props}
    />
  )
}

export { Checkbox }
