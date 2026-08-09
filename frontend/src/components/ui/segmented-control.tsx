import { Children, isValidElement, useCallback, useId, useRef, type ReactNode } from "react"
import { AppIcon, type AppIconName } from "@/components/ui/app-icon"
import { cn } from "@/lib/utils"

/*
 * The segmented control, closed by 01 §3 and 11 §8.
 *
 * Two decisions carry the whole component:
 *
 * 1. `grid-template-columns: repeat(var(--fd-segments), auto)` — the cells
 *    measure by content and the leftover is split evenly, so every option
 *    breathes the same. With `1fr` the cells match and the air does not: in the
 *    248px filter column "Bodega" (icon + label, 65px) was left with 4px a side
 *    while "Todos" (36px) got 19. With `auto` all three get 11px.
 *
 * 2. The pill is the `::before` of the active item, not a floating element that
 *    slides between them. 07 §5 is explicit: the pill changes place with
 *    `tacto`, it does not travel. A sliding indicator also has to measure the
 *    DOM to know where to go, which is a layout read on every render for an
 *    effect the plates never asked for.
 */

type SegmentedOptionProps = {
  value: string
  children: ReactNode
  icon?: AppIconName
  "aria-label"?: string
}

/* Declarative only: `SegmentedControl` reads these props and renders the
   buttons itself, so the roving tab order lives in one place instead of in
   every call site. */
export function SegmentedOption(props: SegmentedOptionProps) {
  void props
  return null
}

export function SegmentedControl({
  value,
  onValueChange,
  children,
  className,
  disabled = false,
  iconSize = 16,
  "aria-label": ariaLabel,
}: {
  value: string
  onValueChange?: (value: string) => void
  children: ReactNode
  className?: string
  disabled?: boolean
  iconSize?: 14 | 16 | 18
  "aria-label"?: string
}) {
  const groupId = useId()
  const listRef = useRef<HTMLDivElement | null>(null)

  const options = Children.toArray(children).filter(
    (child): child is React.ReactElement<SegmentedOptionProps> =>
      isValidElement<SegmentedOptionProps>(child),
  )

  /* Radio semantics: the arrows move *and* choose, which is what a segmented
     control means — there is no "highlighted but not applied" state here, and
     11 §0 rule 2 only forbids confirming without a gesture; an arrow key is
     one. */
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const step = event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0
      if (step === 0) return

      event.preventDefault()
      const current = options.findIndex((option) => option.props.value === value)
      const next = options[(current + step + options.length) % options.length]
      if (!next) return

      onValueChange?.(next.props.value)
      listRef.current
        ?.querySelector<HTMLButtonElement>(`[data-segment="${CSS.escape(next.props.value)}"]`)
        ?.focus()
    },
    [onValueChange, options, value],
  )

  return (
    <div
      ref={listRef}
      role="radiogroup"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      className={cn("fd-segmented", disabled && "fd-disabled", className)}
      style={{ "--fd-segments": options.length } as React.CSSProperties}
      onKeyDown={handleKeyDown}
    >
      {options.map((option) => {
        const active = option.props.value === value
        return (
          <button
            key={option.props.value}
            type="button"
            role="radio"
            id={`${groupId}-${option.props.value}`}
            data-segment={option.props.value}
            data-state={active ? "on" : "off"}
            aria-checked={active}
            aria-label={option.props["aria-label"]}
            tabIndex={active ? 0 : -1}
            disabled={disabled}
            className="fd-segmented-item"
            onClick={() => onValueChange?.(option.props.value)}
          >
            {option.props.icon && <AppIcon name={option.props.icon} size={iconSize} />}
            {option.props.children}
          </button>
        )
      })}
    </div>
  )
}
