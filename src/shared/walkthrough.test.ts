import { describe, expect, test } from "bun:test";
import {
	addSystemComponent,
	addSystemConnection,
	addSystemService,
	createEmptySystemDesign,
	removeSystemConnection,
	removeSystemComponent,
	removeSystemService,
	updateSystemComponent,
	updateSystemConnection,
	type SystemDesign,
} from "./system-design";
import {
	acceptWalkthroughStepRedirection,
	addWalkthrough,
	addWalkthroughStep,
	walkthroughStepsOnConnections,
	moveWalkthrough,
	moveWalkthroughStep,
	normalizeWalkthroughs,
	removeWalkthroughStep,
	renameWalkthrough,
	repairWalkthroughStep,
	selectedWalkthroughHighlight,
	updateWalkthroughStep,
	walkthroughRepairCount,
	walkthroughStepHighlight,
	walkthroughStepStatus,
	type Walkthrough,
	walkthroughSteps,
	addWalkthroughBlock,
	addWalkthroughParallelBranch,
	findWalkthroughBlock,
	moveWalkthroughBlock,
	removeWalkthroughBlock,
	updateWalkthroughRepeat,
} from "./walkthrough";

/** Client, API, and Queue with an upload Connection and an enqueue Connection. */
function uploadSystem(): SystemDesign {
	let design = createEmptySystemDesign();
	design = addSystemComponent(design, { id: "client", name: "Browser", position: { x: 0, y: 0 } });
	design = addSystemComponent(design, { id: "api", name: "API", position: { x: 300, y: 0 } });
	design = addSystemComponent(design, { id: "queue", name: "Queue", position: { x: 600, y: 0 } });
	design = addSystemConnection(design, { id: "upload", sourceId: "client", targetId: "api", label: "Upload" });
	design = addSystemConnection(design, { id: "enqueue", sourceId: "api", targetId: "queue", label: "Enqueue" });
	return design;
}

function withUploadStep(design: SystemDesign): Walkthrough[] {
	const walkthroughs = addWalkthrough([], { id: "w-upload", name: "Image upload" });
	return addWalkthroughStep(walkthroughs, "w-upload", { id: "s-upload", connectionId: "upload", explanation: "The browser sends the file." }, design);
}

describe("Walkthrough model", () => {
	test("names walkthroughs with unique, trimmed names and orders them by position", () => {
		let walkthroughs = addWalkthrough([], { id: "w1" });
		expect(walkthroughs[0]!.name).toBe("Walkthrough");
		walkthroughs = addWalkthrough(walkthroughs, { id: "w2", name: "  Cached read  " });
		expect(walkthroughs.map((walkthrough) => walkthrough.name)).toEqual(["Walkthrough", "Cached read"]);

		expect(() => addWalkthrough(walkthroughs, { id: "w3", name: "cached read" })).not.toThrow();
		expect(() => addWalkthrough(walkthroughs, { id: "w3", name: "Cached read" })).toThrow("A Walkthrough named “Cached read” already exists.");
		expect(() => renameWalkthrough(walkthroughs, "w1", "Cached read")).toThrow("already exists");
		expect(renameWalkthrough(walkthroughs, "w1", "Image upload")[0]!.name).toBe("Image upload");

		expect(moveWalkthrough(walkthroughs, "w2", 0).map((walkthrough) => walkthrough.id)).toEqual(["w2", "w1"]);
		expect(() => moveWalkthrough(walkthroughs, "w2", 2)).toThrow("Walkthrough position must be between 0 and 1.");
	});

	test("a step references a real Connection, records its endpoints, and defaults its title to the Connection label", () => {
		const design = uploadSystem();
		const walkthroughs = withUploadStep(design);
		const step = walkthroughSteps(walkthroughs[0]!)[0]!;
		expect(step).toMatchObject({
			id: "s-upload",
			connectionId: "upload",
			route: { sourceId: "client", targetId: "api" },
			title: "Upload",
			explanation: "The browser sends the file.",
			action: "send",
		});
		expect(walkthroughStepStatus(step, design)).toEqual({ status: "ok" });
		expect(() => addWalkthroughStep(walkthroughs, "w-upload", { id: "s-2", connectionId: "missing" }, design)).toThrow(
			"Choose a Connection from the System design for this step.",
		);
	});

	test("removing a Connection keeps its steps as dangling references that can be repaired", () => {
		let design = uploadSystem();
		let walkthroughs = withUploadStep(design);
		walkthroughs = addWalkthroughStep(walkthroughs, "w-upload", { id: "s-enqueue", connectionId: "enqueue" }, design);

		design = removeSystemConnection(design, "upload");
		const [first, second] = walkthroughSteps(walkthroughs[0]!);
		expect(walkthroughSteps(walkthroughs[0]!).map((step) => step.id)).toEqual(["s-upload", "s-enqueue"]);
		expect(walkthroughStepStatus(first!, design)).toEqual({ status: "dangling" });
		expect(walkthroughStepStatus(second!, design)).toEqual({ status: "ok" });
		expect(walkthroughRepairCount(walkthroughs[0]!, design)).toBe(1);

		// The dangling step still shows the Components it used, but no Connection.
		expect(walkthroughStepHighlight(first!, design)).toEqual({ connectionId: null, endpointIds: ["client", "api"] });

		const repaired = repairWalkthroughStep(walkthroughs, "w-upload", "s-upload", "enqueue", design);
		expect(walkthroughSteps(repaired[0]!)[0]).toMatchObject({ connectionId: "enqueue", route: { sourceId: "api", targetId: "queue" }, title: "Upload" });
		expect(walkthroughRepairCount(repaired[0]!, design)).toBe(0);
	});

	test("a Connection whose endpoints change is redirected until the designer accepts the new route", () => {
		let design = uploadSystem();
		const walkthroughs = withUploadStep(design);
		design = updateSystemConnection(design, "upload", { targetId: "queue" });

		const step = walkthroughSteps(walkthroughs[0]!)[0]!;
		expect(walkthroughStepStatus(step, design)).toEqual({ status: "redirected", sourceId: "client", targetId: "queue" });
		expect(walkthroughStepHighlight(step, design)).toEqual({ connectionId: "upload", endpointIds: ["client", "queue"] });

		const accepted = repairWalkthroughStep(walkthroughs, "w-upload", "s-upload", "upload", design);
		expect(walkthroughStepStatus(walkthroughSteps(accepted[0]!)[0]!, design)).toEqual({ status: "ok" });
		expect(walkthroughSteps(accepted[0]!)[0]!.route).toEqual({ sourceId: "client", targetId: "queue" });
	});

	test("renaming and moving Components keeps step references and highlights", () => {
		let design = uploadSystem();
		const walkthroughs = withUploadStep(design);
		design = updateSystemComponent(design, "api", { name: "Gateway" });
		const step = walkthroughSteps(walkthroughs[0]!)[0]!;
		expect(walkthroughStepStatus(step, design)).toEqual({ status: "ok" });
		expect(selectedWalkthroughHighlight(walkthroughs, design, "w-upload", "s-upload")).toEqual({
			connectionId: "upload",
			endpointIds: ["client", "api"],
		});
	});

	test("a Component removed with its Connections leaves the step dangling and its endpoints unchanged", () => {
		const design = removeSystemComponent(uploadSystem(), "api");
		const walkthroughs = withUploadStep(uploadSystem());
		const step = walkthroughSteps(walkthroughs[0]!)[0]!;
		expect(walkthroughStepStatus(step, design)).toEqual({ status: "dangling" });
		expect(walkthroughStepHighlight(step, design)).toEqual({ connectionId: null, endpointIds: ["client"] });
	});

	test("updates clear optional text with empty strings and clear the duration with null", () => {
		const design = uploadSystem();
		let walkthroughs = updateWalkthroughStep(withUploadStep(design), "w-upload", "s-upload", {
			operation: "upload",
			durationMs: 1200,
			exampleMessage: "POST /images",
			examplePayload: "{\"name\":\"cat.png\"}",
			action: "receive",
			title: "Browser uploads",
		});
		expect(walkthroughSteps(walkthroughs[0]!)[0]).toMatchObject({
			operation: "upload",
			durationMs: 1200,
			exampleMessage: "POST /images",
			examplePayload: "{\"name\":\"cat.png\"}",
			action: "receive",
			title: "Browser uploads",
		});

		walkthroughs = updateWalkthroughStep(walkthroughs, "w-upload", "s-upload", {
			operation: "",
			durationMs: null,
			exampleMessage: "  ",
			examplePayload: "",
		});
		const cleared = walkthroughSteps(walkthroughs[0]!)[0]!;
		expect(cleared).not.toHaveProperty("operation");
		expect(cleared).not.toHaveProperty("durationMs");
		expect(cleared).not.toHaveProperty("exampleMessage");
		expect(cleared).not.toHaveProperty("examplePayload");
	});

	test("a step's travel share is a whole percent from 10 to 90, can be cleared to the default, and is kept on save", () => {
		const design = uploadSystem();
		const draft = withUploadStep(design);
		const shaped = updateWalkthroughStep(draft, "w-upload", "s-upload", { travelPercent: 25 });
		expect(walkthroughSteps(shaped[0]!)[0]).toMatchObject({ travelPercent: 25 });
		expect(normalizeWalkthroughs(shaped)).toEqual(shaped);

		expect(() => updateWalkthroughStep(draft, "w-upload", "s-upload", { travelPercent: 5 })).toThrow(
			"Step travel share must be a whole percent from 10 to 90.",
		);
		expect(() => updateWalkthroughStep(draft, "w-upload", "s-upload", { travelPercent: 90.5 })).toThrow("whole percent");
		expect(() => normalizeWalkthroughs([{ id: "w", name: "W", steps: [{ ...walkthroughSteps(shaped[0]!)[0], travelPercent: 95 }] }]))
			.toThrow("Step travel share must be");

		const cleared = updateWalkthroughStep(shaped, "w-upload", "s-upload", { travelPercent: null });
		expect(walkthroughSteps(cleared[0]!)[0]).not.toHaveProperty("travelPercent");
	});

	test("incomplete drafts with empty title and explanation are accepted, while out-of-range timing and unknown actions are refused", () => {
		const design = uploadSystem();
		const draft = addWalkthroughStep(addWalkthrough([], { id: "w" }), "w", { id: "s", connectionId: "upload", title: "" }, design);
		expect(walkthroughSteps(draft[0]!)[0]).toMatchObject({ title: "", explanation: "" });

		expect(() => updateWalkthroughStep(draft, "w", "s", { durationMs: 50 })).toThrow("Step duration must be a whole number of milliseconds from 100 to 10000.");
		expect(() => updateWalkthroughStep(draft, "w", "s", { durationMs: 1.5 })).toThrow("whole number");
		expect(() => updateWalkthroughStep(draft, "w", "s", { action: "retry" as never })).toThrow('Unsupported step action "retry".');
		expect(() => updateWalkthroughStep(draft, "w", "s", { title: "x".repeat(121) })).toThrow("Step title must be 120 characters or fewer.");
	});

	test("a step can play a Connection whose endpoint is a Service, and reports that Service as its endpoint", () => {
		let design = uploadSystem();
		design = addSystemService(design, { id: "orders", name: "Orders", position: { x: 0, y: -200 } });
		design = updateSystemComponent(design, "api", { serviceId: "orders" });
		design = addSystemConnection(design, { id: "dispatch", sourceId: "orders", targetId: "queue", label: "Dispatches" });
		const walkthroughs = addWalkthroughStep(addWalkthrough([], { id: "w", name: "Dispatch" }), "w", { id: "s", connectionId: "dispatch" }, design);

		const step = walkthroughSteps(walkthroughs[0]!)[0]!;
		expect(walkthroughStepStatus(step, design)).toEqual({ status: "ok" });
		expect(walkthroughStepHighlight(step, design)).toEqual({ connectionId: "dispatch", endpointIds: ["orders", "queue"] });

		// Removing the Service deletes its Connection; the step keeps the endpoint that still exists.
		const withoutService = removeSystemService(design, "orders");
		expect(walkthroughStepStatus(step, withoutService)).toEqual({ status: "dangling" });
		expect(walkthroughStepHighlight(step, withoutService)).toEqual({ connectionId: null, endpointIds: ["queue"] });
	});

	test("steps can be reordered and removed without touching their neighbours", () => {
		const design = uploadSystem();
		let walkthroughs = withUploadStep(design);
		walkthroughs = addWalkthroughStep(walkthroughs, "w-upload", { id: "s-enqueue", connectionId: "enqueue" }, design);
		walkthroughs = moveWalkthroughStep(walkthroughs, "w-upload", "s-enqueue", 0);
		expect(walkthroughSteps(walkthroughs[0]!).map((step) => step.id)).toEqual(["s-enqueue", "s-upload"]);

		walkthroughs = removeWalkthroughStep(walkthroughs, "w-upload", "s-enqueue");
		expect(walkthroughSteps(walkthroughs[0]!).map((step) => step.id)).toEqual(["s-upload"]);
		expect(walkthroughSteps(walkthroughs[0]!)[0]!.explanation).toBe("The browser sends the file.");
	});

	test("normalizeWalkthroughs keeps repairable draft state and refuses malformed structure", () => {
		const repairable: Walkthrough[] = [{
			id: "w",
			name: "Draft",
			blocks: [{
				kind: "step",
				step: {
					id: "s",
					connectionId: "gone",
					route: { sourceId: "client", targetId: "api" },
					title: "",
					explanation: "",
					action: "fail",
				},
			}],
		}];
		expect(normalizeWalkthroughs(repairable)).toEqual(repairable);
		expect(walkthroughStepStatus(walkthroughSteps(normalizeWalkthroughs(repairable)[0]!)[0]!, uploadSystem())).toEqual({ status: "dangling" });

		expect(() => normalizeWalkthroughs({ walkthroughs: [] })).toThrow("The saved Walkthroughs are malformed.");
		expect(() => normalizeWalkthroughs([{ id: "w", name: "A", steps: [] }, { id: "w", name: "B", steps: [] }])).toThrow('Walkthrough "w" is duplicated.');
		expect(() => normalizeWalkthroughs([{ id: "a", name: "Same", steps: [] }, { id: "b", name: "Same", steps: [] }])).toThrow(
			'Walkthrough name "Same" is duplicated.',
		);
		expect(() => normalizeWalkthroughs([{ id: "w", name: "", steps: [] }])).toThrow("Walkthrough name is required.");
		expect(() => normalizeWalkthroughs([{ id: "w", name: "W", steps: "none" }])).toThrow("steps are malformed");
		expect(() => normalizeWalkthroughs([{ id: "w", name: "W", steps: [{ ...walkthroughSteps(repairable[0]!)[0], action: "explode" }] }]))
			.toThrow('Unsupported step action "explode".');
		expect(() => normalizeWalkthroughs([{ id: "w", name: "W", steps: [{ ...walkthroughSteps(repairable[0]!)[0], connectionId: "" }] }]))
			.toThrow("Step connection is required.");
		expect(() => normalizeWalkthroughs([{ id: "w", name: "W", steps: [{ ...walkthroughSteps(repairable[0]!)[0], durationMs: 999999 }] }]))
			.toThrow("Step duration must be");
		expect(() => normalizeWalkthroughs([{ id: "w", name: "W", steps: [{ ...walkthroughSteps(repairable[0]!)[0], route: "api" }] }]))
			.toThrow('Step "s" has a malformed route.');
	});
});

describe("Walkthrough impact and redirection", () => {
	function uploadDesign(): SystemDesign {
		let design = createEmptySystemDesign();
		design = addSystemComponent(design, { id: "client", name: "Browser", position: { x: 0, y: 0 } });
		design = addSystemComponent(design, { id: "api", name: "API", position: { x: 300, y: 0 } });
		design = addSystemComponent(design, { id: "queue", name: "Queue", position: { x: 600, y: 0 } });
		design = addSystemConnection(design, { id: "upload", sourceId: "client", targetId: "api", label: "Upload" });
		return addSystemConnection(design, { id: "enqueue", sourceId: "api", targetId: "queue", label: "Enqueue" });
	}

	function withSteps(design: SystemDesign): Walkthrough[] {
		let walkthroughs = addWalkthrough([], { id: "upload-flow", name: "Upload" });
		walkthroughs = addWalkthrough(walkthroughs, { id: "queue-flow", name: "Queue" });
		walkthroughs = addWalkthroughStep(walkthroughs, "upload-flow", { id: "s1", connectionId: "upload", title: "Send", explanation: "Browser posts." }, design);
		walkthroughs = addWalkthroughStep(walkthroughs, "upload-flow", { id: "s2", connectionId: "enqueue", title: "Queue" }, design);
		return addWalkthroughStep(walkthroughs, "queue-flow", { id: "s3", connectionId: "enqueue", title: "Publish" }, design);
	}

	test("listing impact names every step, across Walkthroughs, that plays a removed Connection and changes nothing", () => {
		const design = uploadDesign();
		const walkthroughs = withSteps(design);
		const before = JSON.stringify(walkthroughs);

		expect(walkthroughStepsOnConnections(walkthroughs, ["enqueue"])).toEqual([
			{ walkthroughId: "upload-flow", walkthroughName: "Upload", stepId: "s2", title: "Queue", connectionId: "enqueue" },
			{ walkthroughId: "queue-flow", walkthroughName: "Queue", stepId: "s3", title: "Publish", connectionId: "enqueue" },
		]);
		expect(walkthroughStepsOnConnections(walkthroughs, ["missing"])).toEqual([]);
		expect(JSON.stringify(walkthroughs)).toBe(before);
	});

	test("accepting a redirected step records the Connection's new endpoints and keeps its text", () => {
		const design = uploadDesign();
		const walkthroughs = withSteps(design);
		const redirected = updateSystemConnection(design, "enqueue", { sourceId: "client" });
		expect(walkthroughStepStatus(walkthroughSteps(walkthroughs[0]!)[1]!, redirected)).toEqual({ status: "redirected", sourceId: "client", targetId: "queue" });

		const accepted = acceptWalkthroughStepRedirection(walkthroughs, "upload-flow", "s2", redirected);
		expect(walkthroughSteps(accepted[0]!)[1]).toMatchObject({ connectionId: "enqueue", route: { sourceId: "client", targetId: "queue" }, title: "Queue" });
		expect(walkthroughStepStatus(walkthroughSteps(accepted[0]!)[1]!, redirected)).toEqual({ status: "ok" });
		expect(accepted[1]).toEqual(walkthroughs[1]);
	});

	test("a retained Connection id is not an accepted redirection: steps that are ok or dangling cannot be accepted", () => {
		const design = uploadDesign();
		const walkthroughs = withSteps(design);
		expect(() => acceptWalkthroughStepRedirection(walkthroughs, "upload-flow", "s2", design))
			.toThrow("This step does not run a changed route to accept.");

		const removed = removeSystemConnection(design, "enqueue");
		expect(() => acceptWalkthroughStepRedirection(walkthroughs, "upload-flow", "s2", removed))
			.toThrow("This step does not run a changed route to accept.");
		expect(() => acceptWalkthroughStepRedirection(walkthroughs, "upload-flow", "missing", removed))
			.toThrow("That step could not be found.");
	});
});

describe("Parallel and repeated blocks", () => {
	/** Upload runs in one branch while the enqueue runs in another; the repeat holds a retried upload. */
	function parallelWalkthrough(): Walkthrough[] {
		const design = uploadSystem();
		let walkthroughs = addWalkthrough([], { id: "w", name: "Concurrent" });
		walkthroughs = addWalkthroughBlock(walkthroughs, "w", { id: "p", kind: "parallel" });
		walkthroughs = addWalkthroughStep(walkthroughs, "w", { id: "a", connectionId: "upload", sequence: { blockId: "p", branch: 0 } }, design);
		walkthroughs = addWalkthroughStep(walkthroughs, "w", { id: "b", connectionId: "enqueue", sequence: { blockId: "p", branch: 1 } }, design);
		walkthroughs = addWalkthroughBlock(walkthroughs, "w", { id: "r", kind: "repeat" });
		walkthroughs = updateWalkthroughRepeat(walkthroughs, "w", "r", 3);
		walkthroughs = addWalkthroughStep(walkthroughs, "w", { id: "c", connectionId: "upload", sequence: { blockId: "r" } }, design);
		return walkthroughs;
	}

	test("authors parallel branches and repeat bodies alongside plain steps, in authoring order", () => {
		const design = uploadSystem();
		let walkthroughs = parallelWalkthrough();
		expect(walkthroughSteps(walkthroughs[0]!).map((step) => step.id)).toEqual(["a", "b", "c"]);
		expect(walkthroughs[0]!.blocks.map((block) => block.kind)).toEqual(["parallel", "repeat"]);

		walkthroughs = addWalkthroughStep(walkthroughs, "w", { id: "d", connectionId: "upload", sequence: { blockId: null } }, design);
		walkthroughs = addWalkthroughParallelBranch(walkthroughs, "w", "p");
		const parallel = findWalkthroughBlock(walkthroughs, "w", "p")!;
		expect(parallel.kind === "parallel" ? parallel.branches.map((branch) => branch.length) : []).toEqual([1, 1, 0]);
		expect(walkthroughSteps(walkthroughs[0]!).map((step) => step.id)).toEqual(["a", "b", "c", "d"]);
	});

	test("repeat counts are finite integers from 1 to 10, and only repeats have counts", () => {
		const walkthroughs = parallelWalkthrough();
		expect(() => updateWalkthroughRepeat(walkthroughs, "w", "r", 0)).toThrow("A repeated block runs from 1 to 10 times.");
		expect(() => updateWalkthroughRepeat(walkthroughs, "w", "r", 11)).toThrow("A repeated block runs from 1 to 10 times.");
		expect(() => updateWalkthroughRepeat(walkthroughs, "w", "r", 2.5)).toThrow("A repeated block runs from 1 to 10 times.");
		expect(() => updateWalkthroughRepeat(walkthroughs, "w", "p", 2)).toThrow("Only a repeated block has a count.");
		expect(() => addWalkthroughParallelBranch(walkthroughs, "w", "r")).toThrow("Only a parallel block has branches.");
		expect(() => addWalkthroughStep(walkthroughs, "w", { id: "x", connectionId: "upload", sequence: { blockId: "p", branch: 9 } }, uploadSystem()))
			.toThrow("Choose a branch of the parallel block for this step.");
	});

	test("nesting and block counts are bounded", () => {
		let walkthroughs = addWalkthrough([], { id: "w" });
		let parent: string | null = null;
		for (let depth = 1; depth <= 4; depth += 1) {
			const id = `r${depth}`;
			walkthroughs = addWalkthroughBlock(walkthroughs, "w", { id, kind: "repeat", sequence: parent ? { blockId: parent } : undefined });
			parent = id;
		}
		expect(() => addWalkthroughBlock(walkthroughs, "w", { id: "deep", kind: "parallel", sequence: { blockId: parent } }))
			.toThrow("Parallel and repeated blocks can nest at most 4 levels deep.");
	});

	test("a flat list of steps saved earlier loads as a sequence of step blocks without changing them", () => {
		const legacy = [{
			id: "w",
			name: "Linear",
			steps: [
				{ id: "s1", connectionId: "upload", route: { sourceId: "client", targetId: "api" }, title: "Upload", explanation: "Browser sends.", action: "send", durationMs: 900 },
				{ id: "s2", connectionId: "enqueue", route: { sourceId: "api", targetId: "queue" }, title: "Queue", explanation: "", action: "succeed" },
			],
		}];
		const loaded = normalizeWalkthroughs(legacy);
		expect(loaded[0]!.blocks.map((block) => block.kind)).toEqual(["step", "step"]);
		expect(walkthroughSteps(loaded[0]!)).toEqual([
			{ id: "s1", connectionId: "upload", route: { sourceId: "client", targetId: "api" }, title: "Upload", explanation: "Browser sends.", action: "send", durationMs: 900 },
			{ id: "s2", connectionId: "enqueue", route: { sourceId: "api", targetId: "queue" }, title: "Queue", explanation: "", action: "succeed" },
		]);
		expect(normalizeWalkthroughs(JSON.parse(JSON.stringify(loaded)))).toEqual(loaded);
	});

	test("stored blocks are validated recursively", () => {
		const stored = parallelWalkthrough();
		expect(normalizeWalkthroughs(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
		const repeat = stored[0]!.blocks[1]!;
		expect(() => normalizeWalkthroughs([{ id: "w", name: "W", blocks: [{ ...repeat, count: 0 }] }]))
			.toThrow("A repeated block runs from 1 to 10 times.");
		expect(() => normalizeWalkthroughs([{ id: "w", name: "W", blocks: [{ kind: "parallel", id: "p", branches: [[]] }] }]))
			.toThrow("A parallel block must have from 2 to 6 branches.");
		expect(() => normalizeWalkthroughs([{ id: "w", name: "W", blocks: [{ kind: "loop", id: "x" }] }]))
			.toThrow("A saved Walkthrough block is malformed.");
	});

	test("removing or moving a block keeps the other blocks and their steps intact", () => {
		let walkthroughs = parallelWalkthrough();
		walkthroughs = moveWalkthroughBlock(walkthroughs, "w", "r", 0);
		expect(walkthroughs[0]!.blocks.map((block) => block.kind)).toEqual(["repeat", "parallel"]);
		expect(walkthroughSteps(walkthroughs[0]!).map((step) => step.id)).toEqual(["c", "a", "b"]);
		walkthroughs = removeWalkthroughBlock(walkthroughs, "w", "p");
		expect(walkthroughSteps(walkthroughs[0]!).map((step) => step.id)).toEqual(["c"]);
		expect(() => removeWalkthroughBlock(walkthroughs, "w", "p")).toThrow("That block could not be found.");
	});

	test("reference checks find dangling and redirected steps inside nested blocks", () => {
		const design = uploadSystem();
		const walkthroughs = parallelWalkthrough();
		const withoutEnqueue = removeSystemConnection(design, "enqueue");
		const impacts = walkthroughStepsOnConnections(walkthroughs, ["enqueue"]);
		expect(impacts.map((impact) => impact.stepId)).toEqual(["b"]);
		expect(walkthroughRepairCount(walkthroughs[0]!, withoutEnqueue)).toBe(1);
		expect(walkthroughStepStatus(walkthroughSteps(walkthroughs[0]!)[1]!, withoutEnqueue)).toEqual({ status: "dangling" });

		const redirected = updateSystemConnection(design, "upload", { targetId: "queue" });
		expect(walkthroughRepairCount(walkthroughs[0]!, redirected)).toBe(2);
		const repaired = repairWalkthroughStep(walkthroughs, "w", "c", "upload", redirected);
		expect(walkthroughStepStatus(walkthroughSteps(repaired[0]!)[2]!, redirected)).toEqual({ status: "ok" });
		expect(walkthroughSteps(repaired[0]!)[0]!.route).toEqual({ sourceId: "client", targetId: "api" });
	});
});
