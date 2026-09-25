import * as React from "react"

import { cn } from "@/lib/utils"

/* Bare on purpose: every input in the product sits inside a field control that
   draws the box, so this carries only what an unstyled input lacks. */
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn("fd-input", className)}
      {...props}
    />
  )
}

export { Input }
