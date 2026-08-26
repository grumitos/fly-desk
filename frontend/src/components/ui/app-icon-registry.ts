import {
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  ArrowRightLeft,
  ArrowUp,
  ArrowUpDown,
  Calendar,
  Check,
  CornerDownLeft,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronsLeft,
  ChevronsRight,
  Clipboard,
  Clock,
  Copy,
  ExternalLink,
  Funnel,
  FunnelX,
  Layers,
  ListChecks,
  Loader2,
  MapPin,
  Minus,
  Moon,
  PanelRight,
  Pencil,
  Plane,
  PlaneTakeoff,
  Plus,
  RotateCcw,
  Search,
  ShieldCheck,
  Sun,
  Users,
  X,
  type LucideIcon,
  type LucideProps,
} from "lucide-react"
import { createElement, forwardRef } from "react"

const BrandPlane = forwardRef<SVGSVGElement, LucideProps>(function BrandPlane(
  { color = "currentColor", size = 24, strokeWidth: _strokeWidth, absoluteStrokeWidth: _absoluteStrokeWidth, ...props },
  ref,
) {
  void _strokeWidth
  void _absoluteStrokeWidth

  return createElement(
    "svg",
    {
      ...props,
      ref,
      xmlns: "http://www.w3.org/2000/svg",
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      fill: "none",
      color,
    },
    createElement("path", { key: "canvas", stroke: "none", d: "M0 0h24v24H0z", fill: "none" }),
    createElement("path", {
      key: "body",
      fill: color,
      fillRule: "evenodd",
      clipRule: "evenodd",
      d: "M21.96 3.05c.76-.3 1.51.42 1.25 1.19l-5.36 15.7c-.26.77-1.24.98-1.79.38l-4.2-4.57-2.45 3.43c-.47.66-1.5.44-1.67-.36l-1.02-4.9-4.52-1.5c-.84-.28-.88-1.46-.05-1.78l19.81-7.59ZM19.46 6.45l-10.3 6.2 3.25 1.07 7.05-7.27Zm-5.94 8.62 2.86 3.13 2.75-8.12-5.61 4.99Z",
    }),
  )
}) as LucideIcon

/**
 * The two baggage marks, drawn here rather than taken from lucide.
 *
 * Every plate in the set draws the same two — `Main`, `Movil`,
 * `MovilCompacta`, `MovilDetalle`, and the `Actual` they replace: a soft cabin
 * bag with a hoop handle, and a plain hold case with a flat one. Lucide's
 * nearest neighbours are a rucksack with shoulder straps and a wheeled trolley
 * with a telescopic handle, and those are what the row, the detail panel and
 * the baggage filter have been drawing. They are the one mark on the row that
 * an agent reads without a label, at 14px, twice per fare.
 *
 * Caps and joins are the system's round and not the plate's default: the plate
 * sets neither, so it took SVG's, which is an omission rather than a drawing
 * decision — and a second cap convention inside a closed pictogram family is a
 * cost with nothing on the other side of it.
 */
function bagIcon(displayName: string, shapes: Array<[string, Record<string, string | number>]>): LucideIcon {
  const Icon = forwardRef<SVGSVGElement, LucideProps>(function BagIcon(
    { color = "currentColor", size = 24, strokeWidth = 2, absoluteStrokeWidth: _absoluteStrokeWidth, ...props },
    ref,
  ) {
    void _absoluteStrokeWidth

    return createElement(
      "svg",
      {
        ...props,
        ref,
        xmlns: "http://www.w3.org/2000/svg",
        width: size,
        height: size,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: color,
        strokeWidth,
        strokeLinecap: "round",
        strokeLinejoin: "round",
      },
      ...shapes.map(([tag, attributes], index) => createElement(tag, { key: index, ...attributes })),
    )
  })
  Icon.displayName = displayName
  return Icon as LucideIcon
}

const CabinBag = bagIcon("CabinBag", [
  ["path", { d: "M7 8h10a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z" }],
  ["path", { d: "M9 8V6a3 3 0 0 1 6 0v2" }],
])

const HoldBag = bagIcon("HoldBag", [
  ["rect", { x: 5, y: 7, width: 14, height: 14, rx: 2 }],
  ["path", { d: "M9 7V4h6v3" }],
])

/*
 * Plate 7b closes the pictogram families. Each glyph has exactly one meaning, so
 * that the agent does not have to read the label to know what a control does:
 *
 *   chevron  something opens or closes in place. Never movement.
 *   arrow    direction or travel: a flight leg, an order, going back, navigating.
 *   check    confirmation: included, selected, applied.
 *   ✗ (aspa)  close or remove. Never "error" — errors carry their own colour and
 *            their own words.
 *
 * `arrowDown` is the keyboard arrow, not a sort direction; sorting is a
 * segmented control with words on it.
 */
export const appIconRegistry = {
  alert: AlertTriangle,
  sort: ArrowUpDown,
  arrowUp: ArrowUp,
  arrowDown: ArrowDown,
  enter: CornerDownLeft,
  cabinBag: CabinBag,
  holdBag: HoldBag,
  calendar: Calendar,
  cityGroup: Layers,
  airport: PlaneTakeoff,
  check: Check,
  chevronDown: ChevronDown,
  chevronLeft: ChevronLeft,
  chevronRight: ChevronRight,
  chevronUp: ChevronUp,
  chevronsLeft: ChevronsLeft,
  chevronsRight: ChevronsRight,
  clipboard: Clipboard,
  clock: Clock,
  copy: Copy,
  detail: PanelRight,
  externalLink: ExternalLink,
  filters: Funnel,
  /* Plate 2g: the list emptied *by a filter*, which is a different problem from
     a search that found nothing — and gets a different glyph and different
     words. */
  filtersOff: FunnelX,
  flight: Plane,
  brandPlane: BrandPlane,
  list: ListChecks,
  loading: Loader2,
  location: MapPin,
  migration: ShieldCheck,
  minus: Minus,
  /* Plate 3c: «Reintentar» after a quotation the provider did not confirm. */
  rotateCcw: RotateCcw,
  moon: Moon,
  oneWay: ArrowRight,
  /* Plate 1d: the way back into the search from the mobile summary. */
  edit: Pencil,
  passengers: Users,
  plus: Plus,
  roundTrip: ArrowRightLeft,
  search: Search,
  sun: Sun,
  swap: ArrowRightLeft,
  /* Plate 1c: stacked fields need a stacked arrow. Same job, same component —
     only the axis follows the layout (see `<SwapIcon>`). */
  swapVertical: ArrowUpDown,
  x: X,
} satisfies Record<string, LucideIcon>

export type AppIconName = keyof typeof appIconRegistry
