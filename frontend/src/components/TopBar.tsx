import { BarChart3, Moon, Plane, Search, ShieldCheck, Sun } from "lucide-react"
import { useEffect, useState, type ReactNode } from "react"
import { Badge } from "@/components/ui/badge"

export type WorkspaceSection = "search" | "migratory"

interface TopBarProps {
  activeSection: WorkspaceSection
  onSectionChange: (section: WorkspaceSection) => void
  loading: boolean
  resultCount: number
}

function getInitialTheme(): "light" | "dark" {
  try {
    const saved = localStorage.getItem("flydesk-theme")
    if (saved === "light" || saved === "dark") return saved
  } catch {
    return "light"
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

export function TopBar({ activeSection, onSectionChange, loading, resultCount }: TopBarProps) {
  const [theme, setTheme] = useState<"light" | "dark">(getInitialTheme)

  useEffect(() => {
    syncTheme(theme)
  }, [theme])

  const status = loading ? "Consultando" : "Listo"

  return (
    <header className="sticky top-0 z-50 border-b border-border bg-card/95 backdrop-blur">
      <div className="mx-auto flex min-h-12 max-w-[1440px] flex-wrap items-center justify-between gap-2 px-3 py-2 sm:px-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-primary">
            <Plane className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-bold text-foreground">Fly Desk</span>
              <Badge variant={loading ? "warning" : "success"} className="h-5 rounded-md px-1.5 text-[10px]">
                {status}
              </Badge>
            </div>
            <div className="hidden text-[11px] text-muted-foreground sm:block">
              Busqueda, comparacion y cotizacion aerea
            </div>
          </div>
        </div>

        <nav className="order-3 flex w-full items-center gap-1 overflow-x-auto sm:order-none sm:w-auto" aria-label="Secciones">
          <SectionButton
            active={activeSection === "search"}
            icon={<Search className="h-3.5 w-3.5" />}
            onClick={() => onSectionChange("search")}
          >
            Busqueda
          </SectionButton>
          <SectionButton
            active={activeSection === "migratory"}
            icon={<ShieldCheck className="h-3.5 w-3.5" />}
            onClick={() => onSectionChange("migratory")}
          >
            Migratorio
          </SectionButton>
        </nav>

        <div className="flex items-center gap-1.5">
          <div className="hidden items-center gap-1 rounded-lg border border-border bg-secondary px-2 py-1 text-[11px] text-secondary-foreground sm:inline-flex">
            <BarChart3 className="h-3.5 w-3.5 text-primary" />
            <span className="font-semibold tabular-nums">{resultCount}</span>
            <span className="text-muted-foreground">resultados</span>
          </div>

          <div className="inline-flex items-center rounded-lg border border-input bg-secondary p-0.5">
            <button
              type="button"
              onClick={() => setTheme("light")}
              aria-pressed={theme === "light"}
              className={`inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                theme === "light" ? "bg-card text-primary shadow-sm" : "text-muted-foreground hover:text-foreground"
              }`}
              aria-label="Tema claro"
            >
              <Sun className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setTheme("dark")}
              aria-pressed={theme === "dark"}
              className={`inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                theme === "dark" ? "bg-card text-primary shadow-sm" : "text-muted-foreground hover:text-foreground"
              }`}
              aria-label="Tema oscuro"
            >
              <Moon className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>
    </header>
  )
}

function SectionButton({
  active,
  icon,
  onClick,
  children,
}: {
  active: boolean
  icon: ReactNode
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        active
          ? "border-primary/30 bg-accent text-accent-foreground"
          : "border-border bg-secondary text-secondary-foreground hover:bg-accent"
      }`}
    >
      {icon}
      {children}
    </button>
  )
}
