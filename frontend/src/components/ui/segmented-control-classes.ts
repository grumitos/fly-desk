const segmentedControlClassName =
  "inline-flex h-8 items-stretch overflow-hidden rounded-lg border border-input bg-secondary transition-[background-color,border-color,opacity,filter] duration-200 ease-out"

const segmentedItemBaseClassName =
  "inline-flex h-full min-h-8 transform-gpu items-center justify-center gap-1.5 px-3 text-xs font-semibold transition-[background-color,color,box-shadow,transform,opacity,filter] duration-150 focus-visible:relative focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.98] disabled:pointer-events-none disabled:opacity-45 disabled:active:scale-100"

const segmentedItemActiveClassName = "rounded-[7px] bg-card text-foreground"

const segmentedItemInactiveClassName =
  "text-muted-foreground first:rounded-l-[7px] last:rounded-r-[7px] hover:rounded-[7px] hover:bg-accent/50 hover:text-foreground"

const segmentedItemDataStateClassName =
  "data-[state=active]:rounded-[7px] data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=inactive]:text-muted-foreground data-[state=inactive]:hover:rounded-[7px] data-[state=inactive]:hover:bg-accent/50 data-[state=inactive]:hover:text-foreground first:data-[state=inactive]:rounded-l-[7px] last:data-[state=inactive]:rounded-r-[7px] data-[state=on]:rounded-[7px] data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=off]:text-muted-foreground data-[state=off]:hover:rounded-[7px] data-[state=off]:hover:bg-accent/50 data-[state=off]:hover:text-foreground first:data-[state=off]:rounded-l-[7px] last:data-[state=off]:rounded-r-[7px]"

export {
  segmentedControlClassName,
  segmentedItemActiveClassName,
  segmentedItemBaseClassName,
  segmentedItemDataStateClassName,
  segmentedItemInactiveClassName,
}
