/// <reference types="vite/client" />
import { useEffect, useRef, useState, type FormEvent } from "react";
import Editor, { type Monaco, type OnMount } from "@monaco-editor/react";
import "./monaco-setup";
import { FileCode2, Plus, Trash2 } from "lucide-react";
import type { EdgeFunction, EdgeFunctionSaveState, DesignEnumType, DesignFunction, SandboxAppliedTable } from "../shared/design";
import { generateScenarioDatabaseTypes, scenarioTypeLibraryUri } from "../shared/scenario-types";
import { edgeFunctionDenoDeclarations, edgeFunctionSupabaseTypePaths } from "../shared/edge-function-types";
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
	edgeFunctions: EdgeFunction[];
	save: EdgeFunctionSaveState;
	appliedTables: SandboxAppliedTable[];
	appliedEnums: DesignEnumType[];
	appliedFunctions: DesignFunction[];
	onCreate: (name: string) => void;
	onRename: (edgeFunctionId: string, name: string) => void;
	onRemove: (edgeFunctionId: string) => void;
	onUpdateSource: (edgeFunctionId: string, source: string) => void;
};



/** Manage project Edge functions as saved source, separate from design history. */
export function EdgeFunctionsView({
	edgeFunctions, save, appliedTables, appliedEnums, appliedFunctions,
	onCreate, onRename, onRemove, onUpdateSource,
}: Props) {
	const [selectedId, setSelectedId] = useState<string | null>(edgeFunctions[0]?.id ?? null);
	const [newName, setNewName] = useState("");
	const [nameDraft, setNameDraft] = useState("");
	const [sourceDraft, setSourceDraft] = useState("");
	const pendingSave = useRef<{ id: string; source: string } | null>(null);
	const saveCallback = useRef(onUpdateSource);
	saveCallback.current = onUpdateSource;
	const monacoApi = useRef<Monaco | null>(null);
	const monacoEditor = useRef<Parameters<OnMount>[0] | null>(null);
	const selected = edgeFunctions.find((item) => item.id === selectedId) ?? null;

	useEffect(() => {
		if (!selected) setSelectedId(edgeFunctions[0]?.id ?? null);
	}, [edgeFunctions, selected]);
	useEffect(() => setNameDraft(selected?.name ?? ""), [selected?.id, selected?.name]);
	useEffect(() => setSourceDraft(selected?.source ?? ""), [selected?.id]);
	useEffect(() => {
		if (!selected || sourceDraft === selected.source) {
			if (pendingSave.current?.id === selected?.id) pendingSave.current = null;
			return;
		}
		const pending = { id: selected.id, source: sourceDraft };
		pendingSave.current = pending;
		const timer = setTimeout(() => {
			if (pendingSave.current === pending) pendingSave.current = null;
			saveCallback.current(pending.id, pending.source);
		}, 300);
		return () => clearTimeout(timer);
	}, [selected?.id, selected?.source, sourceDraft]);
	useEffect(() => () => {
		const pending = pendingSave.current;
		if (!pending) return;
		pendingSave.current = null;
		saveCallback.current(pending.id, pending.source);
	}, [selected?.id]);

	function create(event: FormEvent<HTMLFormElement>) {
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
		<div data-testid="edge-functions-view" className="h-full overflow-y-auto bg-paper">
			<div className="mx-auto max-w-6xl px-5 pb-10 sm:px-8">
				<header className="flex flex-wrap items-end justify-between gap-6 pt-8">
					<div>
						<h2 className="font-display text-[28px] leading-none font-medium tracking-[-0.02em]">Edge functions</h2>
						<p className="mt-2 max-w-xl font-display text-[17px] leading-snug text-ink-2 italic">Saved TypeScript handlers, separate from the design history.</p>
					</div>
					<form onSubmit={create} className="flex items-center gap-2">
						<Input aria-label="New Edge function name" placeholder="function-name" value={newName} onChange={(event) => setNewName(event.target.value)} className="h-8 w-52" />
						<Button type="submit" disabled={!newName.trim()}><Plus /> New Edge function</Button>
					</form>
				</header>
				<div className="mt-8 grid min-h-[min(68vh,720px)] grid-cols-1 border-y border-rule-strong sm:grid-cols-[220px_minmax(0,1fr)]">
					<aside className="border-b border-rule bg-paper-tint/50 sm:border-r sm:border-b-0">
						<div className="flex items-center justify-between border-b border-rule px-4 py-3"><h3 className="kicker">Saved Edge functions</h3><span className="figures font-mono text-[10px] text-ink-4">{edgeFunctions.length}</span></div>
						{edgeFunctions.length ? <ul className="divide-y divide-rule">{edgeFunctions.map((item) => <li key={item.id}><button type="button" aria-current={item.id === selected?.id ? "true" : undefined} onClick={() => setSelectedId(item.id)} className="flex w-full items-center gap-2 px-4 py-3 text-left outline-none hover:bg-paper-tint aria-[current=true]:bg-paper-raised"><FileCode2 className="size-4 shrink-0 text-ink-3" /><span className="truncate font-mono text-[13px]">{item.name}</span></button></li>)}</ul> : <p className="px-4 py-5 text-[12.5px] leading-relaxed text-ink-3">No Edge functions saved yet. Create one to start editing its handler.</p>}
					</aside>
					{selected ? <section aria-label={`Edit Edge function ${selected.name}`} className="flex min-w-0 flex-col">
						<div className="flex flex-wrap items-center gap-3 border-b border-rule px-5 py-3">
							<label className="min-w-48 flex-1"><span className="sr-only">Edge function name</span><Input aria-label="Edge function name" value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} onBlur={saveName} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") setNameDraft(selected.name); }} className="h-8 border-transparent bg-transparent px-1 font-mono text-[16px] focus-visible:border-pencil focus-visible:bg-paper-raised" /></label>
							<SaveIndicator save={save} />
							<Button variant="strike" size="sm" aria-label={`Remove Edge function ${selected.name}`} onClick={() => onRemove(selected.id)}><Trash2 /> Remove</Button>
						</div>
						<div className="flex items-center justify-between border-b border-rule px-5 py-2"><label htmlFor="edge-function-source" className="kicker">TypeScript handler</label><span className="text-[11px] text-ink-4">Saved independently of design undo and redo</span></div>
						<Editor
							key={generateScenarioDatabaseTypes(appliedTables, appliedEnums, appliedFunctions)}
							height="min(68vh, 720px)" language="typescript" value={sourceDraft}
							onChange={(source) => setSourceDraft(source ?? "")}
							onMount={(instance, monaco) => { monacoEditor.current = instance; monacoApi.current = monaco; }}
							onValidate={(markers) => {
							const monaco = monacoApi.current; const model = monacoEditor.current?.getModel();
							if (!monaco || !model || !markers.some((marker) => marker.severity === monaco.MarkerSeverity.Error)) return;
							monaco.editor.setModelMarkers(model, "typescript", markers.map((marker) => ({ ...marker, severity: monaco.MarkerSeverity.Warning })));
						}}
							beforeMount={(monaco) => {
							monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
								target: monaco.languages.typescript.ScriptTarget.ES2022,
								module: monaco.languages.typescript.ModuleKind.ESNext,
								moduleResolution: monaco.languages.typescript.ModuleResolutionKind.Bundler,
								baseUrl: "/", paths: edgeFunctionSupabaseTypePaths, strict: true, noEmit: true,
							});
							monaco.languages.typescript.typescriptDefaults.addExtraLib(edgeFunctionDenoDeclarations, "file:///edge-function-deno.d.ts");
							monaco.languages.typescript.typescriptDefaults.addExtraLib(generateScenarioDatabaseTypes(appliedTables, appliedEnums, appliedFunctions), "file:///edge-function-database.d.ts");
							for (const [filename, contents] of Object.entries(allSupabaseTypeDeclarations)) monaco.languages.typescript.typescriptDefaults.addExtraLib(contents, scenarioTypeLibraryUri(filename));
						}}
							options={{ ariaLabel: "Edge function TypeScript source", fontFamily: "IBM Plex Mono, monospace", fontSize: 13, minimap: { enabled: false }, scrollBeyondLastLine: false, wordWrap: "on" }}
						/>
					</section> : <div className="flex min-w-0 flex-col items-center justify-center px-8 text-center"><FileCode2 className="size-6 text-ink-4" /><p className="mt-3 font-display text-[18px] italic text-ink-3">Your next Edge function starts here.</p><p className="mt-1 max-w-sm text-[12.5px] text-ink-3">Create a named handler to edit its saved TypeScript source.</p></div>}
				</div>
			</div>
		</div>
	);
}

function SaveIndicator({ save }: { save: EdgeFunctionSaveState }) {
	if (save.status === "failed") return <p role="alert" data-testid="edge-function-save-status" className="max-w-64 text-right text-[12px] text-proof-red">Could not save Edge function: {save.error}</p>;
	if (save.status === "saving") return <p role="status" data-testid="edge-function-save-status" className="text-[12px] text-ink-3">Saving…</p>;
	if (save.status === "saved") return <p role="status" data-testid="edge-function-save-status" className="text-[12px] text-press-green">Saved</p>;
	return <p role="status" data-testid="edge-function-save-status" className="text-[12px] text-ink-4">Not saved yet</p>;
}
