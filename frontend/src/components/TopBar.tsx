import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from "react"
import { AppIcon } from "@/components/ui/app-icon"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { withoutThemeTransition } from "@/lib/reduced-motion"

export const TOPBAR_SEARCH_CONTROLS_ID = "fd-topbar-search-controls"

function getInitialTheme(): "light" | "dark" {
  try {
    const saved = localStorage.getItem("flydesk-theme")
    if (saved === "light" || saved === "dark") return saved
  } catch {
    // localStorage can be blocked; fall through to the DOM class.
  }

  return document.documentElement.classList.contains("dark") ? "dark" : "light"
}

function syncTheme(theme: "light" | "dark") {
  document.documentElement.classList.toggle("dark", theme === "dark")
  document.documentElement.dataset.theme = theme

  try {
    localStorage.setItem("flydesk-theme", theme)
    document.cookie = `flydesk_theme=${theme}; Path=/; Max-Age=31536000; SameSite=Lax`
  } catch {
    return
  }
}

function ThemeToggle({
  theme,
  setTheme,
}: {
  theme: "light" | "dark"
  setTheme: (theme: "light" | "dark") => void
}) {
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

function IconButtonTooltip({
  children,
  disabled = false,
  label,
}: {
  children: ReactElement
  disabled?: boolean
  label: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {disabled ? (
          <span
            className="inline-flex focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            tabIndex={0}
            aria-label={label}
          >
            {children}
          </span>
        ) : children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/**
 * Plate 1b draws copy and paste as one capsule and the theme toggle as its own,
 * both 32px on `--secondary` with a 1px `--input` border. In armazón C the
 * capsule breaks into loose buttons (02 §4) — same component, the geometry
 * comes from the container query.
 */
function TopBarCapsule({ children }: { children: ReactNode }) {
  return <div className="fd-capsule">{children}</div>
}

interface TopBarProps {
  copySearchDisabled?: boolean
  /** No configuration is known yet, so Paste reads as dim — but still works. */
  pasteSearchDimmed?: boolean
  onCopySearchConfig?: () => void
  onPasteSearchConfig?: () => void
  workspaceActive?: boolean
}

export function TopBar({
  copySearchDisabled = true,
  pasteSearchDimmed = true,
  onCopySearchConfig,
  onPasteSearchConfig,
  workspaceActive = false,
}: TopBarProps) {
  const [theme, setTheme] = useState<"light" | "dark">(getInitialTheme)
  const homeHref = useMemo(() => `${window.location.origin}/`, [])

  /* Plate 9b names the theme switch among the things that never animate. Left
     bare it starts 130 transitions at once — every border, background and text
     colour in the tree crossfading — which is the opposite of a setting taking
     effect. The wrapper suppresses them for the swap and restores them after. */
  useEffect(() => {
    withoutThemeTransition(() => syncTheme(theme))
  }, [theme])

  return (
    <header className="fd-topbar" data-workspace-active={workspaceActive}>
      <div className="fd-topbar-inner">
        <a
          href={homeHref}
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
            <IconButtonTooltip
              disabled={copySearchDisabled}
              label={copySearchDisabled ? "Completa una búsqueda para copiar la configuración" : "Copiar configuración"}
            >
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={onCopySearchConfig}
                disabled={copySearchDisabled}
                aria-label="Copiar configuración"
                className={`fd-capsule-cell fd-topbar-copy${copySearchDisabled ? " fd-capsule-cell-dim" : ""}`}
              >
                <AppIcon name="copy" />
              </Button>
            </IconButtonTooltip>
            <IconButtonTooltip label="Pegar configuración">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={onPasteSearchConfig}
                aria-label="Pegar configuración"
                className={`fd-capsule-cell fd-topbar-paste${pasteSearchDimmed ? " fd-capsule-cell-dim" : ""}`}
              >
                <AppIcon name="clipboard" />
              </Button>
            </IconButtonTooltip>
          </TopBarCapsule>
          <TopBarCapsule>
            <ThemeToggle theme={theme} setTheme={setTheme} />
          </TopBarCapsule>
        </div>
      </div>
    </header>
  )
}
