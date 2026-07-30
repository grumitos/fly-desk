import { configuredSearchProviders } from "@/lib/providers"

/*
 * Plate 1a — the rail at the foot of the idle screen.
 *
 * Listed = will be searched. Nothing more: showing *which* provider is down
 * before searching needs a loopback surface that does not exist yet, and a rail
 * that implies health it cannot verify is worse than one that only lists names.
 *
 * It is a child of the stage rather than of the search form because the plate
 * pins it to the bottom of the viewport and runs its rule across the full width
 * of `main` — wider than the 1180px column the form occupies.
 */
export function ProviderRail() {
  const searchProviders = configuredSearchProviders()

  if (searchProviders.length === 0) {
    return null
  }

  return (
    <div className="fd-provider-rail">
      <span className="text-xs text-muted-foreground">Buscando en</span>
      {searchProviders.map((provider) => (
        <span key={provider.id} className="fd-provider-rail-item">
          {provider.icon && <img src={provider.icon} alt="" decoding="async" />}
          {provider.label}
        </span>
      ))}
    </div>
  )
}
