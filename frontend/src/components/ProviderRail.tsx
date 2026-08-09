import { useEffect, useState } from "react"
import { getProviderStatus } from "@/lib/api"
import { configuredSearchProviders } from "@/lib/providers"

const PROVIDER_STATUS_REFRESH_MS = 30_000

/*
 * Plate 1a — the rail at the foot of the idle screen.
 *
 * Listed = currently available. The diagnostic state remains behind the
 * authenticated API contract; this customer-facing rail intentionally renders
 * neither status words nor failed/unknown providers.
 *
 * It is a child of the stage rather than of the search form because the plate
 * pins it to the bottom of the viewport and runs its rule across the full width
 * of `main` — wider than the 1180px column the form occupies.
 */
export function ProviderRail({ leaving = false }: { leaving?: boolean } = {}) {
  const [searchProviders, setSearchProviders] = useState(
    () => configuredSearchProviders([]),
  )

  useEffect(() => {
    let active = true
    let controller: AbortController | undefined
    let requestSequence = 0

    const refresh = async () => {
      const requestId = ++requestSequence
      controller?.abort()
      const requestController = new AbortController()
      controller = requestController
      try {
        const response = await getProviderStatus({ signal: requestController.signal })
        if (active && requestId === requestSequence) {
          setSearchProviders(
            configuredSearchProviders(response.providers)
              .filter((provider) => provider.state === "ready" && provider.stale !== true),
          )
        }
      } catch {
        if (active && requestId === requestSequence && !requestController.signal.aborted) {
          setSearchProviders(configuredSearchProviders([]))
        }
      }
    }

    void refresh()
    const timer = window.setInterval(() => void refresh(), PROVIDER_STATUS_REFRESH_MS)
    return () => {
      active = false
      controller?.abort()
      window.clearInterval(timer)
    }
  }, [])

  if (searchProviders.length === 0) {
    return null
  }

  return (
    <div
      /* 07 §1 at 60ms: on the way to the workspace the rail leaves by opacity
         over 120ms instead of vanishing with the screen it belongs to. */
      className={`fd-provider-rail${leaving ? " fd-motion-idle-exit" : ""}`}
      data-leaving={leaving ? "true" : undefined}
      aria-live="polite"
    >
      <span className="text-xs text-muted-foreground">Buscando en</span>
      {searchProviders.map((provider) => (
        <span key={provider.id} className="fd-provider-rail-item">
          {provider.icon && <img src={provider.icon} alt="" decoding="async" />}
          <span>{provider.label}</span>
        </span>
      ))}
    </div>
  )
}
