import * as React from "react"
import * as SwitchPrimitive from "@radix-ui/react-switch"

import { cn } from "@/lib/utils"

function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer inline-flex h-4 w-7 shrink-0 cursor-pointer items-center rounded-full border border-transparent bg-input transition-[background-color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-55 data-[state=checked]:bg-primary",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block h-3 w-3 rounded-full bg-white shadow-sm transition-transform data-[state=checked]:translate-x-3.5 data-[state=unchecked]:translate-x-0.5"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
