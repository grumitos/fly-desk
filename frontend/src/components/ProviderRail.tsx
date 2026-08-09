import { configuredSearchProviders } from "@/lib/providers"

/*
 * Plate 1a — the rail at the foot of the idle screen.
 *
 * «Buscando en» plus the providers this desk searches. It is coverage, not
 * health: the rail used to poll `/api/provider-status` and keep only providers
 * with a live `ready` observation, which read as availability but behaved as
 * censorship — Click and Book Plus cannot reach `ready` until a real search has
 * answered, so on the idle screen it was never there and the desk claimed to
 * search one provider. A provider that fails a search is said in one line above
 * the results (04 §8), where the agent can act on it.
 *
 * It is a child of the stage rather than of the search form because the plate
 * pins it to the bottom of the viewport and runs its rule across the full width
 * of `main` — wider than the 1180px column the form occupies.
 */
export function ProviderRail({ leaving = false }: { leaving?: boolean } = {}) {
  const searchProviders = configuredSearchProviders()

  return (
    <div
      /* 07 §1 at 60ms: on the way to the workspace the rail leaves by opacity
         over 120ms instead of vanishing with the screen it belongs to. */
      className={`fd-provider-rail${leaving ? " fd-motion-idle-exit" : ""}`}
      data-leaving={leaving ? "true" : undefined}
    >
      <span className="text-xs text-muted-foreground">Buscando en</span>
      {searchProviders.map((provider) => (
        <span key={provider.id} className="fd-provider-rail-item">
          <img src={provider.icon} alt="" decoding="async" />
          <span>{provider.label}</span>
        </span>
      ))}
    </div>
  )
}
