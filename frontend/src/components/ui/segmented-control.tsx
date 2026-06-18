import {
  segmentedControlClassName,
  segmentedItemBaseClassName,
  segmentedItemDataStateClassName,
} from "@/components/ui/segmented-control-classes"
import { SlidingSegmentIndicator } from "@/components/ui/sliding-segment-indicator"
import {
  ToggleGroup,
  ToggleGroupItem,
  type ToggleGroupMultipleProps,
} from "@/components/ui/toggle-group"
import { useSlidingSegmentIndicator } from "@/components/ui/use-sliding-segment-indicator"
import { cn } from "@/lib/utils"

type SegmentedControlProps = Omit<
  ToggleGroupMultipleProps,
  "defaultValue" | "onValueChange" | "type" | "value"
> & {
  onValueChange?: (value: string) => void
  value: string
}

function SegmentedControl({
  children,
  disabled = false,
  className,
  onValueChange,
  value,
  ...props
}: SegmentedControlProps) {
  const { containerRef, indicatorStyle } = useSlidingSegmentIndicator<HTMLDivElement>()

  return (
    <ToggleGroup
      ref={containerRef}
      type="multiple"
      value={[value]}
      onValueChange={(values) => {
        const nextValue = values.find((candidate) => candidate !== value)
        if (nextValue) onValueChange?.(nextValue)
      }}
      aria-disabled={disabled}
      disabled={disabled}
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
    </ToggleGroup>
  )
}

function SegmentButton({ className, ...props }: React.ComponentProps<typeof ToggleGroupItem>) {
  return (
    <ToggleGroupItem
      className={cn(
        segmentedItemBaseClassName,
        segmentedItemDataStateClassName,
        className,
      )}
      {...props}
    />
  )
}

export { SegmentButton, SegmentedControl }
