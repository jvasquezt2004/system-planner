/** A question an external harness (Codex, OpenCode) asks the designer, shown as a form in the Assistant sidebar. */

export type HarnessFormValue = string | number | boolean | string[];

export type HarnessFormOption = { value: string; label: string; description?: string };

export type HarnessFormCondition = { key: string; op: "eq" | "neq"; value: string | number | boolean };

export type HarnessFormField = {
	key: string;
	type: "string" | "number" | "integer" | "boolean" | "multiselect" | "external";
	title?: string;
	description?: string;
	required?: boolean;
	/** Hide what is typed, for secrets. */
	secret?: boolean;
	hidden?: boolean;
	when?: HarnessFormCondition[];
	/** Choices for a string or multiselect field. */
	options?: HarnessFormOption[];
	/** A string field with options also accepts typed text. */
	custom?: boolean;
	default?: HarnessFormValue;
	minimum?: number;
	maximum?: number;
	/** Where an external field sends the designer. */
	url?: string;
};

export type HarnessForm = { title?: string; fields: HarnessFormField[] };

export type HarnessFormAnswer = Record<string, HarnessFormValue>;

/** The result a harness receives for a form request. */
export type HarnessFormResult = { answer: HarnessFormAnswer } | { cancelled: true };

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Fields shown for the answers given so far. Hidden fields keep their default. */
export function visibleFields(form: HarnessForm, values: HarnessFormAnswer): HarnessFormField[] {
	return form.fields.filter((field) => !field.hidden && (field.when ?? []).every((condition) =>
		condition.op === "eq" ? values[condition.key] === condition.value : values[condition.key] !== condition.value));
}

/** Accepts an answer only if it fits the form: known keys, right types, allowed choices, required fields present. */
export function validateFormAnswer(form: HarnessForm, answer: unknown): HarnessFormAnswer | null {
	if (!isRecord(answer)) return null;
	const fields = new Map(form.fields.map((field) => [field.key, field]));
	const clean: HarnessFormAnswer = {};
	for (const [key, value] of Object.entries(answer)) {
		const field = fields.get(key);
		if (!field || field.type === "external") return null;
		const allowed = field.options?.map((option) => option.value);
		if (field.type === "string") {
			if (typeof value !== "string") return null;
			if (allowed && !field.custom && !allowed.includes(value)) return null;
		} else if (field.type === "number" || field.type === "integer") {
			if (typeof value !== "number" || !Number.isFinite(value) || (field.type === "integer" && !Number.isInteger(value))) return null;
			if ((field.minimum !== undefined && value < field.minimum) || (field.maximum !== undefined && value > field.maximum)) return null;
		} else if (field.type === "boolean") {
			if (typeof value !== "boolean") return null;
		} else if (field.type === "multiselect") {
			if (!Array.isArray(value) || value.some((item) => typeof item !== "string") || (allowed && !field.custom && value.some((item) => !allowed.includes(item)))) return null;
		}
		clean[key] = value as HarnessFormValue;
	}
	for (const field of visibleFields(form, clean)) {
		if (field.required && field.type !== "external" && clean[field.key] === undefined) return null;
	}
	return clean;
}

/** Codex `item/tool/requestUserInput` questions as a form. Every question is required. */
export function formFromCodexQuestions(questions: unknown): HarnessForm {
	const list = Array.isArray(questions) ? questions : [];
	return {
		fields: list.filter((question): question is Record<string, unknown> => isRecord(question) && typeof question.id === "string").map((question) => {
			const options = Array.isArray(question.options)
				? question.options.filter(isRecord).map((option) => ({ value: String(option.label), label: String(option.label), ...(option.description ? { description: String(option.description) } : {}) }))
				: [];
			return {
				key: String(question.id),
				type: "string" as const,
				title: typeof question.header === "string" ? question.header : undefined,
				description: typeof question.question === "string" ? question.question : undefined,
				required: true,
				secret: question.isSecret === true,
				...(options.length ? { options } : {}),
				// isOther means the designer may type something other than the suggestions.
				custom: question.isOther === true,
			};
		}),
	};
}

/** The answer Codex expects for the questions of a form. */
export function codexAnswersFromForm(result: HarnessFormResult): { answers: Record<string, { answers: string[] }> } {
	if (!("answer" in result)) return { answers: {} };
	return { answers: Object.fromEntries(Object.entries(result.answer).map(([key, value]) => [key, { answers: Array.isArray(value) ? value : [String(value)] }])) };
}

/**
 * A simple JSON Schema object (flat string, number, integer, boolean, and enum
 * properties) as a form, or null when the schema needs more than that.
 */
export function formFromJsonSchema(schema: unknown): HarnessForm | null {
	if (!isRecord(schema) || schema.type !== "object" || !isRecord(schema.properties)) return null;
	const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
	const fields: HarnessFormField[] = [];
	for (const [key, raw] of Object.entries(schema.properties)) {
		if (!isRecord(raw)) return null;
		const base = { key, title: typeof raw.title === "string" ? raw.title : undefined, description: typeof raw.description === "string" ? raw.description : undefined, required: required.has(key) };
		const enumValues = Array.isArray(raw.enum) ? raw.enum.map(String) : null;
		if (raw.type === "string") {
			const names = Array.isArray(raw.enumNames) ? raw.enumNames.map(String) : [];
			fields.push({ ...base, type: "string", ...(enumValues ? { options: enumValues.map((value, index) => ({ value, label: names[index] ?? value })) } : {}), ...(typeof raw.default === "string" ? { default: raw.default } : {}) });
		} else if (raw.type === "number" || raw.type === "integer") {
			fields.push({ ...base, type: raw.type, ...(typeof raw.minimum === "number" ? { minimum: raw.minimum } : {}), ...(typeof raw.maximum === "number" ? { maximum: raw.maximum } : {}), ...(typeof raw.default === "number" ? { default: raw.default } : {}) });
		} else if (raw.type === "boolean") {
			fields.push({ ...base, type: "boolean", ...(typeof raw.default === "boolean" ? { default: raw.default } : {}) });
		} else if (raw.type === "array" && isRecord(raw.items) && Array.isArray(raw.items.enum)) {
			fields.push({ ...base, type: "multiselect", options: raw.items.enum.map((value) => ({ value: String(value), label: String(value) })) });
		} else return null;
	}
	return fields.length ? { fields } : null;
}
