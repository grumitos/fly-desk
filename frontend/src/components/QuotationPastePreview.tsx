import { AppIcon } from "@/components/ui/app-icon"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { SearchRequest } from "@/types"
import type {
  CommercialQuotationParseResult,
  TracedQuotationField,
} from "../../../src/core/quotation-parser"

interface QuotationPastePreviewProps {
  text: string
  result: CommercialQuotationParseResult
  onReview: (request: SearchRequest) => void
  onSearch: (request: SearchRequest) => void
}

interface PreviewField {
  label: string
  value: string
  note: string
  state: "parsed" | "ignored" | "missing"
}

export function QuotationPastePreview({
  text,
  result,
  onReview,
  onSearch,
}: QuotationPastePreviewProps) {
  const fields = buildPreviewFields(text, result)
  const readCount = fields.filter((field) => field.state !== "missing").length
  const draft = quotationDraftFromParse(result)
  const canSearch = quotationDraftCanSearch(result)
  const lineCount = text.split(/\r\n?|\n/).length

  return (
    <div className="fd-quotation-paste">
      <section className="fd-quotation-paste-source">
        <div className="fd-quotation-paste-section-head">
          <span className="fd-type-micro">Texto recibido</span>
          <span className="fd-mono text-xs font-semibold text-muted-foreground">
            {lineCount.toLocaleString("es-PE")} líneas
          </span>
        </div>
        <pre className="fd-quotation-paste-text">{text}</pre>
      </section>

      <section className="fd-quotation-paste-rebuild">
        <div className="fd-quotation-paste-section-head">
          <span className="fd-type-micro">Búsqueda reconstruida</span>
          <span className="fd-paste-read-count">
            <AppIcon name="check" size={12} />
            {readCount} de {fields.length} campos leídos
          </span>
        </div>

        <div className="fd-quotation-paste-fields fd-scrollbar-hidden">
          {fields.map((field) => (
            <div key={field.label} className="fd-quotation-paste-field" data-state={field.state}>
              <span className="fd-quotation-paste-field-icon" aria-hidden="true">
                <AppIcon
                  name={field.state === "parsed" ? "check" : field.state === "ignored" ? "alert" : "minus"}
                  size={14}
                />
              </span>
              <span className="min-w-0">
                <span className="fd-type-micro block">{field.label}</span>
                <span
                  className={cn(
                    "block truncate text-[13px] leading-[1.3]",
                    field.state === "missing" ? "font-normal text-muted-foreground" : "font-semibold text-foreground",
                  )}
                  title={field.value}
                >
                  {field.value}
                </span>
                <span className="block text-[11px] leading-[1.3] text-muted-foreground">{field.note}</span>
              </span>
            </div>
          ))}
        </div>

        <footer className="fd-quotation-paste-actions">
          <p className="fd-quotation-paste-warning">
            <AppIcon name="alert" size={14} />
            <span>La tarifa del texto no se reutiliza: se busca de nuevo</span>
          </p>
          <div className="flex items-center gap-2">
            <Button type="button" variant="secondary" className="h-9" onClick={() => onReview(draft)}>
              Revisar campos
            </Button>
            <Button
              type="button"
              className="h-9 flex-1"
              disabled={!canSearch}
              title={canSearch ? undefined : "Revisa los campos ausentes antes de buscar"}
              onClick={() => onSearch(draft)}
            >
              <AppIcon name="search" size={16} />
              Buscar con estos datos
            </Button>
          </div>
        </footer>
      </section>
    </div>
  )
}

function quotationDraftFromParse(result: CommercialQuotationParseResult): SearchRequest {
  const leg = result.request.legs?.[0]
  const passengers = result.request.passengers
  return {
    origin: leg?.origin ?? "",
    destination: leg?.destination ?? "",
    departureDate: leg?.departureDate,
    returnDate: leg?.returnDate,
    tripType: result.request.tripType ?? "round-trip",
    adults: passengers?.adults ?? 1,
    children: passengers?.children ?? 0,
    infants: passengers?.infants ?? 0,
    searchMode: "exact",
  }
}

function quotationDraftCanSearch(result: CommercialQuotationParseResult): boolean {
  const leg = result.request.legs?.[0]
  if (!leg?.origin || !leg.destination || !leg.departureDate || !result.request.tripType) return false
  return result.request.tripType === "one-way" || Boolean(leg.returnDate)
}

function buildPreviewFields(
  text: string,
  result: CommercialQuotationParseResult,
): PreviewField[] {
  const { fields } = result
  const routeState = combinedState([fields.origin, fields.destination, fields.tripType])
  const routeValue = fields.origin.state === "parsed" && fields.destination.state === "parsed"
    ? [
        fields.origin.value,
        fields.destination.value,
        fields.tripType.state === "parsed" && fields.tripType.value === "round-trip"
          ? fields.origin.value
          : null,
      ].filter(Boolean).join(" → ")
    : combinedReason([fields.origin, fields.destination, fields.tripType])
  const routeNote = fields.tripType.state === "parsed"
    ? fields.tripType.value === "round-trip" ? "ida y vuelta" : "solo ida"
    : "revisa el tipo de viaje"

  const dateFields: Array<TracedQuotationField<unknown>> = [fields.departureDate]
  if (fields.tripType.state !== "parsed" || fields.tripType.value === "round-trip") {
    dateFields.push(fields.returnDate)
  }
  const dateState = combinedState(dateFields)
  const dateValue = [fieldValue(fields.departureDate), fieldValue(fields.returnDate)]
    .filter(Boolean)
    .join(" → ") || combinedReason(dateFields)

  return [
    {
      label: "Ruta",
      value: routeValue,
      note: routeNote,
      state: routeState,
    },
    {
      label: "Fechas",
      value: dateValue,
      note: dateState === "parsed" ? "se usarán para una búsqueda exacta" : combinedReason(dateFields),
      state: dateState,
    },
    fields.passengers.state === "parsed"
      ? {
          label: "Pasajeros",
          value: passengerLabel(fields.passengers.value),
          note: "se usarán en la búsqueda nueva",
          state: "parsed",
        }
      : {
          label: "Pasajeros",
          value: "1 adulto",
          note: "no figura en el texto; se usará el valor inicial del formulario",
          state: "missing",
        },
    previewTraceField(
      text,
      "Aerolínea",
      fields.airline,
      sourceLine(text, fields.airline),
      "leída como referencia; no se convierte en filtro",
    ),
    previewTraceField(
      text,
      "Tarifa del texto",
      fields.price,
      sourceLine(text, fields.price),
      "solo referencia; nunca se hereda",
    ),
    previewTraceField(
      text,
      "Escalas y equipaje",
      fields.stops,
      sourceLine(text, fields.stops) || "No están completos en el texto",
      "quedan sin filtro en la búsqueda nueva",
    ),
  ]
}

function previewTraceField<T>(
  text: string,
  label: string,
  field: TracedQuotationField<T>,
  parsedValue: string,
  note: string,
): PreviewField {
  if (field.state === "parsed") {
    return { label, value: parsedValue, note, state: "parsed" }
  }
  if (field.state === "ignored") {
    return {
      label,
      value: sourceLine(text, field) || "Leído en el texto",
      note,
      state: "ignored",
    }
  }
  return {
    label,
    value: parsedValue || "No está en el texto",
    note: field.reason,
    state: "missing",
  }
}

function combinedState(fields: Array<TracedQuotationField<unknown>>): PreviewField["state"] {
  if (fields.every((field) => field.state === "parsed" || field.state === "ignored")) {
    return fields.some((field) => field.state === "ignored") ? "ignored" : "parsed"
  }
  return "missing"
}

function combinedReason(fields: Array<TracedQuotationField<unknown>>): string {
  const field = fields.find((candidate) => candidate.state !== "parsed" && candidate.state !== "ignored")
  return field && "reason" in field ? field.reason : "Campo leído"
}

function fieldValue<T>(field: TracedQuotationField<T>): string {
  return field.state === "parsed" ? String(field.value) : ""
}

function sourceLine<T>(text: string, field: TracedQuotationField<T>): string {
  if (!field.source) return ""
  const line = text.split(/\r\n?|\n/)[field.source.line - 1]?.trim() ?? ""
  const colon = line.indexOf(":")
  return colon >= 0 ? line.slice(colon + 1).trim() : line
}

function passengerLabel(passengers: { adults?: number; children?: number; infants?: number }): string {
  const parts = [
    passengers.adults ? `${passengers.adults} adulto${passengers.adults === 1 ? "" : "s"}` : "",
    passengers.children ? `${passengers.children} niño${passengers.children === 1 ? "" : "s"}` : "",
    passengers.infants ? `${passengers.infants} bebé${passengers.infants === 1 ? "" : "s"}` : "",
  ].filter(Boolean)
  return parts.join(" · ") || "1 adulto"
}
