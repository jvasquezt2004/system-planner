import * as React from "react"
import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-14 w-full rounded-sm border border-control-rule bg-control px-2.5 py-1.5 text-[13px] text-ink transition-[color,background-color,box-shadow] outline-none placeholder:text-ink-4 focus-visible:bg-paper-raised focus-visible:border-pencil focus-visible:ring-2 focus-visible:ring-pencil/15 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-proof-red",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
