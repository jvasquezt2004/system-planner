import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { Slot } from "radix-ui"

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-sm text-[12.5px] font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-pencil/30 focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-40 aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-ink text-paper-raised hover:bg-ink-2",
        destructive:
          "bg-proof-red text-paper-raised hover:bg-proof-red/90 focus-visible:ring-proof-red/30",
        strike:
          "text-proof-red hover:bg-proof-red-wash focus-visible:ring-proof-red/30",
        pencil: "bg-pencil text-paper-raised hover:bg-pencil/90",
        outline:
          "border border-rule-strong bg-transparent text-ink hover:border-ink-3 hover:bg-paper-tint",
        secondary:
          "bg-paper-sunk text-ink hover:bg-paper-sunk/70",
        ghost:
          "text-ink-2 hover:bg-paper-tint hover:text-ink",
        link: "text-pencil underline-offset-4 hover:underline",
      },
      size: {
        default: "h-8 px-3 has-[>svg]:px-2.5",
        xs: "h-6 gap-1 px-2 text-[11px] has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1.5 px-2.5 has-[>svg]:px-2",
        lg: "h-9 px-4 has-[>svg]:px-3.5",
        icon: "size-8",
        "icon-xs": "size-6 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-7",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
