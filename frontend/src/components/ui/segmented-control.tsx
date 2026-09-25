import { Children, isValidElement, useCallback, useId, useRef, type ReactNode } from "react"
import { AppIcon, type AppIconName } from "@/components/ui/app-icon"
import { cn } from "@/lib/utils"

/* A radio group of options that share the free space evenly. The active pill
   is the item's own `::before`, so it changes place without sliding and
   without measuring the DOM. */

type SegmentedOptionProps = {
  value: string
  children: ReactNode
  icon?: AppIconName
  "aria-label"?: string
}

/* Declarative only: `SegmentedControl` renders the buttons, so the roving tab
   order lives in one place. */
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

  /* Radio semantics: the arrows move and choose. */
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
