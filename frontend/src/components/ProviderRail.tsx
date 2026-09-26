import { SEARCH_PROVIDERS } from "@/lib/providers"

/*
 * Plate 1a — «Buscando en» and the providers this desk searches, at the foot
 * of the idle screen. Coverage, not health: a provider that fails a search is
 * reported above the results (04 §8). It is a child of the stage because its
 * rule runs across the whole of `main`, wider than the form.
 */
export function ProviderRail({ leaving = false }: { leaving?: boolean }) {
  return (
    <div
      /* 07 §1: it leaves by opacity on the way to the workspace. */
      className={`fd-provider-rail${leaving ? " fd-motion-idle-exit" : ""}`}
      data-leaving={leaving ? "true" : undefined}
    >
      <span className="text-xs text-muted-foreground">Buscando en</span>
      {SEARCH_PROVIDERS.map((provider) => (
        <span key={provider.id} className="fd-provider-rail-item">
          <img src={provider.icon} alt="" decoding="async" />
          <span>{provider.label}</span>
        </span>
      ))}
    </div>
  )
}
