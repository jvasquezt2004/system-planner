import { describe, expect, test } from "bun:test";
import {
	HISTORY_COALESCE_WINDOW_MS,
	createProjectHistory,
	describeProjectHistory,
	recordProjectChange,
	stepProjectHistory,
} from "./project-history";

type Value = { items: { id: string; text: string }[]; title: string };

const base: Value = { items: [{ id: "a", text: "one" }], title: "start" };
function next(patch: Partial<Value>): Value {
	return { ...base, ...patch, items: patch.items ?? structuredClone(base.items) };
}

describe("project history", () => {
	test("describes the next Undo and Redo names and availability", () => {
		const history = createProjectHistory<Value>();
		expect(describeProjectHistory(history)).toEqual({ canUndo: false, canRedo: false });
		recordProjectChange(history, { name: "Rename", before: base, after: next({ title: "x" }), structural: false }, 0);
		expect(describeProjectHistory(history)).toEqual({ canUndo: true, canRedo: false, undoActionName: "Rename" });
		stepProjectHistory(history, "undo");
		expect(describeProjectHistory(history)).toEqual({ canUndo: false, canRedo: true, redoActionName: "Rename" });
	});

	test("groups same-key changes inside the coalescing window and keeps the first before state", () => {
		const history = createProjectHistory<Value>();
		recordProjectChange(history, { name: "Edit", before: base, after: next({ title: "a" }), structural: false, coalesceKey: "k" }, 0);
		recordProjectChange(history, { name: "Edit", before: next({ title: "a" }), after: next({ title: "ab" }), structural: false, coalesceKey: "k" }, HISTORY_COALESCE_WINDOW_MS);
		expect(history.entries).toHaveLength(1);
		expect(history.entries[0].before).toEqual(base);
		expect(history.entries[0].after.title).toBe("ab");
	});

	test("splits same-key changes after the window and across different keys", () => {
		const history = createProjectHistory<Value>();
		recordProjectChange(history, { name: "Edit", before: base, after: next({ title: "a" }), structural: false, coalesceKey: "k" }, 0);
		recordProjectChange(history, { name: "Edit", before: next({ title: "a" }), after: next({ title: "ab" }), structural: false, coalesceKey: "k" }, HISTORY_COALESCE_WINDOW_MS + 1);
		recordProjectChange(history, { name: "Other", before: next({ title: "ab" }), after: next({ title: "abc" }), structural: false, coalesceKey: "j" }, HISTORY_COALESCE_WINDOW_MS + 2);
		expect(history.entries.map((entry) => entry.name)).toEqual(["Edit", "Edit", "Other"]);
	});

	test("discards redo entries when a new change branches from an undone state", () => {
		const history = createProjectHistory<Value>();
		recordProjectChange(history, { name: "One", before: base, after: next({ title: "1" }), structural: false }, 0);
		recordProjectChange(history, { name: "Two", before: next({ title: "1" }), after: next({ title: "2" }), structural: false }, 0);
		stepProjectHistory(history, "undo");
		recordProjectChange(history, { name: "Branch", before: next({ title: "1" }), after: next({ title: "b" }), structural: false }, 0);
		expect(history.entries.map((entry) => entry.name)).toEqual(["One", "Branch"]);
		expect(describeProjectHistory(history).canRedo).toBe(false);
	});

	test("folds an Assistant turn into one entry and rebases manual edits made during it", () => {
		const history = createProjectHistory<Value>();
		const turnBefore = base;
		const turnFirst = next({ title: "turn-1" });
		recordProjectChange(history, { name: "Assistant turn", before: turnBefore, after: turnFirst, structural: true, assistantTurnId: "t" }, 0);
		const manualAfter: Value = { ...turnFirst, items: [{ id: "a", text: "one" }, { id: "m", text: "manual" }] };
		recordProjectChange(history, { name: "Add item", before: turnFirst, after: manualAfter, structural: false }, 0);
		const turnSecond: Value = { ...manualAfter, title: "turn-2" };
		recordProjectChange(history, { name: "Assistant turn", before: manualAfter, after: turnSecond, structural: true, assistantTurnId: "t" }, 0);

		expect(describeProjectHistory(history).undoActionName).toBe("Assistant turn");
		expect(history.cursor).toBe(2);
		const undoneTurn = stepProjectHistory(history, "undo")!;
		expect(undoneTurn.name).toBe("Assistant turn");
		expect(undoneTurn.before.items.map((item) => item.id)).toEqual(["a", "m"]);
		expect(undoneTurn.before.title).toBe("start");
	});

	test("starts a separate entry when a different Assistant turn follows", () => {
		const history = createProjectHistory<Value>();
		recordProjectChange(history, { name: "Assistant turn", before: base, after: next({ title: "one" }), structural: true, assistantTurnId: "t1" }, 0);
		recordProjectChange(history, { name: "Assistant turn", before: next({ title: "one" }), after: next({ title: "two" }), structural: true, assistantTurnId: "t2" }, 0);
		expect(history.entries).toHaveLength(2);
	});
});
