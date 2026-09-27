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

/* What the meter shows and says: the cupos the searches in progress hold, out
   of the most that can run at once. A search holds one or more; the count
   never says which search holds how many. */
function describeCapacity(capacity: SearchCapacity): { used: number; total: number; text: string } {
  const used = Math.min(capacity.activeUnits, capacity.capacityUnits)
  const running = capacity.activeSearches === 0
    ? "ninguna búsqueda en curso"
    : `${capacity.activeSearches} ${capacity.activeSearches === 1 ? "búsqueda" : "búsquedas"} en curso`
  const searches = capacity.queuedSearches > 0 ? `${running} · ${capacity.queuedSearches} en espera` : running
  return { used, total: capacity.capacityUnits, text: `${used} de ${capacity.capacityUnits} cupos en uso · ${searches}` }
}

/*
 * The capacity the two agents share, as the title bar reads everything else:
 * a gauge and a tabular «3/7» in a cell of the capsules' height. The gauge's
 * needle points at the share of cupos in use and travels as it changes. It is
 * muted while nothing runs and in ink while something does; with every cupo
 * in use the gauge takes the warning colour; while a search waits for a cupo
 * it takes the clock, which pulses, and the colours of the «En espera» line.
 * Its name, value and tooltip say it in words. It follows the runner as the
 * capacity changes and fades blank, keeping its box, while it cannot be read.
 */
function CapacityMeter() {
  const capacity = useSearchCapacity()
  const reading = capacity ? describeCapacity(capacity) : null
  const fill = reading && reading.total > 0 ? reading.used / reading.total : 0
  const state = !capacity
    ? "unknown"
    : capacity.queuedSearches > 0
      ? "waiting"
      : fill >= 1 ? "full" : capacity.activeSearches > 0 ? "busy" : "idle"

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="meter"
          aria-label="Capacidad de búsqueda"
          aria-valuemin={0}
          aria-valuemax={reading?.total}
          aria-valuenow={reading?.used}
          aria-valuetext={reading?.text}
          aria-hidden={reading ? undefined : true}
          tabIndex={reading ? 0 : -1}
          data-state={state}
          className="fd-capacity fd-focus-ring"
          style={{ "--fd-capacity-fill": fill } as CSSProperties}
        >
          <AppIcon name={state === "waiting" ? "clock" : "capacity"} />
          <span className="fd-capacity-count">{reading ? `${reading.used}/${reading.total}` : "0/0"}</span>
        </span>
      </TooltipTrigger>
      {reading && <TooltipContent>{reading.text}</TooltipContent>}
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
