import * as React from "react"
import { cn } from "@/lib/utils"

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "secondary" | "outline" | "ghost" | "destructive"
  size?: "default" | "sm" | "lg" | "icon"
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "default", size = "default", ...props }, ref) => {
    return (
      <button
        className={cn(
          "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg font-semibold transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.985] disabled:pointer-events-none disabled:opacity-55 disabled:active:scale-100",
          {
            "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90": variant === "default",
            "border border-input bg-secondary text-secondary-foreground hover:bg-accent hover:text-foreground": variant === "secondary",
            "border border-input bg-card hover:bg-accent hover:text-accent-foreground": variant === "outline",
            "hover:bg-accent hover:text-accent-foreground": variant === "ghost",
            "bg-destructive text-destructive-foreground hover:bg-destructive/90": variant === "destructive",
          },
          {
            "h-9 px-4 py-2 text-sm": size === "default",
            "h-7 rounded-md px-2.5 text-xs": size === "sm",
            "h-10 px-6 text-sm": size === "lg",
            "h-9 w-9": size === "icon",
          },
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button }
