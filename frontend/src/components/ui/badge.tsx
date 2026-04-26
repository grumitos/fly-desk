import * as React from "react"
import { cn } from "@/lib/utils"

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: "default" | "secondary" | "outline" | "accent" | "success" | "warning" | "destructive"
}

function Badge({ className, variant = "default", ...props }: BadgeProps) {
  return (
    <div
      className={cn(
        "inline-flex h-5 items-center rounded-md border px-1.5 text-[10px] font-bold uppercase tracking-[0.04em] transition-colors duration-150",
        {
          "border-transparent bg-primary text-primary-foreground shadow-sm": variant === "default",
          "border-transparent bg-secondary text-secondary-foreground": variant === "secondary",
          "border-transparent bg-success text-success-foreground": variant === "success",
          "border-transparent bg-warning text-warning-foreground": variant === "warning",
          "border-transparent bg-destructive text-destructive-foreground": variant === "destructive",
          "bg-card text-foreground": variant === "outline",
          "border-transparent bg-primary/10 text-primary": variant === "accent",
        },
        className
      )}
      {...props}
    />
  )
}

export { Badge }
