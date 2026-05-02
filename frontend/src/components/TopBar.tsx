import { useEffect, useState } from "react"
import { AppIcon } from "@/components/ui/app-icon"
import { Button } from "@/components/ui/button"

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
      className="size-7 border border-transparent text-foreground hover:border-border hover:bg-accent hover:text-accent-foreground focus-visible:border-ring focus-visible:ring-ring/40"
    >
      <AppIcon name={theme === "dark" ? "sun" : "moon"} />
    </Button>
  )
}

interface TopBarProps {
  logViewActive?: boolean
  onLogViewToggle?: () => void
}

export function TopBar({ logViewActive = false, onLogViewToggle }: TopBarProps) {
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
            onClick={onLogViewToggle}
            aria-label="Alternar registro"
            aria-pressed={logViewActive}
            className="flex h-7 w-7 shrink-0 cursor-default items-center justify-center border-0 bg-transparent p-0 text-primary outline-none"
          >
            <AppIcon name="brandPlane" className="h-6 w-6" />
          </button>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-bold text-foreground">Fly Desk</span>
            </div>
          </div>
        </div>

        <div
          id={TOPBAR_SEARCH_CONTROLS_ID}
          data-testid="topbar-search-controls"
          className="min-w-0 justify-self-center"
        />

        <div className="flex items-center gap-1.5 justify-self-end">
          <div className="inline-flex items-center rounded-lg border border-input bg-secondary p-0.5 text-muted-foreground">
            <ThemeToggle theme={theme} setTheme={setTheme} />
          </div>
        </div>
      </div>
    </header>
  )
}
