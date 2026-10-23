/// <reference types="vite/client" />
import { useEffect, useRef, useState, type FormEvent } from "react";
import Editor, { type Monaco, type OnMount } from "@monaco-editor/react";
import "./monaco-setup";
import { FileCode2, Plus, Trash2 } from "lucide-react";
import type { DesignEnumType, DesignFunction, SandboxAppliedTable, Scenario, ScenarioRun, ScenarioSaveState } from "../shared/design";
import { generateScenarioDatabaseTypes, scenarioSupabaseTypePaths, scenarioTypeLibraryUri } from "../shared/scenario-types";
import type { RunAllResult } from "../shared/run-all";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
const supabaseTypeDeclarations = import.meta.glob(
	"../../node_modules/@supabase/{supabase-js,postgrest-js,auth-js,functions-js,realtime-js,storage-js}/dist/**/*.d.{ts,mts,cts}",
	{ eager: true, query: "?raw", import: "default" },
) as Record<string, string>;
const otherSupabaseTypeDeclarations = import.meta.glob(
	"../../node_modules/{iceberg-js}/dist/**/*.d.{ts,mts,cts}",
	{ eager: true, query: "?raw", import: "default" },
) as Record<string, string>;
const phoenixTypeDeclarations = import.meta.glob(
	"../../node_modules/@supabase/phoenix/priv/static/types/**/*.d.ts",
	{ eager: true, query: "?raw", import: "default" },
) as Record<string, string>;
const allSupabaseTypeDeclarations = {
	...supabaseTypeDeclarations,
	...otherSupabaseTypeDeclarations,
	...phoenixTypeDeclarations,
};

type Props = {
	scenarios: Scenario[];
	appliedTables: SandboxAppliedTable[];
	appliedEnums: DesignEnumType[];
	appliedFunctions: DesignFunction[];
	save: ScenarioSaveState;
	scenarioRuns: Record<string, ScenarioRun | null>;
	revision: number;
	runDisabledReason: string | null;
	runAllActive: boolean;
	runAllResults: RunAllResult[];
	activeRunId: string | null;
	onRunAll: () => void;
	onCreate: (name: string) => void;
	onRename: (scenarioId: string, name: string) => void;
	onRemove: (scenarioId: string) => void;
	onUpdateSource: (scenarioId: string, source: string) => void;
	onRun: (scenario: Scenario) => void;
	onStop: (runId: string) => void;
};
/** Manage saved Scenarios and show the latest run's observable results. */
export function ScenarioView({
	scenarios,
	appliedTables,
	appliedEnums,
	appliedFunctions,
	save,
	scenarioRuns,
	revision,
	runDisabledReason,
	runAllActive,
	runAllResults,
	activeRunId,
	onRunAll,
	onCreate,
	onRename,
	onRemove,
	onUpdateSource,
	onRun,
	onStop,
}: Props) {
	const [selectedId, setSelectedId] = useState<string | null>(scenarios[0]?.id ?? null);
	const [newName, setNewName] = useState("");
	const [nameDraft, setNameDraft] = useState("");
	const [sourceDraft, setSourceDraft] = useState(scenarios[0]?.source ?? "");
	const selected = scenarios.find((scenario) => scenario.id === selectedId) ?? null;
	const selectedRun = selected ? scenarioRuns[selected.id] : null;
	const pendingSourceSave = useRef<{ scenarioId: string; source: string } | null>(null);
	const sourceSaveCallback = useRef(onUpdateSource);
	sourceSaveCallback.current = onUpdateSource;
	const monacoApi = useRef<Monaco | null>(null);
	const monacoEditor = useRef<Parameters<OnMount>[0] | null>(null);
	const runAllCounts = runAllResults.reduce(
		(counts, { run }) => {
			if (run.status !== "running") counts[run.status] += 1;
			return counts;
		},
		{ passed: 0, failed: 0, errored: 0 },
	);

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
	useEffect(() => {
		if (!selected || sourceDraft === selected.source) {
			if (pendingSourceSave.current?.scenarioId === selected?.id) {
				pendingSourceSave.current = null;
			}
			return;
		}
		const pending = { scenarioId: selected.id, source: sourceDraft };
		pendingSourceSave.current = pending;
		const timer = setTimeout(() => {
			if (pendingSourceSave.current === pending) pendingSourceSave.current = null;
			sourceSaveCallback.current(pending.scenarioId, pending.source);
		}, 300);
		return () => clearTimeout(timer);
	}, [selected?.id, selected?.source, sourceDraft]);
	useEffect(
		() => () => {
			const pending = pendingSourceSave.current;
			if (!pending) return;
			pendingSourceSave.current = null;
			sourceSaveCallback.current(pending.scenarioId, pending.source);
		},
		[selected?.id],
	);
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
					<div className="flex flex-wrap items-center justify-end gap-2">
						<Button
							type="button"
							aria-label="Run all Scenarios"
							aria-busy={runAllActive}
							disabled={
								Boolean(runDisabledReason) ||
								runAllActive ||
								scenarios.length === 0
							}
							title={
								runDisabledReason ??
								(scenarios.length === 0 ? "Create a Scenario before running all." : undefined)
							}
							onClick={onRunAll}
						>
							{runAllActive ? "Running all…" : "Run all"}
						</Button>
						{runAllActive && activeRunId && selectedRun?.id !== activeRunId && (
							<Button
								type="button"
								variant="strike"
								aria-label="Stop the active Scenario run"
								onClick={() => onStop(activeRunId)}
							>
								Stop
							</Button>
						)}
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
					</div>
				</header>
				{runDisabledReason && !selected && (
					<p role="status" className="mt-3 text-right text-[12px] text-ink-3">
						{runDisabledReason}
					</p>
				)}
				{runAllResults.length > 0 && (
					<section
						aria-labelledby="run-all-results-title"
						className="mt-6 border-y border-rule-strong bg-paper-tint/40"
					>
						<div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 px-4 py-3">
							<h3 id="run-all-results-title" className="font-display text-[17px] font-medium">
								Run all results
							</h3>
							<p role="status" aria-live="polite" aria-atomic="true" className="figures text-[12px] text-ink-2">
								{runAllCounts.passed} passed, {runAllCounts.failed} failed, {runAllCounts.errored} errored
							</p>
						</div>
						<ul aria-label="Run all Scenario outcomes" className="divide-y divide-rule">
							{runAllResults.map(({ scenario, run }) => {
								const isSaved = scenarios.some((item) => item.id === scenario.id);
								const outcome =
									run.reason === "stopped" ? "errored (stopped)" : run.status;
								return (
									<li
										key={run.id}
										className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5"
									>
										<span className="min-w-28 font-mono text-[11px] capitalize text-ink-2">
											{outcome}
										</span>
										<span className="min-w-40 flex-1 font-display text-[14px]">
											{scenario.name}
										</span>
										{isSaved ? (
											<button
												type="button"
												aria-label={`Open Scenario ${scenario.name}`}
												aria-pressed={selected?.id === scenario.id}
												onClick={() => setSelectedId(scenario.id)}
												className="rounded-sm text-[12px] font-medium text-ink underline decoration-ink-3 underline-offset-4 outline-none hover:text-pencil focus-visible:ring-2 focus-visible:ring-pencil/40"
											>
												Open {scenario.name}
											</button>
										) : (
											<span className="text-[12px] text-ink-3">Scenario removed</span>
										)}
									</li>
								);
							})}
						</ul>
					</section>
				)}

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
									size="sm"
									disabled={Boolean(runDisabledReason) || selectedRun?.status === "running"}
									title={runDisabledReason ?? undefined}
									onClick={() => onRun({ ...selected, source: sourceDraft })}
								>
									Run
								</Button>
								{selectedRun?.status === "running" && (
									<Button size="sm" variant="strike" onClick={() => onStop(selectedRun.id)}>
										Stop
									</Button>
								)}
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
<Editor
								key={generateScenarioDatabaseTypes(appliedTables, appliedEnums, appliedFunctions)}
								height="min(60vh, 640px)"
								language="typescript"
								value={sourceDraft}
								onChange={(source) => setSourceDraft(source ?? "")}
								onMount={(instance, monaco) => {
									monacoEditor.current = instance;
									monacoApi.current = monaco;
								}}
								onValidate={(markers) => {
									const monaco = monacoApi.current;
									const model = monacoEditor.current?.getModel();
									if (
										!monaco ||
										!model ||
										!markers.some((marker) => marker.severity === monaco.MarkerSeverity.Error)
									) {
										return;
									}
									monaco.editor.setModelMarkers(
										model,
										"typescript",
										markers.map((marker) => ({
											...marker,
											severity: monaco.MarkerSeverity.Warning,
										})),
									);
								}}
								beforeMount={(monaco) => {
									monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
										target: monaco.languages.typescript.ScriptTarget.ES2022,
										module: monaco.languages.typescript.ModuleKind.ESNext,
										moduleResolution: monaco.languages.typescript.ModuleResolutionKind.Bundler,
										baseUrl: "/",
										paths: scenarioSupabaseTypePaths,
										strict: true,
										noEmit: true,
									});
									monaco.languages.typescript.typescriptDefaults.addExtraLib(
										generateScenarioDatabaseTypes(appliedTables, appliedEnums, appliedFunctions),
										"file:///scenario-globals.d.ts",
									);
									for (const [filename, contents] of Object.entries(allSupabaseTypeDeclarations)) {
										monaco.languages.typescript.typescriptDefaults.addExtraLib(
											contents,
											scenarioTypeLibraryUri(filename),
										);
									}
								}}
								options={{
									ariaLabel: "Scenario TypeScript source",
									fontFamily: "IBM Plex Mono, monospace",
									fontSize: 13,
									minimap: { enabled: false },
									scrollBeyondLastLine: false,
									wordWrap: "on",
								}}
							/>
							{runDisabledReason && (
								<p className="border-t border-rule px-5 py-2 text-[12px] text-ink-3" role="status">
									{runDisabledReason}
								</p>
							)}
							{selectedRun && (
								<section aria-label="Scenario run results" className="border-t border-rule bg-paper-tint/40 px-5 py-4">
									<h3 className="font-display text-[17px] font-medium">
										{selectedRun.status} — revision {selectedRun.revision}
										{selectedRun.stale ? ` (stale; current draft ${revision})` : ` (draft ${revision})`}
									</h3>
									{selectedRun.reason && <p className="text-[12px] text-ink-3">Reason: {selectedRun.reason}</p>}
									{selectedRun.console.length > 0 && (
										<pre aria-label="Scenario console output" className="mt-2 whitespace-pre-wrap font-mono text-[12px]">{selectedRun.console.join("\n")}</pre>
									)}
									{selectedRun.expectations.length > 0 && (
										<ol aria-label="Scenario expectations" className="mt-3 space-y-2">
											{selectedRun.expectations.map((expectation, index) => (
												<li key={`${index}-${expectation.description}`} className="border-t border-rule pt-2 text-[12px]">
													<div className="font-medium">{expectation.passed ? "Met" : "Unmet"}: {expectation.description}</div>
													<p className="text-ink-3">{expectation.message}</p>
												</li>
											))}
										</ol>
									)}
									<ol aria-label="Sandbox API request log" className="mt-3 space-y-2">
										{selectedRun.requests.map((entry) => (
											<li key={entry.order} className="border-t border-rule pt-2 font-mono text-[11px]">
												<div>{entry.order}. {entry.invocation ? `Invoke ${entry.invocation.functionName}` : `${entry.method} /rest/v1/${entry.table}${Object.keys(entry.filters).length > 0 ? `?${new URLSearchParams(entry.filters).toString()}` : ""}`}{entry.invocationRef ? ` during edge function ${entry.invocationRef.split(":").slice(1).join(":")}` : ""} as {entry.identity.role}{entry.identity.userId ? ` (${entry.identity.userId})` : ""} — {entry.status}</div>
												<pre className="whitespace-pre-wrap">{JSON.stringify(entry.result, null, 2)}</pre>
											</li>
										))}
									</ol>
									{selectedRun.grids.length > 0 && (
										<section aria-label="Scenario result grids" className="mt-5 space-y-5">
											{selectedRun.grids.map((grid) => (
												<section key={grid.table} aria-label={`${grid.table} result grid`}>
													<div className="mb-2 flex flex-wrap items-baseline gap-x-3">
														<h4 className="font-display text-[15px] font-medium">{grid.table}</h4>
														<span className="text-[11px] text-ink-3">
															{grid.total > grid.rows.length
																? `Showing ${grid.rows.length} of ${grid.total} records`
																: `${grid.total} ${grid.total === 1 ? "record" : "records"}`}
														</span>
													</div>
													<div className="overflow-x-auto border border-rule">
														<table className="min-w-full border-collapse text-left font-mono text-[11px]">
															<thead className="bg-paper-tint">
																<tr>
																	{grid.columns.map((column) => (
																		<th key={column} scope="col" className="border-b border-rule px-3 py-2 font-medium">{column}</th>
																	))}
																</tr>
															</thead>
															<tbody>
																{grid.rows.length > 0 ? grid.rows.map((row, index) => (
																	<tr key={index} className="border-b border-rule last:border-b-0">
																		{grid.columns.map((column) => (
																			<td key={column} className="max-w-80 whitespace-pre-wrap break-words px-3 py-2">
																				{row[column] === null ? "null" : typeof row[column] === "object" ? JSON.stringify(row[column]) : String(row[column])}
																			</td>
																		))}
																	</tr>
																)) : (
																	<tr>
																		<td colSpan={Math.max(grid.columns.length, 1)} className="px-3 py-3 text-ink-3">No records</td>
																	</tr>
																)}
															</tbody>
														</table>
													</div>
												</section>
											))}
										</section>
									)}
								</section>
							)}
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
