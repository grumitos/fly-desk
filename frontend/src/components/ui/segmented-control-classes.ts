/*
 * The segmented control from plates 1a/1b: 32px tall, radius 10, on secondary,
 * with the active pill drawn by an indicator inset 2px at radius 8. Labels are
 * 12px — 600 when off, 700 when on. Movement is colour only (`tacto`).
 */
const segmentedControlClassName =
  "inline-flex h-8 items-stretch overflow-hidden rounded-lg border border-input bg-secondary transition-[background-color,border-color,opacity] duration-[90ms] ease-[cubic-bezier(0.2,0,0.4,1)]"

/* `h-full` and nothing else: the track is 32px including its 1px border, so an
   item that also claimed a 32px minimum was 1px taller than the box it sits in
   and its label rode 1px below the centre of the pill the indicator draws. */
const segmentedItemBaseClassName =
  "relative z-10 inline-flex h-full items-center justify-center gap-1.5 px-3.5 text-xs font-semibold transition-[color,opacity] duration-[90ms] ease-[cubic-bezier(0.2,0,0.4,1)] focus-visible:relative focus-visible:z-10 focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_2px_color-mix(in_srgb,var(--color-primary)_55%,transparent)] disabled:pointer-events-none disabled:opacity-45"

const segmentedItemDataStateClassName =
  "data-[state=active]:font-bold data-[state=active]:text-foreground data-[state=inactive]:text-muted-foreground data-[state=inactive]:hover:text-foreground data-[state=on]:font-bold data-[state=on]:text-foreground data-[state=off]:text-muted-foreground data-[state=off]:hover:text-foreground"

export {
  segmentedControlClassName,
  segmentedItemBaseClassName,
  segmentedItemDataStateClassName,
}
