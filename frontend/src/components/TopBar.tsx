import { useEffect, useState, type ReactNode } from "react"
import { AppIcon } from "@/components/ui/app-icon"
import { Button } from "@/components/ui/button"
import { segmentedControlClassName } from "@/components/ui/segmented-control-classes"
import { SlidingSegmentIndicator } from "@/components/ui/sliding-segment-indicator"
import { useSlidingSegmentIndicator } from "@/components/ui/use-sliding-segment-indicator"
import { cn } from "@/lib/utils"

export const TOPBAR_SEARCH_CONTROLS_ID = "fd-topbar-search-controls"
const TOPBAR_ICON_BUTTON_CLASS =
  "relative z-10 h-8 w-8 rounded-none border-0 text-foreground transition-[background-color,color,transform,opacity] hover:text-foreground focus-visible:ring-0"

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

  try {
    localStorage.setItem("flydesk-theme", theme)
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
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={() => setTheme(nextTheme)}
      aria-label="Cambiar tema"
      aria-pressed={theme === "dark"}
      className={`${TOPBAR_ICON_BUTTON_CLASS} fd-theme-toggle`}
    >
      <AppIcon name={theme === "dark" ? "sun" : "moon"} />
    </Button>
  )
}

function TopBarIconGroup({ children }: { children: ReactNode }) {
  const { containerRef, indicatorStyle } = useSlidingSegmentIndicator<HTMLDivElement>({ trackActive: false })

  return (
    <div
      ref={containerRef}
      className={cn("fd-segmented-control text-muted-foreground", segmentedControlClassName)}
    >
      <SlidingSegmentIndicator style={indicatorStyle} />
      {children}
    </div>
  )
}

interface TopBarProps {
  onResetSearch?: () => void
  copySearchDisabled?: boolean
  onCopySearchConfig?: () => void
  onPasteSearchConfig?: () => void
}

export function TopBar({
  onResetSearch,
  copySearchDisabled = true,
  onCopySearchConfig,
  onPasteSearchConfig,
}: TopBarProps) {
  const [theme, setTheme] = useState<"light" | "dark">(getInitialTheme)

  useEffect(() => {
    syncTheme(theme)
  }, [theme])

  return (
    <header className="sticky top-0 z-50 border-b border-border bg-card/95 backdrop-blur">
      <div className="mx-auto grid min-h-11 max-w-[1560px] grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 px-3 py-1.5 sm:px-4">
        <div className="flex min-w-0 items-center gap-2 justify-self-start">
          <button
            type="button"
            onClick={onResetSearch}
            aria-label="Limpiar búsqueda"
            title="Limpiar búsqueda"
            className="group -ml-1 flex min-w-0 items-center gap-2 border-0 border-none bg-transparent px-1 py-0.5 text-left outline-none transition-[color,opacity,transform] duration-150 hover:text-primary focus-visible:outline-none focus-visible:ring-0 active:scale-[0.99]"
          >
            <AppIcon name="brandPlane" className="h-6 w-6 text-primary transition-transform duration-150 group-hover:-translate-y-px" />
            <span className="min-w-0 truncate text-sm font-bold text-foreground transition-colors duration-150 group-hover:text-primary">
              Fly Desk
            </span>
          </button>
        </div>

        <div
          id={TOPBAR_SEARCH_CONTROLS_ID}
          data-testid="topbar-search-controls"
          className="min-w-0 justify-self-center"
        />

        <div className="flex items-center gap-1.5 justify-self-end">
          <TopBarIconGroup>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={onCopySearchConfig}
              disabled={copySearchDisabled}
              aria-label="Copiar configuración"
              title={copySearchDisabled ? "Completa una búsqueda para copiar la configuración" : "Copiar configuración"}
              className={TOPBAR_ICON_BUTTON_CLASS}
            >
              <AppIcon name="copy" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={onPasteSearchConfig}
              aria-label="Pegar configuración"
              title="Pegar configuración"
              className={TOPBAR_ICON_BUTTON_CLASS}
            >
              <AppIcon name="clipboard" />
            </Button>
          </TopBarIconGroup>
          <TopBarIconGroup>
            <ThemeToggle theme={theme} setTheme={setTheme} />
          </TopBarIconGroup>
        </div>
      </div>
    </header>
  )
}
