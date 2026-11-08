import { useMemo, useState, type ChangeEvent } from "react";
import { Input } from "@/components/ui/input";
import { validateFormAnswer, visibleFields, type HarnessForm, type HarnessFormAnswer, type HarnessFormField, type HarnessFormValue } from "../shared/harness-form";

/** A question from Codex or OpenCode, answered inside the app. */
export function HarnessFormPanel({ title, message, form, onSubmit, onCancel }: {
	title: string;
	message?: string;
	form: HarnessForm;
	onSubmit: (answer: HarnessFormAnswer) => void;
	onCancel: () => void;
}) {
	const initial = useMemo(() => {
		const values: HarnessFormAnswer = {};
		for (const field of form.fields) if (field.default !== undefined) values[field.key] = field.default;
		return values;
	}, [form]);
	const [values, setValues] = useState<HarnessFormAnswer>(initial);
	// Text typed beside a field's choices; it becomes the answer when it is not empty.
	const [typed, setTyped] = useState<Record<string, string>>({});
	const set = (key: string, value: HarnessFormValue | undefined) => setValues((current) => {
		const next = { ...current };
		if (value === undefined || value === "") delete next[key]; else next[key] = value;
		return next;
	});
	const shown = visibleFields(form, values);
	// Fields that are not shown do not take part in the answer, except hidden defaults.
	const answer: HarnessFormAnswer = {};
	for (const field of form.fields) {
		const visible = shown.includes(field);
		if (values[field.key] !== undefined && (visible || field.hidden)) answer[field.key] = values[field.key];
	}
	const valid = validateFormAnswer(form, answer) !== null;

	return (
		<form className="space-y-2" onSubmit={(event) => { event.preventDefault(); if (valid) onSubmit(answer); }}>
			<p className="font-semibold">{title}</p>
			{message && <p className="whitespace-pre-wrap">{message}</p>}
			{shown.map((field) => (
				<fieldset key={field.key} className="min-w-0">
					{(field.title || field.description) && (
						<legend className="mb-1">
							{field.title && <span className="font-medium">{field.title}{field.required && " *"}</span>}
							{field.description && <span className="block whitespace-pre-wrap text-ink-3">{field.description}</span>}
						</legend>
					)}
					<FieldInput field={field} value={values[field.key]} typed={typed[field.key] ?? ""} onChange={(value) => set(field.key, value)} onType={(text) => setTyped((current) => ({ ...current, [field.key]: text }))} />
				</fieldset>
			))}
			<div className="sticky -bottom-2 -mx-2 flex gap-2 border-t border-ink/15 bg-surface px-2 py-2">
				<button type="submit" disabled={!valid} className="rounded border border-ink/30 px-2 py-1 disabled:opacity-40">Submit</button>
				<button type="button" onClick={onCancel} className="rounded border border-ink/30 px-2 py-1">Skip</button>
			</div>
		</form>
	);
}

function FieldInput({ field, value, typed, onChange, onType }: {
	field: HarnessFormField;
	value: HarnessFormValue | undefined;
	typed: string;
	onChange: (value: HarnessFormValue | undefined) => void;
	onType: (text: string) => void;
}) {
	if (field.type === "external") {
		return field.url && /^https?:\/\//i.test(field.url)
			? <a className="break-all underline" href={field.url} target="_blank" rel="noreferrer">{field.url}</a>
			: <p className="text-ink-3">This step must be completed outside the app.</p>;
	}
	if (field.type === "boolean") {
		return (
			<label className="flex items-center gap-2">
				<input type="checkbox" checked={value === true} onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.checked)} />
				<span>Yes</span>
			</label>
		);
	}
	if (field.type === "number" || field.type === "integer") {
		return (
			<Input
				type="number" step={field.type === "integer" ? 1 : "any"} min={field.minimum} max={field.maximum}
				value={typeof value === "number" ? String(value) : ""} aria-label={field.title ?? field.key} className="h-8 text-xs"
				onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value === "" ? undefined : Number(event.target.value))}
			/>
		);
	}
	if (field.type === "multiselect") {
		const chosen = Array.isArray(value) ? value : [];
		return (
			<div className="space-y-1">
				{(field.options ?? []).map((option) => (
					<label key={option.value} className="flex items-start gap-2" title={option.description}>
						<input type="checkbox" checked={chosen.includes(option.value)} onChange={(event: ChangeEvent<HTMLInputElement>) => {
							const next = event.target.checked ? [...chosen, option.value] : chosen.filter((item) => item !== option.value);
							onChange(next.length ? next : undefined);
						}} />
						<span>{option.label}{option.description && <span className="block text-ink-3">{option.description}</span>}</span>
					</label>
				))}
			</div>
		);
	}
	const options = field.options ?? [];
	return (
		<div className="space-y-1">
			{options.map((option) => (
				<label key={option.value} className="flex items-start gap-2" title={option.description}>
					<input type="radio" name={field.key} checked={value === option.value} onChange={() => { onType(""); onChange(option.value); }} />
					<span>{option.label}{option.description && <span className="block text-ink-3">{option.description}</span>}</span>
				</label>
			))}
			{(options.length === 0 || field.custom) && (
				<Input
					type={field.secret ? "password" : "text"} value={options.length ? typed : typeof value === "string" ? value : ""}
					placeholder={options.length ? "Something else…" : undefined} aria-label={field.title ?? field.key} className="h-8 text-xs"
					onChange={(event: ChangeEvent<HTMLInputElement>) => { onType(event.target.value); onChange(event.target.value); }}
				/>
			)}
		</div>
	);
}
