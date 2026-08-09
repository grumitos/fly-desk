import { cva } from "class-variance-authority"

/*
 * Sizes are the desktop column of the geometry catalog (plate 5b):
 * 26 · 32 · 36 · 40 · 52, each with the radius its family uses. The 30/32 pair
 * the app used to carry was merged into a single 32px control.
 *
 * `tacto` is colour and opacity only, so there is no press-scale here — a
 * button that shrinks under the cursor is the fake inertia rule 6 forbids.
 * Pressed is one step darker for the length of `tacto` (08 §1, 07 §4 row 11);
 * it is written once here rather than per surface.
 *
 * The duration and easing read the two motion tokens instead of repeating their
 * values: a second copy of `tacto` is a second place to forget.
 */
const buttonVariants = cva(
  /* Movement 11 — one step darker for 90ms — comes from `.fd-pressable`, which
     paints 12% of black over the surface and under the label. It used to be
     `filter: brightness(.88)`, which darkened the words with the fill and is
     not one of the two things `tacto` is allowed to touch. */
  "fd-pressable fd-focus-ring inline-flex items-center justify-center gap-2 whitespace-nowrap font-semibold transition-[background-color,border-color,color,box-shadow,opacity] duration-[var(--fd-dur-tacto)] ease-[var(--fd-ease-tacto)] disabled:pointer-events-none",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-[color-mix(in_srgb,var(--color-primary)_90%,black)]",
        secondary: "border border-input bg-secondary text-secondary-foreground hover:bg-accent hover:text-foreground",
        outline: "border border-input bg-card hover:bg-accent hover:text-accent-foreground",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
      },
      size: {
        /** 26 · r8 — fare chips, night counters, stop labels, pagination cells. */
        chip: "h-[26px] rounded-md px-2.5 text-xs",
        /** 32 · r10 — the standard control: buttons, chips, filter rows. */
        sm: "h-8 rounded-lg px-3 text-xs",
        /** 36 · r10 — bar actions: Buscar, Filtros, date presets. */
        default: "h-9 rounded-lg px-4 text-[13px]",
        /** 40 · r12 — secondary inputs. */
        lg: "h-10 rounded-xl px-5 text-[13px]",
        /** 52 · r12 — the primary action, and every search field. */
        xl: "h-[52px] rounded-xl px-5 text-sm",
        /** 32 square · r10 — icon button in the top bar and dense rows. */
        icon: "size-8 rounded-lg",
        /** 26 square · r8 — icon button inside a 26px row. */
        "icon-chip": "size-[26px] rounded-md",
        /** 20 square · r6 — badge-scale affordances only. */
        "icon-xs": "size-5 rounded-sm",
        /** 44 square · r12 — the mobile touch minimum. */
        "icon-touch": "size-11 rounded-xl",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export { buttonVariants }
