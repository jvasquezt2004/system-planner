import { useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import type { DesignIndex, DesignTable } from "../shared/design";
import { findIndexMethod, indexOperatorClasses } from "../shared/index-methods";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";

type IndexEditorProps = {
	table: DesignTable;
	indexes: DesignIndex[];
	busy: boolean;
	onChange: (indexes: DesignIndex[]) => void;
};

/** Edits the table's access structures and commits text drafts on blur or Enter. */
export function IndexEditor({ table, indexes, busy, onChange }: IndexEditorProps) {
	const [nameDrafts, setNameDrafts] = useState<Record<string, string | undefined>>({});
	const [optionDrafts, setOptionDrafts] = useState<Record<string, string | undefined>>({});

	function updateIndex(id: string, update: (index: DesignIndex) => DesignIndex) {
		onChange(indexes.map((index) => index.id === id ? update(index) : index));
	}

	function updateKey(
		indexId: string,
		keyPosition: number,
		changes: Partial<DesignIndex["keys"][number]>,
	) {
		updateIndex(indexId, (current) => ({
			...current,
			keys: current.keys.map((key, position) =>
				position === keyPosition ? { ...key, ...changes } : key,
			),
		}));
	}

	function commitName(index: DesignIndex) {
		const value = nameDrafts[index.id];
		if (value === undefined) return;
		const name = value.trim();
		updateIndex(index.id, (current) => ({ ...current, name: name || undefined }));
		setNameDrafts((drafts) => ({ ...drafts, [index.id]: undefined }));
	}

	function commitOption(index: DesignIndex, key: string) {
		const draftKey = `${index.id}:${key}`;
		const value = optionDrafts[draftKey];
		if (value === undefined) return;
		const number = value.trim() === "" ? undefined : Number(value);
		updateIndex(index.id, (current) => ({
			...current,
			with: { ...current.with, [key]: number },
		}));
		setOptionDrafts((drafts) => ({ ...drafts, [draftKey]: undefined }));
	}

	return (
		<Section
			id="indexes-heading"
			title="Indexes"
			action={
				<Button
					variant="ghost"
					size="xs"
					data-testid="add-index"
					disabled={busy || table.columns.length === 0}
					onClick={() => onChange([
						...indexes,
						{ id: crypto.randomUUID(), method: "btree", keys: [{ columnId: table.columns[0].id }] },
					])}
				>
					<Plus /> Add index
				</Button>
			}
		>
			{indexes.length === 0 ? (
				<p className="px-6 text-[12px] text-ink-3">No indexes configured.</p>
			) : (
				<ul className="border-y border-rule">
					{indexes.map((index, indexPosition) => (
						<li
							key={index.id}
							className={indexPosition > 0 ? "border-t border-rule-soft px-6 py-3" : "px-6 py-3"}
						>
							<div className="flex gap-2">
								<Input
									aria-label="Index name"
									placeholder="Generated name"
									value={nameDrafts[index.id] ?? index.name ?? ""}
									disabled={busy}
									onChange={(event) => setNameDrafts((drafts) => ({ ...drafts, [index.id]: event.target.value }))}
									onBlur={() => commitName(index)}
									onKeyDown={(event) => event.key === "Enter" && commitName(index)}
								/>
								<Select
									value={index.method}
									disabled={busy}
									onValueChange={(value) => updateIndex(index.id, (current) => ({ ...current, method: value as DesignIndex["method"] }))}
								>
									<SelectTrigger aria-label="Index access method" className="w-28"><SelectValue /></SelectTrigger>
									<SelectContent>
										{["btree", "hash", "gin", "gist", "spgist", "brin", "hnsw", "ivfflat"].map((method) => (
											<SelectItem key={method} value={method}>{findIndexMethod(method)?.label ?? method}</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
							{index.keys.map((key, keyPosition) => {
								const column = table.columns.find((candidate) => candidate.id === key.columnId);
								const classes = column
									? indexOperatorClasses(index.method, column.type, column.typeParameters?.array)
									: [];
								return (
									<div key={`${index.id}-${keyPosition}`} className="mt-2 flex flex-wrap gap-2">
										<Select
										value={key.columnId}
										disabled={busy}
										onValueChange={(columnId) => updateKey(
											index.id,
											keyPosition,
											{ columnId, operatorClass: undefined },
										)}
									>
										<SelectTrigger aria-label="Index key column" className="min-w-0 flex-1">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{table.columns.map((candidate) => (
												<SelectItem key={candidate.id} value={candidate.id}>
													{candidate.name} · {candidate.type}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
										{classes.length > 0 && (
										<Select
										value={key.operatorClass ?? (classes.find((option) => option.default)?.name ?? "default")}
										disabled={busy || !column}
										onValueChange={(value) => updateKey(
											index.id,
											keyPosition,
											{ operatorClass: value === "default" ? undefined : value },
										)}
									>
											<SelectTrigger aria-label="Operator class" className="w-40"><SelectValue /></SelectTrigger>
											<SelectContent>
											{classes.map((option) => (
												<SelectItem key={option.name} value={option.name}>
													{option.name}{option.default ? " · default" : ""}
												</SelectItem>
											))}
											</SelectContent>
										</Select>
										)}
										{findIndexMethod(index.method)?.ordering && (
											<>
											<Select
												value={key.order ?? "default"}
												onValueChange={(value) => updateKey(index.id, keyPosition, {
													order: value === "default" ? undefined : value as "asc" | "desc",
												})}
											>
												<SelectTrigger aria-label="Index key order" className="w-20">
													<SelectValue />
												</SelectTrigger>
												<SelectContent>
													<SelectItem value="default">default</SelectItem>
													<SelectItem value="asc">ASC</SelectItem>
													<SelectItem value="desc">DESC</SelectItem>
												</SelectContent>
												</Select>
											<Select
												value={key.nulls ?? "default"}
												onValueChange={(value) => updateKey(index.id, keyPosition, {
													nulls: value === "default" ? undefined : value as "first" | "last",
												})}
											>
												<SelectTrigger aria-label="Index null ordering" className="w-24">
													<SelectValue />
												</SelectTrigger>
												<SelectContent>
													<SelectItem value="default">NULLS default</SelectItem>
													<SelectItem value="first">NULLS FIRST</SelectItem>
													<SelectItem value="last">NULLS LAST</SelectItem>
												</SelectContent>
												</Select>
											</>
										)}
									</div>
								);
							})}
							<Button
								type="button"
								variant="ghost"
								size="xs"
								className="mt-1"
								disabled={busy || index.keys.length >= table.columns.length}
								onClick={() => {
									const column = table.columns.find((candidate) => !index.keys.some((key) => key.columnId === candidate.id));
									if (column) updateIndex(index.id, (current) => ({ ...current, keys: [...current.keys, { columnId: column.id }] }));
								}}
							>
								<Plus /> Add key column
							</Button>
							<div className="mt-2 flex items-center justify-between gap-2 text-[11px]">
							<label className="flex items-center gap-1.5">
								<Checkbox
									checked={index.unique ?? false}
									disabled={busy || !findIndexMethod(index.method)?.unique}
									onCheckedChange={(checked) => updateIndex(index.id, (current) => ({
										...current,
										unique: checked === true,
										nullsNotDistinct: checked === true ? current.nullsNotDistinct : false,
									}))}
								/>
								Unique
							</label>
							{index.unique && (
								<label className="flex items-center gap-1.5">
									<Checkbox
										aria-label="Nulls not distinct"
										checked={index.nullsNotDistinct ?? false}
										onCheckedChange={(checked) => updateIndex(index.id, (current) => ({
											...current,
											nullsNotDistinct: checked === true,
										}))}
									/>
									NULLS NOT DISTINCT
								</label>
							)}
							<div className="flex gap-1">
								<Button
									size="xs"
									variant="ghost"
									aria-label="Move index up"
									disabled={busy || indexPosition === 0}
									onClick={() => onChange(reorder(indexPosition, indexPosition - 1, indexes))}
								>
									<ArrowUp />
								</Button>
								<Button
									size="xs"
									variant="ghost"
									aria-label="Move index down"
									disabled={busy || indexPosition === indexes.length - 1}
									onClick={() => onChange(reorder(indexPosition, indexPosition + 1, indexes))}
								>
									<ArrowDown />
								</Button>
								<Button
									size="xs"
									variant="strike"
									aria-label="Remove index"
									disabled={busy}
									onClick={() => onChange(indexes.filter((candidate) => candidate.id !== index.id))}
								>
									<Trash2 />
								</Button>
								</div>
							</div>
							<details className="mt-2 text-[11px] text-ink-3">
								<summary className="cursor-pointer">Include columns and storage options</summary>
								<div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
									{table.columns
										.filter((candidate) => !index.keys.some((key) => key.columnId === candidate.id))
										.map((column) => (
											<label key={column.id} className="flex items-center gap-1">
												<Checkbox
													aria-label={`Include ${column.name}`}
													disabled={busy || !findIndexMethod(index.method)?.include}
													checked={index.includeColumnIds?.includes(column.id) ?? false}
													onCheckedChange={(checked) => updateIndex(index.id, (current) => ({
														...current,
														includeColumnIds: checked
															? [...(current.includeColumnIds ?? []), column.id]
															: (current.includeColumnIds ?? []).filter((id) => id !== column.id),
													}))}
												/>
												{column.name}
											</label>
									))}
								</div>
								{storageFields(index.method).map(([key, label]) => (
									<label key={key} className="mt-2 flex flex-1 flex-col gap-1">
										{label}
										<Input
										aria-label={`Index ${label}`}
										type="number"
										min={1}
									value={
										optionDrafts[`${index.id}:${key}`] ??
										String((index.with as Record<string, number> | undefined)?.[key] ?? "")
									}
										disabled={busy}
									onChange={(event) => setOptionDrafts((drafts) => ({
									...drafts,
									[`${index.id}:${key}`]: event.target.value,
								}))}
										onBlur={() => commitOption(index, key)}
										onKeyDown={(event) => event.key === "Enter" && commitOption(index, key)}
									/>
									</label>
								))}
							</details>
						{index.keys.some((key) => {
								const column = table.columns.find((candidate) => candidate.id === key.columnId);
							if (!column) return false;
							const classes = indexOperatorClasses(
								index.method,
								column.type,
								column.typeParameters?.array,
							);
							return !classes.some((option) =>
								key.operatorClass
									? option.name === key.operatorClass
									: option.default,
							);
						}) && (
							<p className="mt-2 text-[11px] text-proof-red">
								A key column no longer has a compatible operator class for
								this access method. Choose a supported method, type, or
								operator class.
							</p>
						)}
						{(() => {
							const key = index.keys[0];
							const column = key
								? table.columns.find((candidate) => candidate.id === key.columnId)
								: undefined;
							const dimensions =
								column?.type === "bit"
									? column.typeParameters?.length
									: column?.typeParameters?.dimensions;
							const limit =
								column?.type === "vector"
									? 2000
									: column?.type === "halfvec"
										? 4000
										: column?.type === "bit"
											? 64000
											: undefined;
							if (!limit || dimensions === undefined || dimensions <= limit) {
								return null;
							}
							return (
								<p className="mt-2 text-[11px] text-proof-red">
									{index.method} supports at most {limit} dimensions for {column?.type} columns.
								</p>
							);
						})()}
						</li>
					))}
				</ul>
			)}
		</Section>
	);
}

function storageFields(method: DesignIndex["method"]): [string, string][] {
	if (method === "hnsw") {
		return [
			["m", "m"],
			["efConstruction", "ef_construction"],
		];
	}
	if (method === "ivfflat") return [["lists", "lists"]];
	if (method === "brin") return [["pagesPerRange", "pages_per_range"]];
	return [];
}

function reorder(from: number, to: number, indexes: DesignIndex[]): DesignIndex[] {
	const next = [...indexes];
	const [item] = next.splice(from, 1);
	next.splice(to, 0, item);
	return next;
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
