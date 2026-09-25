import { AppIcon } from "@/components/ui/app-icon"

/* The only thing that rotates. It stops under reduced motion, so whatever it
   marks also says so in words. */
export function Spinner({ size = 14 }: { size?: 12 | 14 }) {
  return <AppIcon name="loading" size={size} spin />
}
