import * as React from "react"
import * as SwitchPrimitive from "@radix-ui/react-switch"

import { cn } from "@/lib/utils"

function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer inline-flex h-4 w-7 shrink-0 cursor-pointer items-center rounded-full border border-transparent bg-input transition-[background-color,box-shadow] duration-[var(--fd-dur-tacto)] ease-[var(--fd-ease-tacto)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-55 data-[state=checked]:bg-primary",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        /* 05 §8 and the movement table of 9b both put the switch on `tacto`,
           «solo color y posición del pomo» — so the knob does move. What it
           must not do is invent its own timing: the 150ms it used to carry was
           outside the six tokens and therefore survived
           `prefers-reduced-motion`, where the token is switched off. */
        className="pointer-events-none block h-3 w-3 rounded-full bg-white shadow-sm transition-transform duration-[var(--fd-dur-tacto)] ease-[var(--fd-ease-tacto)] data-[state=checked]:translate-x-3.5 data-[state=unchecked]:translate-x-0.5"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
