import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { DesignFunction } from "../shared/design";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Props = {
	functions: DesignFunction[];
	busy: boolean;
	onSave: (functions: DesignFunction[]) => void;
	onRemove: (functionId: string) => void;
};

const newFunction = (): DesignFunction => ({
	id: crypto.randomUUID(),
	name: "new_function",
	arguments: [],
	returnType: "integer",
	returnsSet: false,
	language: "sql",
	volatility: "volatile",
	security: "invoker",
	body: "SELECT 1",
});

/** Project-level editor for the Functions emitted in PostgreSQL SQL. */
export function FunctionsView({ functions, busy, onSave, onRemove }: Props) {
	const [selectedId, setSelectedId] = useState<string | null>(functions[0]?.id ?? null);
	const [draft, setDraft] = useState<DesignFunction | null>(null);
	const [argumentText, setArgumentText] = useState("");
	const [validationError, setValidationError] = useState<string | null>(null);
	const selected = functions.find((fn) => fn.id === selectedId) ?? null;

	useEffect(() => {
		setSelectedId(functions[0]?.id ?? null);
	}, [functions.length === 0]);
	useEffect(() => {
		if (!selected) {
			setDraft(null);
			setArgumentText("");
			return;
		}
		setDraft(structuredClone(selected));
		setArgumentText(selected.arguments.map((argument) => `${argument.name} ${argument.type}`).join("\n"));
	}, [selectedId, functions]);

	function addFunction() {
		const fn = newFunction();
		onSave([...functions, fn]);
		setSelectedId(fn.id);
	}

	function saveFunction() {
		if (!draft) return;
		try {
			const args = argumentText.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
				const separator = line.indexOf(" ");
				if (separator < 1 || !line.slice(separator + 1).trim()) throw new Error(`Argument must be written as “name type”: ${line}`);
				return { name: line.slice(0, separator), type: line.slice(separator + 1).trim() };
			});
			onSave(functions.map((fn) => fn.id === draft.id ? { ...draft, arguments: args } : fn));
			setValidationError(null);
		} catch (error) {
			setValidationError(error instanceof Error ? error.message : String(error));
		}
	}

	function removeFunction() {
		if (selected) onRemove(selected.id);
	}

	return (
		<div className="flex h-full min-h-0 flex-col px-6 py-5">
			<div className="mb-5 flex items-end justify-between border-b border-rule pb-3">
				<div>
					<p className="kicker">Database logic</p>
					<h2 className="font-display text-[26px] font-medium">Functions</h2>
				</div>
				<Button onClick={addFunction} disabled={busy} variant="outline" size="sm"><Plus className="size-4" /> Add function</Button>
			</div>
			<div className="grid min-h-0 flex-1 grid-cols-[240px_minmax(0,1fr)] gap-6">
				<nav aria-label="Project functions" className="min-h-0 overflow-auto border-r border-rule pr-4">
					{functions.length === 0 ? <p className="text-sm text-ink-3">No functions yet.</p> : functions.map((fn) => (
						<button key={fn.id} type="button" onClick={() => setSelectedId(fn.id)} className={`mb-1 block w-full rounded-sm px-3 py-2 text-left font-mono text-sm ${fn.id === selectedId ? "bg-paper-2 text-pencil" : "text-ink-2 hover:bg-paper-2"}`}>
							{fn.name}
						</button>
					))}
				</nav>
				{draft ? (
					<div className="min-h-0 overflow-auto pr-2">
						<div className="grid grid-cols-2 gap-4">
							<label className="space-y-1 text-xs text-ink-2">Name<Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
							<label className="space-y-1 text-xs text-ink-2">Return type<Input value={draft.returnType} onChange={(event) => { const returnType = event.target.value; setDraft({ ...draft, returnType, ...(returnType.trim().toLowerCase() === "trigger" ? { language: "plpgsql", returnsSet: false } : {}) }); }} placeholder="integer, text, trigger, or a table name" /></label>
							<label className="space-y-1 text-xs text-ink-2">Arguments <span className="block text-ink-4">One “name type” per line</span><textarea value={argumentText} onChange={(event) => setArgumentText(event.target.value)} className="min-h-20 w-full rounded-sm border border-rule bg-paper px-3 py-2 font-mono text-sm" placeholder="user_id uuid" /></label>
							<div className="grid grid-cols-2 gap-3">
								<label className="space-y-1 text-xs text-ink-2">Language<select value={draft.language} disabled={draft.returnType.trim().toLowerCase() === "trigger"} onChange={(event) => setDraft({ ...draft, language: event.target.value as DesignFunction["language"] })} className="block h-9 w-full rounded-sm border border-rule bg-paper px-2"><option value="sql">SQL</option><option value="plpgsql">PL/pgSQL</option></select></label>
								<label className="space-y-1 text-xs text-ink-2">Volatility<select value={draft.volatility} onChange={(event) => setDraft({ ...draft, volatility: event.target.value as DesignFunction["volatility"] })} className="block h-9 w-full rounded-sm border border-rule bg-paper px-2"><option value="volatile">Volatile</option><option value="stable">Stable</option><option value="immutable">Immutable</option></select></label>
								<label className="space-y-1 text-xs text-ink-2">Security<select value={draft.security} onChange={(event) => setDraft({ ...draft, security: event.target.value as DesignFunction["security"] })} className="block h-9 w-full rounded-sm border border-rule bg-paper px-2"><option value="invoker">Invoker</option><option value="definer">Definer</option></select></label>
								<label className="flex items-center gap-2 pt-6 text-xs text-ink-2"><input type="checkbox" checked={draft.returnsSet} onChange={(event) => setDraft({ ...draft, returnsSet: event.target.checked })} /> Returns a set</label>
							</div>
						</div>
						<label className="mt-4 block space-y-1 text-xs text-ink-2">Handwritten body<textarea value={draft.body} onChange={(event) => setDraft({ ...draft, body: event.target.value })} spellCheck={false} className="min-h-[260px] w-full rounded-sm border border-rule bg-paper px-3 py-2 font-mono text-[13px]" /></label>
						<div className="mt-4 flex justify-between"><Button variant="outline" onClick={removeFunction} disabled={busy}><Trash2 className="size-4" /> Remove</Button><Button onClick={saveFunction} disabled={busy}>Save function</Button></div>
						{validationError && <p role="alert" className="mt-3 text-xs text-proof-red">{validationError}</p>}
					</div>
				) : <p className="text-sm text-ink-3">Add a function to define database-side logic for this project.</p>}
			</div>
		</div>
	);
}
