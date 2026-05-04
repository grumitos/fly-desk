import * as React from "react"
import * as TabsPrimitive from "@radix-ui/react-tabs"

import { segmentedControlClassName, segmentedItemBaseClassName, segmentedItemDataStateClassName } from "@/components/ui/segmented-control-classes"
import { SlidingSegmentIndicator } from "@/components/ui/sliding-segment-indicator"
import { useSlidingSegmentIndicator } from "@/components/ui/use-sliding-segment-indicator"
import { cn } from "@/lib/utils"

function Tabs({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root data-slot="tabs" className={cn("flex flex-col", className)} {...props} />
}

function TabsList({ className, children, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  const { containerRef, indicatorStyle } = useSlidingSegmentIndicator<HTMLDivElement>()

  return (
    <TabsPrimitive.List
      ref={containerRef}
      data-slot="tabs-list"
      className={cn("fd-segmented-control", segmentedControlClassName, className)}
      {...props}
    >
      <SlidingSegmentIndicator style={indicatorStyle} />
      {children}
    </TabsPrimitive.List>
  )
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        segmentedItemBaseClassName,
        segmentedItemDataStateClassName,
        "font-bold",
        className
      )}
      {...props}
    />
  )
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("min-h-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent }
