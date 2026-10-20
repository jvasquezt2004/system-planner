import { findColumnTypeInfo, type ColumnTypeFamilyId } from "../shared/column-types";
import type { ColumnType } from "../shared/design";

/** Family colours are presentation only; names and labels come from the registry. */
const FAMILY_CLASSNAMES: Record<ColumnTypeFamilyId, string> = {
	integer: "border-sky-500/40 bg-sky-500/10 text-sky-300",
	text: "border-amber-500/40 bg-amber-500/10 text-amber-300",
	uuid: "border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-300",
	boolean: "border-teal-500/40 bg-teal-500/10 text-teal-300",
	numeric: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
	temporal: "border-violet-500/40 bg-violet-500/10 text-violet-300",
	json: "border-orange-500/40 bg-orange-500/10 text-orange-300",
};

/**
 * The type-family symbol. It is never the only identification: callers show
 * the exact PostgreSQL type name beside it, and the tooltip names the family.
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
				className={`flex shrink-0 items-center justify-center rounded border border-slate-600 bg-slate-800 text-[10px] font-semibold text-slate-300 ${className}`}
			>
				?
			</span>
		);
	}

	return (
		<span
			title={`${info.family.label} type family — ${info.family.summary}. Column type: ${info.type}`}
			aria-label={`${info.family.label} type family`}
			className={`flex shrink-0 items-center justify-center rounded border text-[10px] font-semibold ${FAMILY_CLASSNAMES[info.family.id]} ${className}`}
		>
			{info.family.glyph}
		</span>
	);
}
