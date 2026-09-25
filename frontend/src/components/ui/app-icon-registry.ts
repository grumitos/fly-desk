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

/* A cabin bag and a hold case, read without a label at 14px; lucide's nearest
   glyphs are a rucksack and a trolley. Round caps and joins, like the set. */
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

/* `arrowUp`/`arrowDown` are keyboard keys, not sort directions. */
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
  clipboard: Clipboard,
  clock: Clock,
  copy: Copy,
  externalLink: ExternalLink,
  filters: Funnel,
  filtersOff: FunnelX,
  flight: Plane,
  brandPlane: BrandPlane,
  list: ListChecks,
  loading: Loader2,
  location: MapPin,
  migration: ShieldCheck,
  minus: Minus,
  rotateCcw: RotateCcw,
  moon: Moon,
  oneWay: ArrowRight,
  edit: Pencil,
  passengers: Users,
  plus: Plus,
  roundTrip: ArrowRightLeft,
  search: Search,
  sun: Sun,
  swap: ArrowRightLeft,
  swapVertical: ArrowUpDown,
  x: X,
} satisfies Record<string, LucideIcon>

export type AppIconName = keyof typeof appIconRegistry
