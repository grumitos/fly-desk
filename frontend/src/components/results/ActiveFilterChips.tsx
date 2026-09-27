import type { CSSProperties } from "react"
import { AppIcon, type AppIconName } from "@/components/ui/app-icon"
import { Button } from "@/components/ui/button"
import type { ActiveFilterChip } from "@/components/ResultsPanel"
import { formatCount } from "@/lib/format"

/** A one-tap filter of the phone's row: the sheet's own state, on or off. */
export type QuickFilter = {
  /** The id of the chip it stands for while it is on. */
  id: string
  label: string
  /** The accessible name, which contains the label: «Salida mañana». */
  name: string
  icon?: AppIconName
  pressed: boolean
}

/*
 * The phone's filter row, the middle band of the retractable tools block
 * (plate 1d): «Filtros», the one-tap filters, one chip per other active
 * constraint, the hidden count, and the title bar's copy action, which has no
 * title bar to live in once a search exists. The row scrolls inside itself.
 * The icon sizes follow 7b: 18 at the 40px controls, 12 on the chip's cross,
 * which `index.css` lifts with the chip.
 */
export function ActiveFilterChips({
  chips,
  quickFilters,
  hiddenByFiltersCount,
  onOpenFilters,
  onRemoveFilter,
  onToggleQuickFilter,
  onCopySearchConfig,
  copyDisabled,
  copyConfirmed,
}: {
  chips: ActiveFilterChip[]
  quickFilters: QuickFilter[]
  hiddenByFiltersCount: number
  onOpenFilters: () => void
  onRemoveFilter: (id: string) => void
  onToggleQuickFilter: (id: string) => void
  onCopySearchConfig: () => void
  copyDisabled: boolean
  copyConfirmed: boolean
}) {
  /* 07 §1: items enter 40ms apart, counted here rather than by `nth-child`. */
  let position = 0
  const stagger = () => ({ "--i": position++ } as CSSProperties)
  /* A filter that is on is said once, by its pressed toggle. */
  const otherChips = chips.filter((chip) => !quickFilters.some((filter) => filter.pressed && filter.id === chip.id))

  return (
    <div className="fd-filter-strip">
      <button
        type="button"
        className="fd-filter-strip-open fd-focus-ring"
        aria-label="Abrir filtros"
        style={stagger()}
        onClick={onOpenFilters}
      >
        <AppIcon name="filters" size={18} />
        Filtros
        {chips.length > 0 && (
          <span className="fd-filter-strip-count">{chips.length}</span>
        )}
      </button>

      {quickFilters.map((filter) => (
        <Button
          key={filter.id}
          type="button"
          variant="secondary"
          className="fd-quick-filter"
          aria-label={filter.name}
          aria-pressed={filter.pressed}
          style={stagger()}
          onClick={() => onToggleQuickFilter(filter.id)}
        >
          {filter.icon && <AppIcon name={filter.icon} size={18} />}
          {filter.label}
        </Button>
      ))}

      {otherChips.map((chip) => (
        <span key={chip.id} className="fd-active-chip fd-motion-emergente" style={stagger()}>
          {chip.label}
          <button
            type="button"
            className="fd-active-chip-remove fd-focus-ring"
            aria-label={`Quitar filtro ${chip.label}`}
            onClick={() => onRemoveFilter(chip.id)}
          >
            <AppIcon name="x" size={12} />
          </button>
        </span>
      ))}

      {hiddenByFiltersCount > 0 && (
        /* «N vuelos ocultos»: the toggles and chips to its left already say by what. */
        <span className="fd-filter-strip-hidden" style={stagger()}>
          <span className="fd-count">{formatCount(hiddenByFiltersCount)}</span>{" "}
          {hiddenByFiltersCount === 1 ? "vuelo oculto" : "vuelos ocultos"}
        </span>
      )}

      {/* Pinned to the row's right edge; the chips scroll under it. Focusable
          while unavailable, so its title can say why. */}
      <button
        type="button"
        className="fd-filter-strip-copy fd-focus-ring"
        data-testid="filter-strip-copy"
        aria-label="Copiar configuración"
        title={copyDisabled
          ? "Completa una búsqueda para copiar la configuración"
          : copyConfirmed ? "Configuración copiada" : "Copiar configuración"}
        aria-disabled={copyDisabled || undefined}
        onClick={copyDisabled ? undefined : onCopySearchConfig}
      >
        <AppIcon name={copyConfirmed ? "check" : "copy"} size={18} />
      </button>
    </div>
  )
}
