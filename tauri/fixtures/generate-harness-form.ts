/**
 * Differential fixtures for the harness question forms (`harness-form.ts`): questions and JSON
 * Schemas from Codex and OpenCode become forms, answers are checked against them, and a form's
 * answer becomes what the harness expects. Inputs are hand-written and mutated by a seeded RNG.
 *
 * Run from the repository root: bun tauri/fixtures/generate-harness-form.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codexAnswersFromForm, formFromCodexQuestions, formFromJsonSchema, validateFormAnswer } from "../../src/shared/harness-form";
import { mutateOnce, seededRng } from "./lib/mutate";

const questions = [
	{ id: "q1", header: "Choice", question: "Which database?", options: [{ label: "Postgres", description: "SQL" }, { label: "SQLite" }], isOther: true },
	{ id: "q2", question: "Your name?", isSecret: true },
	{ id: "q3", header: "Free", options: [] },
];
const schema = {
	type: "object",
	required: ["name", "age"],
	properties: {
		name: { type: "string", title: "Name", description: "Who", default: "Ada" },
		age: { type: "integer", minimum: 0, maximum: 130 },
		ratio: { type: "number", default: 0.5 },
		ok: { type: "boolean", default: true },
		color: { type: "string", enum: ["red", "green"], enumNames: ["Red"] },
		tags: { type: "array", items: { enum: ["a", "b"] } },
	},
};
const form = {
	fields: [
		{ key: "name", type: "string", required: true },
		{ key: "color", type: "string", options: [{ value: "red", label: "Red" }, { value: "green", label: "Green" }], custom: false },
		{ key: "other", type: "string", options: [{ value: "x", label: "X" }], custom: true },
		{ key: "age", type: "integer", minimum: 1, maximum: 9 },
		{ key: "ratio", type: "number", minimum: 0.5 },
		{ key: "ok", type: "boolean" },
		{ key: "tags", type: "multiselect", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] },
		{ key: "secret", type: "string", hidden: true },
		{ key: "link", type: "external", url: "https://example.com" },
		{ key: "detail", type: "string", required: true, when: [{ key: "ok", op: "eq", value: true }] },
		{ key: "other detail", type: "string", required: true, when: [{ key: "ok", op: "neq", value: true }] },
	],
};
const answers = [
	{ name: "A", detail: "d" }, { name: "A", ok: false, "other detail": "o" }, { name: "A", ok: false }, { name: "A" }, { name: 5 }, {}, { name: "A", detail: "d", color: "blue" },
	{ name: "A", detail: "d", color: "red", other: "anything" }, { name: "A", detail: "d", age: 5 }, { name: "A", detail: "d", age: 5.5 }, { name: "A", detail: "d", age: 0 },
	{ name: "A", detail: "d", age: 10 }, { name: "A", detail: "d", ratio: 0.4 }, { name: "A", detail: "d", ratio: "0.5" }, { name: "A", detail: "d", ok: "yes" },
	{ name: "A", detail: "d", tags: ["a", "b"] }, { name: "A", detail: "d", tags: ["c"] }, { name: "A", detail: "d", tags: "a" }, { name: "A", detail: "d", tags: [1] },
	{ name: "A", detail: "d", unknown: 1 }, { name: "A", detail: "d", link: "x" }, null, [], "text", 7,
];

const cases: unknown[] = [];
const record = (kind: string, input: unknown, output: unknown) => cases.push({ kind, input: JSON.parse(JSON.stringify(input ?? null)), output: JSON.parse(JSON.stringify(output ?? null)) });

record("questions", questions, formFromCodexQuestions(questions));
record("questions", "nope", formFromCodexQuestions("nope"));
record("questions", [{ id: 5 }, null, "x", { id: "ok", options: [{ label: 1, description: 0 }, { label: true, description: "d" }, 7] }], formFromCodexQuestions([{ id: 5 }, null, "x", { id: "ok", options: [{ label: 1, description: 0 }, { label: true, description: "d" }, 7] }]));
record("schema", schema, formFromJsonSchema(schema));
for (const input of [null, "x", [], { type: "array" }, { type: "object" }, { type: "object", properties: {} }, { type: "object", properties: { a: 1 } }, { type: "object", properties: { a: { type: "object" } } }, { type: "object", properties: { a: { type: "array", items: { type: "string" } } } }, { type: "object", properties: { a: { type: "string", enum: [1, 2] } }, required: [1, "a"] }]) {
	record("schema", input, formFromJsonSchema(input));
}
for (const answer of answers) record("answer", { form, answer }, validateFormAnswer(form as never, answer));
for (const result of [{ answer: { a: "x", b: ["y", "z"], c: 3, d: true } }, { cancelled: true }, { answer: {} }]) record("codexAnswers", result, codexAnswersFromForm(result as never));

// A seeded walk over the same inputs, to meet shapes nobody wrote by hand.
const rng = seededRng(4242);
for (let index = 0; index < 300; index += 1) {
	const pick = rng() < 0.5;
	const base = structuredClone(pick ? schema : questions);
	for (let times = 1 + Math.floor(rng() * 2); times > 0; times -= 1) mutateOnce(base as never, rng);
	record(pick ? "schema" : "questions", base, pick ? formFromJsonSchema(base) : formFromCodexQuestions(base));
	const mutatedForm = structuredClone(form);
	mutateOnce(mutatedForm as never, rng);
	const answer = structuredClone(answers[Math.floor(rng() * answers.length)]);
	if (answer && typeof answer === "object") mutateOnce(answer as never, rng);
	try { record("answer", { form: mutatedForm, answer }, validateFormAnswer(mutatedForm as never, answer)); } catch { /* A form that is not a form is not a case. */ }
}
mkdirSync(join(import.meta.dir, "data"), { recursive: true });
writeFileSync(join(import.meta.dir, "data/harness-form.json"), `${JSON.stringify(cases)}\n`);
console.log(`harness form: ${cases.length} cases`);
