/**
 * Differential fixtures for the column type registry helpers and the structured
 * column defaults: which defaults a type accepts and the exact message when it
 * does not, how a default renders as SQL, and how a type with parameters renders.
 *
 * Run from the repository root: bun tauri/fixtures/generate-columns.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { columnDefaultProblem, renderDefaultExpression, type ColumnDefault } from "../../src/shared/column-defaults";
import { COLUMN_TYPE_DEFINITIONS, renderColumnType, type ColumnType, type ColumnTypeParameters } from "../../src/shared/column-types";

const literal = (literalType: string, value: string) => ({ kind: "literal", literalType, value }) as unknown as ColumnDefault;

const LITERALS: Record<string, string[]> = {
	text: ["", " ", "plain", "it's", "'; DROP TABLE x; --", "line\nbreak", "tab\there", "é世界😀", "a\u0000b"],
	integer: [
		"0", "-0", "+5", "7", "-1", "32767", "32768", "-32768", "-32769", "2147483647", "2147483648", "-2147483648", "-2147483649",
		"9223372036854775807", "9223372036854775808", "-9223372036854775808", "-9223372036854775809",
		"99999999999999999999999999999999999999999999", "1.5", "1e3", "0x10", "", " ", " 5", "5 ", "1_000", "−5", "٣", "１２", "+", "-", "NaN",
	],
	numeric: ["0", "1", "-1.5", "+.5", ".5", "5.", ".", "1e5", "1E-5", "1e", "e5", "1.2.3", "Infinity", "NaN", "", " 1", "٣", "1,5", "00012", "-.0e+10", "1e+"],
	boolean: ["true", "false", "TRUE", "False", "t", "1", "", " true"],
	date: [
		"2024-02-29", "2023-02-29", "1900-02-29", "2000-02-29", "0000-01-01", "0001-01-01", "9999-12-31", "2024-00-10", "2024-13-10", "2024-04-31", "2024-04-30",
		"2024-1-1", "24-01-01", "２０２４-01-01", "2024-01-01 ", "2024/01/01", "", "2024-01-00",
	],
	time: [
		"00:00", "23:59", "24:00", "12:30:45", "12:30:60", "12:30:45.123456", "12:30:45.1234567", "12:30:45Z", "12:30+14:00", "12:30+14:01", "12:30-13:59",
		"12:30+15:00", "12:30+13:60", "12:30:45+05:30", "1:30", "12:30:", "", "12:60", "12", "12:30:45.", "٠٩:٣٠",
	],
	timestamp: [
		"2024-02-29T12:00:00Z", "2024-02-29 12:00:00+00:00", "2024-02-29T12:00Z", "2024-02-29T12:00:00", "2024-02-29T12:00:00.123456Z", "2024-02-29T12:00:00.1234567Z",
		"2024-02-29T24:00:00Z", "2024-02-29T12:60:00Z", "2024-02-29T12:00:60Z", "2024-02-29T12:00:00+14:00", "2024-02-29T12:00:00+14:01", "2024-02-29T12:00:00+15:00",
		"2024-02-29T12:00:00-14:00", "2023-02-29T12:00:00Z", "2024-02-29t12:00:00Z", "2024-02-29T12:00:00z", "2024-02-29T12:00:00+0530", "2024-02-29T12:00:00+05:60", "", "now",
	],
	json: ["{}", "[]", "null", "\"x\"", "1", "-0", "1e999", "true", "", " ", "  {\"a\": [1, 2, {\"b\": null}]}  ", "nope", "{\"a\":", "{'a':1}", "[1,]", "{\"a\":1}x", "\u00e9", "\"\\u00e9\""],
};

const NON_LITERAL: ColumnDefault[] = [{ kind: "none" }, { kind: "currentTimestamp" }, { kind: "generateUuid" }];

const types: string[] = [...COLUMN_TYPE_DEFINITIONS.map((definition) => definition.type), "bogus"];
const expectedLiteral = new Map<string, string | null>(COLUMN_TYPE_DEFINITIONS.map((definition) => [definition.type, definition.defaults.literal]));

/** Every default shape for a type: the non-literals, all of its own literal values, and a few of another category. */
const problems: Array<[string, ColumnDefault, string | null]> = [];
for (const type of types) {
	const defaults: ColumnDefault[] = [...NON_LITERAL];
	const own = expectedLiteral.get(type);
	for (const literalType of own ? [own] : []) for (const value of LITERALS[literalType]!) defaults.push(literal(literalType, value));
	for (const other of ["integer", "json", "text"]) if (other !== own) defaults.push(literal(other, LITERALS[other]![3]!));
	for (const value of defaults) problems.push([type, value, columnDefaultProblem(type as ColumnType, value)]);
}

/** Rendering depends only on the literal category and on timetz vs the other column types. */
const renders: Array<[string | null, ColumnDefault, string | null]> = [];
for (const type of [null, "timetz", "time"]) {
	for (const value of NON_LITERAL) renders.push([type, value, renderDefaultExpression(value, (type ?? undefined) as ColumnType | undefined)]);
	for (const [literalType, values] of Object.entries(LITERALS)) {
		for (const value of values) renders.push([type, literal(literalType, value), renderDefaultExpression(literal(literalType, value), (type ?? undefined) as ColumnType | undefined)]);
	}
}

const PARAMETERS: Array<ColumnTypeParameters | undefined> = [
	undefined, {}, { length: 10 }, { length: 0 }, { length: 1.5 }, { precision: 10 }, { precision: 10, scale: 2 }, { precision: 10, scale: 0 }, { scale: 2 },
	{ dimensions: 3 }, { dimensions: 1536, array: true }, { array: true }, { array: false }, { length: 5, array: true }, { length: 5, precision: 4, scale: 1, dimensions: 2 },
];
const renderedTypes: Array<[string, ColumnTypeParameters | null, string]> = [];
for (const type of types) {
	for (const parameters of PARAMETERS) renderedTypes.push([type, parameters ?? null, renderColumnType(type as ColumnType, parameters)]);
}

const accepted = problems.filter(([, , problem]) => problem === null).length;
console.log(`column defaults: ${problems.length} validations (${accepted} accepted), ${renders.length} renders, ${renderedTypes.length} rendered types`);

const outDir = join(import.meta.dir, "data");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "columns.json"), `${JSON.stringify({ problems, renders, renderedTypes })}\n`);
