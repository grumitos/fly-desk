import * as React from "react"

import { cn } from "@/lib/utils"

function Field({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="field"
      className={cn("group/field", className)}
      {...props}
    />
  )
}

/* The floating micro label of plate 1a: 10px 700 uppercase at 12/9, tracked
   .04em, absolute inside the field it labels. It is the same label the merged
   date control already used, so there is one of it rather than two. */
function FieldLabel({ className, ...props }: React.ComponentProps<"label">) {
  return (
    <label
      data-slot="field-label"
      className={cn("fd-field-label", className)}
      {...props}
    />
  )
}

function FieldError({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="field-error"
      role="alert"
      className={cn("fd-control-helper", className)}
      {...props}
    />
  )
}

export { Field, FieldError, FieldLabel }
