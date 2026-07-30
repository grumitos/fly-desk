import {
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  ArrowRightLeft,
  ArrowUp,
  ArrowUpDown,
  Backpack,
  Briefcase,
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
  Layers,
  ListChecks,
  Loader2,
  Luggage,
  MapPin,
  Minus,
  Moon,
  PanelRight,
  Plane,
  PlaneTakeoff,
  Plus,
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
  backpack: Backpack,
  luggage: Luggage,
  baggage: Briefcase,
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
  flight: Plane,
  brandPlane: BrandPlane,
  list: ListChecks,
  loading: Loader2,
  location: MapPin,
  migration: ShieldCheck,
  minus: Minus,
  moon: Moon,
  oneWay: ArrowRight,
  passengers: Users,
  plus: Plus,
  roundTrip: ArrowRightLeft,
  search: Search,
  sun: Sun,
  swap: ArrowRightLeft,
  x: X,
} satisfies Record<string, LucideIcon>

export type AppIconName = keyof typeof appIconRegistry
