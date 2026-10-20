/**
 * A compact key/identity/uniqueness/nullability mark beside a column.
 * Shared by table cards and the column inspector so both read the same way.
 */
export function ColumnBadge({
	label,
	className,
	title,
}: {
	label: string;
	className: string;
	title: string;
}) {
	return (
		<span
			title={title}
			className={`shrink-0 rounded border border-slate-700 bg-slate-950 px-1 text-[10px] font-semibold ${className}`}
		>
			{label}
		</span>
	);
}
