import * as React from "react"
import { cn } from "@/lib/utils"

export interface SwitchProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
  checked?: boolean
  onCheckedChange?: (checked: boolean) => void
}

const Switch = React.forwardRef<HTMLInputElement, SwitchProps>(
  ({ className, checked, onCheckedChange, ...props }, ref) => {
    return (
      <label
        className={cn(
          "inline-flex h-5 w-9 cursor-pointer items-center rounded-full border border-transparent transition-[background-color,box-shadow] duration-150 focus-within:ring-2 focus-within:ring-ring",
          checked ? "bg-primary" : "bg-input",
          className
        )}
      >
        <input
          type="checkbox"
          className="sr-only"
          ref={ref}
          checked={checked}
          onChange={(e) => onCheckedChange?.(e.target.checked)}
          {...props}
        />
        <span
          className={cn(
            "block h-4 w-4 rounded-full bg-background shadow-sm transition-transform duration-150",
            checked ? "translate-x-[17px]" : "translate-x-0.5"
          )}
        />
      </label>
    )
  }
)
Switch.displayName = "Switch"

export { Switch }
