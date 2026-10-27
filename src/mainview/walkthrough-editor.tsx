import { useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2, X } from "lucide-react";
import type { SaveState, WorkspaceState } from "../shared/design";
import type { SystemConnection, SystemDesign } from "../shared/system-design";
import {
	WALKTHROUGH_ACTIONS,
	WALKTHROUGH_DURATION_MAX_MS,
	WALKTHROUGH_DURATION_MIN_MS,
	WALKTHROUGH_EXAMPLE_MESSAGE_LIMIT,
	WALKTHROUGH_EXAMPLE_PAYLOAD_LIMIT,
	WALKTHROUGH_EXPLANATION_LIMIT,
	WALKTHROUGH_NAME_LIMIT,
	WALKTHROUGH_PARALLEL_BRANCH_LIMIT,
	WALKTHROUGH_REPEAT_COUNT_MAX,
	WALKTHROUGH_REPEAT_COUNT_MIN,
	WALKTHROUGH_TRAVEL_PERCENT_MAX,
	WALKTHROUGH_TRAVEL_PERCENT_MIN,
	WALKTHROUGH_OPERATION_LIMIT,
	WALKTHROUGH_TITLE_LIMIT,
	findSystemEndpoint,
	findWalkthrough,
	walkthroughRepairCount,
	walkthroughStepStatus,
	walkthroughSteps,
	type Walkthrough,
	type WalkthroughBlock,
	type WalkthroughContainerBlock,
	type WalkthroughSequenceRef,
	type WalkthroughStep,
	type WalkthroughStepChanges,
	type WalkthroughStepStatus,
} from "../shared/walkthrough";
import type { workspaceClient } from "./workspace-client";
import type { WalkthroughPlaybackControls } from "./use-walkthrough-playback";
import { WalkthroughTransport } from "./walkthrough-transport";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type Client = typeof workspaceClient;

/** The Walkthrough and step the designer has open. Selection is navigation, so it is not saved. */
export type WalkthroughSelection = { walkthroughId: string; stepId: string | null };

export type WalkthroughEditorProps = {
	walkthroughs: Walkthrough[];
	design: SystemDesign;
	save?: SaveState;
	client: Client;
	onApply: (action: () => Promise<WorkspaceState>) => void;
	selection: WalkthroughSelection | null;
	onSelect: (selection: WalkthroughSelection | null) => void;
	onClose: () => void;
	playback: WalkthroughPlaybackControls;
	followCamera: { enabled: boolean; onChange: (enabled: boolean) => void };
};

/**
 * Manual editor for the Project's named Walkthroughs. Each step plays one real
 * Connection of the System design. Every edit goes through the workspace so it
 * is saved and recorded in the Project history.
 */
export function WalkthroughEditor({
	walkthroughs,
	design,
	save,
	client,
	onApply,
	selection,
	onSelect,
	onClose,
	playback,
	followCamera,
}: WalkthroughEditorProps) {
	const walkthrough = selection ? findWalkthrough(walkthroughs, selection.walkthroughId) ?? null : null;
	const steps = walkthrough ? walkthroughSteps(walkthrough) : [];
	const step = walkthrough && selection?.stepId
		? steps.find((candidate) => candidate.id === selection.stepId) ?? null
		: null;
	const blockNames = walkthrough ? blockNameMap(walkthrough.blocks) : new Map<string, string>();
	const treeContext: TreeContext | null = walkthrough
		? {
			walkthroughId: walkthrough.id,
			design,
			selectedStepId: selection?.stepId ?? null,
			numbers: new Map(steps.map((item, index) => [item.id, index + 1])),
			names: blockNames,
			client,
			onApply,
			onSelect,
		}
		: null;

	function createWalkthrough() {
		const id = crypto.randomUUID();
		onSelect({ walkthroughId: id, stepId: null });
		onApply(() => client.createWalkthrough({ id }));
	}

	function moveWalkthrough(id: string, toIndex: number) {
		onApply(() => client.moveWalkthrough(id, toIndex));
	}

	function removeWalkthrough(id: string) {
		onSelect(null);
		onApply(() => client.removeWalkthrough(id));
	}

	return (
		<aside
			aria-label="Walkthroughs"
			className="flex h-full min-h-0 w-[340px] shrink-0 flex-col border-r border-rule-soft bg-paper-raised"
		>
			<div className="flex items-center justify-between gap-2 border-b border-rule-soft px-4 py-3">
				<span className="kicker">Walkthroughs</span>
				<div className="flex items-center gap-1">
					<Button type="button" size="xs" variant="outline" onClick={createWalkthrough}>
						<Plus className="size-3" />
						New
					</Button>
					<Button type="button" size="icon" variant="ghost" aria-label="Close walkthroughs" className="size-7" onClick={onClose}>
						<X className="size-3.5" />
					</Button>
				</div>
			</div>

			<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 text-[13px]">
				{walkthroughs.length === 0 && (
					<p className="text-ink-3">
						Save named explanations of how an interaction moves through the system. Each step plays one Connection.
					</p>
				)}

				{walkthroughs.length > 0 && (
					<ol aria-label="Saved walkthroughs" className="flex flex-col gap-1">
						{walkthroughs.map((item, index) => {
							const active = item.id === selection?.walkthroughId;
							const repairs = walkthroughRepairCount(item, design);
							return (
								<li
									key={item.id}
									className={cn("flex items-center gap-1 rounded-sm px-1.5 py-1", active && "bg-paper-tint")}
								>
									<button
										type="button"
										aria-pressed={active}
										onClick={() => onSelect({ walkthroughId: item.id, stepId: null })}
										className="min-w-0 flex-1 text-left"
									>
										<span className="block truncate font-medium text-ink">{item.name}</span>
										<span className="block text-[11.5px] text-ink-3">
											{countLabel(walkthroughSteps(item).length, "step")}
											{repairs > 0 ? ` · ${repairs} to repair` : ""}
										</span>
									</button>
									<Button
										type="button"
										size="icon-xs"
										variant="ghost"
										aria-label={`Move ${item.name} up`}
										disabled={index === 0}
										onClick={() => moveWalkthrough(item.id, index - 1)}
									>
										<ArrowUp />
									</Button>
									<Button
										type="button"
										size="icon-xs"
										variant="ghost"
										aria-label={`Move ${item.name} down`}
										disabled={index === walkthroughs.length - 1}
										onClick={() => moveWalkthrough(item.id, index + 1)}
									>
										<ArrowDown />
									</Button>
								</li>
							);
						})}
					</ol>
				)}

				{walkthrough && (
					<section aria-label="Selected walkthrough" className="flex flex-col gap-3 border-t border-rule-soft pt-4">
						<label className="flex flex-col gap-1">
							<span className="text-ink-3">Name</span>
							<WalkthroughNameInput
								key={`${walkthrough.id}:${walkthrough.name}`}
								walkthrough={walkthrough}
								onRename={(name) => onApply(() => client.renameWalkthrough(walkthrough.id, name))}
							/>
						</label>

						<div className="flex flex-col gap-1.5">
							<span className="text-ink-3">Steps</span>
							{walkthroughSteps(walkthrough).length === 0 && (
								<p className="text-ink-3">No steps yet. Add a step below, or add a parallel or repeated block first.</p>
							)}
							<BlockList blocks={walkthrough.blocks} label="Steps" context={treeContext!} />
						</div>

						<WalkthroughTransport controls={playback} follow={followCamera} />

						<AddEntryControl
							walkthrough={walkthrough}
							names={blockNames}
							design={design}
							client={client}
							onApply={onApply}
							onSelect={onSelect}
						/>

						{step && (
							<StepEditor
								key={`${step.id}:${JSON.stringify(step)}`}
								walkthroughId={walkthrough.id}
								step={step}
								design={design}
								client={client}
								onApply={onApply}
								onRemove={() => {
									onSelect({ walkthroughId: walkthrough.id, stepId: null });
									onApply(() => client.removeWalkthroughStep(walkthrough.id, step.id));
								}}
							/>
						)}

						<Button
							type="button"
							variant="strike"
							size="sm"
							className="self-start"
							onClick={() => removeWalkthrough(walkthrough.id)}
						>
							<Trash2 className="size-3.5" />
							Remove walkthrough
						</Button>
					</section>
				)}
			</div>

			<SaveLine save={save} />
		</aside>
	);
}

function countLabel(count: number, noun: string, plural = `${noun}s`): string {
	return `${count} ${count === 1 ? noun : plural}`;
}

/** A Connection endpoint may be a Component or a Service. */
function endpointName(design: SystemDesign, endpointId: string): string {
	return findSystemEndpoint(design, endpointId)?.name ?? "Missing endpoint";
}

function connectionRoute(design: SystemDesign, sourceId: string, targetId: string): string {
	return `${endpointName(design, sourceId)} → ${endpointName(design, targetId)}`;
}

function connectionOptionLabel(design: SystemDesign, connection: SystemConnection): string {
	return `${connection.label}: ${connectionRoute(design, connection.sourceId, connection.targetId)}`;
}

function statusText(status: WalkthroughStepStatus, step: WalkthroughStep, design: SystemDesign): string {
	if (status.status === "dangling") return "Connection removed";
	if (status.status === "redirected") return "Route changed";
	return connectionRoute(design, step.route.sourceId, step.route.targetId);
}

function WalkthroughNameInput({
	walkthrough,
	onRename,
}: {
	walkthrough: Walkthrough;
	onRename: (name: string) => void;
}) {
	const [name, setName] = useState(walkthrough.name);
	function commit() {
		const trimmed = name.trim();
		if (trimmed.length === 0) {
			setName(walkthrough.name);
			return;
		}
		if (trimmed !== walkthrough.name) onRename(trimmed);
	}
	return (
		<Input
			value={name}
			maxLength={WALKTHROUGH_NAME_LIMIT}
			aria-label="Walkthrough name"
			onChange={(event) => setName(event.target.value)}
			onBlur={commit}
			onKeyDown={(event) => {
				if (event.key === "Enter") (event.target as HTMLInputElement).blur();
			}}
		/>
	);
}

/** Everything the block tree needs to show a Walkthrough and to act on it. */
type TreeContext = {
	walkthroughId: string;
	design: SystemDesign;
	selectedStepId: string | null;
	/** Authored ordinal of each step, from 1. */
	numbers: ReadonlyMap<string, number>;
	/** Display name of each parallel or repeated block. */
	names: ReadonlyMap<string, string>;
	client: Client;
	onApply: (action: () => Promise<WorkspaceState>) => void;
	onSelect: (selection: WalkthroughSelection | null) => void;
};

function BlockList({ blocks, label, context }: { blocks: WalkthroughBlock[]; label: string; context: TreeContext }) {
	return (
		<ol aria-label={label} className="flex flex-col gap-1">
			{blocks.map((block, position) => {
				const last = position === blocks.length - 1;
				if (block.kind === "step") {
					const id = block.step.id;
					return (
						<StepRow
							key={id}
							number={context.numbers.get(id) ?? position + 1}
							position={position}
							step={block.step}
							status={walkthroughStepStatus(block.step, context.design)}
							design={context.design}
							active={id === context.selectedStepId}
							last={last}
							onSelect={() => context.onSelect({ walkthroughId: context.walkthroughId, stepId: id })}
							onMove={(toIndex) => context.onApply(() => context.client.moveWalkthroughStep(context.walkthroughId, id, toIndex))}
						/>
					);
				}
				return (
					<ContainerRow
						key={block.id}
						block={block}
						name={context.names.get(block.id) ?? block.id}
						position={position}
						last={last}
						context={context}
					/>
				);
			})}
		</ol>
	);
}

function ContainerRow({
	block,
	name,
	position,
	last,
	context,
}: {
	block: WalkthroughContainerBlock;
	name: string;
	position: number;
	last: boolean;
	context: TreeContext;
}) {
	const { client, onApply, walkthroughId } = context;
	return (
		<li aria-label={name} className="flex flex-col gap-2 rounded-md border border-rule-soft bg-paper p-2">
			<div className="flex items-center gap-1">
				<span className="min-w-0 flex-1 truncate">
					<span className="font-medium text-ink">{name}</span>
					<span className="text-[11.5px] text-ink-3">
						{block.kind === "parallel"
							? ` · ${countLabel(block.branches.length, "branch", "branches")} run together`
							: " · runs its steps in order"}
					</span>
				</span>
				<Button
					type="button"
					size="icon-xs"
					variant="ghost"
					aria-label={`Move ${name} up`}
					disabled={position === 0}
					onClick={() => onApply(() => client.moveWalkthroughBlock(walkthroughId, block.id, position - 1))}
				>
					<ArrowUp />
				</Button>
				<Button
					type="button"
					size="icon-xs"
					variant="ghost"
					aria-label={`Move ${name} down`}
					disabled={last}
					onClick={() => onApply(() => client.moveWalkthroughBlock(walkthroughId, block.id, position + 1))}
				>
					<ArrowDown />
				</Button>
				<Button
					type="button"
					size="icon-xs"
					variant="ghost"
					aria-label={`Remove ${name}`}
					onClick={() => {
						if (context.selectedStepId && containsStep(block, context.selectedStepId)) {
							context.onSelect({ walkthroughId, stepId: null });
						}
						onApply(() => client.removeWalkthroughBlock(walkthroughId, block.id));
					}}
				>
					<Trash2 />
				</Button>
			</div>

			{block.kind === "repeat" ? (
				<>
					<RepeatCountInput
						key={block.count}
						name={name}
						count={block.count}
						onCommit={(count) => onApply(() => client.updateWalkthroughRepeat(walkthroughId, block.id, count))}
					/>
					{block.body.length === 0 ? (
						<p className="text-[11.5px] italic text-ink-3">Empty body. Add steps here with “Add to”.</p>
					) : (
						<BlockList blocks={block.body} label={`${name} steps`} context={context} />
					)}
				</>
			) : (
				<div className="flex flex-col gap-2">
					{block.branches.map((branch, branchIndex) => (
						<section
							key={branchIndex}
							aria-label={`${name} branch ${branchIndex + 1}`}
							className="flex flex-col gap-1 border-l-2 border-rule-soft pl-2"
						>
							<span className="text-[11.5px] text-ink-3">Branch {branchIndex + 1}</span>
							{branch.length === 0 ? (
								<p className="text-[11.5px] italic text-ink-3">Empty branch. Add steps here with “Add to”.</p>
							) : (
								<BlockList blocks={branch} label={`${name} branch ${branchIndex + 1} steps`} context={context} />
							)}
						</section>
					))}
					{block.branches.length < WALKTHROUGH_PARALLEL_BRANCH_LIMIT && (
						<Button
							type="button"
							size="xs"
							variant="outline"
							className="self-start"
							onClick={() => onApply(() => client.addWalkthroughParallelBranch(walkthroughId, block.id))}
						>
							<Plus className="size-3" />
							Add branch
						</Button>
					)}
				</div>
			)}
		</li>
	);
}

function RepeatCountInput({ name, count, onCommit }: { name: string; count: number; onCommit: (count: number) => void }) {
	const [draft, setDraft] = useState(String(count));
	function commit() {
		const value = Number(draft.trim());
		if (!Number.isInteger(value) || value < WALKTHROUGH_REPEAT_COUNT_MIN || value > WALKTHROUGH_REPEAT_COUNT_MAX) {
			setDraft(String(count));
			return;
		}
		if (value !== count) onCommit(value);
	}
	return (
		<label className="flex items-center gap-2 text-[12.5px] text-ink-2">
			<span>Runs</span>
			<Input
				type="number"
				inputMode="numeric"
				min={WALKTHROUGH_REPEAT_COUNT_MIN}
				max={WALKTHROUGH_REPEAT_COUNT_MAX}
				value={draft}
				aria-label={`${name} count`}
				className="h-8 w-20"
				onChange={(event) => setDraft(event.target.value)}
				onBlur={commit}
			/>
			<span>times, in order</span>
		</label>
	);
}

function StepRow({
	number,
	position,
	step,
	status,
	design,
	active,
	last,
	onSelect,
	onMove,
}: {
	number: number;
	position: number;
	step: WalkthroughStep;
	status: WalkthroughStepStatus;
	design: SystemDesign;
	active: boolean;
	last: boolean;
	onSelect: () => void;
	onMove: (toIndex: number) => void;
}) {
	return (
		<li className={cn("flex items-center gap-1 rounded-sm px-1.5 py-1", active && "bg-paper-tint")}>
			<button
				type="button"
				aria-pressed={active}
				onClick={onSelect}
				className="flex min-w-0 flex-1 items-baseline gap-2 text-left"
			>
				<span className="tabular-nums text-ink-3">{number}.</span>
				<span className="min-w-0 flex-1">
					<span className={cn("block truncate", step.title ? "text-ink" : "italic text-ink-3")}>
						{step.title || "Untitled step"}
					</span>
					<span
						className={cn(
							"block truncate text-[11.5px]",
							status.status === "ok" ? "text-ink-3" : "text-proof-red",
						)}
					>
						{statusText(status, step, design)}
					</span>
				</span>
			</button>
			<Button
				type="button"
				size="icon-xs"
				variant="ghost"
				aria-label={`Move step ${number} up`}
				disabled={position === 0}
				onClick={() => onMove(position - 1)}
			>
				<ArrowUp />
			</Button>
			<Button
				type="button"
				size="icon-xs"
				variant="ghost"
				aria-label={`Move step ${number} down`}
				disabled={last}
				onClick={() => onMove(position + 1)}
			>
				<ArrowDown />
			</Button>
		</li>
	);
}

/** Where a new step or block goes: the top level, a parallel branch, or a repeated body. */
type SequenceTarget = { value: string; label: string; ref: WalkthroughSequenceRef };
const TOP_LEVEL_TARGET = "top";

function sequenceTargets(blocks: WalkthroughBlock[], names: ReadonlyMap<string, string>): SequenceTarget[] {
	const targets: SequenceTarget[] = [{ value: TOP_LEVEL_TARGET, label: "Top level", ref: { blockId: null } }];
	const visit = (items: WalkthroughBlock[]) => {
		for (const block of items) {
			if (block.kind === "step") continue;
			const name = names.get(block.id) ?? block.id;
			if (block.kind === "parallel") {
				block.branches.forEach((branch, index) => {
					const ref = { blockId: block.id, branch: index };
					targets.push({ value: JSON.stringify(ref), label: `${name}, branch ${index + 1}`, ref });
					visit(branch);
				});
			} else {
				const ref = { blockId: block.id };
				targets.push({ value: JSON.stringify(ref), label: `${name} body`, ref });
				visit(block.body);
			}
		}
	};
	visit(blocks);
	return targets;
}

/** Names parallel and repeated blocks in authoring order, counting each kind separately. */
function blockNameMap(blocks: WalkthroughBlock[]): Map<string, string> {
	const names = new Map<string, string>();
	let parallel = 0;
	let repeat = 0;
	const visit = (items: WalkthroughBlock[]) => {
		for (const block of items) {
			if (block.kind === "step") continue;
			if (block.kind === "parallel") {
				parallel += 1;
				names.set(block.id, `Parallel ${parallel}`);
				block.branches.forEach(visit);
			} else {
				repeat += 1;
				names.set(block.id, `Repeat ${repeat}`);
				visit(block.body);
			}
		}
	};
	visit(blocks);
	return names;
}

function containsStep(block: WalkthroughBlock, stepId: string): boolean {
	if (block.kind === "step") return block.step.id === stepId;
	const sequences = block.kind === "parallel" ? block.branches : [block.body];
	return sequences.some((sequence) => sequence.some((child) => containsStep(child, stepId)));
}

function AddEntryControl({
	walkthrough,
	names,
	design,
	client,
	onApply,
	onSelect,
}: {
	walkthrough: Walkthrough;
	names: ReadonlyMap<string, string>;
	design: SystemDesign;
	client: Client;
	onApply: (action: () => Promise<WorkspaceState>) => void;
	onSelect: (selection: WalkthroughSelection | null) => void;
}) {
	const [chosenTarget, setChosenTarget] = useState<string>(TOP_LEVEL_TARGET);
	const [chosenConnection, setChosenConnection] = useState<string | null>(null);
	const targets = sequenceTargets(walkthrough.blocks, names);
	const target = targets.find((candidate) => candidate.value === chosenTarget) ?? targets[0]!;
	const connections = design.connections;
	const connectionId = connections.some((connection) => connection.id === chosenConnection)
		? chosenConnection!
		: connections[0]?.id;
	return (
		<div className="flex flex-col gap-1.5">
			<label className="flex flex-col gap-1">
				<span className="text-ink-3">Add to</span>
				<select
					aria-label="Add to"
					value={target.value}
					onChange={(event) => setChosenTarget(event.target.value)}
					className="h-8 rounded-md border border-input bg-paper-raised px-2 text-[12.5px]"
				>
					{targets.map((item) => (
						<option key={item.value} value={item.value}>{item.label}</option>
					))}
				</select>
			</label>
			{connections.length === 0 ? (
				<p className="text-ink-3">Connect components in the System design to add steps.</p>
			) : (
				<div className="flex items-center gap-1.5">
					<select
						aria-label="Connection for new step"
						value={connectionId}
						onChange={(event) => setChosenConnection(event.target.value)}
						className="h-8 min-w-0 flex-1 rounded-md border border-input bg-paper-raised px-2 text-[12.5px]"
					>
						{connections.map((connection) => (
							<option key={connection.id} value={connection.id}>
								{connectionOptionLabel(design, connection)}
							</option>
						))}
					</select>
					<Button
						type="button"
						size="sm"
						variant="outline"
						onClick={() => {
							const id = crypto.randomUUID();
							onSelect({ walkthroughId: walkthrough.id, stepId: id });
							onApply(() => client.addWalkthroughStep({ id, walkthroughId: walkthrough.id, connectionId: connectionId!, sequence: target.ref }));
						}}
					>
						<Plus className="size-3.5" />
						Add step
					</Button>
				</div>
			)}
			<div className="flex flex-wrap gap-1.5">
				<Button
					type="button"
					size="sm"
					variant="outline"
					onClick={() => onApply(() => client.addWalkthroughBlock(walkthrough.id, "parallel", crypto.randomUUID(), target.ref))}
				>
					<Plus className="size-3.5" />
					Parallel block
				</Button>
				<Button
					type="button"
					size="sm"
					variant="outline"
					onClick={() => onApply(() => client.addWalkthroughBlock(walkthrough.id, "repeat", crypto.randomUUID(), target.ref))}
				>
					<Plus className="size-3.5" />
					Repeated block
				</Button>
			</div>
		</div>
	);
}

function StepEditor({
	walkthroughId,
	step,
	design,
	client,
	onApply,
	onRemove,
}: {
	walkthroughId: string;
	step: WalkthroughStep;
	design: SystemDesign;
	client: Client;
	onApply: (action: () => Promise<WorkspaceState>) => void;
	onRemove: () => void;
}) {
	const status = walkthroughStepStatus(step, design);
	const [title, setTitle] = useState(step.title);
	const [explanation, setExplanation] = useState(step.explanation);
	const [operation, setOperation] = useState(step.operation ?? "");
	const [duration, setDuration] = useState(step.durationMs === undefined ? "" : String(step.durationMs));
	const [travelPercent, setTravelPercent] = useState(step.travelPercent === undefined ? "" : String(step.travelPercent));
	const [exampleMessage, setExampleMessage] = useState(step.exampleMessage ?? "");
	const [examplePayload, setExamplePayload] = useState(step.examplePayload ?? "");

	function commit(changes: WalkthroughStepChanges) {
		onApply(() => client.updateWalkthroughStep(walkthroughId, step.id, changes));
	}
	function commitRepair(connectionId: string) {
		if (!connectionId) return;
		onApply(() => client.repairWalkthroughStep(walkthroughId, step.id, connectionId));
	}
	/** Accepts the endpoints the Connection now joins. Choosing a different Connection repairs the step instead. */
	function commitAcceptRedirection() {
		onApply(() => client.acceptWalkthroughStepRedirection(walkthroughId, step.id));
	}
	function commitText(
		key: "title" | "explanation" | "operation" | "exampleMessage" | "examplePayload",
		draft: string,
	) {
		const trimmed = draft.trim();
		const current = step[key] ?? "";
		if (trimmed === current) return;
		commit({ [key]: trimmed });
	}
	function commitDuration() {
		const trimmed = duration.trim();
		if (trimmed.length === 0) {
			if (step.durationMs !== undefined) commit({ durationMs: null });
			return;
		}
		const value = Number(trimmed);
		if (!Number.isInteger(value)) {
			setDuration(step.durationMs === undefined ? "" : String(step.durationMs));
			return;
		}
		if (value !== step.durationMs) commit({ durationMs: value });
	}
	function commitTravelPercent() {
		const trimmed = travelPercent.trim();
		if (trimmed.length === 0) {
			if (step.travelPercent !== undefined) commit({ travelPercent: null });
			return;
		}
		const value = Number(trimmed);
		if (!Number.isInteger(value)) {
			setTravelPercent(step.travelPercent === undefined ? "" : String(step.travelPercent));
			return;
		}
		if (value !== step.travelPercent) commit({ travelPercent: value });
	}

	return (
		<div className="flex flex-col gap-3 rounded-md border border-rule-soft p-3" aria-label="Selected step">
			{status.status === "dangling" && (
				<p role="alert" className="rounded-sm bg-proof-red-wash px-2.5 py-2 text-[12.5px] text-proof-red">
					The Connection this step played was removed. The step keeps its text. Choose a Connection to repair it.
				</p>
			)}
			{status.status === "redirected" && (
				<div className="flex flex-col gap-2 rounded-sm bg-paper-tint px-2.5 py-2 text-[12.5px] text-ink-2">
					<p>
						This Connection now runs {connectionRoute(design, status.sourceId, status.targetId)}, not the route this step was written for.
					</p>
					<Button
						type="button"
						size="sm"
						variant="outline"
						className="self-start"
						onClick={commitAcceptRedirection}
					>
						Accept current route
					</Button>
				</div>
			)}

			<label className="flex flex-col gap-1">
				<span className="text-ink-3">Connection</span>
				<select
					aria-label="Step connection"
					value={status.status === "dangling" ? "" : step.connectionId}
					onChange={(event) => commitRepair(event.target.value)}
					className="h-8 rounded-md border border-input bg-paper-raised px-2 text-[12.5px]"
				>
					{status.status === "dangling" && <option value="" disabled>Choose a Connection</option>}
					{design.connections.map((connection) => (
						<option key={connection.id} value={connection.id}>
							{connectionOptionLabel(design, connection)}
						</option>
					))}
				</select>
			</label>

			<label className="flex flex-col gap-1">
				<span className="text-ink-3">Title</span>
				<Input
					value={title}
					maxLength={WALKTHROUGH_TITLE_LIMIT}
					aria-label="Step title"
					placeholder="What happens in this step"
					onChange={(event) => setTitle(event.target.value)}
					onBlur={() => commitText("title", title)}
					onKeyDown={(event) => {
						if (event.key === "Enter") (event.target as HTMLInputElement).blur();
					}}
				/>
			</label>

			<label className="flex flex-col gap-1">
				<span className="text-ink-3">Explanation</span>
				<Textarea
					value={explanation}
					maxLength={WALKTHROUGH_EXPLANATION_LIMIT}
					rows={4}
					aria-label="Step explanation"
					onChange={(event) => setExplanation(event.target.value)}
					onBlur={() => commitText("explanation", explanation)}
				/>
			</label>

			<div className="grid grid-cols-2 gap-2">
				<label className="flex flex-col gap-1">
					<span className="text-ink-3">Action</span>
					<select
						aria-label="Step action"
						value={step.action}
						onChange={(event) => commit({ action: event.target.value as WalkthroughStep["action"] })}
						className="h-8 rounded-md border border-input bg-paper-raised px-2 text-[12.5px]"
					>
						{WALKTHROUGH_ACTIONS.map((action) => (
							<option key={action} value={action}>{action}</option>
						))}
					</select>
				</label>
				<label className="flex flex-col gap-1">
					<span className="text-ink-3">Duration (ms)</span>
					<Input
						type="number"
						inputMode="numeric"
						min={WALKTHROUGH_DURATION_MIN_MS}
						max={WALKTHROUGH_DURATION_MAX_MS}
						value={duration}
						aria-label="Step duration in milliseconds"
						placeholder="Optional"
						onChange={(event) => setDuration(event.target.value)}
						onBlur={commitDuration}
					/>
				</label>
			</div>

			<label className="flex flex-col gap-1">
				<span className="text-ink-3">Travel share (%)</span>
				<Input
					type="number"
					inputMode="numeric"
					min={WALKTHROUGH_TRAVEL_PERCENT_MIN}
					max={WALKTHROUGH_TRAVEL_PERCENT_MAX}
					value={travelPercent}
					aria-label="Step travel share in percent"
					placeholder="Default 60"
					onChange={(event) => setTravelPercent(event.target.value)}
					onBlur={commitTravelPercent}
				/>
				<span className="text-[11.5px] text-ink-3">The part of the duration spent travelling before the message arrives.</span>
			</label>

			<label className="flex flex-col gap-1">
				<span className="text-ink-3">Operation</span>
				<Input
					value={operation}
					maxLength={WALKTHROUGH_OPERATION_LIMIT}
					aria-label="Step operation"
					placeholder="Optional, e.g. cache hit"
					onChange={(event) => setOperation(event.target.value)}
					onBlur={() => commitText("operation", operation)}
				/>
			</label>

			<label className="flex flex-col gap-1">
				<span className="text-ink-3">Example message</span>
				<Input
					value={exampleMessage}
					maxLength={WALKTHROUGH_EXAMPLE_MESSAGE_LIMIT}
					aria-label="Example message"
					placeholder="Optional"
					onChange={(event) => setExampleMessage(event.target.value)}
					onBlur={() => commitText("exampleMessage", exampleMessage)}
				/>
			</label>

			<label className="flex flex-col gap-1">
				<span className="text-ink-3">Example payload</span>
				<Textarea
					value={examplePayload}
					maxLength={WALKTHROUGH_EXAMPLE_PAYLOAD_LIMIT}
					rows={3}
					aria-label="Example payload"
					className="font-mono text-[12px]"
					onChange={(event) => setExamplePayload(event.target.value)}
					onBlur={() => commitText("examplePayload", examplePayload)}
				/>
			</label>

			<Button type="button" variant="strike" size="sm" className="self-start" onClick={onRemove}>
				<Trash2 className="size-3.5" />
				Remove step
			</Button>
		</div>
	);

}

function SaveLine({ save }: { save?: SaveState }) {
	if (!save) return null;
	if (save.status === "failed") {
		return (
			<p role="alert" className="border-t border-rule-soft px-4 py-2 text-[12px] text-proof-red">
				Save failed: {save.error}
			</p>
		);
	}
	const text = save.status === "saving" ? "Saving…" : save.status === "saved" ? "Saved" : "";
	return text ? <p className="border-t border-rule-soft px-4 py-2 text-[11.5px] text-ink-3" aria-live="polite">{text}</p> : null;
}
