import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { Toggle as TogglePrimitive } from "radix-ui"

const toggleVariants = cva(
  "inline-flex items-center justify-center gap-1.5 rounded-sm text-[12px] font-medium whitespace-nowrap text-ink-2 transition-colors outline-none hover:bg-paper-tint hover:text-ink focus-visible:ring-2 focus-visible:ring-pencil/30 disabled:pointer-events-none disabled:opacity-40 data-[state=on]:bg-ink data-[state=on]:text-paper-raised [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-transparent",
        outline:
          "border border-rule-strong bg-transparent",
      },
      size: {
        default: "h-8 min-w-8 px-2",
        sm: "h-6 min-w-6 px-1.5 text-[11px]",
        lg: "h-9 min-w-9 px-2.5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Toggle({
  className,
  variant,
  size,
  ...props
}: React.ComponentProps<typeof TogglePrimitive.Root> &
  VariantProps<typeof toggleVariants>) {
  return (
    <TogglePrimitive.Root
      data-slot="toggle"
      className={cn(toggleVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Toggle, toggleVariants }
