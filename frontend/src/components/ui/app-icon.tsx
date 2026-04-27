import { appIconRegistry, type AppIconName } from "@/components/ui/app-icon-registry"
import { cn } from "@/lib/utils"

export type { AppIconName } from "@/components/ui/app-icon-registry"

export function AppIcon({
  name,
  className,
  spin = false,
}: {
  name: AppIconName
  className?: string
  spin?: boolean
}) {
  const Icon = appIconRegistry[name]
  return (
    <Icon
      aria-hidden="true"
      className={cn("h-4 w-4 shrink-0", spin && "animate-spin", className)}
      strokeWidth={2}
    />
  )
}
