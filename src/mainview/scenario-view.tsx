import { useEffect, useState, type FormEvent } from "react";
import { FileCode2, Plus, Trash2 } from "lucide-react";
import type { Scenario, ScenarioSaveState } from "../shared/design";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type Props = {
	scenarios: Scenario[];
	save: ScenarioSaveState;
	onCreate: (name: string) => void;
	onRename: (scenarioId: string, name: string) => void;
	onRemove: (scenarioId: string) => void;
	onUpdateSource: (scenarioId: string, source: string) => void;
};

/** Manage saved TypeScript Scenarios; execution is intentionally not part of this view. */
export function ScenarioView({
	scenarios,
	save,
	onCreate,
	onRename,
	onRemove,
	onUpdateSource,
}: Props) {
	const [selectedId, setSelectedId] = useState<string | null>(scenarios[0]?.id ?? null);
	const [newName, setNewName] = useState("");
	const [nameDraft, setNameDraft] = useState("");
	const [sourceDraft, setSourceDraft] = useState(scenarios[0]?.source ?? "");
	const selected = scenarios.find((scenario) => scenario.id === selectedId) ?? null;

	useEffect(() => {
		if (!selected || !scenarios.some((scenario) => scenario.id === selectedId)) {
			setSelectedId(scenarios[0]?.id ?? null);
		}
	}, [scenarios, selected, selectedId]);

	useEffect(() => {
		setNameDraft(selected?.name ?? "");
	}, [selected?.id, selected?.name]);
	useEffect(() => {
		setSourceDraft(selected?.source ?? "");
	}, [selected?.id]);

	function createScenario(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const name = newName.trim();
		if (!name) return;
		onCreate(name);
		setNewName("");
	}

	function saveName() {
		const name = nameDraft.trim();
		if (selected && name && name !== selected.name) onRename(selected.id, name);
		else setNameDraft(selected?.name ?? "");
	}

	return (
		<div data-testid="scenario-view" className="h-full overflow-y-auto bg-paper">
			<div className="mx-auto max-w-6xl px-5 pb-10 sm:px-8">
				<header className="flex flex-wrap items-end justify-between gap-6 pt-8">
					<div>
						<h2 className="font-display text-[28px] leading-none font-medium tracking-[-0.02em]">
							Scenarios
						</h2>
						<p className="mt-2 max-w-xl font-display text-[17px] leading-snug text-ink-2 italic">
							Saved TypeScript source, kept separate from the design history.
						</p>
					</div>
					<form onSubmit={createScenario} className="flex items-center gap-2">
						<Input
							aria-label="New Scenario name"
							placeholder="Scenario name"
							value={newName}
							onChange={(event) => setNewName(event.target.value)}
							className="h-8 w-52"
						/>
						<Button type="submit" disabled={!newName.trim()}>
							<Plus />
							New Scenario
						</Button>
					</form>
				</header>

				<div className="mt-8 grid min-h-[min(68vh,720px)] grid-cols-1 border-y border-rule-strong sm:grid-cols-[220px_minmax(0,1fr)]">
					<aside className="border-b border-rule bg-paper-tint/50 sm:border-r sm:border-b-0">
						<div className="flex items-center justify-between border-b border-rule px-4 py-3">
							<h3 className="kicker">Saved Scenarios</h3>
							<span className="figures font-mono text-[10px] text-ink-4">
								{scenarios.length}
							</span>
						</div>
						{scenarios.length ? (
							<ul className="divide-y divide-rule">
								{scenarios.map((scenario) => (
									<li key={scenario.id}>
										<button
											type="button"
											aria-current={scenario.id === selected?.id ? "true" : undefined}
											onClick={() => setSelectedId(scenario.id)}
											className="flex w-full items-center gap-2 px-4 py-3 text-left outline-none transition-colors hover:bg-paper-tint focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-pencil/40 aria-[current=true]:bg-paper-raised"
										>
											<FileCode2 className="size-4 shrink-0 text-ink-3" />
											<span className="truncate font-display text-[15px]">{scenario.name}</span>
										</button>
									</li>
								))}
							</ul>
						) : (
							<p className="px-4 py-5 text-[12.5px] leading-relaxed text-ink-3">
								No Scenarios saved yet. Create one to start editing its source.
							</p>
						)}
					</aside>

					{selected ? (
						<section aria-label={`Edit ${selected.name}`} className="flex min-w-0 flex-col">
							<div className="flex flex-wrap items-center gap-3 border-b border-rule px-5 py-3">
								<label className="min-w-48 flex-1">
									<span className="sr-only">Scenario name</span>
									<Input
										aria-label="Scenario name"
										value={nameDraft}
										onChange={(event) => setNameDraft(event.target.value)}
										onBlur={saveName}
										onKeyDown={(event) => {
											if (event.key === "Enter") event.currentTarget.blur();
											if (event.key === "Escape") setNameDraft(selected.name);
										}}
										className="h-8 border-transparent bg-transparent px-1 font-display text-[20px] font-medium focus-visible:border-pencil focus-visible:bg-paper-raised"
									/>
								</label>
								<SaveIndicator save={save} />
								<Button
									variant="strike"
									size="sm"
									aria-label={`Remove Scenario ${selected.name}`}
									onClick={() => onRemove(selected.id)}
								>
									<Trash2 />
									Remove
								</Button>
							</div>
							<div className="flex items-center justify-between border-b border-rule px-5 py-2">
								<label htmlFor="scenario-source" className="kicker">TypeScript source</label>
								<span className="text-[11px] text-ink-4">Saved independently of design undo and redo</span>
							</div>
							<Textarea
								id="scenario-source"
								aria-label="Scenario TypeScript source"
								value={sourceDraft}
								onChange={(event) => {
									const source = event.target.value;
									setSourceDraft(source);
									onUpdateSource(selected.id, source);
								}}
								spellCheck={false}
								className="min-h-[min(60vh,640px)] flex-1 resize-y rounded-none border-0 bg-paper-raised px-5 py-4 font-mono text-[12.5px] leading-6 focus-visible:ring-0"
							/>
						</section>
					) : (
						<div className="flex min-w-0 flex-col items-center justify-center px-8 text-center">
							<FileCode2 className="size-6 text-ink-4" />
							<p className="mt-3 font-display text-[18px] italic text-ink-3">Your next Scenario starts here.</p>
							<p className="mt-1 max-w-sm text-[12.5px] text-ink-3">Create a named Scenario to edit its saved TypeScript source.</p>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

function SaveIndicator({ save }: { save: ScenarioSaveState }) {
	if (save.status === "failed") {
		return <p role="alert" data-testid="scenario-save-status" className="max-w-64 text-right text-[12px] text-proof-red">Could not save Scenario: {save.error}</p>;
	}
	if (save.status === "saving") {
		return <p role="status" data-testid="scenario-save-status" className="text-[12px] text-ink-3">Saving…</p>;
	}
	if (save.status === "saved") {
		return <p role="status" data-testid="scenario-save-status" className="text-[12px] text-press-green">Saved</p>;
	}
	return <p role="status" data-testid="scenario-save-status" className="text-[12px] text-ink-4">Not saved yet</p>;
}
