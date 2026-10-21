import * as React from "react"
import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-8 w-full min-w-0 rounded-sm border border-control-rule bg-control px-2.5 py-1 text-[13px] text-ink transition-[color,background-color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-ink-4 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        "focus-visible:bg-paper-raised focus-visible:border-pencil focus-visible:ring-2 focus-visible:ring-pencil/15",
        "aria-invalid:border-proof-red aria-invalid:ring-proof-red/15",
        className
      )}
      {...props}
    />
  )
}

export { Input }
