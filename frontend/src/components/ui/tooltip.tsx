import * as React from "react"
import * as TooltipPrimitive from "@radix-ui/react-tooltip"

import { cn } from "@/lib/utils"

/* Tooltips name icons that have no label, or say the shortcut of one that
   does: never text that is already on screen. */
function TooltipProvider({
  delayDuration = 300,
  skipDelayDuration = 150,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      skipDelayDuration={skipDelayDuration}
      {...props}
    />
  )
}

function Tooltip({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn("fd-tooltip fd-motion-emergente", className)}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

type TriggerElementProps = {
  disabled?: boolean
  onClick?: React.MouseEventHandler<HTMLElement>
  "aria-disabled"?: boolean
}

/**
 * The shortcut of a labelled control, or why it is unavailable.
 *
 * A disabled control keeps focus and pointer events (`aria-disabled` instead of
 * `disabled`), so keyboard and mouse users both reach the explanation, and a
 * press does nothing.
 */
function ShortcutTooltip({
  children,
  label,
  shortcut,
  disabled = false,
}: {
  children: React.ReactElement<TriggerElementProps>
  label: string
  shortcut: React.ReactNode
  disabled?: boolean
}) {
  const trigger = disabled
    ? React.cloneElement(children, {
        disabled: false,
        "aria-disabled": true,
        onClick: (event: React.MouseEvent<HTMLElement>) => event.preventDefault(),
      })
    : children

  return (
    <Tooltip>
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      <TooltipContent className="fd-tooltip-shortcut">
        {label}
        {shortcut}
      </TooltipContent>
    </Tooltip>
  )
}

export { ShortcutTooltip, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger }
