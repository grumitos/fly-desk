import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode, type RefObject } from "react"
import {
  ArrowRight,
  ArrowRightLeft,
  Calendar,
  ChevronDown,
  Minus,
  Plus,
  Search,
  Users,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { useAutocomplete } from "@/hooks/useAutocomplete"
import type { LocationSuggestion, SearchRequest, SortMode } from "@/types"

interface SearchShellProps {
  onSearch: (req: SearchRequest, sort?: SortMode) => void
  loading: boolean
}

export function SearchShell({ onSearch, loading }: SearchShellProps) {
  const [mode] = useState<"exact" | "flexible">("exact")
  const [trip, setTrip] = useState<"round-trip" | "one-way">("round-trip")
  const [originCode, setOriginCode] = useState("")
  const [destCode, setDestCode] = useState("")
  const [departureDate, setDepartureDate] = useState("")
  const [returnDate, setReturnDate] = useState("")
  const [adults, setAdults] = useState(1)
  const [children, setChildren] = useState(0)
  const [infants, setInfants] = useState(0)
  const [paxOpen, setPaxOpen] = useState(false)

  const origin = useAutocomplete("origin", (suggestion) => setOriginCode(suggestion.code))
  const destination = useAutocomplete("destination", (suggestion) => setDestCode(suggestion.code))
  const paxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (paxRef.current && !paxRef.current.contains(e.target as Node)) setPaxOpen(false)
    }
    document.addEventListener("mousedown", onDocClick)
    return () => document.removeEventListener("mousedown", onDocClick)
  }, [])

  const swapRoute = () => {
    setOriginCode(destCode)
    setDestCode(originCode)
    origin.setQuery(destination.query)
    destination.setQuery(origin.query)
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    const [resolvedOrigin, resolvedDestination] = await Promise.all([
      origin.resolveCurrentQuery(),
      destination.resolveCurrentQuery(),
    ])
    const request: SearchRequest = {
      origin: (resolvedOrigin?.code ?? originCode).toUpperCase().trim(),
      destination: (resolvedDestination?.code ?? destCode).toUpperCase().trim(),
      departureDate: departureDate || undefined,
      returnDate: trip === "round-trip" ? returnDate || undefined : undefined,
      tripType: trip,
      adults,
      children,
      infants,
      searchMode: "exact",
    }
    onSearch(request)
  }

  const passengerTotal = adults + children + infants
  const tripTabs: { key: typeof trip; label: string; icon: ReactNode }[] = [
    { key: "round-trip", label: "Ida y vuelta", icon: <ArrowRightLeft className="h-3.5 w-3.5" /> },
    { key: "one-way", label: "Solo ida", icon: <ArrowRight className="h-3.5 w-3.5" /> },
  ]

  return (
    <section className="fd-panel overflow-visible p-2">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 px-1">
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl>
            <SegmentButton active={mode === "exact"} onClick={() => undefined}>
              Exacto
            </SegmentButton>
            <SegmentButton active={mode === "flexible"} disabled onClick={() => undefined}>
              Flexible
            </SegmentButton>
          </SegmentedControl>

          <SegmentedControl>
            {tripTabs.map((item) => (
              <SegmentButton key={item.key} active={trip === item.key} onClick={() => setTrip(item.key)}>
                {item.icon}
                {item.label}
              </SegmentButton>
            ))}
          </SegmentedControl>
        </div>

      </div>

      <form onSubmit={handleSubmit}>
        <div className="grid grid-cols-1 gap-1 lg:grid-cols-[minmax(150px,1.2fr)_36px_minmax(150px,1.2fr)_minmax(130px,.85fr)_minmax(130px,.85fr)_minmax(150px,.9fr)_128px]">
          <LocationField
            label="Origen"
            value={origin.query}
            inputRef={origin.inputRef}
            suggestions={origin.suggestions}
            open={origin.open}
            activeIndex={origin.activeIndex}
            placeholder="Ciudad o IATA"
            roundedClass="lg:rounded-l-lg"
            onFocus={() => origin.setOpen(true)}
            onBlur={origin.resolveCurrentQuery}
            onKeyDown={origin.onKeyDown}
            onChange={(value) => {
              origin.setQuery(value)
              setOriginCode(value)
              origin.setOpen(true)
            }}
            onSelect={(suggestion) => {
              origin.selectSuggestion(suggestion)
              setOriginCode(suggestion.code)
            }}
          />

          <div className="hidden items-center justify-center lg:flex">
            <button
              type="button"
              onClick={swapRoute}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-secondary text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Intercambiar ruta"
            >
              <ArrowRightLeft className="h-3.5 w-3.5" />
            </button>
          </div>

          <LocationField
            label="Destino"
            value={destination.query}
            inputRef={destination.inputRef}
            suggestions={destination.suggestions}
            open={destination.open}
            activeIndex={destination.activeIndex}
            placeholder="Ciudad o IATA"
            onFocus={() => destination.setOpen(true)}
            onBlur={destination.resolveCurrentQuery}
            onKeyDown={destination.onKeyDown}
            onChange={(value) => {
              destination.setQuery(value)
              setDestCode(value)
              destination.setOpen(true)
            }}
            onSelect={(suggestion) => {
              destination.selectSuggestion(suggestion)
              setDestCode(suggestion.code)
            }}
          />

          <DateField label="Salida" value={departureDate} onChange={setDepartureDate} />
          {trip === "round-trip" ? (
            <DateField label="Regreso" value={returnDate} onChange={setReturnDate} />
          ) : (
            <div className="hidden lg:block" />
          )}

          <div className="relative" ref={paxRef}>
            <label className="fd-label absolute left-3 top-2 z-10">Pasajeros</label>
            <button
              type="button"
              aria-label="Seleccionar pasajeros"
              onClick={() => setPaxOpen((value) => !value)}
              className="fd-control flex h-14 w-full items-end gap-2 px-3 pb-2.5 pt-6 text-left"
            >
              <Users className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 text-sm font-semibold">
                {passengerTotal} pasajero{passengerTotal > 1 ? "s" : ""}
              </span>
              <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${paxOpen ? "rotate-180" : ""}`} />
            </button>

            {paxOpen && (
              <div className="absolute right-0 z-50 mt-1 w-72 rounded-xl border border-border bg-popover p-2 text-popover-foreground shadow-lg">
                <PaxRow label="Adultos" detail="12+ años" value={adults} onInc={() => setAdults((v) => Math.min(v + 1, 9))} onDec={() => setAdults((v) => Math.max(v - 1, 1))} />
                <PaxRow label="Niños" detail="2-11 años" value={children} onInc={() => setChildren((v) => Math.min(v + 1, 8))} onDec={() => setChildren((v) => Math.max(v - 1, 0))} />
                <PaxRow label="Bebés" detail="Menos de 2 años" value={infants} onInc={() => setInfants((v) => Math.min(v + 1, adults))} onDec={() => setInfants((v) => Math.max(v - 1, 0))} />
              </div>
            )}
          </div>

          <Button
            type="submit"
            disabled={loading}
            className="h-14 rounded-lg text-sm"
          >
            <Search className="h-4 w-4" />
            {loading ? "Buscando" : "Buscar"}
          </Button>
        </div>
      </form>

    </section>
  )
}

function LocationField({
  label,
  value,
  inputRef,
  suggestions,
  open,
  activeIndex,
  placeholder,
  roundedClass = "",
  onFocus,
  onBlur,
  onKeyDown,
  onChange,
  onSelect,
}: {
  label: string
  value: string
  inputRef: RefObject<HTMLInputElement | null>
  suggestions: LocationSuggestion[]
  open: boolean
  activeIndex: number
  placeholder: string
  roundedClass?: string
  onFocus: () => void
  onBlur: () => void | Promise<unknown>
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void
  onChange: (value: string) => void
  onSelect: (suggestion: LocationSuggestion) => void
}) {
  const fieldId = `location-${label.toLowerCase()}`
  const listboxId = `${fieldId}-suggestions`
  const activeOptionId = activeIndex >= 0 && suggestions[activeIndex]
    ? `${listboxId}-${activeIndex}`
    : undefined

  return (
    <div className="relative">
      <label htmlFor={fieldId} className="fd-label absolute left-3 top-2 z-10">{label}</label>
      <input
        id={fieldId}
        ref={inputRef}
        aria-label={label}
        aria-autocomplete="list"
        aria-controls={listboxId}
        aria-expanded={open && suggestions.length > 0}
        aria-activedescendant={activeOptionId}
        autoComplete="off"
        name={fieldId}
        role="combobox"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onFocus={onFocus}
        onBlur={() => {
          void onBlur()
        }}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        className={`fd-control h-14 w-full px-3 pb-2.5 pt-6 text-sm font-semibold placeholder:text-muted-foreground/60 ${roundedClass}`}
      />
      {open && suggestions.length > 0 && (
        <div id={listboxId} role="listbox" className="absolute z-50 mt-1 max-h-72 w-full overflow-auto rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-lg">
          {suggestions.map((suggestion, index) => (
            <button
              id={`${listboxId}-${index}`}
              key={`${suggestion.code}-${index}`}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              onMouseDown={() => onSelect(suggestion)}
              className={`w-full rounded-lg px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                index === activeIndex ? "bg-accent text-accent-foreground" : "hover:bg-muted"
              }`}
            >
              <div className="font-bold">{suggestion.code}</div>
              <div className="truncate text-xs text-muted-foreground">{suggestion.label}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function DateField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <div className="relative">
      <label className="fd-label absolute left-3 top-2 z-10">{label}</label>
      <div className="fd-control flex h-14 items-end gap-2 px-3 pb-2.5 pt-6">
        <Calendar className="h-4 w-4 shrink-0 text-muted-foreground" />
        <input
          type="date"
          aria-label={label}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="h-5 min-w-0 flex-1 appearance-none bg-transparent text-sm font-semibold outline-none"
        />
      </div>
    </div>
  )
}

function SegmentedControl({ children }: { children: ReactNode }) {
  return (
    <div className="inline-flex items-center rounded-lg border border-input bg-secondary p-0.5">
      {children}
    </div>
  )
}

function SegmentButton({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      disabled={disabled}
      className={`inline-flex h-7 items-center justify-center gap-1.5 rounded-md px-2.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        active ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-muted-foreground"
      }`}
    >
      {children}
    </button>
  )
}

function PaxRow({
  label,
  detail,
  value,
  onInc,
  onDec,
}: {
  label: string
  detail: string
  value: number
  onInc: () => void
  onDec: () => void
}) {
  return (
    <div className="flex items-center justify-between rounded-lg px-2 py-2 hover:bg-muted">
      <div>
        <div className="text-sm font-semibold">{label}</div>
        <div className="text-xs text-muted-foreground">{detail}</div>
      </div>
      <div className="flex items-center gap-2">
        <button type="button" onClick={onDec} aria-label={`Quitar ${label.toLowerCase()}`} className="fd-control inline-flex h-8 w-8 items-center justify-center">
          <Minus className="h-3.5 w-3.5" />
        </button>
        <span className="w-6 text-center font-mono text-sm font-bold">{value}</span>
        <button type="button" onClick={onInc} aria-label={`Agregar ${label.toLowerCase()}`} className="fd-control inline-flex h-8 w-8 items-center justify-center">
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}
