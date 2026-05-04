const segmentedControlClassName =
  "inline-flex h-8 items-stretch overflow-hidden rounded-lg border border-input bg-secondary transition-[background-color,border-color,opacity,filter] duration-200 ease-out"

const segmentedItemBaseClassName =
  "relative z-10 inline-flex h-full min-h-8 transform-gpu items-center justify-center gap-1.5 px-3 text-xs font-semibold transition-[color,transform,opacity,filter] duration-150 focus-visible:relative focus-visible:z-10 focus-visible:outline-none focus-visible:ring-0 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-45 disabled:active:scale-100"

const segmentedItemActiveClassName = "font-bold text-foreground"

const segmentedItemInactiveClassName =
  "text-muted-foreground hover:text-foreground"

const segmentedItemDataStateClassName =
  "data-[state=active]:font-bold data-[state=active]:text-foreground data-[state=inactive]:text-muted-foreground data-[state=inactive]:hover:text-foreground data-[state=on]:font-bold data-[state=on]:text-foreground data-[state=off]:text-muted-foreground data-[state=off]:hover:text-foreground"

export {
  segmentedControlClassName,
  segmentedItemActiveClassName,
  segmentedItemBaseClassName,
  segmentedItemDataStateClassName,
  segmentedItemInactiveClassName,
}
