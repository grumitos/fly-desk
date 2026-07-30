import { useEffect, useState } from "react"
import { getProviderStatus } from "@/lib/api"
import {
  configuredSearchProviders,
  providerStatusCopy,
} from "@/lib/providers"

const PROVIDER_STATUS_REFRESH_MS = 30_000

/*
 * Plate 1a — the rail at the foot of the idle screen.
 *
 * Listed = will be searched. Health copy only appears after the authenticated
 * backend status surface returns a closed observation; unknown remains explicit.
 *
 * It is a child of the stage rather than of the search form because the plate
 * pins it to the bottom of the viewport and runs its rule across the full width
 * of `main` — wider than the 1180px column the form occupies.
 */
export function ProviderRail() {
  const [searchProviders, setSearchProviders] = useState(
    () => configuredSearchProviders(),
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
          setSearchProviders(configuredSearchProviders(response.providers))
        }
      } catch {
        if (active && requestId === requestSequence && !requestController.signal.aborted) {
          setSearchProviders(configuredSearchProviders())
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
    <div className="fd-provider-rail" aria-live="polite">
      <span className="text-xs text-muted-foreground">Buscando en</span>
      {searchProviders.map((provider) => {
        const statusCopy = providerStatusCopy(provider)
        return (
          <span key={provider.id} className="fd-provider-rail-item">
            {provider.icon && <img src={provider.icon} alt="" decoding="async" />}
            <span>{provider.label}</span>
            {statusCopy && (
              <span
                className="fd-provider-rail-status"
                data-state={provider.state}
              >
                {statusCopy}
              </span>
            )}
          </span>
        )
      })}
    </div>
  )
}
