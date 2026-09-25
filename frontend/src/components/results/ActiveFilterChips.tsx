import type { CSSProperties } from "react"
import { AppIcon } from "@/components/ui/app-icon"
import type { ActiveFilterChip } from "@/components/ResultsPanel"
import { formatCount } from "@/lib/format"

/*
 * The phone's filter row, the middle band of the retractable tools block
 * (plate 1d): «Filtros», one chip per active constraint, the hidden count, and
 * the title bar's copy action, which has no title bar to live in once a search
 * exists. The icon sizes follow 7b: 18 at the 40px controls, 12 on the chip's
 * cross, which `index.css` lifts with the chip.
 */
export function ActiveFilterChips({
  chips,
  hiddenByFiltersCount,
  onOpenFilters,
  onRemoveFilter,
  onCopySearchConfig,
  copyDisabled,
  copyConfirmed,
}: {
  chips: ActiveFilterChip[]
  hiddenByFiltersCount: number
  onOpenFilters: () => void
  onRemoveFilter: (id: string) => void
  onCopySearchConfig: () => void
  copyDisabled: boolean
  copyConfirmed: boolean
}) {
  /* 07 §1: items enter 40ms apart, counted here rather than by `nth-child`. */
  let position = 0
  const stagger = () => ({ "--fd-chip-index": position++ } as CSSProperties)

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

      {chips.map((chip) => (
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
        /* «N vuelos ocultos»: the chips to its left already say by what. */
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
