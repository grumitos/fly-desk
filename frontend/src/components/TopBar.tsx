import { memo, useEffect, useState, type CSSProperties, type ReactNode } from "react"
import { AppIcon } from "@/components/ui/app-icon"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useSearchCapacity } from "@/hooks/useSearchCapacity"
import type { SearchCapacity } from "@/lib/api"
import { withoutThemeTransition } from "@/lib/reduced-motion"

export const TOPBAR_SEARCH_CONTROLS_ID = "fd-topbar-search-controls"

type Theme = "light" | "dark"

function getInitialTheme(): Theme {
  try {
    const saved = localStorage.getItem("flydesk-theme")
    if (saved === "light" || saved === "dark") return saved
  } catch {
    // Blocked storage falls back to the light theme `index.html` applied.
  }

  return "light"
}

/* The cookie is what the server-rendered login page reads, so it is written
   even where storage is blocked. */
function syncTheme(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark")
  document.documentElement.dataset.theme = theme
  document.cookie = `flydesk_theme=${theme}; Path=/; Max-Age=31536000; SameSite=Lax`

  try {
    localStorage.setItem("flydesk-theme", theme)
  } catch {
    // The page falls back to the light theme on the next load.
  }
}

function ThemeToggle({ theme, setTheme }: { theme: Theme; setTheme: (theme: Theme) => void }) {
  const nextTheme = theme === "dark" ? "light" : "dark"

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => setTheme(nextTheme)}
          aria-label="Cambiar tema"
          aria-pressed={theme === "dark"}
          className="fd-capsule-cell"
        >
          <AppIcon name={theme === "dark" ? "sun" : "moon"} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{`Cambiar a tema ${nextTheme === "dark" ? "oscuro" : "claro"}`}</TooltipContent>
    </Tooltip>
  )
}

const percent = new Intl.NumberFormat("es-PE", { style: "percent", maximumFractionDigits: 0 })

/* The occupancy the meter draws and says: the share of the capacity the
   searches in progress hold, never the units a search costs. */
function describeCapacity(capacity: SearchCapacity): { share: number; searches: string; text: string } {
  const share = Math.min(1, capacity.activeUnits / capacity.capacityUnits)
  const running = capacity.activeSearches === 0
    ? "ninguna búsqueda en curso"
    : `${capacity.activeSearches} ${capacity.activeSearches === 1 ? "búsqueda" : "búsquedas"} en curso`
  const searches = capacity.queuedSearches > 0 ? `${running} · ${capacity.queuedSearches} en espera` : running
  return { share, searches, text: `${percent.format(share)} ocupada · ${searches}` }
}

/*
 * The capacity the two agents share, as a bar in the month cards' geometry:
 * its fill is the searches in progress against the most that can run, and it
 * turns to the accent while a search waits for room. It has no text of its
 * own; its name, its value and its tooltip say it. It follows the runner as
 * the capacity changes and goes blank while it cannot be read.
 */
function CapacityMeter() {
  const capacity = useSearchCapacity()
  const reading = capacity ? describeCapacity(capacity) : null
  const state = !capacity
    ? "unknown"
    : capacity.queuedSearches > 0 ? "waiting" : capacity.activeSearches > 0 ? "busy" : "idle"

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="meter"
          aria-label="Capacidad de búsqueda"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={reading ? Math.round(reading.share * 100) : undefined}
          aria-valuetext={reading?.text}
          aria-hidden={reading ? undefined : true}
          tabIndex={reading ? 0 : -1}
          data-state={state}
          className="fd-capacity fd-focus-ring"
          style={{ "--fd-capacity-share": reading?.share ?? 0 } as CSSProperties}
        >
          <span className="fd-capacity-track">
            <span className="fd-capacity-fill" />
          </span>
        </span>
      </TooltipTrigger>
      {reading && <TooltipContent>{`Capacidad de búsqueda · ${reading.searches}`}</TooltipContent>}
    </Tooltip>
  )
}

/* Plate 1b: copy and paste in one capsule, the theme toggle in another; on a
   phone the capsule breaks into loose buttons by container query (02 §4). */
function TopBarCapsule({ children }: { children: ReactNode }) {
  return <div className="fd-capsule">{children}</div>
}

interface TopBarProps {
  copySearchDisabled: boolean
  /** A copy just succeeded: the icon confirms it for the hold of a confirmation. */
  copyConfirmed: boolean
  /** No configuration is known yet, so Paste reads as dim — but still works. */
  pasteSearchDimmed: boolean
  onCopySearchConfig: () => void
  onPasteSearchConfig: () => void
  workspaceActive: boolean
}

export const TopBar = memo(function TopBar({
  copySearchDisabled,
  copyConfirmed,
  pasteSearchDimmed,
  onCopySearchConfig,
  onPasteSearchConfig,
  workspaceActive,
}: TopBarProps) {
  const [theme, setTheme] = useState<Theme>(getInitialTheme)

  /* 9b: the theme swap never animates; the wrapper silences transitions for it. */
  useEffect(() => {
    withoutThemeTransition(() => syncTheme(theme))
  }, [theme])

  return (
    <header className="fd-topbar" data-workspace-active={workspaceActive}>
      <div className="fd-topbar-inner">
        <a
          href="/"
          aria-label="Abrir Fly Desk"
          title="Abrir Fly Desk"
          className="fd-topbar-brand fd-focus-ring"
        >
          <AppIcon name="brandPlane" className="fd-topbar-brand-mark" />
          <span className="fd-topbar-brand-name">Fly Desk</span>
        </a>

        <div
          id={TOPBAR_SEARCH_CONTROLS_ID}
          data-testid="topbar-search-controls"
          className="fd-topbar-search-slot"
        />

        <div className="fd-topbar-actions">
          <CapacityMeter />
          <TopBarCapsule>
            {/* `aria-disabled` rather than `disabled`: the button stays
                focusable, so its tooltip can say why it does nothing yet. */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={copySearchDisabled ? undefined : onCopySearchConfig}
                  aria-disabled={copySearchDisabled || undefined}
                  aria-label="Copiar configuración"
                  className={`fd-capsule-cell fd-topbar-copy${copySearchDisabled ? " fd-capsule-cell-dim" : ""}`}
                >
                  <AppIcon name={copyConfirmed ? "check" : "copy"} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {copySearchDisabled
                  ? "Completa una búsqueda para copiar la configuración"
                  : copyConfirmed ? "Configuración copiada" : "Copiar configuración"}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={onPasteSearchConfig}
                  aria-label="Pegar configuración"
                  className={`fd-capsule-cell${pasteSearchDimmed ? " fd-capsule-cell-dim" : ""}`}
                >
                  <AppIcon name="clipboard" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Pegar configuración</TooltipContent>
            </Tooltip>
          </TopBarCapsule>
          <TopBarCapsule>
            <ThemeToggle theme={theme} setTheme={setTheme} />
          </TopBarCapsule>
        </div>
      </div>
    </header>
  )
})
