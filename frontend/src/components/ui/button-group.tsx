import * as React from "react"

import { cn } from "@/lib/utils"

function ButtonGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="button-group"
      role="group"
      className={cn("flex w-fit items-center", className)}
      {...props}
    />
  )
}

function ButtonGroupText({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="button-group-text"
      className={cn("inline-flex items-center justify-center", className)}
      {...props}
    />
  )
}

export { ButtonGroup, ButtonGroupText }
