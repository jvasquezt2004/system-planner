import { findColumnTypeInfo } from "../shared/column-types";
import type { ColumnType } from "../shared/design";
import { cn } from "@/lib/utils";

/**
 * The type-family symbol, set like a single piece of type in its own block.
 * It is never the only identification: callers show the exact PostgreSQL type
 * name beside it, and the tooltip names the family.
 */
export function ColumnTypeBadge({
	type,
	className = "h-4 w-5",
}: {
	type: ColumnType;
	className?: string;
}) {
	const info = findColumnTypeInfo(type);
	if (!info) {
		return (
			<span
				title="Unsupported type"
				className={cn(
					"flex shrink-0 items-center justify-center rounded-[2px] border border-proof-red/40 font-mono text-[9.5px] text-proof-red",
					className,
				)}
			>
				?
			</span>
		);
	}

	return (
		<span
			title={`${info.family.label} type family — ${info.family.summary}. Column type: ${info.type}`}
			aria-label={`${info.family.label} type family`}
			className={cn(
				"flex shrink-0 items-center justify-center rounded-[2px] border border-rule bg-paper-tint font-mono text-[9.5px] leading-none text-ink-2",
				className,
			)}
		>
			{info.family.glyph}
		</span>
	);
}
