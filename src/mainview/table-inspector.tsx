import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Plus, Trash2, Unlink } from "lucide-react";
import {
	COLUMN_LITERAL_LABELS,
	columnDefaultProblem,
	describeColumnDefault,
	noColumnDefault,
	sameColumnDefault,
	type ColumnDefault,
} from "../shared/column-defaults";
import {
	COLUMN_TYPE_DEFINITIONS,
	COLUMN_TYPE_FAMILIES,
	findColumnTypeInfo,
	type ColumnLiteralType,
	type ColumnType,
} from "../shared/column-types";
import {
	getSqlValidationErrors,
	type ColumnChanges,
	type DesignColumn,
	type DesignTable,
	type RelationshipCardinality,
	type SqlState,
} from "../shared/design";
import type { RelationshipView } from "../shared/relationships";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { ColumnBadge } from "./column-badge";
import { ColumnTypeBadge } from "./column-type-badge";

type TableInspectorProps = {
	table: DesignTable;
	selectedColumnId: string | null;
	relationships: RelationshipView[];
	selectedRelationshipId: string | null;
	sql: SqlState;
	busy: boolean;
	onRename: (name: string) => void;
	onRemove: () => void;
	onSelectColumn: (columnId: string | null) => void;
	onAddColumn: () => void;
	onApplyColumn: (columnId: string, changes: ColumnChanges) => void;
	onRemoveColumn: (columnId: string) => void;
	onSelectRelationship: (relationshipId: string | null) => void;
	onSetRelationshipRequired: (relationshipId: string, required: boolean) => void;
	onSetRelationshipCardinality: (
		relationshipId: string,
		cardinality: RelationshipCardinality,
	) => void;
	onRemoveRelationship: (relationshipId: string) => void;
};

/**
 * The focused editor for the selected table, shown in the side sheet: table
 * identity, its column list, the column editor, and its relationships. Column
 * edits are drafts until applied; the table card and the SQL preview only
 * change once the workspace accepts them.
 */
export function TableInspector({
	table,
	selectedColumnId,
	relationships,
	selectedRelationshipId,
	sql,
	busy,
	onRename,
	onRemove,
	onSelectColumn,
	onAddColumn,
	onApplyColumn,
	onRemoveColumn,
	onSelectRelationship,
	onSetRelationshipRequired,
	onSetRelationshipCardinality,
	onRemoveRelationship,
}: TableInspectorProps) {
	const [name, setName] = useState(table.name);

	useEffect(() => {
		setName(table.name);
	}, [table.id, table.name]);

	const selectedColumn =
		table.columns.find((column) => column.id === selectedColumnId) ?? null;
	const manyToManyReference =
		selectedColumn !== null &&
		relationships.some(
			(view) =>
				view.manyToManyAssociation !== null &&
				view.referencingTable.id === table.id &&
				view.referencingColumn.id === selectedColumn.id,
		);
	const validationErrors = getSqlValidationErrors(sql);
	const renamed = name.trim().length > 0 && name.trim() !== table.name;

	return (
		<section
			aria-labelledby="selection-heading"
			data-testid="table-selection"
			className="flex flex-col"
		>
			<header className="px-6 pt-5 pb-1">
				<p id="selection-heading" className="kicker">
					Table
					<span className="figures ml-2 font-mono font-normal tracking-normal normal-case text-ink-4">
						{table.columns.length} {table.columns.length === 1 ? "column" : "columns"}
						{" · "}
						{relationships.length}{" "}
						{relationships.length === 1 ? "relationship" : "relationships"}
					</span>
				</p>
				<form
					className="mt-1.5 flex items-end gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						if (renamed) onRename(name.trim());
					}}
				>
					<input
						value={name}
						onChange={(event) => setName(event.target.value)}
						aria-label="Selected table name"
						data-testid="table-name-input"
						className="min-w-0 flex-1 border-b border-transparent bg-transparent pb-0.5 font-display text-[28px] leading-tight font-medium tracking-[-0.015em] text-ink outline-none hover:border-rule focus:border-pencil"
					/>
					<Button
						type="submit"
						size="sm"
						variant={renamed ? "default" : "ghost"}
						data-testid="rename-table"
						disabled={busy || !renamed}
						className={cn(!renamed && "invisible")}
					>
						Rename
					</Button>
				</form>
			</header>

			<Section
				id="columns-heading"
				title="Columns"
				action={
					<Button
						variant="ghost"
						size="xs"
						data-testid="add-column"
						onClick={onAddColumn}
						disabled={busy}
					>
						<Plus />
						Add column
					</Button>
				}
			>
				<ul data-testid="table-columns" className="border-y border-rule">
					{table.columns.map((column, index) => {
						const selected = column.id === selectedColumnId;
						return (
							<li key={column.id} className={cn(index > 0 && "border-t border-rule-soft")}>
								<button
									type="button"
									data-testid="table-column"
									data-column-id={column.id}
									aria-pressed={selected}
									onClick={() => onSelectColumn(selected ? null : column.id)}
									className={cn(
										"flex h-8 w-full items-center gap-2 border-l-2 pr-6 pl-[22px] text-left text-[12.5px] outline-none focus-visible:bg-pencil-wash",
										selected
											? "border-l-pencil bg-pencil-wash"
											: "border-l-transparent hover:bg-paper-tint",
									)}
								>
									<span className="figures w-4 shrink-0 text-right font-mono text-[9.5px] text-ink-4">
										{index + 1}
									</span>
									<ColumnTypeBadge type={column.type} />
									<span
										className={cn(
											"min-w-0 flex-1 truncate font-medium",
											selected ? "text-pencil" : "text-ink",
										)}
									>
										{column.name}
									</span>
									<span className="shrink-0 font-mono text-[10.5px] text-ink-3">
										{column.type}
									</span>
									<span className="flex w-[74px] shrink-0 items-center justify-end gap-1">
										{column.primaryKey && (
											<ColumnBadge label="PK" tone="key" title="Primary key" />
										)}
										{column.unique && !column.primaryKey && (
											<ColumnBadge label="UQ" tone="strong" title="Unique" />
										)}
										{column.identity && (
											<ColumnBadge label="ID" tone="quiet" title="Identity generation" />
										)}
										{column.default.kind !== "none" && (
											<ColumnBadge
												label="D"
												tone="quiet"
												title={`Default: ${describeColumnDefault(column.default)}`}
											/>
										)}
										{column.nullable ? (
											<ColumnBadge label="?" tone="quiet" title="Nullable" />
										) : (
											<ColumnBadge label="!" tone="faint" title="Required" />
										)}
										{column.notes.length > 0 && (
											<span
												title={column.notes}
												aria-label="Column note"
												className="font-display text-[12px] leading-none text-ink-3 italic"
											>
												†
											</span>
										)}
									</span>
								</button>
							</li>
						);
					})}
				</ul>

				<div className="px-6 pt-3">
					{selectedColumn ? (
						<ColumnEditor
							tableName={table.name}
							column={selectedColumn}
							manyToManyReference={manyToManyReference}
							busy={busy}
							onApply={(changes) => onApplyColumn(selectedColumn.id, changes)}
							onRemove={() => onRemoveColumn(selectedColumn.id)}
						/>
					) : (
						<p className="text-[12px] leading-relaxed text-ink-3">
							Select a column to edit its name, type, default, key settings,
							nullability, uniqueness, and notes.
						</p>
					)}
				</div>
			</Section>

			<Section
				id="relationships-heading"
				title="Relationships"
				action={
					<span className="figures font-mono text-[10.5px] text-ink-4">
						{relationships.length === 0
							? "none"
							: `${relationships.length} ${relationships.length === 1 ? "link" : "links"}`}
					</span>
				}
			>
				{relationships.length === 0 ? (
					<p className="px-6 text-[12px] leading-relaxed text-ink-3">
						Press <span className="font-medium text-ink-2 uppercase tracking-[0.06em] text-[10.5px]">relate</span> on a
						table card, then click the table it references. The foreign-key column is
						created for you.
					</p>
				) : (
					<ul data-testid="table-relationships" className="border-y border-rule">
						{relationships.map((view, index) => (
							<RelationshipRow
								key={view.relationship.id}
								view={view}
								table={table}
								first={index === 0}
								selected={view.relationship.id === selectedRelationshipId}
								busy={busy}
								onSelect={onSelectRelationship}
								onSetRequired={onSetRelationshipRequired}
								onSetCardinality={onSetRelationshipCardinality}
								onRemove={onRemoveRelationship}
							/>
						))}
					</ul>
				)}
				<p className="px-6 pt-2.5 text-[11.5px] leading-relaxed text-ink-3">
					Required references need a parent for every referencing row. One-to-one
					limits each parent to one referencing row. Many-to-many stores pairs in
					this editable junction; either endpoint may have no pairs.
				</p>
			</Section>

			{validationErrors.length > 0 && (
				<div
					data-testid="validation-errors"
					className="mx-6 mt-6 border-l-2 border-ochre bg-ochre-wash px-3 py-2.5"
				>
					<p className="kicker text-ochre!">Blocked by validation</p>
					<ul className="mt-1.5 space-y-1 text-[12px] leading-snug text-ink-2">
						{validationErrors.map((message) => (
							<li key={message}>{message}</li>
						))}
					</ul>
				</div>
			)}

			<footer className="mt-8 border-t border-rule px-6 py-4">
				<Button
					variant="strike"
					size="sm"
					data-testid="remove-table"
					onClick={onRemove}
					disabled={busy}
					className="-ml-2.5"
				>
					<Trash2 />
					Remove table
				</Button>
			</footer>
		</section>
	);
}

/** A titled run of content under a kicker and hairline, like a page section. */
function Section({
	id,
	title,
	action,
	children,
}: {
	id: string;
	title: string;
	action?: React.ReactNode;
	children: React.ReactNode;
}) {
	return (
		<section aria-labelledby={id} className="mt-5">
			<header className="flex h-7 items-center justify-between pr-4 pl-6">
				<h3 id={id} className="kicker">
					{title}
				</h3>
				{action}
			</header>
			{children}
		</section>
	);
}

function RelationshipRow({
	view,
	table,
	first,
	selected,
	busy,
	onSelect,
	onSetRequired,
	onSetCardinality,
	onRemove,
}: {
	view: RelationshipView;
	table: DesignTable;
	first: boolean;
	selected: boolean;
	busy: boolean;
	onSelect: (relationshipId: string | null) => void;
	onSetRequired: (relationshipId: string, required: boolean) => void;
	onSetCardinality: (relationshipId: string, cardinality: RelationshipCardinality) => void;
	onRemove: (relationshipId: string) => void;
}) {
	const relationshipId = view.relationship.id;
	const outgoing = view.referencingTable.id === table.id;
	const referencing = view.referencingTable.name;
	const referenced = view.referencedTable.name;
	const manyToMany = view.manyToManyAssociation !== null;
	return (
		<li
			data-testid="table-relationship"
			data-relationship-id={relationshipId}
			data-cardinality={manyToMany ? "many-to-many" : view.relationship.cardinality}
			data-selected={selected ? "true" : undefined}
			className={cn(
				"border-l-2",
				!first && "border-t border-t-rule-soft",
				selected ? "border-l-pencil bg-pencil-wash" : "border-l-transparent",
			)}
		>
			<button
				type="button"
				onClick={() => onSelect(selected ? null : relationshipId)}
				aria-pressed={selected}
				className="flex w-full flex-col gap-1 pt-2.5 pr-6 pb-1.5 pl-[22px] text-left outline-none hover:bg-paper-tint focus-visible:bg-pencil-wash"
			>
				<span className="flex items-baseline gap-2">
					{outgoing ? (
						<ArrowRight className="size-3 shrink-0 self-center text-ink-3" aria-hidden="true" />
					) : (
						<ArrowLeft className="size-3 shrink-0 self-center text-ink-3" aria-hidden="true" />
					)}
					<span
						className={cn(
							"min-w-0 flex-1 truncate font-display text-[15px] font-medium",
							selected ? "text-pencil" : "text-ink",
						)}
					>
						{outgoing ? `References ${referenced}` : `Referenced by ${referencing}`}
					</span>
					<span className="kicker shrink-0">
						{manyToMany
							? "many-to-many"
							: view.oneToOne
								? "one-to-one"
								: "one-to-many"}
					</span>
				</span>
				<span className="truncate pl-5 font-mono text-[10.5px] text-ink-3">
					{referencing}.{view.referencingColumn.name} → {referenced}.
					{view.referencedColumn?.name ?? "(no primary key)"}
					{manyToMany ? " · visible junction" : view.oneToOne ? " · unique" : ""}
				</span>
			</button>
			<div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 pr-4 pb-2.5 pl-[42px]">
				<label
					className="flex items-center gap-1.5 text-[12px] text-ink-2"
					title={
						manyToMany
							? "Many-to-many junction references are always required."
							: view.oneToOne
								? `Every ${referencing} record must name one ${referenced} record, and at most one ${referencing} record may name it. ${referenced} records may still have none.`
								: `Every ${referencing} record must name one ${referenced} record. ${referenced} records may have none.`
					}
				>
					<Checkbox
						aria-label={`Required reference from ${referencing} to ${referenced}`}
						data-testid="relationship-required"
						checked={view.required}
						disabled={busy || manyToMany}
						onCheckedChange={(checked) => onSetRequired(relationshipId, checked === true)}
					/>
					Required
				</label>
				{!manyToMany && (
					<ToggleGroup
						type="single"
						variant="outline"
						size="sm"
						spacing={0}
						aria-label={`Cardinality of the reference from ${referencing} to ${referenced}`}
						value={view.relationship.cardinality}
						disabled={busy}
						onValueChange={(value) => {
							if (
								(value === "one-to-many" || value === "one-to-one") &&
								value !== view.relationship.cardinality
							) {
								onSetCardinality(relationshipId, value);
							}
						}}
					>
						<ToggleGroupItem value="one-to-many" data-testid="relationship-one-to-many">
							many
						</ToggleGroupItem>
						<ToggleGroupItem
							value="one-to-one"
							data-testid="relationship-one-to-one"
							title={`One-to-one adds uniqueness on ${referencing}.${view.referencingColumn.name}, so at most one record may name the same ${referenced} record.`}
						>
							one-to-one
						</ToggleGroupItem>
					</ToggleGroup>
				)}
				<Button
					variant="strike"
					size="xs"
					data-testid="remove-relationship"
					onPointerDown={(event) => event.stopPropagation()}
					onClick={() => onRemove(relationshipId)}
					disabled={busy}
					title={
						manyToMany
							? "Remove the many-to-many relationship's constraints, keeping the junction and its columns"
							: "Remove the relationship-owned foreign key and uniqueness, keeping the columns"
					}
					className="ml-auto"
				>
					<Unlink />
					{manyToMany ? "Remove association" : "Remove link"}
				</Button>
			</div>
		</li>
	);
}

type ColumnDraft = {
	name: string;
	type: ColumnType;
	nullable: boolean;
	primaryKey: boolean;
	unique: boolean;
	identity: boolean;
	defaultValue: ColumnDefault;
	notes: string;
};

function draftFrom(column: DesignColumn): ColumnDraft {
	return {
		name: column.name,
		type: column.type,
		nullable: column.nullable,
		primaryKey: column.primaryKey,
		unique: column.unique,
		identity: column.identity,
		defaultValue: column.default,
		notes: column.notes,
	};
}

function changesFrom(column: DesignColumn, draft: ColumnDraft): ColumnChanges {
	const changes: ColumnChanges = {};
	if (draft.name.trim() !== column.name) changes.name = draft.name.trim();
	if (draft.type !== column.type) changes.type = draft.type;
	if (draft.nullable !== column.nullable) changes.nullable = draft.nullable;
	if (draft.primaryKey !== column.primaryKey) changes.primaryKey = draft.primaryKey;
	if (draft.unique !== column.unique) changes.unique = draft.unique;
	if (draft.identity !== column.identity) changes.identity = draft.identity;
	if (!sameColumnDefault(draft.defaultValue, column.default)) {
		changes.default = draft.defaultValue;
	}
	if (draft.notes.trim() !== column.notes) changes.notes = draft.notes;
	return changes;
}

type DefaultChoice =
	| "none"
	| "literal"
	| "currentTimestamp"
	| "generateUuid"
	| "identity";

function defaultChoice(draft: ColumnDraft): DefaultChoice {
	if (draft.identity) return "identity";
	return draft.defaultValue.kind;
}

function draftLiteralType(draft: ColumnDraft): ColumnLiteralType | null {
	if (draft.defaultValue.kind === "literal") return draft.defaultValue.literalType;
	return findColumnTypeInfo(draft.type)?.defaults.literal ?? null;
}

const LITERAL_PLACEHOLDERS: Record<ColumnLiteralType, string> = {
	text: "Default text",
	integer: "42",
	numeric: "12.50",
	boolean: "true",
	date: "2024-02-29",
	timestamp: "2024-02-29T12:00:00Z",
	json: '{"key": "value"}',
};

function capitalize(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1);
}

function ColumnEditor({
	tableName,
	column,
	manyToManyReference,
	busy,
	onApply,
	onRemove,
}: {
	tableName: string;
	column: DesignColumn;
	manyToManyReference: boolean;
	busy: boolean;
	onApply: (changes: ColumnChanges) => void;
	onRemove: () => void;
}) {
	const [draft, setDraft] = useState<ColumnDraft>(() => draftFrom(column));

	// Reset only when the stored column changes, so a background save or
	// sandbox result never overwrites what is being typed.
	useEffect(() => {
		setDraft(draftFrom(column));
	}, [
		column.id,
		column.name,
		column.type,
		column.nullable,
		column.primaryKey,
		column.unique,
		column.identity,
		column.default,
		column.notes,
	]);

	const changes = changesFrom(column, draft);
	const dirty = Object.keys(changes).length > 0;
	const invalid = draft.name.trim().length === 0;
	const draftType = findColumnTypeInfo(draft.type);
	const support = draftType?.defaults ?? {
		literal: null,
		currentTimestamp: false,
		generateUuid: false,
	};
	const choice = defaultChoice(draft);
	const literalType = draftLiteralType(draft);
	const defaultProblem = columnDefaultProblem(draft.type, draft.defaultValue);
	// A stored identity column whose draft type leaves the integer family is
	// cleared by the workspace in the same visible edit.
	const dropsIdentity = draft.identity && draftType !== null && !draftType.identity;

	function chooseDefault(next: DefaultChoice) {
		if (next === "identity") {
			setDraft({
				...draft,
				identity: true,
				// Identity columns are always required.
				nullable: false,
				defaultValue: noColumnDefault(),
			});
			return;
		}
		if (next === "none") {
			setDraft({ ...draft, identity: false, defaultValue: noColumnDefault() });
			return;
		}
		if (next === "literal") {
			const keep =
				draft.defaultValue.kind === "literal" ? draft.defaultValue : null;
			const literalKind = support.literal ?? "text";
			setDraft({
				...draft,
				identity: false,
				defaultValue:
					keep ??
					({
						kind: "literal",
						literalType: literalKind,
						value: literalKind === "boolean" ? "true" : "",
					} satisfies ColumnDefault),
			});
			return;
		}
		setDraft({
			...draft,
			identity: false,
			defaultValue: { kind: next },
		});
	}

	const literalValue =
		draft.defaultValue.kind === "literal" ? draft.defaultValue.value : "";

	/** Keeps the literal category and updates only the value being typed. */
	function updateLiteralValue(value: string) {
		if (draft.defaultValue.kind !== "literal") return;
		setDraft({
			...draft,
			defaultValue: { ...draft.defaultValue, value },
		});
	}

	const showGenerated =
		support.currentTimestamp ||
		support.generateUuid ||
		draftType?.identity ||
		choice === "currentTimestamp" ||
		choice === "generateUuid" ||
		choice === "identity";

	return (
		<form
			aria-labelledby="column-editor-heading"
			data-testid="column-editor"
			className="rounded-[3px] border border-rule bg-paper px-4 pt-3 pb-4"
			onSubmit={(event) => {
				event.preventDefault();
				if (!dirty || invalid || busy) return;
				onApply(changes);
			}}
		>
			<header className="flex items-baseline justify-between gap-2">
				<h3 id="column-editor-heading" className="kicker">
					Column
				</h3>
				<span className="truncate font-mono text-[10.5px] text-ink-4">
					{tableName}.{column.name}
				</span>
			</header>
			{manyToManyReference && (
				<Hint testId="many-to-many-reference-lock">
					Many-to-many references stay required; pair uniqueness belongs to the
					association. Nullability, uniqueness, primary-key, and default/identity
					settings are locked.
				</Hint>
			)}

			<Field label="Name" htmlFor="column-name">
				<Input
					id="column-name"
					value={draft.name}
					onChange={(event) => setDraft({ ...draft, name: event.target.value })}
					aria-label="Column name"
					aria-invalid={invalid || undefined}
					data-testid="column-name-input"
					className="font-mono text-[12.5px]"
				/>
			</Field>
			{invalid && <Hint tone="warn">A column needs a name.</Hint>}

			<Field label="Type">
				<Select
					value={draft.type}
					onValueChange={(value) => setDraft({ ...draft, type: value as ColumnType })}
				>
					<SelectTrigger
						aria-label="Column type"
						data-testid="column-type-picker"
						className="w-full"
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent position="popper" className="max-h-80">
						{COLUMN_TYPE_FAMILIES.map((family) => (
							<SelectGroup key={family.id}>
								<SelectLabel>{family.label}</SelectLabel>
								{COLUMN_TYPE_DEFINITIONS.filter(
									(definition) => definition.family === family.id,
								).map((definition) => (
									<SelectItem key={definition.type} value={definition.type}>
										<ColumnTypeBadge type={definition.type} />
										<span className="font-mono text-[12px]">{definition.type}</span>
										<span className="text-ink-3">{definition.label}</span>
									</SelectItem>
								))}
							</SelectGroup>
						))}
					</SelectContent>
				</Select>
			</Field>
			{dropsIdentity && (
				<Hint>Identity generation will be cleared because it only applies to integer types.</Hint>
			)}

			<Field label="Default">
				<Select
					value={choice}
					onValueChange={(value) => chooseDefault(value as DefaultChoice)}
					disabled={manyToManyReference}
				>
					<SelectTrigger
						aria-label="Column default"
						data-testid="column-default-picker"
						className="w-full"
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent position="popper">
						<SelectItem value="none">No default</SelectItem>
						{(support.literal !== null || choice === "literal") && (
							<SelectGroup>
								<SelectLabel>Typed literal</SelectLabel>
								<SelectItem value="literal">
									{literalType
										? `A ${COLUMN_LITERAL_LABELS[literalType]}`
										: "A typed value"}
								</SelectItem>
							</SelectGroup>
						)}
						{showGenerated && (
							<SelectGroup>
								<SelectLabel>Database-generated</SelectLabel>
								{(support.currentTimestamp || choice === "currentTimestamp") && (
									<SelectItem value="currentTimestamp">Current timestamp</SelectItem>
								)}
								{(support.generateUuid || choice === "generateUuid") && (
									<SelectItem value="generateUuid">Generate a UUID</SelectItem>
								)}
								{(draftType?.identity || choice === "identity") && (
									<SelectItem value="identity">Identity generation</SelectItem>
								)}
							</SelectGroup>
						)}
					</SelectContent>
				</Select>
			</Field>

			{choice === "literal" && literalType !== null && (
				<Field label={COLUMN_LITERAL_LABELS[literalType]}>
					{literalType === "boolean" ? (
						<ToggleGroup
							type="single"
							variant="outline"
							size="sm"
							spacing={0}
							aria-label="Default value"
							data-testid="column-default-literal"
							disabled={manyToManyReference}
							value={literalValue === "true" || literalValue === "false" ? literalValue : ""}
							onValueChange={(value) => {
								if (value) updateLiteralValue(value);
							}}
						>
							<ToggleGroupItem value="true" className="font-mono">
								true
							</ToggleGroupItem>
							<ToggleGroupItem value="false" className="font-mono">
								false
							</ToggleGroupItem>
						</ToggleGroup>
					) : literalType === "json" ? (
						<Textarea
							value={literalValue}
							onChange={(event) => updateLiteralValue(event.target.value)}
							aria-label="Default value"
							disabled={manyToManyReference}
							data-testid="column-default-literal"
							rows={2}
							placeholder={LITERAL_PLACEHOLDERS.json}
							className="font-mono text-[12px]"
						/>
					) : (
						<Input
							value={literalValue}
							onChange={(event) => updateLiteralValue(event.target.value)}
							aria-label="Default value"
							disabled={manyToManyReference}
							data-testid="column-default-literal"
							inputMode={
								literalType === "integer" || literalType === "numeric"
									? "decimal"
									: undefined
							}
							placeholder={LITERAL_PLACEHOLDERS[literalType]}
							className="font-mono text-[12.5px]"
						/>
					)}
				</Field>
			)}
			{literalType === "boolean" &&
				choice === "literal" &&
				literalValue !== "true" &&
				literalValue !== "false" && (
					<Hint tone="warn">“{literalValue}” is not a boolean. Choose true or false.</Hint>
				)}
			{defaultProblem !== null && (
				<Hint tone="warn" testId="default-warning">
					{capitalize(defaultProblem)}. Applying keeps this default in the saved draft,
					but SQL generation stays blocked until it is resolved.
				</Hint>
			)}
			{draft.identity && draft.defaultValue.kind !== "none" && (
				<Hint tone="warn">
					This column has both identity generation and a default. Choose one.
				</Hint>
			)}

			<fieldset className="mt-3.5">
				<legend className="kicker mb-2">Settings</legend>
				<div className="flex flex-wrap gap-x-5 gap-y-2">
					<Setting
						label="Nullable"
						testId="column-nullable"
						checked={draft.nullable}
						disabled={manyToManyReference || draft.primaryKey || draft.identity}
						title={
							draft.primaryKey
								? "A primary key is always required"
								: draft.identity
									? "Identity columns are always required"
									: undefined
						}
						onChange={(checked) => setDraft({ ...draft, nullable: checked })}
					/>
					<Setting
						label="Unique"
						testId="column-unique"
						checked={draft.unique && !draft.primaryKey}
						disabled={manyToManyReference || draft.primaryKey}
						title={draft.primaryKey ? "A primary key is already unique" : undefined}
						onChange={(checked) => setDraft({ ...draft, unique: checked })}
					/>
					<Setting
						label="Primary key"
						testId="column-primary-key"
						checked={draft.primaryKey}
						disabled={manyToManyReference}
						onChange={(checked) =>
							setDraft(
								checked
									? {
											...draft,
											primaryKey: true,
											// A key is required, and uniqueness is implied.
											nullable: false,
											unique: false,
										}
									: { ...draft, primaryKey: false },
							)
						}
					/>
				</div>
			</fieldset>
			{column.identity && (
				<Hint>This column currently uses identity generation. Choosing a default replaces it.</Hint>
			)}

			<Field label="Notes" htmlFor="column-notes">
				<Textarea
					id="column-notes"
					value={draft.notes}
					onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
					aria-label="Column notes"
					data-testid="column-notes"
					rows={2}
					placeholder="Why this column exists"
					className="font-display text-[14px] italic placeholder:not-italic"
				/>
			</Field>

			<div className="mt-4 flex flex-wrap items-center gap-2">
				<Button type="submit" size="sm" data-testid="apply-column" disabled={busy || !dirty || invalid}>
					Apply changes
				</Button>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					data-testid="reset-column"
					onClick={() => setDraft(draftFrom(column))}
					disabled={busy || !dirty}
				>
					Reset
				</Button>
				<Button
					type="button"
					variant="strike"
					size="sm"
					data-testid="remove-column"
					onClick={onRemove}
					disabled={busy}
					className="ml-auto"
				>
					<Trash2 />
					Remove column
				</Button>
			</div>
		</form>
	);
}

function Field({
	label,
	htmlFor,
	children,
}: {
	label: string;
	htmlFor?: string;
	children: React.ReactNode;
}) {
	return (
		<div className="mt-3 flex flex-col gap-1">
			<label htmlFor={htmlFor} className="text-[11px] font-medium text-ink-3">
				{label}
			</label>
			{children}
		</div>
	);
}

function Hint({
	tone = "note",
	testId,
	children,
}: {
	tone?: "note" | "warn";
	testId?: string;
	children: React.ReactNode;
}) {
	return (
		<p
			data-testid={testId}
			className={cn(
				"mt-1.5 text-[11.5px] leading-snug",
				tone === "warn" ? "text-ochre" : "text-ink-3",
			)}
		>
			{children}
		</p>
	);
}

function Setting({
	label,
	testId,
	checked,
	disabled,
	title,
	onChange,
}: {
	label: string;
	testId: string;
	checked: boolean;
	disabled?: boolean;
	title?: string;
	onChange: (checked: boolean) => void;
}) {
	return (
		<label
			title={title}
			className={cn(
				"flex items-center gap-1.5 text-[12.5px] text-ink-2",
				disabled && "text-ink-4",
			)}
		>
			<Checkbox
				aria-label={label}
				data-testid={testId}
				checked={checked}
				disabled={disabled}
				onCheckedChange={(next) => onChange(next === true)}
			/>
			{label}
		</label>
	);
}
