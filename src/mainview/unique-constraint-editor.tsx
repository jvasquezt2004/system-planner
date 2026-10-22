import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { DesignTable, DesignUniqueConstraint } from "../shared/design";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";

/** Edits table-level composite unique constraints. */
export function UniqueConstraintEditor({
	table,
	busy,
	onChange,
}: {
	table: DesignTable;
	busy: boolean;
	onChange: (constraints: DesignUniqueConstraint[]) => void;
}) {
	const constraints = table.uniqueConstraints ?? [];
	const [nameDrafts, setNameDrafts] = useState<Record<string, string | undefined>>({});
	function update(id: string, change: (constraint: DesignUniqueConstraint) => DesignUniqueConstraint) {
		onChange(constraints.map((constraint) => constraint.id === id ? change(constraint) : constraint));
	}
	return (
		<Section
			id="unique-constraints-heading"
			title="Unique constraints"
			action={
				<Button
					variant="ghost"
					size="xs"
					disabled={busy || table.columns.length < 2}
					onClick={() => onChange([
						...constraints,
						{
							id: crypto.randomUUID(),
							columnIds: table.columns.slice(0, 2).map((column) => column.id),
						},
					])}
				>
					<Plus /> Add composite
				</Button>
			}
		>
			{constraints.map((constraint) => (
				<div key={constraint.id} className="flex flex-col gap-2 border-y border-rule px-6 py-2">
					<Input
						aria-label="Unique constraint name"
						placeholder="Generated name"
						value={nameDrafts[constraint.id] ?? constraint.name ?? ""}
						disabled={busy}
						onChange={(event) => setNameDrafts((drafts) => ({
							...drafts,
							[constraint.id]: event.target.value,
						}))}
						onBlur={() => {
							const name = nameDrafts[constraint.id]?.trim();
							if (name !== undefined) {
								update(constraint.id, (current) => ({
									...current,
									name: name || undefined,
								}));
							}
							setNameDrafts((drafts) => ({ ...drafts, [constraint.id]: undefined }));
						}}
						onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
					/>
					<div className="flex flex-wrap gap-x-3">
						{table.columns.map((column) => (
							<label key={column.id} className="flex items-center gap-1 text-[11px]">
								<Checkbox
									aria-label={`Unique ${column.name}`}
									checked={constraint.columnIds.includes(column.id)}
									disabled={busy}
									onCheckedChange={(checked) => update(constraint.id, (current) => ({
										...current,
										columnIds: checked
											? [...current.columnIds, column.id]
											: current.columnIds.filter((id) => id !== column.id),
									}))}
								/>
								{column.name}
							</label>
						))}
					</div>
					<div className="flex items-center justify-between">
						<label className="flex items-center gap-1.5 text-[11px]">
							<Checkbox
								aria-label="Constraint nulls not distinct"
								checked={constraint.nullsNotDistinct ?? false}
								disabled={busy}
								onCheckedChange={(checked) => update(constraint.id, (current) => ({
									...current,
									nullsNotDistinct: checked === true,
								}))}
							/>
							NULLS NOT DISTINCT
						</label>
						<Button
							variant="strike"
							size="xs"
							aria-label="Remove unique constraint"
							disabled={busy}
							onClick={() => onChange(constraints.filter((item) => item.id !== constraint.id))}
						>
							<Trash2 />
						</Button>
					</div>
				</div>
			))}
		</Section>
	);
}

function Section({
	id,
	title,
	action,
	children,
}: {
	id: string;
	title: string;
	action: React.ReactNode;
	children: React.ReactNode;
}) {
	return (
		<section aria-labelledby={id} className="mt-5">
			<header className="flex h-7 items-center justify-between pr-4 pl-6">
				<h3 id={id} className="kicker">{title}</h3>
				{action}
			</header>
			{children}
		</section>
	);
}
