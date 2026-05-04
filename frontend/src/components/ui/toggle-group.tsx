import * as React from "react"
import * as ToggleGroupPrimitive from "@radix-ui/react-toggle-group"
import type { VariantProps } from "class-variance-authority"

import { buttonVariants } from "@/components/ui/button-variants"
import { segmentedControlClassName, segmentedItemBaseClassName, segmentedItemDataStateClassName } from "@/components/ui/segmented-control-classes"
import { SlidingSegmentIndicator } from "@/components/ui/sliding-segment-indicator"
import { useSlidingSegmentIndicator } from "@/components/ui/use-sliding-segment-indicator"
import { cn } from "@/lib/utils"

function ToggleGroup({
  className,
  variant = "ghost",
  size = "sm",
  children,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Root> &
  VariantProps<typeof buttonVariants>) {
  const { containerRef, indicatorStyle } = useSlidingSegmentIndicator<HTMLDivElement>()

  return (
    <ToggleGroupPrimitive.Root
      ref={containerRef}
      data-slot="toggle-group"
      data-variant={variant}
      data-size={size}
      className={cn("fd-segmented-control", segmentedControlClassName, className)}
      {...props}
    >
      <SlidingSegmentIndicator style={indicatorStyle} />
      {React.Children.map(children, (child) =>
        React.isValidElement(child)
          ? React.cloneElement(child as React.ReactElement<{ variant?: typeof variant; size?: typeof size }>, {
              variant,
              size,
            })
          : child
      )}
    </ToggleGroupPrimitive.Root>
  )
}

function ToggleGroupItem({
  className,
  variant = "ghost",
  size = "sm",
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Item> &
  VariantProps<typeof buttonVariants>) {
  return (
    <ToggleGroupPrimitive.Item
      data-slot="toggle-group-item"
      className={cn(
        buttonVariants({ variant, size }),
        segmentedItemBaseClassName,
        segmentedItemDataStateClassName,
        "border-0 bg-transparent shadow-none",
        className
      )}
      {...props}
    />
  )
}

export { ToggleGroup, ToggleGroupItem }
