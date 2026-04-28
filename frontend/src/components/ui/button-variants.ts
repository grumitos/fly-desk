import { cva } from "class-variance-authority"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg font-semibold transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.985] disabled:pointer-events-none disabled:opacity-55 disabled:active:scale-100",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90",
        secondary: "border border-input bg-secondary text-secondary-foreground hover:bg-accent hover:text-foreground",
        outline: "border border-input bg-card hover:bg-accent hover:text-accent-foreground",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
      },
      size: {
        default: "h-9 px-4 py-2 text-sm",
        sm: "h-7 rounded-md px-2.5 text-xs",
        lg: "h-10 px-6 text-sm",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export { buttonVariants }
