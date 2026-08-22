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
 *
 * Copy travels the same way. Once a search exists there is no title bar on a
 * phone to keep it in — the brand, the theme switch and the 48px they sat on
 * are the first thing a screen this size should spend on the results — so the
 * one action worth keeping moves to the free end of this row. It is given, not
 * assumed: the desk mount passes no handler and grows no button.
 */
export function ActiveFilterChips({
  chips,
  activeFilterCount,
  hiddenByFiltersCount,
  onOpenFilters,
  onRemoveFilter,
  onCopySearchConfig,
  copyDisabled = false,
}: {
  chips: ActiveFilterChip[]
  activeFilterCount: number
  hiddenByFiltersCount: number
  onOpenFilters?: () => void
  onRemoveFilter?: (id: string) => void
  /** Phone only: the title bar's copy action, rehoused at the end of the row. */
  onCopySearchConfig?: () => void
  copyDisabled?: boolean
}) {
  if (!onOpenFilters && !onCopySearchConfig && chips.length === 0 && hiddenByFiltersCount === 0) return null

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

      {/* Last in the row and pinned to its right edge: the chips scroll under
          it rather than carrying it out of reach, which is the whole reason
          this row had room to spare in the first place. */}
      {onCopySearchConfig && (
        <button
          type="button"
          className="fd-filter-strip-copy fd-focus-ring"
          data-testid="filter-strip-copy"
          aria-label="Copiar configuración"
          title={copyDisabled
            ? "Completa una búsqueda para copiar la configuración"
            : "Copiar configuración"}
          disabled={copyDisabled}
          onClick={onCopySearchConfig}
        >
          <AppIcon name="copy" size={16} />
        </button>
      )}
    </div>
  )
}
