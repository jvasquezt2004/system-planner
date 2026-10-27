import { findSystemComponent, findSystemConnection, findSystemService, type SystemDesign } from "./system-design";

/**
 * Saved, named Walkthroughs of a Project's System design. A Walkthrough is an
 * ordered sequence of blocks. A block is a step that plays one Connection, a
 * `parallel` block whose authored branches run together, or a `repeat` block
 * that runs its body a fixed number of times. Repetition is never decided by a
 * runtime condition: a failed attempt followed by a retry or a final outcome is
 * authored explicitly as ordinary steps.
 *
 * Repairable draft state is kept, never erased: a step whose Connection was
 * removed is `dangling`, and one whose Connection now joins different endpoints
 * is `redirected`. Both stay in the Walkthrough until the designer repairs them.
 * Malformed stored content is refused by `normalizeWalkthroughs`. Stored
 * Walkthroughs saved as a flat list of steps load as a sequence of step blocks.
 */

export const WALKTHROUGH_ACTIONS = ["send", "receive", "process", "succeed", "fail"] as const;
export type WalkthroughAction = (typeof WALKTHROUGH_ACTIONS)[number];
export const DEFAULT_WALKTHROUGH_ACTION: WalkthroughAction = "send";

export const WALKTHROUGH_NAME_LIMIT = 80;
export const WALKTHROUGH_TITLE_LIMIT = 120;
export const WALKTHROUGH_EXPLANATION_LIMIT = 2000;
export const WALKTHROUGH_OPERATION_LIMIT = 40;
export const WALKTHROUGH_EXAMPLE_MESSAGE_LIMIT = 500;
export const WALKTHROUGH_EXAMPLE_PAYLOAD_LIMIT = 4000;
export const WALKTHROUGH_DURATION_MIN_MS = 100;
export const WALKTHROUGH_DURATION_MAX_MS = 10_000;
/** Share of a step spent travelling before the message arrives; the rest shows arrival and outcome. */
export const WALKTHROUGH_TRAVEL_PERCENT_MIN = 10;
export const WALKTHROUGH_TRAVEL_PERCENT_MAX = 90;
export const WALKTHROUGH_LIMIT = 50;
/** Authored steps per Walkthrough, counted across every block. */
export const WALKTHROUGH_STEP_LIMIT = 200;
/** Parallel and repeat blocks per Walkthrough. */
export const WALKTHROUGH_BLOCK_LIMIT = 50;
/** How many parallel or repeat blocks may enclose a step. */
export const WALKTHROUGH_NESTING_LIMIT = 4;
export const WALKTHROUGH_PARALLEL_BRANCH_MIN = 2;
export const WALKTHROUGH_PARALLEL_BRANCH_LIMIT = 6;
export const WALKTHROUGH_REPEAT_COUNT_MIN = 1;
export const WALKTHROUGH_REPEAT_COUNT_MAX = 10;
export const WALKTHROUGH_REPEAT_COUNT_DEFAULT = 2;

export type WalkthroughStep = {
	id: string;
	/** The Connection this step plays, by stable identity. */
	connectionId: string;
	/** The endpoints of that Connection when the step was authored or last repaired. */
	route: { sourceId: string; targetId: string };
	title: string;
	explanation: string;
	action: WalkthroughAction;
	/** Optional visual preset, such as upload, cache hit, or enqueue. */
	operation?: string;
	/** Illustrative duration in milliseconds. */
	durationMs?: number;
	/** Whole percent of the step's duration spent travelling, from 10 to 90. Defaults to the playback default. */
	travelPercent?: number;
	exampleMessage?: string;
	examplePayload?: string;
};

export type WalkthroughStepBlock = { kind: "step"; step: WalkthroughStep };
/** Every branch starts when the block starts; the block ends when its longest branch ends. */
export type WalkthroughParallelBlock = { kind: "parallel"; id: string; branches: WalkthroughBlock[][] };
/** The body runs `count` times in order. Nothing inside is evaluated to decide whether to repeat. */
export type WalkthroughRepeatBlock = { kind: "repeat"; id: string; count: number; body: WalkthroughBlock[] };
export type WalkthroughContainerBlock = WalkthroughParallelBlock | WalkthroughRepeatBlock;
export type WalkthroughBlock = WalkthroughStepBlock | WalkthroughContainerBlock;
export type WalkthroughContainerKind = WalkthroughContainerBlock["kind"];

export type Walkthrough = {
	id: string;
	name: string;
	blocks: WalkthroughBlock[];
};

/**
 * Where new content goes: the top-level sequence (`blockId` null), the body of a
 * repeat block, or one branch of a parallel block.
 */
export type WalkthroughSequenceRef = { blockId: string | null; branch?: number };

/** Fields a designer may set on a step. Empty text clears an optional field; null clears the duration. */
export type WalkthroughStepDraft = {
	title?: string;
	explanation?: string;
	action?: WalkthroughAction;
	operation?: string;
	durationMs?: number | null;
	/** Null clears the share, returning the step to the playback default. */
	travelPercent?: number | null;
	exampleMessage?: string;
	examplePayload?: string;
};

export type WalkthroughStepChanges = WalkthroughStepDraft;

export type WalkthroughStepStatus =
	| { status: "ok" }
	| { status: "dangling" }
	| { status: "redirected"; sourceId: string; targetId: string };

/** What the architecture shows for a selected step: its Connection and the Component or Service ids at its ends. */
export type WalkthroughHighlight = { connectionId: string | null; endpointIds: string[] };

/** Client-chosen ids let the view select what it creates; omitted ids are generated by the workspace. */
export type CreateWalkthroughAction = { id?: string; name?: string };
export type RenameWalkthroughAction = { walkthroughId: string; name: string };
export type RemoveWalkthroughAction = { walkthroughId: string };
export type MoveWalkthroughAction = { walkthroughId: string; toIndex: number };
export type AddWalkthroughStepAction = WalkthroughStepDraft & {
	id?: string;
	walkthroughId: string;
	connectionId: string;
	sequence?: WalkthroughSequenceRef;
};
export type UpdateWalkthroughStepAction = { walkthroughId: string; stepId: string; changes: WalkthroughStepChanges };
export type MoveWalkthroughStepAction = { walkthroughId: string; stepId: string; toIndex: number };
export type RemoveWalkthroughStepAction = { walkthroughId: string; stepId: string };
export type RepairWalkthroughStepAction = { walkthroughId: string; stepId: string; connectionId: string };
export type AcceptWalkthroughStepRedirectionAction = { walkthroughId: string; stepId: string };
export type AddWalkthroughBlockAction = {
	id?: string;
	walkthroughId: string;
	kind: WalkthroughContainerKind;
	sequence?: WalkthroughSequenceRef;
};
export type AddWalkthroughParallelBranchAction = { walkthroughId: string; blockId: string };
export type UpdateWalkthroughRepeatAction = { walkthroughId: string; blockId: string; count: number };
export type MoveWalkthroughBlockAction = { walkthroughId: string; blockId: string; toIndex: number };
export type RemoveWalkthroughBlockAction = { walkthroughId: string; blockId: string };

/** A step, in any Walkthrough, that plays a Connection a pending removal would delete. */
export type AffectedWalkthroughStep = {
	walkthroughId: string;
	walkthroughName: string;
	stepId: string;
	title: string;
	connectionId: string;
};

/** What removing architecture content does to Walkthroughs. Affected steps keep their text and become dangling. */
export type WalkthroughRemovalImpact = { walkthroughSteps: AffectedWalkthroughStep[] };

const ROOT_SEQUENCE: WalkthroughSequenceRef = { blockId: null };

export function findWalkthrough(walkthroughs: Walkthrough[], walkthroughId: string): Walkthrough | undefined {
	return walkthroughs.find((walkthrough) => walkthrough.id === walkthroughId);
}

/** Every authored step of a Walkthrough, in authoring order (parallel branches in branch order, repeat bodies once). */
export function walkthroughSteps(walkthrough: Walkthrough): WalkthroughStep[] {
	return stepsIn(walkthrough.blocks);
}

export function findWalkthroughStep(walkthroughs: Walkthrough[], walkthroughId: string, stepId: string): WalkthroughStep | undefined {
	const walkthrough = findWalkthrough(walkthroughs, walkthroughId);
	return walkthrough ? walkthroughSteps(walkthrough).find((step) => step.id === stepId) : undefined;
}

export function findWalkthroughBlock(
	walkthroughs: Walkthrough[],
	walkthroughId: string,
	blockId: string,
): WalkthroughContainerBlock | undefined {
	const walkthrough = findWalkthrough(walkthroughs, walkthroughId);
	if (!walkthrough) return undefined;
	return allBlocks(walkthrough.blocks).find(
		(block): block is WalkthroughContainerBlock => block.kind !== "step" && block.id === blockId,
	);
}

export function addWalkthrough(walkthroughs: Walkthrough[], input: { id: string; name?: string }): Walkthrough[] {
	requireIdentity(input.id, "Walkthrough id");
	if (findWalkthrough(walkthroughs, input.id)) throw new Error(`Walkthrough "${input.id}" already exists.`);
	if (walkthroughs.length >= WALKTHROUGH_LIMIT) throw new Error(`A Project can have at most ${WALKTHROUGH_LIMIT} Walkthroughs.`);
	const name = requireName(input.name ?? defaultWalkthroughName(walkthroughs), "Walkthrough name");
	requireUniqueName(walkthroughs, name);
	return [...walkthroughs, { id: input.id, name, blocks: [] }];
}

export function renameWalkthrough(walkthroughs: Walkthrough[], walkthroughId: string, name: string): Walkthrough[] {
	const current = requireWalkthrough(walkthroughs, walkthroughId);
	const next = requireName(name, "Walkthrough name");
	if (next === current.name) return walkthroughs;
	requireUniqueName(walkthroughs, next, walkthroughId);
	return replaceWalkthrough(walkthroughs, { ...current, name: next });
}

export function removeWalkthrough(walkthroughs: Walkthrough[], walkthroughId: string): Walkthrough[] {
	requireWalkthrough(walkthroughs, walkthroughId);
	return walkthroughs.filter((walkthrough) => walkthrough.id !== walkthroughId);
}

export function moveWalkthrough(walkthroughs: Walkthrough[], walkthroughId: string, toIndex: number): Walkthrough[] {
	requireWalkthrough(walkthroughs, walkthroughId);
	return moveById(walkthroughs, walkthroughId, toIndex, "Walkthrough", (walkthrough) => walkthrough.id);
}

/**
 * Appends a step that plays an existing Connection to the sequence named by
 * `sequence` (the top level by default). The step records that Connection's
 * endpoints now, and its title defaults to the Connection's label.
 */
export function addWalkthroughStep(
	walkthroughs: Walkthrough[],
	walkthroughId: string,
	input: WalkthroughStepDraft & { id: string; connectionId: string; sequence?: WalkthroughSequenceRef },
	design: SystemDesign,
): Walkthrough[] {
	const walkthrough = requireWalkthrough(walkthroughs, walkthroughId);
	requireIdentity(input.id, "Step id");
	if (allEntryIds(walkthroughs).has(input.id)) throw new Error(`Step "${input.id}" already exists.`);
	const connection = findSystemConnection(design, input.connectionId);
	if (!connection) throw new Error("Choose a Connection from the System design for this step.");
	const base: WalkthroughStep = {
		id: input.id,
		connectionId: connection.id,
		route: { sourceId: connection.sourceId, targetId: connection.targetId },
		title: connection.label,
		explanation: "",
		action: DEFAULT_WALKTHROUGH_ACTION,
	};
	const step = applyStepChanges(base, input);
	const blocks = appendToSequence(walkthrough.blocks, input.sequence ?? ROOT_SEQUENCE, { kind: "step", step });
	return replaceWalkthrough(walkthroughs, checkedWalkthrough({ ...walkthrough, blocks }));
}

/**
 * Appends an empty parallel block (two branches) or repeat block (default count)
 * to the sequence named by `sequence`.
 */
export function addWalkthroughBlock(
	walkthroughs: Walkthrough[],
	walkthroughId: string,
	input: { id: string; kind: WalkthroughContainerKind; sequence?: WalkthroughSequenceRef },
): Walkthrough[] {
	const walkthrough = requireWalkthrough(walkthroughs, walkthroughId);
	requireIdentity(input.id, "Block id");
	if (allEntryIds(walkthroughs).has(input.id)) throw new Error(`Block "${input.id}" already exists.`);
	const block: WalkthroughContainerBlock = input.kind === "parallel"
		? { kind: "parallel", id: input.id, branches: Array.from({ length: WALKTHROUGH_PARALLEL_BRANCH_MIN }, () => []) }
		: { kind: "repeat", id: input.id, count: WALKTHROUGH_REPEAT_COUNT_DEFAULT, body: [] };
	const blocks = appendToSequence(walkthrough.blocks, input.sequence ?? ROOT_SEQUENCE, block);
	return replaceWalkthrough(walkthroughs, checkedWalkthrough({ ...walkthrough, blocks }));
}

/** Adds an empty branch to a parallel block, up to the branch limit. */
export function addWalkthroughParallelBranch(walkthroughs: Walkthrough[], walkthroughId: string, blockId: string): Walkthrough[] {
	const walkthrough = requireWalkthrough(walkthroughs, walkthroughId);
	const blocks = editContainer(walkthrough.blocks, blockId, (container) => {
		if (container.kind !== "parallel") throw new Error("Only a parallel block has branches.");
		if (container.branches.length >= WALKTHROUGH_PARALLEL_BRANCH_LIMIT) {
			throw new Error(`A parallel block can have at most ${WALKTHROUGH_PARALLEL_BRANCH_LIMIT} branches.`);
		}
		return { ...container, branches: [...container.branches, []] };
	});
	return replaceWalkthrough(walkthroughs, checkedWalkthrough({ ...walkthrough, blocks: requireEdited(blocks, "That block could not be found.") }));
}

/** Sets how many times a repeat block runs. The count is a fixed, finite number. */
export function updateWalkthroughRepeat(walkthroughs: Walkthrough[], walkthroughId: string, blockId: string, count: number): Walkthrough[] {
	const walkthrough = requireWalkthrough(walkthroughs, walkthroughId);
	const checked = requireRepeatCount(count);
	const blocks = editContainer(walkthrough.blocks, blockId, (container) => {
		if (container.kind !== "repeat") throw new Error("Only a repeated block has a count.");
		return { ...container, count: checked };
	});
	return replaceWalkthrough(walkthroughs, checkedWalkthrough({ ...walkthrough, blocks: requireEdited(blocks, "That block could not be found.") }));
}

export function updateWalkthroughStep(
	walkthroughs: Walkthrough[],
	walkthroughId: string,
	stepId: string,
	changes: WalkthroughStepChanges,
): Walkthrough[] {
	const walkthrough = requireWalkthrough(walkthroughs, walkthroughId);
	requireStep(walkthrough, stepId);
	const blocks = editStep(walkthrough.blocks, stepId, (current) => applyStepChanges(current, changes));
	return replaceWalkthrough(walkthroughs, { ...walkthrough, blocks: requireEdited(blocks, "That step could not be found.") });
}

/** Moves a step within the sequence it sits in. */
export function moveWalkthroughStep(walkthroughs: Walkthrough[], walkthroughId: string, stepId: string, toIndex: number): Walkthrough[] {
	const walkthrough = requireWalkthrough(walkthroughs, walkthroughId);
	requireStep(walkthrough, stepId);
	const blocks = moveWithinSequence(walkthrough.blocks, stepId, toIndex, "Step");
	return replaceWalkthrough(walkthroughs, { ...walkthrough, blocks });
}

/** Moves a parallel or repeat block within the sequence it sits in. Its contents move with it. */
export function moveWalkthroughBlock(walkthroughs: Walkthrough[], walkthroughId: string, blockId: string, toIndex: number): Walkthrough[] {
	const walkthrough = requireWalkthrough(walkthroughs, walkthroughId);
	if (!findWalkthroughBlock(walkthroughs, walkthroughId, blockId)) throw new Error("That block could not be found.");
	const blocks = moveWithinSequence(walkthrough.blocks, blockId, toIndex, "Block");
	return replaceWalkthrough(walkthroughs, { ...walkthrough, blocks });
}

/** Removes one step. Other steps and their Connection references are unchanged. */
export function removeWalkthroughStep(walkthroughs: Walkthrough[], walkthroughId: string, stepId: string): Walkthrough[] {
	const walkthrough = requireWalkthrough(walkthroughs, walkthroughId);
	requireStep(walkthrough, stepId);
	const blocks = removeEntry(walkthrough.blocks, stepId);
	return replaceWalkthrough(walkthroughs, { ...walkthrough, blocks: requireEdited(blocks, "That step could not be found.") });
}

/** Removes a parallel or repeat block together with every step it contains. */
export function removeWalkthroughBlock(walkthroughs: Walkthrough[], walkthroughId: string, blockId: string): Walkthrough[] {
	const walkthrough = requireWalkthrough(walkthroughs, walkthroughId);
	if (!findWalkthroughBlock(walkthroughs, walkthroughId, blockId)) throw new Error("That block could not be found.");
	const blocks = removeEntry(walkthrough.blocks, blockId);
	return replaceWalkthrough(walkthroughs, { ...walkthrough, blocks: requireEdited(blocks, "That block could not be found.") });
}

/**
 * Points a step at an existing Connection and records that Connection's current
 * endpoints. This repairs a dangling step and accepts a redirected route. The
 * explanation is kept as the designer wrote it.
 */
export function repairWalkthroughStep(
	walkthroughs: Walkthrough[],
	walkthroughId: string,
	stepId: string,
	connectionId: string,
	design: SystemDesign,
): Walkthrough[] {
	const walkthrough = requireWalkthrough(walkthroughs, walkthroughId);
	requireStep(walkthrough, stepId);
	const connection = findSystemConnection(design, connectionId);
	if (!connection) throw new Error("Choose a Connection from the System design to repair this step.");
	const blocks = editStep(walkthrough.blocks, stepId, (step) => ({
		...step,
		connectionId: connection.id,
		route: { sourceId: connection.sourceId, targetId: connection.targetId },
	}));
	return replaceWalkthrough(walkthroughs, { ...walkthrough, blocks: requireEdited(blocks, "That step could not be found.") });
}

/**
 * Accepts the route a redirected step's Connection now runs. Keeping the same
 * Connection id is not enough on its own: only a step whose endpoints changed
 * can be accepted, and acceptance records the endpoints the designer reviewed.
 */
export function acceptWalkthroughStepRedirection(
	walkthroughs: Walkthrough[],
	walkthroughId: string,
	stepId: string,
	design: SystemDesign,
): Walkthrough[] {
	const walkthrough = requireWalkthrough(walkthroughs, walkthroughId);
	const current = requireStep(walkthrough, stepId);
	if (walkthroughStepStatus(current, design).status !== "redirected") {
		throw new Error("This step does not run a changed route to accept.");
	}
	return repairWalkthroughStep(walkthroughs, walkthroughId, stepId, current.connectionId, design);
}

/**
 * The steps, across every Walkthrough, that play one of the given Connections.
 * Removing those Connections, directly or with the Components and Services they
 * join, leaves these steps dangling. Nothing is deleted by listing them.
 */
export function walkthroughStepsOnConnections(walkthroughs: Walkthrough[], connectionIds: readonly string[]): AffectedWalkthroughStep[] {
	const ids = new Set(connectionIds);
	return walkthroughs.flatMap((walkthrough) =>
		walkthroughSteps(walkthrough)
			.filter((step) => ids.has(step.connectionId))
			.map((step) => ({
				walkthroughId: walkthrough.id,
				walkthroughName: walkthrough.name,
				stepId: step.id,
				title: step.title,
				connectionId: step.connectionId,
			})),
	);
}

/** The highlight for the selected step, or null when the selection no longer names a step. */
export function selectedWalkthroughHighlight(
	walkthroughs: Walkthrough[],
	design: SystemDesign,
	walkthroughId: string,
	stepId: string,
): WalkthroughHighlight | null {
	const step = findWalkthroughStep(walkthroughs, walkthroughId, stepId);
	return step ? walkthroughStepHighlight(step, design) : null;
}

/** A Connection endpoint is a Component or a Service; their ids share one namespace. */
export function findSystemEndpoint(design: SystemDesign, endpointId: string) {
	return findSystemComponent(design, endpointId) ?? findSystemService(design, endpointId);
}

/** Compares a step's stored reference with the System design as it is now. */
export function walkthroughStepStatus(step: WalkthroughStep, design: SystemDesign): WalkthroughStepStatus {
	const connection = findSystemConnection(design, step.connectionId);
	if (!connection) return { status: "dangling" };
	if (connection.sourceId !== step.route.sourceId || connection.targetId !== step.route.targetId) {
		return { status: "redirected", sourceId: connection.sourceId, targetId: connection.targetId };
	}
	return { status: "ok" };
}

/**
 * The Connection and Components a selected step identifies. A dangling step
 * still shows the Components it used, when they exist.
 */
export function walkthroughStepHighlight(step: WalkthroughStep, design: SystemDesign): WalkthroughHighlight {
	const connection = findSystemConnection(design, step.connectionId);
	if (connection) {
		return { connectionId: connection.id, endpointIds: [connection.sourceId, connection.targetId] };
	}
	const endpointIds = [step.route.sourceId, step.route.targetId].filter((id) => findSystemEndpoint(design, id) !== undefined);
	return { connectionId: null, endpointIds };
}

/** How many of a Walkthrough's steps need repair or review. */
export function walkthroughRepairCount(walkthrough: Walkthrough, design: SystemDesign): number {
	return walkthroughSteps(walkthrough).filter((step) => walkthroughStepStatus(step, design).status !== "ok").length;
}

/**
 * Validates Walkthroughs loaded from storage. Malformed structure is refused.
 * Dangling and redirected references are not, because they are repairable
 * draft state; they are reported by `walkthroughStepStatus` against the design.
 * A flat `steps` list from earlier saves becomes a sequence of step blocks.
 */
export function normalizeWalkthroughs(value: unknown): Walkthrough[] {
	if (!Array.isArray(value)) throw new Error("The saved Walkthroughs are malformed.");
	if (value.length > WALKTHROUGH_LIMIT) throw new Error(`A Project can have at most ${WALKTHROUGH_LIMIT} Walkthroughs.`);
	const walkthroughIds = new Set<string>();
	const names = new Set<string>();
	const entryIds = new Set<string>();
	return value.map((item) => {
		if (!isRecord(item)) throw new Error("A saved Walkthrough is malformed.");
		const id = requireIdentity(item.id, "Walkthrough id");
		if (walkthroughIds.has(id)) throw new Error(`Walkthrough "${id}" is duplicated.`);
		walkthroughIds.add(id);
		const name = requireName(item.name, "Walkthrough name");
		if (names.has(name)) throw new Error(`Walkthrough name "${name}" is duplicated.`);
		names.add(name);
		let blocks: WalkthroughBlock[];
		if (Array.isArray(item.blocks)) {
			blocks = normalizeBlocks(item.blocks, entryIds);
		} else if (Array.isArray(item.steps)) {
			blocks = item.steps.map((stepItem): WalkthroughBlock => ({ kind: "step", step: normalizeStep(stepItem, entryIds) }));
		} else {
			throw new Error("A saved Walkthrough's steps are malformed.");
		}
		return checkedWalkthrough({ id, name, blocks });
	});
}

function normalizeBlocks(items: unknown[], entryIds: Set<string>): WalkthroughBlock[] {
	return items.map((item): WalkthroughBlock => {
		if (!isRecord(item)) throw new Error("A saved Walkthrough block is malformed.");
		if (item.kind === "step") {
			if (!isRecord(item.step)) throw new Error("A saved Walkthrough step is malformed.");
			return { kind: "step", step: normalizeStep(item.step, entryIds) };
		}
		if (item.kind === "parallel") {
			const id = requireNewEntryId(item.id, "Block", entryIds);
			if (!Array.isArray(item.branches) || item.branches.some((branch) => !Array.isArray(branch))) {
				throw new Error(`Block "${id}" has malformed branches.`);
			}
			const count = item.branches.length;
			if (count < WALKTHROUGH_PARALLEL_BRANCH_MIN || count > WALKTHROUGH_PARALLEL_BRANCH_LIMIT) {
				throw new Error(`A parallel block must have from ${WALKTHROUGH_PARALLEL_BRANCH_MIN} to ${WALKTHROUGH_PARALLEL_BRANCH_LIMIT} branches.`);
			}
			const branches = (item.branches as unknown[][]).map((branch) => normalizeBlocks(branch, entryIds));
			return { kind: "parallel", id, branches };
		}
		if (item.kind === "repeat") {
			const id = requireNewEntryId(item.id, "Block", entryIds);
			if (!Array.isArray(item.body)) throw new Error(`Block "${id}" has a malformed body.`);
			const count = requireRepeatCount(item.count);
			return { kind: "repeat", id, count, body: normalizeBlocks(item.body, entryIds) };
		}
		throw new Error("A saved Walkthrough block is malformed.");
	});
}

function normalizeStep(stepItem: unknown, entryIds: Set<string>): WalkthroughStep {
	if (!isRecord(stepItem)) throw new Error("A saved Walkthrough step is malformed.");
	const stepId = requireNewEntryId(stepItem.id, "Step", entryIds);
	if (!isRecord(stepItem.route)) throw new Error(`Step "${stepId}" has a malformed route.`);
	const route = {
		sourceId: requireIdentity(stepItem.route.sourceId, "Step route source"),
		targetId: requireIdentity(stepItem.route.targetId, "Step route target"),
	};
	return withoutUndefined({
		id: stepId,
		connectionId: requireIdentity(stepItem.connectionId, "Step connection"),
		route,
		title: requireText(stepItem.title, "Step title", WALKTHROUGH_TITLE_LIMIT),
		explanation: requireText(stepItem.explanation, "Step explanation", WALKTHROUGH_EXPLANATION_LIMIT),
		action: requireAction(stepItem.action),
		operation: optionalStoredText(stepItem.operation, WALKTHROUGH_OPERATION_LIMIT, "Step operation"),
		durationMs: optionalStoredDuration(stepItem.durationMs),
		travelPercent: optionalStoredTravelPercent(stepItem.travelPercent),
		exampleMessage: optionalStoredText(stepItem.exampleMessage, WALKTHROUGH_EXAMPLE_MESSAGE_LIMIT, "Example message"),
		examplePayload: optionalStoredText(stepItem.examplePayload, WALKTHROUGH_EXAMPLE_PAYLOAD_LIMIT, "Example payload"),
	});
}

function requireNewEntryId(value: unknown, label: string, entryIds: Set<string>): string {
	const id = requireIdentity(value, `${label} id`);
	if (entryIds.has(id)) throw new Error(`${label} "${id}" is duplicated.`);
	entryIds.add(id);
	return id;
}

function applyStepChanges(step: WalkthroughStep, changes: WalkthroughStepDraft): WalkthroughStep {
	const next: WalkthroughStep = { ...step };
	if (changes.title !== undefined) next.title = requireText(changes.title, "Step title", WALKTHROUGH_TITLE_LIMIT);
	if (changes.explanation !== undefined) {
		next.explanation = requireText(changes.explanation, "Step explanation", WALKTHROUGH_EXPLANATION_LIMIT);
	}
	if (changes.action !== undefined) next.action = requireAction(changes.action);
	if (changes.operation !== undefined) {
		next.operation = optionalText(changes.operation, WALKTHROUGH_OPERATION_LIMIT, "Step operation");
	}
	if (changes.durationMs !== undefined) next.durationMs = changes.durationMs === null ? undefined : requireDuration(changes.durationMs);
	if (changes.travelPercent !== undefined) {
		next.travelPercent = changes.travelPercent === null ? undefined : requireTravelPercent(changes.travelPercent);
	}
	if (changes.exampleMessage !== undefined) {
		next.exampleMessage = optionalText(changes.exampleMessage, WALKTHROUGH_EXAMPLE_MESSAGE_LIMIT, "Example message");
	}
	if (changes.examplePayload !== undefined) {
		next.examplePayload = optionalText(changes.examplePayload, WALKTHROUGH_EXAMPLE_PAYLOAD_LIMIT, "Example payload");
	}
	return withoutUndefined(next);
}

/* ----------------------------- block tree helpers ----------------------------- */

/** A block and, recursively, every block it contains, in authoring order. */
function allBlocks(blocks: WalkthroughBlock[]): WalkthroughBlock[] {
	return blocks.flatMap((block) => (block.kind === "step" ? [block] : [block, ...childSequences(block).flatMap(allBlocks)]));
}

function stepsIn(blocks: WalkthroughBlock[]): WalkthroughStep[] {
	return blocks.flatMap((block) => (block.kind === "step" ? [block.step] : childSequences(block).flatMap(stepsIn)));
}

function allEntryIds(walkthroughs: Walkthrough[]): Set<string> {
	return new Set(
		walkthroughs.flatMap((walkthrough) =>
			allBlocks(walkthrough.blocks).map((block) => (block.kind === "step" ? block.step.id : block.id)),
		),
	);
}

/** The sequences a container holds: a parallel block's branches, or a repeat block's body. */
function childSequences(block: WalkthroughContainerBlock): WalkthroughBlock[][] {
	return block.kind === "parallel" ? block.branches : [block.body];
}

function withChildSequences(block: WalkthroughContainerBlock, sequences: WalkthroughBlock[][]): WalkthroughContainerBlock {
	return block.kind === "parallel" ? { ...block, branches: sequences } : { ...block, body: sequences[0]! };
}

/**
 * Applies `change` to the first sequence, searching the top level and then every
 * nested one, that `change` accepts. Returns null when no sequence accepts it.
 */
function editSequence(
	blocks: WalkthroughBlock[],
	change: (sequence: WalkthroughBlock[]) => WalkthroughBlock[] | null,
): WalkthroughBlock[] | null {
	const direct = change(blocks);
	if (direct) return direct;
	for (let index = 0; index < blocks.length; index += 1) {
		const block = blocks[index]!;
		if (block.kind === "step") continue;
		const sequences = childSequences(block);
		for (let position = 0; position < sequences.length; position += 1) {
			const edited = editSequence(sequences[position]!, change);
			if (edited) {
				const next = sequences.map((sequence, at) => (at === position ? edited : sequence));
				return replaceAt(blocks, index, withChildSequences(block, next));
			}
		}
	}
	return null;
}

function editContainer(
	blocks: WalkthroughBlock[],
	blockId: string,
	change: (container: WalkthroughContainerBlock) => WalkthroughContainerBlock,
): WalkthroughBlock[] | null {
	return editSequence(blocks, (sequence) => {
		const index = sequence.findIndex((block) => block.kind !== "step" && block.id === blockId);
		return index < 0 ? null : replaceAt(sequence, index, change(sequence[index] as WalkthroughContainerBlock));
	});
}

function editStep(blocks: WalkthroughBlock[], stepId: string, change: (step: WalkthroughStep) => WalkthroughStep): WalkthroughBlock[] | null {
	return editSequence(blocks, (sequence) => {
		const index = sequence.findIndex((block) => block.kind === "step" && block.step.id === stepId);
		if (index < 0) return null;
		const block = sequence[index] as WalkthroughStepBlock;
		return replaceAt(sequence, index, { kind: "step", step: change(block.step) });
	});
}

function removeEntry(blocks: WalkthroughBlock[], entryId: string): WalkthroughBlock[] | null {
	return editSequence(blocks, (sequence) => {
		const next = sequence.filter((block) => entryIdOf(block) !== entryId);
		return next.length === sequence.length ? null : next;
	});
}

function moveWithinSequence(blocks: WalkthroughBlock[], entryId: string, toIndex: number, label: string): WalkthroughBlock[] {
	const moved = editSequence(blocks, (sequence) => {
		if (!sequence.some((block) => entryIdOf(block) === entryId)) return null;
		return moveById(sequence, entryId, toIndex, label, entryIdOf);
	});
	return requireEdited(moved, `That ${label.toLowerCase()} could not be found.`);
}

function appendToSequence(blocks: WalkthroughBlock[], ref: WalkthroughSequenceRef, block: WalkthroughBlock): WalkthroughBlock[] {
	if (ref.blockId === null) return [...blocks, block];
	const edited = editContainer(blocks, ref.blockId, (container) => {
		if (container.kind === "parallel") {
			if (ref.branch === undefined || !Number.isInteger(ref.branch) || ref.branch < 0 || ref.branch >= container.branches.length) {
				throw new Error("Choose a branch of the parallel block for this step.");
			}
			return { ...container, branches: container.branches.map((branch, at) => (at === ref.branch ? [...branch, block] : branch)) };
		}
		if (ref.branch !== undefined) throw new Error("A repeated block has one body, not branches.");
		return { ...container, body: [...container.body, block] };
	});
	return requireEdited(edited, "Choose a parallel or repeated block to add to.");
}

function entryIdOf(block: WalkthroughBlock): string {
	return block.kind === "step" ? block.step.id : block.id;
}

function replaceAt<T>(items: T[], index: number, item: T): T[] {
	return items.map((current, at) => (at === index ? item : current));
}

function requireEdited(blocks: WalkthroughBlock[] | null, message: string): WalkthroughBlock[] {
	if (!blocks) throw new Error(message);
	return blocks;
}

/** Checks the limits a structural edit can break, and returns the Walkthrough unchanged when they hold. */
function checkedWalkthrough(walkthrough: Walkthrough): Walkthrough {
	const steps = stepsIn(walkthrough.blocks).length;
	if (steps > WALKTHROUGH_STEP_LIMIT) throw new Error(`A Walkthrough can have at most ${WALKTHROUGH_STEP_LIMIT} steps.`);
	const containers = allBlocks(walkthrough.blocks).filter((block) => block.kind !== "step").length;
	if (containers > WALKTHROUGH_BLOCK_LIMIT) {
		throw new Error(`A Walkthrough can have at most ${WALKTHROUGH_BLOCK_LIMIT} parallel or repeated blocks.`);
	}
	if (depthOf(walkthrough.blocks) > WALKTHROUGH_NESTING_LIMIT) {
		throw new Error(`Parallel and repeated blocks can nest at most ${WALKTHROUGH_NESTING_LIMIT} levels deep.`);
	}
	return walkthrough;
}

/** How many containers enclose the deepest step, counting the outermost as one. */
function depthOf(blocks: WalkthroughBlock[]): number {
	return blocks.reduce((deepest, block) => {
		if (block.kind === "step") return deepest;
		const inner = childSequences(block).reduce((max, sequence) => Math.max(max, depthOf(sequence)), 0);
		return Math.max(deepest, 1 + inner);
	}, 0);
}

function moveById<T>(items: T[], id: string, toIndex: number, label: string, idOf: (item: T) => string): T[] {
	if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= items.length) {
		throw new Error(`${label} position must be between 0 and ${items.length - 1}.`);
	}
	const from = items.findIndex((item) => idOf(item) === id);
	if (from < 0) throw new Error(`That ${label.toLowerCase()} could not be found.`);
	const rest = items.filter((item) => idOf(item) !== id);
	const moving = items[from]!;
	return [...rest.slice(0, toIndex), moving, ...rest.slice(toIndex)];
}

/* --------------------------------- requirements -------------------------------- */

function replaceWalkthrough(walkthroughs: Walkthrough[], next: Walkthrough): Walkthrough[] {
	return walkthroughs.map((walkthrough) => (walkthrough.id === next.id ? next : walkthrough));
}

function requireWalkthrough(walkthroughs: Walkthrough[], walkthroughId: string): Walkthrough {
	const walkthrough = findWalkthrough(walkthroughs, walkthroughId);
	if (!walkthrough) throw new Error("That Walkthrough could not be found.");
	return walkthrough;
}

function requireStep(walkthrough: Walkthrough, stepId: string): WalkthroughStep {
	const step = walkthroughSteps(walkthrough).find((candidate) => candidate.id === stepId);
	if (!step) throw new Error("That step could not be found.");
	return step;
}

function requireUniqueName(walkthroughs: Walkthrough[], name: string, exceptId?: string) {
	if (walkthroughs.some((walkthrough) => walkthrough.id !== exceptId && walkthrough.name === name)) {
		throw new Error(`A Walkthrough named “${name}” already exists.`);
	}
}

function defaultWalkthroughName(walkthroughs: Walkthrough[]): string {
	const names = new Set(walkthroughs.map((walkthrough) => walkthrough.name));
	if (!names.has("Walkthrough")) return "Walkthrough";
	for (let index = 2; ; index += 1) {
		const candidate = `Walkthrough ${index}`;
		if (!names.has(candidate)) return candidate;
	}
}

function requireIdentity(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} is required.`);
	return value;
}

function requireName(value: unknown, label: string): string {
	if (typeof value !== "string") throw new Error(`${label} is required.`);
	const trimmed = value.trim();
	if (trimmed.length === 0) throw new Error(`${label} is required.`);
	if (trimmed.length > WALKTHROUGH_NAME_LIMIT) throw new Error(`${label} must be ${WALKTHROUGH_NAME_LIMIT} characters or fewer.`);
	return trimmed;
}

/** Authored text may be empty while a draft is incomplete, but never over its limit. */
function requireText(value: unknown, label: string, limit: number): string {
	if (typeof value !== "string") throw new Error(`${label} must be text.`);
	const trimmed = value.trim();
	if (trimmed.length > limit) throw new Error(`${label} must be ${limit} characters or fewer.`);
	return trimmed;
}

function optionalText(value: unknown, limit: number, label: string): string | undefined {
	const trimmed = requireText(value, label, limit);
	return trimmed.length > 0 ? trimmed : undefined;
}

function optionalStoredText(value: unknown, limit: number, label: string): string | undefined {
	if (value === undefined) return undefined;
	return optionalText(value, limit, label);
}

function requireAction(value: unknown): WalkthroughAction {
	if (typeof value !== "string" || !WALKTHROUGH_ACTIONS.includes(value as WalkthroughAction)) {
		throw new Error(`Unsupported step action "${String(value)}".`);
	}
	return value as WalkthroughAction;
}

function requireDuration(value: unknown): number {
	if (typeof value !== "number" || !Number.isInteger(value)
		|| value < WALKTHROUGH_DURATION_MIN_MS || value > WALKTHROUGH_DURATION_MAX_MS) {
		throw new Error(`Step duration must be a whole number of milliseconds from ${WALKTHROUGH_DURATION_MIN_MS} to ${WALKTHROUGH_DURATION_MAX_MS}.`);
	}
	return value;
}

function optionalStoredDuration(value: unknown): number | undefined {
	if (value === undefined) return undefined;
	return requireDuration(value);
}

function requireRepeatCount(value: unknown): number {
	if (typeof value !== "number" || !Number.isInteger(value)
		|| value < WALKTHROUGH_REPEAT_COUNT_MIN || value > WALKTHROUGH_REPEAT_COUNT_MAX) {
		throw new Error(`A repeated block runs from ${WALKTHROUGH_REPEAT_COUNT_MIN} to ${WALKTHROUGH_REPEAT_COUNT_MAX} times.`);
	}
	return value;
}

function requireTravelPercent(value: unknown): number {
	if (typeof value !== "number" || !Number.isInteger(value)
		|| value < WALKTHROUGH_TRAVEL_PERCENT_MIN || value > WALKTHROUGH_TRAVEL_PERCENT_MAX) {
		throw new Error(
			`Step travel share must be a whole percent from ${WALKTHROUGH_TRAVEL_PERCENT_MIN} to ${WALKTHROUGH_TRAVEL_PERCENT_MAX}.`,
		);
	}
	return value;
}

function optionalStoredTravelPercent(value: unknown): number | undefined {
	if (value === undefined) return undefined;
	return requireTravelPercent(value);
}

function withoutUndefined<T extends object>(value: T): T {
	return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
