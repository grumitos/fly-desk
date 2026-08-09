import type { CSSProperties } from "react"
import { AppIcon } from "@/components/ui/app-icon"
import type { ActiveFilterChip } from "@/components/ResultsPanel"

/**
 * The strip of active constraints, and the way out of each one.
 *
 * One component with two mounting points, like `TripModeControls` (02 §4). On a
 * desk it lives under the list header as 26px chips; on a phone it is the
 * middle band of the retractable tools block, at the 44px touch minimum and
 * scrolling horizontally. It is the *same* strip either way — the geometry
 * comes from the container query, never from a `Mobile` copy of the component.
 *
 * The "Filtros" chip only exists where the filter column does not: on a desk
 * the panel is always on screen, so a button to open it would open nothing.
 */
export function ActiveFilterChips({
  chips,
  activeFilterCount,
  hiddenByFiltersCount,
  onOpenFilters,
  onRemoveFilter,
}: {
  chips: ActiveFilterChip[]
  activeFilterCount: number
  hiddenByFiltersCount: number
  onOpenFilters?: () => void
  onRemoveFilter?: (id: string) => void
}) {
  if (!onOpenFilters && chips.length === 0 && hiddenByFiltersCount === 0) return null

  /* On a phone the strip is a row of 07 §1: it enters 12px from the left with
     40ms between one item and the next. The position is counted here because
     the strip's first item is the «Filtros» button on a phone and the first
     chip on a desk, so `nth-child` would be counting two different things. */
  let position = 0
  const stagger = () => ({ "--fd-chip-index": position++ } as CSSProperties)

  return (
    <div className="fd-filter-strip">
      {onOpenFilters && (
        <button
          type="button"
          className="fd-filter-strip-open fd-focus-ring"
          aria-label="Abrir filtros"
          style={stagger()}
          onClick={onOpenFilters}
        >
          <AppIcon name="filters" size={14} />
          Filtros
          {activeFilterCount > 0 && (
            <span className="fd-filter-strip-count">{activeFilterCount}</span>
          )}
        </button>
      )}

      {chips.map((chip) => (
        <span key={chip.id} className="fd-active-chip fd-motion-emergente" style={stagger()}>
          {chip.label}
          {onRemoveFilter && (
            <button
              type="button"
              className="fd-active-chip-remove fd-focus-ring"
              aria-label={`Quitar filtro ${chip.label}`}
              onClick={() => onRemoveFilter(chip.id)}
            >
              <AppIcon name="x" size={14} />
            </button>
          )}
        </span>
      ))}

      {hiddenByFiltersCount > 0 && (
        <span className="fd-filter-strip-hidden" style={stagger()}>
          {hiddenByFiltersCount === 1
            ? "1 vuelo oculto por filtros"
            : `${hiddenByFiltersCount.toLocaleString("es-PE")} vuelos ocultos por filtros`}
        </span>
      )}
    </div>
  )
}
