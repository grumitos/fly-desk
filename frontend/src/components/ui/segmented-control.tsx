import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react"
import {
  segmentedControlClassName,
  segmentedItemActiveClassName,
  segmentedItemBaseClassName,
  segmentedItemInactiveClassName,
} from "@/components/ui/segmented-control-classes"
import { SlidingSegmentIndicator } from "@/components/ui/sliding-segment-indicator"
import { useSlidingSegmentIndicator } from "@/components/ui/use-sliding-segment-indicator"
import { cn } from "@/lib/utils"

interface SegmentedControlProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
  disabled?: boolean
}

function SegmentedControl({ children, disabled = false, className, ...props }: SegmentedControlProps) {
  const { containerRef, indicatorStyle } = useSlidingSegmentIndicator<HTMLDivElement>()

  return (
    <div
      ref={containerRef}
      aria-disabled={disabled}
      className={cn(
        "fd-segmented-control",
        segmentedControlClassName,
        disabled && "fd-disabled-section",
        className,
      )}
      {...props}
    >
      <SlidingSegmentIndicator style={indicatorStyle} />
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
