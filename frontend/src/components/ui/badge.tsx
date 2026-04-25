import * as React from "react"
import { cn } from "@/lib/utils"

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: "default" | "secondary" | "outline" | "accent" | "success" | "warning" | "destructive"
}

function Badge({ className, variant = "default", ...props }: BadgeProps) {
  return (
    <div
      className={cn(
        "inline-flex items-center rounded-lg border px-2.5 py-0.5 text-xs font-semibold transition-colors",
        {
          "border-transparent bg-primary text-primary-foreground shadow-sm hover:bg-primary/80": variant === "default",
          "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80": variant === "secondary",
          "border-transparent bg-success text-success-foreground hover:bg-success/80": variant === "success",
          "border-transparent bg-warning text-warning-foreground hover:bg-warning/80": variant === "warning",
          "border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/80": variant === "destructive",
          "bg-background text-foreground hover:bg-muted": variant === "outline",
          "border-transparent bg-primary/10 text-primary hover:bg-primary/20": variant === "accent",
        },
        className
      )}
      {...props}
    />
  )
}

export { Badge }
