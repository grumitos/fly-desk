import * as React from "react"
import * as ToggleGroupPrimitive from "@radix-ui/react-toggle-group"
import type { VariantProps } from "class-variance-authority"

import { buttonVariants } from "@/components/ui/button-variants"
import { segmentedControlClassName, segmentedItemBaseClassName, segmentedItemDataStateClassName } from "@/components/ui/segmented-control-classes"
import { cn } from "@/lib/utils"

function ToggleGroup({
  className,
  variant = "ghost",
  size = "sm",
  children,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Root> &
  VariantProps<typeof buttonVariants>) {
  return (
    <ToggleGroupPrimitive.Root
      data-slot="toggle-group"
      data-variant={variant}
      data-size={size}
      className={cn(segmentedControlClassName, className)}
      {...props}
    >
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
