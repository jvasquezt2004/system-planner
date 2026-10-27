import {
	type SystemDesign,
	findSystemConnection,
} from "../shared/system-design";
import {
	acceptWalkthroughStepRedirection,
	addWalkthrough,
	addWalkthroughBlock,
	addWalkthroughParallelBranch,
	addWalkthroughStep,
	moveWalkthrough,
	moveWalkthroughBlock,
	moveWalkthroughStep,
	removeWalkthrough,
	removeWalkthroughBlock,
	removeWalkthroughStep,
	renameWalkthrough,
	repairWalkthroughStep,
	updateWalkthroughRepeat,
	updateWalkthroughStep,
	walkthroughStepStatus,
	walkthroughSteps,
	walkthroughStepsOnConnections,
	type Walkthrough,
	type WalkthroughAction,
	type WalkthroughBlock,
	type WalkthroughContainerKind,
	type WalkthroughStepDraft,
} from "../shared/walkthrough";
import { systemItemVersion } from "./system-design-operations";

/**
 * One Assistant operation on the Project's Walkthroughs. Fields an operation
 * does not use are omitted. Step and block ids are chosen by the Assistant for
 * new entries, so later operations in the same batch can refer to them.
 */
export const WALKTHROUGH_OPERATION_NAMES = [
	"create_walkthrough",
	"rename_walkthrough",
	"remove_walkthrough",
	"move_walkthrough",
	"add_step",
	"update_step",
	"move_step",
	"remove_step",
	"repair_step",
	"accept_redirection",
	"add_block",
	"add_parallel_branch",
	"update_repeat",
	"move_block",
	"remove_block",
] as const;
export type WalkthroughOperationName = (typeof WALKTHROUGH_OPERATION_NAMES)[number];

export type WalkthroughOperation = {
	op: WalkthroughOperationName;
	/** New stable id for a create or add operation. */
	id?: string;
	walkthroughId?: string;
	stepId?: string;
	blockId?: string;
	name?: string;
	toIndex?: number;
	/** The System design Connection a step plays, by id. */
	connectionId?: string;
	kind?: Extract<WalkthroughContainerKind, "parallel" | "repeat">;
	count?: number;
	/** Where new content goes: the top-level sequence, a repeat body, or one parallel branch. */
	sequence?: { blockId: string | null; branch?: number };
	title?: string;
	explanation?: string;
	action?: WalkthroughAction;
	/** Visual preset such as "Cache hit". Empty text clears it. */
	operation?: string;
	/** Illustrative duration in milliseconds; null clears it. */
	durationMs?: number | null;
	/** Whole percent of the step spent travelling; null returns to the playback default. */
	travelPercent?: number | null;
	exampleMessage?: string;
	examplePayload?: string;
};

export type WalkthroughOperationPlan = { next: Walkthrough[] };

/**
 * Validates a whole batch of Walkthrough operations against the Walkthroughs and
 * System design as they stand. Any invalid operation throws, so the batch either
 * applies in full or not at all. Later operations see the effects of earlier ones.
 */
export function planWalkthroughOperations(
	current: Walkthrough[],
	operations: WalkthroughOperation[],
	design: SystemDesign,
): WalkthroughOperationPlan {
	if (operations.length === 0) throw new Error("At least one Walkthrough operation is required.");
	let next = structuredClone(current);
	operations.forEach((operation, index) => {
		try {
			next = applyOperation(next, operation, design);
		} catch (error) {
			throw new Error(`Operation ${index + 1} (${operation.op}): ${error instanceof Error ? error.message : String(error)}`);
		}
	});
	return { next };
}

function applyOperation(walkthroughs: Walkthrough[], operation: WalkthroughOperation, design: SystemDesign): Walkthrough[] {
	switch (operation.op) {
		case "create_walkthrough":
			return addWalkthrough(walkthroughs, { id: requireString(operation.id, "id"), name: operation.name });
		case "rename_walkthrough":
			return renameWalkthrough(walkthroughs, requireString(operation.walkthroughId, "walkthroughId"), requireString(operation.name, "name"));
		case "remove_walkthrough":
			return removeWalkthrough(walkthroughs, requireString(operation.walkthroughId, "walkthroughId"));
		case "move_walkthrough":
			return moveWalkthrough(walkthroughs, requireString(operation.walkthroughId, "walkthroughId"), requireIndex(operation.toIndex));
		case "add_step": {
			const connectionId = requireConnection(design, operation.connectionId);
			return addWalkthroughStep(
				walkthroughs,
				requireString(operation.walkthroughId, "walkthroughId"),
				{ ...draftOf(operation), id: requireString(operation.id, "id"), connectionId, ...(operation.sequence ? { sequence: operation.sequence } : {}) },
				design,
			);
		}
		case "update_step": {
			const changes = draftOf(operation);
			if (Object.keys(changes).length === 0) throw new Error("Give at least one step field to change.");
			return updateWalkthroughStep(
				walkthroughs,
				requireString(operation.walkthroughId, "walkthroughId"),
				requireString(operation.stepId, "stepId"),
				changes,
			);
		}
		case "move_step":
			return moveWalkthroughStep(walkthroughs, requireString(operation.walkthroughId, "walkthroughId"), requireString(operation.stepId, "stepId"), requireIndex(operation.toIndex));
		case "remove_step":
			return removeWalkthroughStep(walkthroughs, requireString(operation.walkthroughId, "walkthroughId"), requireString(operation.stepId, "stepId"));
		case "repair_step":
			return repairWalkthroughStep(
				walkthroughs,
				requireString(operation.walkthroughId, "walkthroughId"),
				requireString(operation.stepId, "stepId"),
				requireConnection(design, operation.connectionId),
				design,
			);
		case "accept_redirection":
			return acceptWalkthroughStepRedirection(walkthroughs, requireString(operation.walkthroughId, "walkthroughId"), requireString(operation.stepId, "stepId"), design);
		case "add_block": {
			if (operation.kind !== "parallel" && operation.kind !== "repeat") throw new Error('kind must be "parallel" or "repeat".');
			return addWalkthroughBlock(walkthroughs, requireString(operation.walkthroughId, "walkthroughId"), {
				id: requireString(operation.id, "id"),
				kind: operation.kind,
				...(operation.sequence ? { sequence: operation.sequence } : {}),
			});
		}
		case "add_parallel_branch":
			return addWalkthroughParallelBranch(walkthroughs, requireString(operation.walkthroughId, "walkthroughId"), requireString(operation.blockId, "blockId"));
		case "update_repeat":
			return updateWalkthroughRepeat(
				walkthroughs,
				requireString(operation.walkthroughId, "walkthroughId"),
				requireString(operation.blockId, "blockId"),
				operation.count as number,
			);
		case "move_block":
			return moveWalkthroughBlock(walkthroughs, requireString(operation.walkthroughId, "walkthroughId"), requireString(operation.blockId, "blockId"), requireIndex(operation.toIndex));
		case "remove_block":
			return removeWalkthroughBlock(walkthroughs, requireString(operation.walkthroughId, "walkthroughId"), requireString(operation.blockId, "blockId"));
		default:
			throw new Error(`Unsupported operation "${String((operation as { op: unknown }).op)}".`);
	}
}

/**
 * Refuses a batch that edits a Walkthrough the Assistant read before that
 * Walkthrough changed. Unrelated manual edits to other Walkthroughs do not block it.
 */
export function checkWalkthroughReadPreconditions(
	read: Walkthrough[] | undefined,
	current: Walkthrough[],
	operations: WalkthroughOperation[],
): void {
	if (!read) return;
	const named = new Set(operations.map((operation) => operation.walkthroughId).filter((id): id is string => typeof id === "string"));
	const changed: string[] = [];
	for (const id of named) {
		const before = read.find((walkthrough) => walkthrough.id === id);
		if (!before) continue;
		const now = current.find((walkthrough) => walkthrough.id === id) ?? null;
		if (JSON.stringify(before) !== JSON.stringify(now)) changed.push(`Walkthrough "${before.name}"`);
	}
	if (changed.length > 0) {
		throw new Error(`These changed after you read the Walkthroughs: ${changed.join(", ")}. Read the Walkthroughs again before editing them.`);
	}
}

/**
 * The focused Walkthrough content the Assistant reads: every Walkthrough with its
 * stable id and version, its blocks in order, and each step's status against the
 * System design, plus diagnostics that name what needs repair or review.
 */
export function readWalkthroughs(walkthroughs: readonly Walkthrough[], design: SystemDesign) {
	return walkthroughs.map((walkthrough) => ({
		id: walkthrough.id,
		name: walkthrough.name,
		version: systemItemVersion(walkthrough),
		blocks: walkthrough.blocks.map((block) => describeBlock(block, design)),
	}));
}

/** Problems a designer would want fixed in the Walkthroughs. A step with a problem keeps its explanation. */
export function walkthroughDiagnostics(walkthroughs: readonly Walkthrough[], design: SystemDesign): string[] {
	const notes: string[] = [];
	for (const walkthrough of walkthroughs) {
		for (const step of walkthroughSteps(walkthrough)) {
			const status = walkthroughStepStatus(step, design);
			const where = `Walkthrough "${walkthrough.name}" step "${step.title}" (${step.id})`;
			if (status.status === "dangling") {
				notes.push(`${where} plays Connection ${step.connectionId}, which no longer exists. Repair it with repair_step, or remove the step. Its explanation is kept.`);
			} else if (status.status === "redirected") {
				notes.push(
					`${where} plays Connection ${step.connectionId}, which now runs from ${status.sourceId} to ${status.targetId} instead of ${step.route.sourceId} to ${step.route.targetId}. Accept the route with accept_redirection, or repair the step. Playback waits for this review.`,
				);
			}
		}
	}
	return notes;
}

/**
 * Walkthrough steps a System design edit leaves dangling: the batch removed
 * their Connections, directly or with the Components and Services they join.
 */
export function walkthroughImpactOfRemovedConnections(
	walkthroughs: readonly Walkthrough[],
	before: SystemDesign,
	after: SystemDesign,
) {
	const removed = before.connections
		.filter((connection) => !findSystemConnection(after, connection.id))
		.map((connection) => connection.id);
	return walkthroughStepsOnConnections([...walkthroughs], removed);
}

function describeBlock(block: WalkthroughBlock, design: SystemDesign): Record<string, unknown> {
	switch (block.kind) {
		case "step": {
			const status = walkthroughStepStatus(block.step, design);
			return {
				kind: "step",
				...block.step,
				status: status.status,
				...(status.status === "redirected" ? { currentRoute: { sourceId: status.sourceId, targetId: status.targetId } } : {}),
			};
		}
		case "parallel":
			return { kind: "parallel", id: block.id, branches: block.branches.map((branch) => branch.map((item) => describeBlock(item, design))) };
		case "repeat":
			return { kind: "repeat", id: block.id, count: block.count, body: block.body.map((item) => describeBlock(item, design)) };
	}
}

function draftOf(operation: WalkthroughOperation): WalkthroughStepDraft {
	const draft: WalkthroughStepDraft = {};
	if (operation.title !== undefined) draft.title = operation.title;
	if (operation.explanation !== undefined) draft.explanation = operation.explanation;
	if (operation.action !== undefined) draft.action = operation.action;
	if (operation.operation !== undefined) draft.operation = operation.operation;
	if (operation.durationMs !== undefined) draft.durationMs = operation.durationMs;
	if (operation.travelPercent !== undefined) draft.travelPercent = operation.travelPercent;
	if (operation.exampleMessage !== undefined) draft.exampleMessage = operation.exampleMessage;
	if (operation.examplePayload !== undefined) draft.examplePayload = operation.examplePayload;
	return draft;
}

function requireConnection(design: SystemDesign, value: string | undefined): string {
	const id = requireString(value, "connectionId");
	if (!findSystemConnection(design, id)) {
		throw new Error(`connectionId "${id}" does not match a Connection in the System design. Read the System design and use one of its Connection ids, or add the Connection first.`);
	}
	return id;
}

function requireString(value: string | undefined, label: string): string {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} is required.`);
	return value.trim();
}

function requireIndex(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error("toIndex must be a whole number, 0 or more.");
	return value;
}

