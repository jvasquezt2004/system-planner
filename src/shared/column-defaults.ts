/**
 * Structured column defaults. A default is never handwritten SQL: it is one of
 * a small set of choices that the type registry says the column supports, and a
 * typed literal is validated and encoded here so its content stays a value.
 */

import {
	findColumnTypeInfo,
	type ColumnLiteralType,
	type ColumnType,
} from "./column-types";

export type ColumnDefault =
	| { kind: "none" }
	/** A value written as the column's literal category, never as an expression. */
	| { kind: "literal"; literalType: ColumnLiteralType; value: string }
	| { kind: "currentTimestamp" }
	| { kind: "generateUuid" };

export function noColumnDefault(): ColumnDefault {
	return { kind: "none" };
}

/** The literal category a default value is written in, for display and input. */
export const COLUMN_LITERAL_LABELS: Record<ColumnLiteralType, string> = {
	text: "text value",
	integer: "whole number",
	numeric: "number",
	boolean: "true or false",
	date: "date",
	time: "time",
	timestamp: "timestamp",
	json: "JSON value",
};

export function isColumnLiteralType(value: unknown): value is ColumnLiteralType {
	return (
		value === "text" ||
		value === "integer" ||
		value === "numeric" ||
		value === "boolean" ||
		value === "date" ||
		value === "time" ||
		value === "timestamp" ||
		value === "json"
	);
}

/** Shape check for persisted documents and incoming workspace actions. */
export function isColumnDefault(value: unknown): value is ColumnDefault {
	if (!value || typeof value !== "object") return false;
	const candidate = value as {
		kind?: unknown;
		literalType?: unknown;
		value?: unknown;
	};
	switch (candidate.kind) {
		case "none":
		case "currentTimestamp":
		case "generateUuid":
			return true;
		case "literal":
			return (
				isColumnLiteralType(candidate.literalType) &&
				typeof candidate.value === "string"
			);
		default:
			return false;
	}
}

/**
 * Trims values whose surrounding whitespace is noise while leaving text exactly
 * as the designer wrote it.
 */
export function normalizeColumnDefault(value: ColumnDefault): ColumnDefault {
	switch (value.kind) {
		case "none":
			return { kind: "none" };
		case "currentTimestamp":
			return { kind: "currentTimestamp" };
		case "generateUuid":
			return { kind: "generateUuid" };
		case "literal":
			return {
				kind: "literal",
				literalType: value.literalType,
				value:
					value.literalType === "text" ? value.value : value.value.trim(),
			};
	}
}

export function sameColumnDefault(a: ColumnDefault, b: ColumnDefault): boolean {
	if (a.kind !== b.kind) return false;
	if (a.kind !== "literal" || b.kind !== "literal") return true;
	return a.literalType === b.literalType && a.value === b.value;
}

/**
 * Explains why a default cannot apply to a column type, or null when the
 * combination is valid. The message is a sentence fragment so callers can place
 * it in their own context.
 */
export function columnDefaultProblem(
	type: ColumnType,
	value: ColumnDefault,
): string | null {
	const info = findColumnTypeInfo(type);
	if (!info) return "the column type is not supported";

	switch (value.kind) {
		case "none":
			return null;
		case "currentTimestamp":
			return info.defaults.currentTimestamp
				? null
				: "current timestamp only applies to timestamp columns";
		case "generateUuid":
			return info.defaults.generateUuid
				? null
				: "UUID generation only applies to UUID columns";
		case "literal": {
			const expected = info.defaults.literal;
			if (expected === null) {
				return `a ${type} column does not take a literal default`;
			}
			if (value.literalType !== expected) {
				return `the ${type} type needs a ${COLUMN_LITERAL_LABELS[expected]} default, not a ${COLUMN_LITERAL_LABELS[value.literalType]}`;
			}
			return literalProblem(type, value.literalType, value.value);
		}
	}
}

function literalProblem(
	type: ColumnType,
	literalType: ColumnLiteralType,
	value: string,
): string | null {
	if (value.includes("\u0000")) return "a default value cannot contain the null character";

	switch (literalType) {
		case "text":
			return null;
		case "integer":
			return integerProblem(type, value);
		case "numeric":
			return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)
				? null
				: `“${value}” is not a number`;
		case "boolean":
			return value === "true" || value === "false"
				? null
				: "choose true or false";
		case "date":
			return isCalendarDate(value)
				? null
				: `“${value}” is not a valid date; use an ISO date such as 2024-02-29`;
		case "time":
			return isTime(value)
				? null
				: `“${value}” is not a valid time; use HH:MM:SS, optionally followed by an offset`;
		case "timestamp":
			return isTimestamp(value)
				? null
				: `“${value}” is not a valid timestamp; include a zone, such as 2024-02-29T12:00:00Z`;
		case "json":
			try {
				JSON.parse(value);
				return null;
			} catch {
				return `“${value}” is not valid JSON`;
			}
	}
}

const INTEGER_RANGES: Partial<Record<ColumnType, [bigint, bigint]>> = {
	smallint: [BigInt(-32768), BigInt(32767)],
	integer: [BigInt(-2147483648), BigInt(2147483647)],
	bigint: [BigInt("-9223372036854775808"), BigInt("9223372036854775807")],
};

function integerProblem(type: ColumnType, value: string): string | null {
	if (!/^[+-]?\d+$/.test(value)) return `“${value}” is not a whole number`;
	const range = INTEGER_RANGES[type];
	if (!range) return null;
	const number = BigInt(value);
	if (number < range[0] || number > range[1]) {
		return `“${value}” is outside the ${type} range`;
	}
	return null;
}

function isCalendarDate(value: string): boolean {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (!match) return false;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	if (year < 1 || month < 1 || month > 12 || day < 1) return false;
	return day <= daysInMonth(year, month);
}

function daysInMonth(year: number, month: number): number {
	if (month === 2) {
		const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
		return leap ? 29 : 28;
	}
	return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

const TIMESTAMP_PATTERN =
	/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?(Z|[+-]\d{2}:\d{2})$/;

function isTimestamp(value: string): boolean {
	const match = TIMESTAMP_PATTERN.exec(value);
	if (!match) return false;
	const date = `${match[1]}-${match[2]}-${match[3]}`;
	if (!isCalendarDate(date)) return false;
	if (Number(match[4]) > 23 || Number(match[5]) > 59) return false;
	if (match[6] !== undefined && Number(match[6]) > 59) return false;
	const zone = match[8];
	if (zone === "Z") return true;
	const offsetHours = Number(zone.slice(1, 3));
	const offsetMinutes = Number(zone.slice(4, 6));
	if (offsetHours > 14 || offsetMinutes > 59) return false;
	return offsetHours < 14 || offsetMinutes === 0;
}

function isTime(value: string): boolean {
	const match = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?(Z|[+-]\d{2}:\d{2})?$/.exec(value);
	if (!match) return false;
	if (Number(match[1]) > 23 || Number(match[2]) > 59 || Number(match[3] ?? 0) > 59) return false;
	const zone = match[5];
	if (!zone || zone === "Z") return true;
	const hours = Number(zone.slice(1, 3));
	const minutes = Number(zone.slice(4, 6));
	return hours < 14 ? minutes <= 59 : hours === 14 && minutes === 0;
}

/**
 * Renders the SQL value expression without the `DEFAULT` keyword. Literal
 * content is quoted and its quotes doubled, so it can never become a statement.
 */
export function renderDefaultExpression(value: ColumnDefault, columnType?: ColumnType): string | null {
	switch (value.kind) {
		case "none":
			return null;
		case "currentTimestamp":
			return "CURRENT_TIMESTAMP";
		case "generateUuid":
			return "gen_random_uuid()";
		case "literal":
			switch (value.literalType) {
				case "text":
					return quoteStringLiteral(value.value);
				case "integer":
				case "numeric":
					return value.value;
				case "boolean":
					return value.value;
				case "date":
					return `DATE ${quoteStringLiteral(value.value)}`;
				case "time":
					return columnType === "timetz"
						? `TIME WITH TIME ZONE ${quoteStringLiteral(value.value)}`
						: `TIME ${quoteStringLiteral(value.value)}`;
				case "timestamp":
					return `TIMESTAMP WITH TIME ZONE ${quoteStringLiteral(value.value)}`;
				case "json":
					return `JSONB ${quoteStringLiteral(value.value)}`;
			}
	}
}

/** A short, SQL-shaped description for badges and tooltips. */
export function describeColumnDefault(value: ColumnDefault): string {
	return renderDefaultExpression(value) ?? "No default";
}

function quoteStringLiteral(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}
