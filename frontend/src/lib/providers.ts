export function providerDisplayName(providerId?: string | null): string {
  const normalized = String(providerId ?? "").trim().toLowerCase()

  if (!normalized) return "Proveedor"
  if (normalized.includes("costamar")) return "Click and Book Plus"
  if (normalized.includes("agil")) return "Agilsmart"

  return String(providerId).trim()
}

const PROVIDER_DEFINITIONS = [
  {
    id: "agil-local",
    label: "Agilsmart",
    icon: "/assets/provider-icons/agilsmart-128.png",
  },
  {
    id: "costamar",
    label: "Click and Book Plus",
    icon: "/assets/provider-icons/click-and-book-plus-128.png",
  },
] as const

export type SearchProviderId = (typeof PROVIDER_DEFINITIONS)[number]["id"]
export type ProviderStatusState = "unknown" | "checking" | "ready" | "degraded"
export type ProviderStatusEvidence = "prewarm" | "search"
export type ProviderStatusReasonCode =
  | "not_configured"
  | "not_checked"
  | "check_in_progress"
  | "context_only"
  | "stale"
  | "authentication_required"
  | "provider_unavailable"
  | "timeout"
  | "invalid_response"
  | "partial_results"
  | "provider_error"

export type SearchProvider = {
  id: SearchProviderId
  label: string
  icon: string
  configured?: boolean
  state?: ProviderStatusState
  evidence?: ProviderStatusEvidence | null
  reasonCode?: ProviderStatusReasonCode | null
  observedAt?: string | null
  stale?: boolean
}

export type ProviderStatusResponse = {
  generatedAt?: string
  staleAfterMs?: number
  providers: SearchProvider[]
}

/**
 * The providers the rail on the idle screen lists (plate 1a).
 *
 * Before the backend status request resolves, the canonical providers only mean
 * "this is where the search will go". Once a status response exists, backend
 * configuration controls visibility and only explicit observations add health
 * copy; an unknown state never becomes an availability claim.
 */
export function configuredSearchProviders(
  statusProviders?: readonly SearchProvider[],
): SearchProvider[] {
  if (statusProviders) {
    return statusProviders
      .filter((provider) => provider.configured === true)
      .map((provider) => ({ ...provider }))
  }

  return PROVIDER_DEFINITIONS.map((provider) => ({ ...provider }))
}

export function providerStatusCopy(provider: SearchProvider): string {
  if (provider.state === "ready") return "disponible"
  if (provider.state === "checking") return "verificando"
  if (provider.state === "degraded") {
    return provider.reasonCode === "authentication_required"
      ? provider.id === "agil-local" ? "requiere sesión" : "requiere autenticación"
      : "con incidencias"
  }
  if (provider.state === "unknown") return "sin verificar"
  return ""
}

const STATUS_STATES = new Set<ProviderStatusState>([
  "unknown",
  "checking",
  "ready",
  "degraded",
])
const STATUS_EVIDENCE = new Set<ProviderStatusEvidence>(["prewarm", "search"])
const STATUS_REASONS = new Set<ProviderStatusReasonCode>([
  "not_configured",
  "not_checked",
  "check_in_progress",
  "context_only",
  "stale",
  "authentication_required",
  "provider_unavailable",
  "timeout",
  "invalid_response",
  "partial_results",
  "provider_error",
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function validIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
}

function normalizeProviderStatus(
  value: unknown,
  id: SearchProviderId,
): SearchProvider | undefined {
  if (!isRecord(value) || value.id !== id) return undefined
  if (typeof value.configured !== "boolean") return undefined
  if (typeof value.state !== "string" || !STATUS_STATES.has(value.state as ProviderStatusState)) {
    return undefined
  }
  if (value.evidence !== null
    && (typeof value.evidence !== "string"
      || !STATUS_EVIDENCE.has(value.evidence as ProviderStatusEvidence))) {
    return undefined
  }
  if (value.reasonCode !== null
    && (typeof value.reasonCode !== "string"
      || !STATUS_REASONS.has(value.reasonCode as ProviderStatusReasonCode))) {
    return undefined
  }
  if (value.observedAt !== null && !validIsoTimestamp(value.observedAt)) return undefined
  if (typeof value.stale !== "boolean") return undefined

  const definition = PROVIDER_DEFINITIONS.find((provider) => provider.id === id)!
  return {
    ...definition,
    configured: value.configured,
    state: value.state as ProviderStatusState,
    evidence: value.evidence as ProviderStatusEvidence | null,
    reasonCode: value.reasonCode as ProviderStatusReasonCode | null,
    observedAt: value.observedAt as string | null,
    stale: value.stale,
  }
}

export function normalizeProviderStatusResponse(value: unknown): ProviderStatusResponse {
  if (!isRecord(value)) return { providers: [] }
  const rawProviders = Array.isArray(value.providers) ? value.providers : []
  const providers = PROVIDER_DEFINITIONS.flatMap(({ id }) => {
    const raw = rawProviders.find((provider) => isRecord(provider) && provider.id === id)
    const normalized = normalizeProviderStatus(raw, id)
    return normalized ? [normalized] : []
  })

  return {
    generatedAt: validIsoTimestamp(value.generatedAt) ? value.generatedAt : undefined,
    staleAfterMs: typeof value.staleAfterMs === "number"
      && Number.isFinite(value.staleAfterMs)
      && value.staleAfterMs >= 0
      ? value.staleAfterMs
      : undefined,
    providers,
  }
}
