import { cva } from "class-variance-authority"

/*
 * Sizes are the desktop column of the geometry catalog (plate 5b):
 * 26 · 32 · 36 · 40 · 52, each with the radius its family uses. The 30/32 pair
 * the app used to carry was merged into a single 32px control.
 *
 * And they are the tokens, not the numbers: the height scale and the type scale
 * live in `design-system.css` and are read from here. Written out as Tailwind
 * literals they were a second catalogue — one that had already fallen behind,
 * since `icon-touch` still drew the 44px the catalogue retired. The weight is
 * the one thing that stays a Tailwind class (`font-semibold`, which is
 * `--fd-weight-label`), because that is what lets a surface raise it with
 * `font-bold` through `cn()`; a weight written as an arbitrary property would
 * beat that override instead of losing to it.
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
        /** 26 · r8 — fare chips, night counters, stop labels. The pagination
         * cells this used to name last went with the paginator; the list
         * scrolls (see `result-groups.ts`). */
        chip: "h-[var(--fd-control-chip)] rounded-md px-2.5 text-[length:var(--fd-text-meta)]",
        /** 32 · r10 — the standard control: buttons, chips, filter rows. */
        sm: "h-[var(--fd-control-standard)] rounded-lg px-3 text-[length:var(--fd-text-meta)]",
        /** 36 · r10 — bar actions: Buscar, Filtros, date presets. */
        default: "h-[var(--fd-control-bar)] rounded-lg px-4 text-[length:var(--fd-text-base)]",
        /** 40 · r12 — secondary inputs. */
        lg: "h-[var(--fd-control-input)] rounded-xl px-5 text-[length:var(--fd-text-base)]",
        /** 52 · r12 — the primary action, and every search field. */
        xl: "h-[var(--fd-control-primary)] rounded-xl px-5 text-[length:var(--fd-text-body)]",
        /** 32 square · r10 — icon button in the top bar and dense rows. */
        icon: "size-[var(--fd-control-standard)] rounded-lg",
        /** 26 square · r8 — icon button inside a 26px row. */
        "icon-chip": "size-[var(--fd-control-chip)] rounded-md",
        /** 20 square · r6 — badge-scale affordances only. The 20 belongs to
         * the key/badge piece of 7b, not to the catalogue of control heights:
         * there is no token for it, and one is not invented here. */
        "icon-xs": "size-5 rounded-sm",
        /** 40 square · r12 — the mobile touch floor. It said 44 and drew 44,
         * which is the height the catalogue retired: 02 §12 was read as «44 on
         * every square control on a phone» and that came out three times per
         * column. The floor is `--fd-control-touch`. */
        "icon-touch": "size-[var(--fd-control-touch)] rounded-xl",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export { buttonVariants }
