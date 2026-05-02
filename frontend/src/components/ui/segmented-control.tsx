import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react"
import {
  segmentedControlClassName,
  segmentedItemActiveClassName,
  segmentedItemBaseClassName,
  segmentedItemInactiveClassName,
} from "@/components/ui/segmented-control-classes"
import { cn } from "@/lib/utils"

interface SegmentedControlProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
  disabled?: boolean
}

function SegmentedControl({ children, disabled = false, className, ...props }: SegmentedControlProps) {
  return (
    <div
      aria-disabled={disabled}
      className={cn(
        segmentedControlClassName,
        disabled && "fd-disabled-section",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  )
}

interface SegmentButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active: boolean
}

function SegmentButton({
  active,
  disabled,
  className,
  children,
  type = "button",
  ...props
}: SegmentButtonProps) {
  return (
    <button
      type={type}
      aria-pressed={active}
      disabled={disabled}
      className={cn(
        segmentedItemBaseClassName,
        active ? segmentedItemActiveClassName : segmentedItemInactiveClassName,
        className,
      )}
      {...props}
    >
      {children}
    </button>
  )
}

export { SegmentButton, SegmentedControl }
