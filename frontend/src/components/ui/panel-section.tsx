import type { HTMLAttributes, ReactNode } from "react"
import { cn } from "@/lib/utils"

export function PanelSectionStack({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("divide-y divide-border", className)}
      {...props}
    />
  )
}

type PanelSectionProps = HTMLAttributes<HTMLElement> & {
  title?: string
  action?: ReactNode
  contentClassName?: string
}

export function PanelSection({
  title,
  action,
  children,
  className,
  contentClassName,
  ...props
}: PanelSectionProps) {
  return (
    <section
      className={cn("py-3 first:pt-0", className)}
      {...props}
    >
      {(title || action) && (
        <div className="mb-1.5 flex min-h-5 min-w-0 items-center justify-between gap-2">
          {title ? <h3 className="fd-label min-w-0 truncate">{title}</h3> : <span aria-hidden="true" />}
          {action}
        </div>
      )}
      <div className={contentClassName}>{children}</div>
    </section>
  )
}
