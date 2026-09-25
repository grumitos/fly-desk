import { memo, useEffect, useState, type ReactNode } from "react"
import { AppIcon } from "@/components/ui/app-icon"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
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

/* The cookie is what the server-rendered login page reads. */
function syncTheme(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark")
  document.documentElement.dataset.theme = theme

  try {
    localStorage.setItem("flydesk-theme", theme)
    document.cookie = `flydesk_theme=${theme}; Path=/; Max-Age=31536000; SameSite=Lax`
  } catch {
    return
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
          className="fd-capsule-cell fd-theme-toggle"
        >
          <AppIcon name={theme === "dark" ? "sun" : "moon"} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{`Cambiar a tema ${nextTheme === "dark" ? "oscuro" : "claro"}`}</TooltipContent>
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
