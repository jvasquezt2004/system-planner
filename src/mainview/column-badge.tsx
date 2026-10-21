import { cn } from "@/lib/utils";

/**
 * Marks differ by their letters, not by colour: the tone only says how much a
 * mark matters when scanning — a key, a constraint, or a quiet detail.
 */
const TONE_CLASSNAMES = {
	key: "text-ink font-semibold",
	strong: "text-ink-2",
	quiet: "text-ink-3",
	faint: "text-ink-4",
} as const;

/**
 * A compact key/identity/uniqueness/nullability mark beside a column.
 * Shared by table cards and the column inspector so both read the same way.
 */
export function ColumnBadge({
	label,
	tone,
	title,
}: {
	label: string;
	tone: keyof typeof TONE_CLASSNAMES;
	title: string;
}) {
	return (
		<span
			title={title}
			className={cn(
				"shrink-0 font-mono text-[9.5px] leading-none font-medium tracking-[0.04em]",
				TONE_CLASSNAMES[tone],
			)}
		>
			{label}
		</span>
	);
}
