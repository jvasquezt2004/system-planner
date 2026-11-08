import { describe, expect, test } from "bun:test";
import { codexAnswersFromForm, formFromCodexQuestions, formFromJsonSchema, validateFormAnswer, visibleFields, type HarnessForm } from "./harness-form";

const form: HarnessForm = { fields: [
	{ key: "color", type: "string", required: true, options: [{ value: "Red", label: "Red" }, { value: "Blue", label: "Blue" }] },
	{ key: "other", type: "string", custom: true, options: [{ value: "a", label: "A" }] },
	{ key: "count", type: "integer", minimum: 1, maximum: 5 },
	{ key: "agree", type: "boolean" },
	{ key: "tags", type: "multiselect", options: [{ value: "x", label: "X" }, { value: "y", label: "Y" }] },
	{ key: "why", type: "string", required: true, when: [{ key: "agree", op: "eq", value: true }] },
] };

describe("validateFormAnswer", () => {
	test("accepts a complete answer and drops nothing", () => {
		const answer = { color: "Red", other: "free text", count: 3, agree: false, tags: ["x"] };
		expect(validateFormAnswer(form, answer)).toEqual(answer);
	});
	test("rejects unknown keys, wrong types, unlisted choices, and out-of-range numbers", () => {
		expect(validateFormAnswer(form, { color: "Green" })).toBeNull();
		expect(validateFormAnswer(form, { color: "Red", nope: 1 })).toBeNull();
		expect(validateFormAnswer(form, { color: "Red", count: 2.5 })).toBeNull();
		expect(validateFormAnswer(form, { color: "Red", count: 9 })).toBeNull();
		expect(validateFormAnswer(form, { color: "Red", tags: ["z"] })).toBeNull();
		expect(validateFormAnswer(form, { color: "Red", agree: "yes" })).toBeNull();
		expect(validateFormAnswer(form, "Red")).toBeNull();
	});
	test("requires required fields only while they are visible", () => {
		expect(validateFormAnswer(form, {})).toBeNull();
		expect(validateFormAnswer(form, { color: "Red", agree: true })).toBeNull();
		expect(validateFormAnswer(form, { color: "Red", agree: true, why: "because" })).not.toBeNull();
		expect(visibleFields(form, { agree: false }).map((field) => field.key)).not.toContain("why");
	});
});

describe("Codex questions", () => {
	const questions = [
		{ id: "q1", header: "Name", question: "What is your name?", isOther: false, isSecret: false, options: null },
		{ id: "q2", header: "Mode", question: "Pick one", isOther: true, isSecret: false, options: [{ label: "Fast", description: "Quick" }] },
		{ id: "q3", header: "Key", question: "API key?", isOther: false, isSecret: true, options: null },
	];
	test("become required string fields and answer in Codex's shape", () => {
		const converted = formFromCodexQuestions(questions);
		expect(converted.fields.map((field) => [field.key, field.required, field.secret, field.custom])).toEqual([["q1", true, false, false], ["q2", true, false, true], ["q3", true, true, false]]);
		expect(converted.fields[1].options).toEqual([{ value: "Fast", label: "Fast", description: "Quick" }]);
		const answer = validateFormAnswer(converted, { q1: "Ada", q2: "Faster", q3: "k" })!;
		expect(codexAnswersFromForm({ answer })).toEqual({ answers: { q1: { answers: ["Ada"] }, q2: { answers: ["Faster"] }, q3: { answers: ["k"] } } });
		expect(codexAnswersFromForm({ cancelled: true })).toEqual({ answers: {} });
	});
});

describe("JSON Schema forms", () => {
	test("converts flat schemas and refuses anything nested", () => {
		const converted = formFromJsonSchema({ type: "object", required: ["name"], properties: {
			name: { type: "string", title: "Name" }, size: { type: "string", enum: ["s", "l"] }, n: { type: "integer", minimum: 1 }, ok: { type: "boolean", default: true },
			tags: { type: "array", items: { enum: ["a", "b"] } },
		} })!;
		expect(converted.fields.map((field) => [field.key, field.type, field.required])).toEqual([["name", "string", true], ["size", "string", false], ["n", "integer", false], ["ok", "boolean", false], ["tags", "multiselect", false]]);
		expect(formFromJsonSchema({ type: "object", properties: { nested: { type: "object" } } })).toBeNull();
		expect(formFromJsonSchema({ type: "string" })).toBeNull();
	});
});
