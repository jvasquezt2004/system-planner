import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { DesignFunction, DesignTable, DesignTrigger, DesignTriggerEvent } from "../shared/design";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Props = {
	triggers: DesignTrigger[];
	tables: DesignTable[];
	functions: DesignFunction[];
	busy: boolean;
	onSave: (triggers: DesignTrigger[]) => void;
	onRemove: (triggerId: string) => void;
};

type TriggerEventName = DesignTriggerEvent["event"];
const eventNames: TriggerEventName[] = ["INSERT", "UPDATE", "DELETE", "TRUNCATE"];

function newTrigger(functionId: string): DesignTrigger {
	return {
		id: crypto.randomUUID(),
		name: "new_trigger",
		tableId: "",
		timing: "BEFORE",
		events: [{ event: "INSERT" }],
		level: "ROW",
		functionId,
		when: "",
	};
}

/** Project-level editor for PostgreSQL triggers. */
export function TriggersView({ triggers, tables, functions, busy, onSave, onRemove }: Props) {
	const [selectedId, setSelectedId] = useState<string | null>(triggers[0]?.id ?? null);
	const [draft, setDraft] = useState<DesignTrigger | null>(null);
	const selected = triggers.find((trigger) => trigger.id === selectedId) ?? null;
	const triggerFunctions = functions.filter((fn) => fn.language === "plpgsql" && fn.returnType.trim().toLowerCase() === "trigger" && fn.arguments.length === 0);

	useEffect(() => {
		if (!selected) {
			setDraft(null);
			return;
		}
		setDraft(structuredClone(selected));
	}, [selectedId, triggers]);

	function addTrigger() {
		const trigger = newTrigger(triggerFunctions[0]?.id ?? "");
		onSave([...triggers, trigger]);
		setSelectedId(trigger.id);
	}

	function saveTrigger() {
		if (!draft) return;
		const events = draft.events.map((entry) => entry.event === "UPDATE"
			? { event: entry.event, ...(entry.columnIds?.length ? { columnIds: entry.columnIds } : {}) }
			: { event: entry.event });
		onSave(triggers.map((trigger) => trigger.id === draft.id ? { ...draft, events } : trigger));
	}

	function changeEvent(eventName: TriggerEventName, checked: boolean) {
		if (!draft) return;
		const current = draft.events.find((entry) => entry.event === eventName);
		const events = checked
			? current ? draft.events : [...draft.events, { event: eventName }]
			: draft.events.filter((entry) => entry.event !== eventName);
		setDraft({ ...draft, events });
	}

	function toggleColumn(columnId: string, checked: boolean) {
		if (!draft) return;
		const events = draft.events.map((entry) => {
			if (entry.event !== "UPDATE") return entry;
			const columnIds = new Set(entry.columnIds ?? []);
			if (checked) columnIds.add(columnId);
			else columnIds.delete(columnId);
			return { event: "UPDATE" as const, ...(columnIds.size ? { columnIds: [...columnIds] } : {}) };
		});
		setDraft({ ...draft, events });
	}

	function removeTrigger() {
		if (!selected) return;
		onRemove(selected.id);
		const remaining = triggers.filter((trigger) => trigger.id !== selected.id);
		setSelectedId(remaining[0]?.id ?? null);
	}

	const selectedTable = tables.find((table) => table.id === draft?.tableId);
	const updateEvent = draft?.events.find((entry) => entry.event === "UPDATE");

	return (
		<div className="flex h-full min-h-0 flex-col px-6 py-5">
			<div className="mb-5 flex items-end justify-between border-b border-rule pb-3">
				<div>
					<p className="kicker">Database logic</p>
					<h2 className="font-display text-[26px] font-medium">Triggers</h2>
				</div>
				<Button onClick={addTrigger} disabled={busy || tables.length === 0} variant="outline" size="sm"><Plus className="size-4" /> Add trigger</Button>
			</div>
			<div className="grid min-h-0 flex-1 grid-cols-[240px_minmax(0,1fr)] gap-6">
				<nav aria-label="Project triggers" className="min-h-0 overflow-auto border-r border-rule pr-4">
					{triggers.length === 0 ? <p className="text-sm text-ink-3">No triggers yet.</p> : triggers.map((trigger) => (
						<button key={trigger.id} type="button" onClick={() => setSelectedId(trigger.id)} className={`mb-1 block w-full rounded-sm px-3 py-2 text-left font-mono text-sm ${trigger.id === selectedId ? "bg-paper-2 text-pencil" : "text-ink-2 hover:bg-paper-2"}`}>
							{trigger.name}
						</button>
					))}
				</nav>
				{draft ? (
					<div className="min-h-0 overflow-auto pr-2">
						<div className="grid grid-cols-2 gap-4">
							<label className="space-y-1 text-xs text-ink-2">Name<Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
							<label className="space-y-1 text-xs text-ink-2">Table<select value={draft.tableId} onChange={(event) => setDraft({ ...draft, tableId: event.target.value })} className="block h-9 w-full rounded-sm border border-rule bg-paper px-2"><option value="" disabled>Select a table</option>{tables.map((table) => <option key={table.id} value={table.id}>{table.name}</option>)}</select></label>
							<label className="space-y-1 text-xs text-ink-2">Timing<select value={draft.timing} onChange={(event) => setDraft({ ...draft, timing: event.target.value as DesignTrigger["timing"] })} className="block h-9 w-full rounded-sm border border-rule bg-paper px-2"><option value="BEFORE">Before</option><option value="AFTER">After</option><option value="INSTEAD OF">Instead of</option></select></label>
							<label className="space-y-1 text-xs text-ink-2">Function<select value={draft.functionId} onChange={(event) => setDraft({ ...draft, functionId: event.target.value })} className="block h-9 w-full rounded-sm border border-rule bg-paper px-2"><option value="" disabled>Select a PL/pgSQL trigger function</option>{triggerFunctions.map((fn) => <option key={fn.id} value={fn.id}>{fn.name}</option>)}</select></label>
						</div>
						<fieldset className="mt-5">
							<legend className="mb-2 text-xs text-ink-2">Events</legend>
							<div className="flex flex-wrap gap-x-5 gap-y-2">
								{eventNames.map((eventName) => <label key={eventName} className="flex items-center gap-2 text-sm text-ink-2"><input type="checkbox" checked={draft.events.some((entry) => entry.event === eventName)} onChange={(event) => changeEvent(eventName, event.target.checked)} />{eventName}</label>)}
							</div>
						</fieldset>
						{updateEvent && selectedTable && <fieldset className="mt-4">
							<legend className="mb-2 text-xs text-ink-2">UPDATE OF columns <span className="text-ink-4">Optional</span></legend>
							<div className="flex flex-wrap gap-x-5 gap-y-2">{selectedTable.columns.map((column) => <label key={column.id} className="flex items-center gap-2 text-sm text-ink-2"><input type="checkbox" checked={updateEvent.columnIds?.includes(column.id) ?? false} onChange={(event) => toggleColumn(column.id, event.target.checked)} />{column.name}</label>)}</div>
						</fieldset>}
						<label className="mt-5 block space-y-1 text-xs text-ink-2">Level<select value={draft.level} onChange={(event) => setDraft({ ...draft, level: event.target.value as DesignTrigger["level"] })} className="block h-9 w-full rounded-sm border border-rule bg-paper px-2"><option value="ROW">Each row</option><option value="STATEMENT">Each statement</option></select></label>
						<label className="mt-4 block space-y-1 text-xs text-ink-2">WHEN condition <span className="text-ink-4">Optional SQL expression</span><textarea value={draft.when} onChange={(event) => setDraft({ ...draft, when: event.target.value })} spellCheck={false} className="min-h-20 w-full rounded-sm border border-rule bg-paper px-3 py-2 font-mono text-[13px]" placeholder="NEW.status = 'ready'" /></label>
						<div className="mt-4 flex justify-between"><Button variant="outline" onClick={removeTrigger} disabled={busy}><Trash2 className="size-4" /> Remove</Button><Button onClick={saveTrigger} disabled={busy}>Save trigger</Button></div>
					</div>
				) : <p className="text-sm text-ink-3">Add a trigger to run a project function when table data changes.</p>}
			</div>
		</div>
	);
}
