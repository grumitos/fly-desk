import type { SlidingIndicatorStyle } from "@/components/ui/use-sliding-segment-indicator"

export function SlidingSegmentIndicator({ style }: { style: SlidingIndicatorStyle }) {
  return <span aria-hidden="true" className="fd-segmented-indicator" style={style} />
}
