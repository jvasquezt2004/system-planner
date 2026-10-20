import { useEffect, useState } from "react";
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
import type {
	ColumnChanges,
	DesignColumn,
	DesignTable,
	SqlState,
} from "../shared/design";
import { ColumnBadge } from "./column-badge";
import { ColumnTypeBadge } from "./column-type-badge";

type TableInspectorProps = {
	table: DesignTable | null;
	selectedColumnId: string | null;
	sql: SqlState;
	busy: boolean;
	onRename: (name: string) => void;
	onRemove: () => void;
	onSelectColumn: (columnId: string | null) => void;
	onAddColumn: () => void;
	onApplyColumn: (columnId: string, changes: ColumnChanges) => void;
	onRemoveColumn: (columnId: string) => void;
};

/**
 * The focused side panel for the selected table: table identity, its column
 * list, and the column editor. Column edits are drafts until applied; the
 * table card and the SQL/sandbox panels only change once the workspace accepts
 * them.
 */
export function TableInspector({
	table,
	selectedColumnId,
	sql,
	busy,
	onRename,
	onRemove,
	onSelectColumn,
	onAddColumn,
	onApplyColumn,
	onRemoveColumn,
}: TableInspectorProps) {
	const [name, setName] = useState(table?.name ?? "");
	const [confirmingRemoval, setConfirmingRemoval] = useState(false);

	useEffect(() => {
		setName(table?.name ?? "");
		setConfirmingRemoval(false);
	}, [table?.id, table?.name]);

	if (!table) {
		return (
			<section
				aria-labelledby="selection-heading"
				className="rounded-xl border border-slate-800 bg-slate-900/60 p-4"
			>
				<h2
					id="selection-heading"
					className="text-[11px] font-semibold uppercase tracking-wide text-slate-400"
				>
					Selected table
				</h2>
				<p className="mt-2 text-sm text-slate-500">
					Select a table card to inspect its columns here. Adding, renaming, and removing
					columns happens in this focused panel.
				</p>
			</section>
		);
	}

	const selectedColumn =
		table.columns.find((column) => column.id === selectedColumnId) ?? null;
	const validationErrors = sql.status === "current" ? [] : sql.errors;

	function requestTableRename(nextName: string) {
		if (nextName.trim().length === 0 || nextName.trim() === table?.name) return;
		onRename(nextName.trim());
	}

	return (
		<section
			aria-labelledby="selection-heading"
			data-testid="table-selection"
			className="rounded-xl border border-slate-800 bg-slate-900/60"
		>
			<header className="flex items-center justify-between border-b border-slate-800 px-4 py-2.5">
				<h2
					id="selection-heading"
					className="text-[11px] font-semibold uppercase tracking-wide text-slate-400"
				>
					Selected table
				</h2>
				<span className="text-[10px] uppercase tracking-wide text-slate-500">
					{table.columns.length} {table.columns.length === 1 ? "column" : "columns"}
				</span>
			</header>

			<form
				className="flex gap-2 px-4 pt-3"
				onSubmit={(event) => {
					event.preventDefault();
					requestTableRename(name);
				}}
			>
				<input
					value={name}
					onChange={(event) => setName(event.target.value)}
					aria-label="Selected table name"
					data-testid="table-name-input"
					className="min-w-0 flex-1 rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-sm outline-none focus:border-indigo-500"
				/>
				<button
					type="submit"
					data-testid="rename-table"
					disabled={busy || name.trim().length === 0 || name.trim() === table.name}
					className="rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-slate-500 disabled:cursor-not-allowed disabled:opacity-40"
				>
					Rename
				</button>
			</form>

			<section aria-labelledby="columns-heading" className="mt-3">
				<header className="flex items-center justify-between px-4">
					<h3
						id="columns-heading"
						className="text-[11px] font-semibold uppercase tracking-wide text-slate-400"
					>
						Columns
					</h3>
					<button
						type="button"
						data-testid="add-column"
						onClick={onAddColumn}
						disabled={busy}
						className="rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1 text-[11px] font-medium text-slate-200 hover:border-slate-500 disabled:cursor-not-allowed disabled:opacity-40"
					>
						Add column
					</button>
				</header>

				<ul
					data-testid="table-columns"
					className="mt-2 divide-y divide-slate-800 border-y border-slate-800"
				>
					{table.columns.map((column, index) => {
						const selected = column.id === selectedColumnId;
						return (
							<li key={column.id}>
								<button
									type="button"
									data-testid="table-column"
									data-column-id={column.id}
									aria-pressed={selected}
									onClick={() => onSelectColumn(column.id)}
									className={`flex w-full items-center gap-2 px-4 py-2 text-left text-xs outline-none focus-visible:ring-1 focus-visible:ring-indigo-400 ${
										selected
											? "bg-indigo-500/10 text-indigo-100"
											: "text-slate-300 hover:bg-slate-800/40"
									}`}
								>
									<span className="w-4 shrink-0 text-right text-[10px] tabular-nums text-slate-600">
										{index + 1}
									</span>
									<ColumnTypeBadge type={column.type} />
									<span className="min-w-0 flex-1 truncate font-medium">
										{column.name}
									</span>
									<span className="shrink-0 text-[11px] text-slate-400">
										{column.type}
									</span>
									{column.primaryKey && (
										<ColumnBadge label="PK" className="text-amber-300" title="Primary key" />
									)}
									{column.unique && !column.primaryKey && (
										<ColumnBadge
											label="UQ"
											className="text-emerald-300"
											title="Unique"
										/>
									)}
									{column.identity && (
										<ColumnBadge
											label="ID"
											className="text-sky-300"
											title="Identity generation"
										/>
									)}
									{column.default.kind !== "none" && (
										<ColumnBadge
											label="D"
											className="text-fuchsia-300"
											title={`Default: ${describeColumnDefault(column.default)}`}
										/>
									)}
									{column.nullable ? (
										<ColumnBadge label="?" className="text-slate-500" title="Nullable" />
									) : (
										<ColumnBadge label="!" className="text-slate-400" title="Required" />
									)}
									{column.notes.length > 0 && (
										<span
											title={column.notes}
											aria-label="Column note"
											className="shrink-0 text-[10px] text-slate-500"
										>
											✎
										</span>
									)}
								</button>
							</li>
						);
					})}
				</ul>
			</section>

			<div className="px-4 py-3">
				{selectedColumn ? (
					<ColumnEditor
						tableName={table.name}
						column={selectedColumn}
						busy={busy}
						onApply={(changes) => onApplyColumn(selectedColumn.id, changes)}
						onRemove={() => onRemoveColumn(selectedColumn.id)}
					/>
				) : (
					<p className="text-[11px] text-slate-500">
						Select a column above to edit its name, type, key settings, nullability,
						uniqueness, and notes.
					</p>
				)}
			</div>

			{validationErrors.length > 0 && (
				<div
					data-testid="validation-errors"
					className="mx-4 mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2"
				>
					<p className="text-[11px] font-semibold uppercase tracking-wide text-amber-300">
						Blocked by validation
					</p>
					<ul className="mt-1 list-disc space-y-1 pl-4 text-[11px] text-amber-200">
						{validationErrors.map((message) => (
							<li key={message}>{message}</li>
						))}
					</ul>
				</div>
			)}

			<div className="flex flex-col gap-2 border-t border-slate-800 px-4 py-3">
				{confirmingRemoval ? (
					<div className="flex flex-wrap items-center gap-2 rounded-md border border-red-500/40 bg-red-500/10 px-2 py-2">
						<span className="text-xs text-red-200">Remove “{table.name}”?</span>
						<button
							type="button"
							data-testid="confirm-remove-table"
							onClick={onRemove}
							disabled={busy}
							className="rounded-md bg-red-500 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-400 disabled:cursor-not-allowed disabled:opacity-40"
						>
							Remove
						</button>
						<button
							type="button"
							onClick={() => setConfirmingRemoval(false)}
							className="rounded-md border border-slate-700 px-2.5 py-1 text-xs text-slate-300 hover:border-slate-500"
						>
							Cancel
						</button>
					</div>
				) : (
					<button
						type="button"
						data-testid="remove-table"
						onClick={() => setConfirmingRemoval(true)}
						disabled={busy}
						className="self-start rounded-md border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-200 hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-40"
					>
						Remove table
					</button>
				)}
			</div>
		</section>
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
	busy,
	onApply,
	onRemove,
}: {
	tableName: string;
	column: DesignColumn;
	busy: boolean;
	onApply: (changes: ColumnChanges) => void;
	onRemove: () => void;
}) {
	const [draft, setDraft] = useState<ColumnDraft>(() => draftFrom(column));
	const [confirmingRemoval, setConfirmingRemoval] = useState(false);

	// Reset only when the stored column changes, so a background save or
	// sandbox result never overwrites what is being typed.
	useEffect(() => {
		setDraft(draftFrom(column));
		setConfirmingRemoval(false);
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

	return (
		<form
			aria-labelledby="column-editor-heading"
			data-testid="column-editor"
			className="rounded-lg border border-slate-700 bg-slate-950/70 p-3"
			onSubmit={(event) => {
				event.preventDefault();
				if (!dirty || invalid || busy) return;
				onApply(changes);
			}}
		>
			<header className="flex items-baseline justify-between gap-2">
				<h3
					id="column-editor-heading"
					className="text-[11px] font-semibold uppercase tracking-wide text-slate-400"
				>
					Column editor
				</h3>
				<span className="truncate text-[10px] text-slate-500">{tableName}</span>
			</header>

			<label className="mt-2 flex flex-col gap-1">
				<span className="text-[10px] uppercase tracking-wide text-slate-500">Name</span>
				<input
					value={draft.name}
					onChange={(event) => setDraft({ ...draft, name: event.target.value })}
					aria-label="Column name"
					data-testid="column-name-input"
					className="rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-sm outline-none focus:border-indigo-500"
				/>
			</label>
			{invalid && (
				<p className="mt-1 text-[11px] text-amber-300">A column needs a name.</p>
			)}

			<label className="mt-2 flex flex-col gap-1">
				<span className="text-[10px] uppercase tracking-wide text-slate-500">Type</span>
				<select
					value={draft.type}
					onChange={(event) =>
						setDraft({ ...draft, type: event.target.value as ColumnType })
					}
					aria-label="Column type"
					data-testid="column-type-picker"
					className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm outline-none focus:border-indigo-500"
				>
					{COLUMN_TYPE_FAMILIES.map((family) => (
						<optgroup key={family.id} label={`${family.glyph} ${family.label}`}>
							{COLUMN_TYPE_DEFINITIONS.filter(
								(definition) => definition.family === family.id,
							).map((definition) => (
								<option key={definition.type} value={definition.type}>
									{definition.type} — {definition.label}
								</option>
							))}
						</optgroup>
					))}
				</select>
			</label>
			{dropsIdentity && (
				<p className="mt-1 text-[11px] text-sky-300">
					Identity generation will be cleared because it only applies to integer types.
				</p>
			)}

			<label className="mt-2 flex flex-col gap-1">
				<span className="text-[10px] uppercase tracking-wide text-slate-500">
					Default
				</span>
				<select
					value={choice}
					onChange={(event) => chooseDefault(event.target.value as DefaultChoice)}
					aria-label="Column default"
					data-testid="column-default-picker"
					className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm outline-none focus:border-indigo-500"
				>
					<option value="none">No default</option>
					{(support.literal !== null || choice === "literal") && (
						<optgroup label="Typed literal">
							<option value="literal">
								{literalType
									? `A ${COLUMN_LITERAL_LABELS[literalType]}`
									: "A typed value"}
							</option>
						</optgroup>
					)}
					{(support.currentTimestamp ||
						support.generateUuid ||
						draftType?.identity ||
						choice === "currentTimestamp" ||
						choice === "generateUuid" ||
						choice === "identity") && (
						<optgroup label="Database-generated">
							{(support.currentTimestamp || choice === "currentTimestamp") && (
								<option value="currentTimestamp">Current timestamp</option>
							)}
							{(support.generateUuid || choice === "generateUuid") && (
								<option value="generateUuid">Generate a UUID</option>
							)}
							{(draftType?.identity || choice === "identity") && (
								<option value="identity">Identity generation</option>
							)}
						</optgroup>
					)}
				</select>
			</label>

			{choice === "literal" && literalType !== null && (
				<label className="mt-2 flex flex-col gap-1">
					<span className="text-[10px] uppercase tracking-wide text-slate-500">
						{COLUMN_LITERAL_LABELS[literalType]}
					</span>
					{literalType === "boolean" ? (
						<select
							value={literalValue}
							onChange={(event) => updateLiteralValue(event.target.value)}
							aria-label="Default value"
							data-testid="column-default-literal"
							className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm outline-none focus:border-indigo-500"
						>
							{literalValue !== "true" && literalValue !== "false" && (
								<option value={literalValue}>“{literalValue}” (invalid)</option>
							)}
							<option value="true">true</option>
							<option value="false">false</option>
						</select>
					) : literalType === "json" ? (
						<textarea
							value={literalValue}
							onChange={(event) => updateLiteralValue(event.target.value)}
							aria-label="Default value"
							data-testid="column-default-literal"
							rows={2}
							placeholder={'{"key": "value"}'}
							className="resize-y rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1.5 font-mono text-xs outline-none placeholder:text-slate-600 focus:border-indigo-500"
						/>
					) : (
						<input
							value={literalValue}
							onChange={(event) => updateLiteralValue(event.target.value)}
							aria-label="Default value"
							data-testid="column-default-literal"
							inputMode={
								literalType === "integer" || literalType === "numeric"
									? "decimal"
									: undefined
							}
							placeholder={LITERAL_PLACEHOLDERS[literalType]}
							className="rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-sm outline-none placeholder:text-slate-600 focus:border-indigo-500"
						/>
					)}
				</label>
			)}
			{defaultProblem !== null && (
				<p data-testid="default-warning" className="mt-1 text-[11px] text-amber-300">
					{capitalize(defaultProblem)}. Applying keeps this default in the saved draft,
					but SQL generation stays blocked until it is resolved.
				</p>
			)}
			{draft.identity && draft.defaultValue.kind !== "none" && (
				<p className="mt-1 text-[11px] text-amber-300">
					This column has both identity generation and a default. Choose one.
				</p>
			)}

			<fieldset className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
				<legend className="text-[10px] uppercase tracking-wide text-slate-500">
					Settings
				</legend>
				<label
					className="flex items-center gap-1.5 text-xs text-slate-300"
					title={
						draft.primaryKey
							? "A primary key is always required"
							: draft.identity
								? "Identity columns are always required"
								: undefined
					}
				>
					<input
						type="checkbox"
						aria-label="Nullable"
						data-testid="column-nullable"
						checked={draft.nullable}
						disabled={draft.primaryKey || draft.identity}
						onChange={(event) => setDraft({ ...draft, nullable: event.target.checked })}
						className="accent-indigo-500"
					/>
					Nullable
				</label>
				<label
					className="flex items-center gap-1.5 text-xs text-slate-300"
					title={draft.primaryKey ? "A primary key is already unique" : undefined}
				>
					<input
						type="checkbox"
						aria-label="Unique"
						data-testid="column-unique"
						checked={draft.unique && !draft.primaryKey}
						disabled={draft.primaryKey}
						onChange={(event) => setDraft({ ...draft, unique: event.target.checked })}
						className="accent-indigo-500"
					/>
					Unique
				</label>
				<label className="flex items-center gap-1.5 text-xs text-slate-300">
					<input
						type="checkbox"
						aria-label="Primary key"
						data-testid="column-primary-key"
						checked={draft.primaryKey}
						onChange={(event) =>
							setDraft(
								event.target.checked
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
						className="accent-indigo-500"
					/>
					Primary key
				</label>
			</fieldset>
			{column.identity && (
				<p className="mt-1 text-[11px] text-slate-500">
					This column currently uses identity generation. Choosing a default replaces it.
				</p>
			)}

			<label className="mt-2 flex flex-col gap-1">
				<span className="text-[10px] uppercase tracking-wide text-slate-500">Notes</span>
				<textarea
					value={draft.notes}
					onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
					aria-label="Column notes"
					data-testid="column-notes"
					rows={2}
					placeholder="Why this column exists"
					className="resize-y rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs outline-none placeholder:text-slate-600 focus:border-indigo-500"
				/>
			</label>

			<div className="mt-3 flex flex-wrap items-center gap-2">
				<button
					type="submit"
					data-testid="apply-column"
					disabled={busy || !dirty || invalid}
					className="rounded-md bg-indigo-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-40"
				>
					Apply changes
				</button>
				<button
					type="button"
					data-testid="reset-column"
					onClick={() => setDraft(draftFrom(column))}
					disabled={busy || !dirty}
					className="rounded-md border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:border-slate-500 disabled:cursor-not-allowed disabled:opacity-40"
				>
					Reset
				</button>
			</div>

			<div className="mt-3 border-t border-slate-800 pt-2">
				{confirmingRemoval ? (
					<div className="flex flex-wrap items-center gap-2">
						<span className="text-xs text-red-200">Remove “{column.name}”?</span>
						<button
							type="button"
							data-testid="confirm-remove-column"
							onClick={onRemove}
							disabled={busy}
							className="rounded-md bg-red-500 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-400 disabled:cursor-not-allowed disabled:opacity-40"
						>
							Remove
						</button>
						<button
							type="button"
							onClick={() => setConfirmingRemoval(false)}
							className="rounded-md border border-slate-700 px-2.5 py-1 text-xs text-slate-300 hover:border-slate-500"
						>
							Cancel
						</button>
					</div>
				) : (
					<button
						type="button"
						data-testid="remove-column"
						onClick={() => setConfirmingRemoval(true)}
						disabled={busy}
						className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-200 hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-40"
					>
						Remove column
					</button>
				)}
			</div>
		</form>
	);
}
