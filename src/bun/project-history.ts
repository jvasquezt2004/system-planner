/**
 * The Project-wide content history shared by Undo, Redo, and Assistant turns.
 *
 * Each entry stores the content before and after one named action. The
 * workspace decides what "content" means (today: the Design document plus
 * Scenarios and Edge functions); this module only orders, groups, and replays
 * those snapshots. Later System design and Walkthrough mutations extend the
 * content type and record through the same `recordProjectChange` call instead
 * of starting a separate history.
 *
 * Grouping rules:
 * - A change with a `coalesceKey` joins the newest entry when that entry has
 *   the same key, is not Assistant-owned, and was recorded no more than
 *   HISTORY_COALESCE_WINDOW_MS earlier. This groups continuous typing and rapid
 *   renames. Completed drags do not set a key, so each one stays its own action.
 * - An Assistant change joins the newest Assistant turn entry for the same turn.
 *   Manual changes made between the turn's changes are rebased so the turn is
 *   one action and the designer's work is kept.
 */

export const HISTORY_COALESCE_WINDOW_MS = 1500;

export type ProjectHistoryChange<T> = {
	/** The name Undo and Redo show, such as `Add table “Authors”`. */
	name: string;
	before: T;
	after: T;
	/** True when the schema changed, so the SQL preview and sandbox must rebuild. */
	structural: boolean;
	/** Attributes the change to one Assistant turn. Omit for manual edits. */
	assistantTurnId?: string;
	/** Groups consecutive changes to the same thing, such as one source editor. */
	coalesceKey?: string;
};

export type ProjectHistoryEntry<T> = ProjectHistoryChange<T> & {
	recordedAt: number;
};

export type ProjectHistory<T> = {
	entries: ProjectHistoryEntry<T>[];
	cursor: number;
};

export type ProjectHistoryDescription = {
	canUndo: boolean;
	canRedo: boolean;
	undoActionName?: string;
	redoActionName?: string;
};

export function createProjectHistory<T>(): ProjectHistory<T> {
	return { entries: [], cursor: 0 };
}

/** Describes the next Undo and Redo actions for display. */
export function describeProjectHistory<T>(history: ProjectHistory<T> | undefined): ProjectHistoryDescription {
	if (!history) return { canUndo: false, canRedo: false };
	const undo = history.entries[history.cursor - 1];
	const redo = history.entries[history.cursor];
	return {
		canUndo: history.cursor > 0,
		canRedo: history.cursor < history.entries.length,
		...(undo ? { undoActionName: undo.name } : {}),
		...(redo ? { redoActionName: redo.name } : {}),
	};
}

/**
 * Records one change at the cursor. Any redo entries are discarded first, so
 * a new change always branches from the current state.
 */
export function recordProjectChange<T>(
	history: ProjectHistory<T>,
	change: ProjectHistoryChange<T>,
	recordedAt: number,
): void {
	history.entries.length = history.cursor;
	if (change.assistantTurnId !== undefined) {
		if (foldIntoAssistantTurn(history, change, recordedAt)) return;
	} else {
		const latest = history.entries[history.cursor - 1];
		if (
			change.coalesceKey !== undefined &&
			latest !== undefined &&
			latest.coalesceKey === change.coalesceKey &&
			latest.assistantTurnId === undefined &&
			recordedAt - latest.recordedAt <= HISTORY_COALESCE_WINDOW_MS
		) {
			latest.name = change.name;
			latest.after = change.after;
			latest.structural = latest.structural || change.structural;
			latest.recordedAt = recordedAt;
			return;
		}
	}
	history.entries.push({ ...change, recordedAt });
	history.cursor = history.entries.length;
}

/**
 * Moves the cursor one step and returns the entry that was crossed: its
 * `before` content for Undo and its `after` content for Redo. Returns null when
 * there is nothing to cross. The caller restores the cursor if applying fails.
 */
export function stepProjectHistory<T>(
	history: ProjectHistory<T>,
	direction: "undo" | "redo",
): ProjectHistoryEntry<T> | null {
	if (direction === "undo") {
		const entry = history.entries[history.cursor - 1];
		if (!entry) return null;
		history.cursor -= 1;
		return entry;
	}
	const entry = history.entries[history.cursor];
	if (!entry) return null;
	history.cursor += 1;
	return entry;
}

/**
 * Folds an Assistant change into its turn's entry. Manual entries recorded
 * after the turn started are rebased onto the turn's starting content and
 * placed before the combined entry, so the turn remains one action.
 */
function foldIntoAssistantTurn<T>(
	history: ProjectHistory<T>,
	change: ProjectHistoryChange<T>,
	recordedAt: number,
): boolean {
	let turnIndex = history.cursor - 1;
	while (turnIndex >= 0 && history.entries[turnIndex].assistantTurnId === undefined) turnIndex -= 1;
	const turn = history.entries[turnIndex];
	if (!turn || turn.assistantTurnId !== change.assistantTurnId) return false;

	let rebased = turn.before;
	const manualEntries: ProjectHistoryEntry<T>[] = [];
	for (let index = turnIndex + 1; index < history.cursor; index += 1) {
		const entry = history.entries[index];
		const next = rebaseManualEdits(entry.before, entry.after, rebased) as T;
		if (JSON.stringify(rebased) !== JSON.stringify(next)) {
			manualEntries.push({ ...entry, before: rebased, after: next });
			rebased = next;
		}
	}
	let rebasedAfter: T = structuredClone(change.after);
	for (let index = turnIndex + 1; index < history.cursor; index += 1) {
		const entry = history.entries[index];
		rebasedAfter = rebaseManualEdits(entry.before, entry.after, rebasedAfter) as T;
	}
	const turnEntry: ProjectHistoryEntry<T> = {
		name: turn.name,
		before: rebased,
		after: rebasedAfter,
		structural: turn.structural || change.structural,
		assistantTurnId: turn.assistantTurnId,
		recordedAt,
	};
	history.entries.splice(turnIndex, history.cursor - turnIndex, ...manualEntries, turnEntry);
	history.cursor = turnIndex + manualEntries.length + 1;
	return true;
}

/** Re-applies a manual before/after delta onto content that may have changed since. */
export function rebaseManualEdits(manualBefore: unknown, manualAfter: unknown, base: unknown): unknown {
	return applyManualDelta(base, manualBefore, manualAfter);
}

/**
 * The identity an array entry is matched by: its `id`, or for a Walkthrough step
 * block (`{ kind: "step", step }`) the step's id. Undefined when it has neither.
 */
function entryKey(item: unknown): string | undefined {
	if (item === null || typeof item !== "object") return undefined;
	const record = item as { id?: unknown; kind?: unknown; step?: unknown };
	if (typeof record.id === "string") return record.id;
	if (record.kind === "step" && record.step !== null && typeof record.step === "object") {
		const stepId = (record.step as { id?: unknown }).id;
		if (typeof stepId === "string") return stepId;
	}
	return undefined;
}

/**
 * Applies the difference between two snapshots to a target. Records with a
 * stable `id` are matched by identity so independent edits merge. Anything
 * that cannot be matched takes the manual value.
 */
function applyManualDelta(target: unknown, manualBefore: unknown, manualAfter: unknown): unknown {
	if (JSON.stringify(manualBefore) === JSON.stringify(manualAfter)) return structuredClone(target);
	if (Array.isArray(manualBefore) && Array.isArray(manualAfter)) {
		const keyed = [...manualBefore, ...manualAfter].every((item) => entryKey(item) !== undefined);
		if (keyed && Array.isArray(target)) {
			const beforeById = new Map(manualBefore.map((item) => [entryKey(item)!, item]));
			const afterById = new Map(manualAfter.map((item) => [entryKey(item)!, item]));
			const targetById = new Map(target.map((item) => [entryKey(item)!, item]));
			const result = target.map((item) => structuredClone(item));
			const resultById = new Map(result.map((item) => [entryKey(item)!, item]));
			for (const id of new Set([...beforeById.keys(), ...afterById.keys()])) {
				const before = beforeById.get(id);
				const after = afterById.get(id);
				if (before === undefined && after !== undefined) {
					if (!resultById.has(id)) {
						const added = structuredClone(after);
						result.push(added);
						resultById.set(id, added);
					}
				} else if (before !== undefined && after === undefined) {
					const index = result.findIndex((item) => entryKey(item) === id);
					if (index >= 0) result.splice(index, 1);
					resultById.delete(id);
				} else if (before !== undefined && after !== undefined && resultById.has(id)) {
					const next = applyManualDelta(targetById.get(id), before, after);
					const index = result.findIndex((item) => entryKey(item) === id);
					if (index >= 0) result[index] = next;
					resultById.set(id, next);
				}
			}
			return result;
		}
		if (Array.isArray(target) && manualBefore.length === manualAfter.length && target.length === manualBefore.length) {
			return manualBefore.map((item, index) => applyManualDelta(target[index], item, manualAfter[index]));
		}
		return structuredClone(manualAfter);
	}
	if (manualBefore && manualAfter && target
		&& typeof manualBefore === "object" && typeof manualAfter === "object" && typeof target === "object"
		&& !Array.isArray(manualBefore) && !Array.isArray(manualAfter) && !Array.isArray(target)) {
		const before = manualBefore as Record<string, unknown>;
		const after = manualAfter as Record<string, unknown>;
		const result = structuredClone(target) as Record<string, unknown>;
		for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
			if (!(key in after)) delete result[key];
			else if (!(key in before)) result[key] = structuredClone(after[key]);
			else if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
				if (before[key] && after[key] && typeof before[key] === "object" && typeof after[key] === "object"
					&& key in result) {
					result[key] = applyManualDelta(result[key], before[key], after[key]);
				} else result[key] = structuredClone(after[key]);
			}
		}
		return result;
	}
	return structuredClone(manualAfter);
}
