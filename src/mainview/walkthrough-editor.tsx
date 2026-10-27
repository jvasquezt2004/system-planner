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
	WALKTHROUGH_OPERATION_LIMIT,
	WALKTHROUGH_TITLE_LIMIT,
	findSystemEndpoint,
	findWalkthrough,
	walkthroughRepairCount,
	walkthroughStepStatus,
	type Walkthrough,
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
}: WalkthroughEditorProps) {
	const walkthrough = selection ? findWalkthrough(walkthroughs, selection.walkthroughId) ?? null : null;
	const step = walkthrough && selection?.stepId
		? walkthrough.steps.find((candidate) => candidate.id === selection.stepId) ?? null
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
											{countLabel(item.steps.length, "step")}
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
							{walkthrough.steps.length === 0 && (
								<p className="text-ink-3">No steps yet. Choose a Connection below to add the first one.</p>
							)}
							<ol aria-label="Steps" className="flex flex-col gap-1">
								{walkthrough.steps.map((item, index) => (
									<StepRow
										key={item.id}
										index={index}
										step={item}
										status={walkthroughStepStatus(item, design)}
										design={design}
										active={item.id === selection?.stepId}
										onSelect={() => onSelect({ walkthroughId: walkthrough.id, stepId: item.id })}
										onMove={(toIndex) => onApply(() => client.moveWalkthroughStep(walkthrough.id, item.id, toIndex))}
										last={index === walkthrough.steps.length - 1}
									/>
								))}
							</ol>
						</div>

						<WalkthroughTransport controls={playback} />

						<AddStepControl
							walkthroughId={walkthrough.id}
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

function countLabel(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
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

function StepRow({
	index,
	step,
	status,
	design,
	active,
	last,
	onSelect,
	onMove,
}: {
	index: number;
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
				<span className="tabular-nums text-ink-3">{index + 1}.</span>
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
				aria-label={`Move step ${index + 1} up`}
				disabled={index === 0}
				onClick={() => onMove(index - 1)}
			>
				<ArrowUp />
			</Button>
			<Button
				type="button"
				size="icon-xs"
				variant="ghost"
				aria-label={`Move step ${index + 1} down`}
				disabled={last}
				onClick={() => onMove(index + 1)}
			>
				<ArrowDown />
			</Button>
		</li>
	);
}

function AddStepControl({
	walkthroughId,
	design,
	client,
	onApply,
	onSelect,
}: {
	walkthroughId: string;
	design: SystemDesign;
	client: Client;
	onApply: (action: () => Promise<WorkspaceState>) => void;
	onSelect: (selection: WalkthroughSelection | null) => void;
}) {
	const [chosen, setChosen] = useState<string | null>(null);
	const connections = design.connections;
	if (connections.length === 0) {
		return <p className="text-ink-3">Connect components in the System design to add steps.</p>;
	}
	const connectionId = connections.some((connection) => connection.id === chosen) ? chosen! : connections[0]!.id;
	return (
		<div className="flex flex-col gap-1.5">
			<span className="text-ink-3">Add a step</span>
			<div className="flex items-center gap-1.5">
				<select
					aria-label="Connection for new step"
					value={connectionId}
					onChange={(event) => setChosen(event.target.value)}
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
						onSelect({ walkthroughId, stepId: id });
						onApply(() => client.addWalkthroughStep({ id, walkthroughId, connectionId }));
					}}
				>
					<Plus className="size-3.5" />
					Add
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
