import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import type { PGlite as PGliteInstance } from "@electric-sql/pglite";
import type { SandboxApiRequest, SandboxApiResponse, SandboxAppliedTable, ScenarioRequestLogEntry, ScenarioResultGrid } from "../shared/design";
export type ScenarioRunDatabase = PGliteInstance;
export async function createScenarioRunDatabase(sql: string): Promise<ScenarioRunDatabase> {
	const database = new PGlite({ extensions: { vector } });
	try {
		await database.waitReady;
		await database.exec(sql);
		return database;
	} catch (error) {
		await database.close();
		throw error;
	}
}



export async function captureScenarioResultGrids(
	database: ScenarioRunDatabase,
	tables: SandboxAppliedTable[],
): Promise<ScenarioResultGrid[]> {
	await database.exec("BEGIN");
	try {
		await database.exec("SET LOCAL ROLE postgres");
		const grids: ScenarioResultGrid[] = [];
		for (const table of tables) {
			const primaryKey = table.columns.filter((column) => column.primaryKey).map((column) => column.name);
			const orderBy = primaryKey.length
				? ` ORDER BY ${primaryKey.map(quoteIdentifier).join(", ")}`
				: "";
			const countResult = await database.query<{ total: string | number }>(
				`SELECT count(*) AS total FROM ${quoteIdentifier(table.name)}`,
			);
			const rowResult = await database.query<Record<string, unknown>>(
				`SELECT * FROM ${quoteIdentifier(table.name)}${orderBy} LIMIT 500`,
			);
			grids.push({
				table: table.name,
				columns: table.columns.map((column) => column.name),
				rows: rowResult.rows,
				total: Number(countResult.rows[0]?.total ?? 0),
			});
		}
		await database.exec("COMMIT");
		return grids;
	} catch (error) {
		await database.exec("ROLLBACK");
		throw error;
	}
}

const UNSUPPORTED_CODE = "PGRST_SANDBOX_UNSUPPORTED";

export async function handleSandboxApiRequest(
	database: PGlite,
	tables: SandboxAppliedTable[],
	request: SandboxApiRequest,
): Promise<{ response: SandboxApiResponse; entry: Omit<ScenarioRequestLogEntry, "order"> }> {
	const url = new URL(request.path + (request.query ? `?${request.query}` : ""), "http://sandbox.local");
	const segments = url.pathname.split("/").filter(Boolean);
	const tableName = segments.length === 3 && segments[0] === "rest" && segments[1] === "v1"
		? decodeURIComponent(segments[2])
		: "";
	const filters = Object.fromEntries([...url.searchParams.entries()].filter(([key]) => key !== "select"));
	let response: SandboxApiResponse;
	let table = tableName;
	try {
		if (segments.length !== 3 || segments[0] !== "rest" || segments[1] !== "v1") {
			throw unsupported("endpoint");
		}
		const schemaTable = tables.find((candidate) => candidate.name === tableName);
		if (!schemaTable) throw unsupported("unknown table");
		const columns = new Set(schemaTable.columns.map((column) => column.name));
		const select = url.searchParams.get("select");
		const preferences = (request.headers.prefer ?? "").split(",").map((value) => value.trim()).filter(Boolean);
		if (request.method === "GET" || request.method === "HEAD") {
			if (request.method === "HEAD") throw unsupported("HEAD requests");
			const accept = request.headers.accept ?? "application/json";
			if (preferences.length > 0) {
				if (preferences.some((preference) => preference.startsWith("count="))) throw unsupported("row counts");
				throw unsupported("Prefer options on reads");
			}
			if (!accept.includes("application/json") && !accept.includes("vnd.pgrst.object")) {
				throw unsupported(accept.includes("csv") ? "CSV responses" : accept.includes("plan") ? "explain responses" : "response media type");
			}
			const selected = parseSelection(select, columns);
			const params: unknown[] = [...selected];
			const where: string[] = [];
			let orderBy = "";
			let offset = 0;
			let limit: number | null = null;
			for (const [key, value] of url.searchParams.entries()) {
				if (key === "select") continue;
				if (key === "order") {
					if (orderBy) throw unsupported("multiple order clauses");
					orderBy = parseOrder(value, columns);
				} else if (key === "limit" || key === "offset") {
					if (!/^\d+$/.test(value)) throw unsupported(`${key} value`);
					const number = Number(value);
					if (!Number.isSafeInteger(number)) throw unsupported(`${key} value`);
					if (key === "limit") limit = number;
					else offset = number;
				} else if (key === "or") {
					where.push(parseOr(value, columns, params));
				} else if (key === "and") {
					throw unsupported("and filters");
				} else {
					const column = key;
					if (!columns.has(column)) throw unsupported(`filter column ${column}`);
					where.push(parseFilter(column, value, params));
				}
			}
			const rangeHeader = request.headers.range;
			if (rangeHeader) {
				if (request.headers["range-unit"] && request.headers["range-unit"] !== "items") throw unsupported("range unit");
				const match = /^(\d+)-(\d*)$/.exec(rangeHeader);
				if (!match) throw unsupported("range header");
				const start = Number(match[1]);
				const end = match[2] === "" ? null : Number(match[2]);
				if (!Number.isSafeInteger(start) || (end !== null && (!Number.isSafeInteger(end) || end < start))) {
					throw unsupported("range header");
				}
				offset = start;
				limit = end === null ? null : end - start + 1;
			}
			const jsonProjection = selected.map((column, index) => `$${index + 1}::text, sandbox_table.${quoteIdentifier(column)}`).join(", ");
			const sql = [
				`SELECT jsonb_build_object(${jsonProjection}) AS result FROM ${quoteIdentifier(tableName)} AS sandbox_table`,
				where.length ? `WHERE ${where.join(" AND ")}` : "",
				orderBy ? `ORDER BY ${orderBy}` : "",
				limit === null ? "" : `LIMIT ${limit}`,
				offset ? `OFFSET ${offset}` : "",
			].filter(Boolean).join(" ");
			const result = await database.query<{ result: unknown }>(sql, params);
			const records = result.rows.map((row) => row.result);
			const start = offset;
			const end = records.length ? start + records.length - 1 : start;
			const partial = Boolean(rangeHeader || limit !== null || offset > 0);
			if (request.headers.accept?.includes("vnd.pgrst.object")) {
				if (records.length !== 1) {
					const count = records.length;
					throw new PostgrestError("PGRST116", "JSON object requested, multiple (or no) rows returned", `The result contains ${count} rows`);
				}
				response = { status: 200, headers: { "content-type": "application/vnd.pgrst.object+json", "content-range": `${start}-${end}/*` }, body: records[0] };
			} else {
				response = {
					status: partial ? 206 : 200,
					headers: { "content-type": "application/json", "content-range": `${start}-${end}/*` },
					body: records,
				};
			}
		} else if (request.method === "POST") {
			if ([...url.searchParams.keys()].some((key) => key !== "select")) throw unsupported("insert query options");
			if (select !== null && select !== "*") throw unsupported("insert representation columns other than *");
			if (preferences.length !== 1 || preferences[0] !== "return=representation") {
				throw unsupported("insert requires only Prefer: return=representation");
			}
			const record = request.body ? JSON.parse(request.body) : null;
			if (!record || typeof record !== "object" || Array.isArray(record)) throw unsupported("insert requires one JSON record");
			const fields = Object.keys(record);
			if (fields.length === 0 || fields.some((field) => !columns.has(field))) throw unsupported("insert columns outside the applied table");
			const params = fields.map((field) => (record as Record<string, unknown>)[field]);
			const values = params.map((_, index) => `$${index + 1}`).join(", ");
			const names = fields.map(quoteIdentifier).join(", ");
			const result = await database.query(`INSERT INTO ${quoteIdentifier(tableName)} (${names}) VALUES (${values}) RETURNING *`, params);
			response = { status: 201, headers: { "content-type": "application/json", "content-range": `0-${Math.max(0, result.rows.length - 1)}/*` }, body: result.rows };
		} else {
			throw unsupported(`HTTP ${request.method}`);
		}
	} catch (error) {
		if (error instanceof UnsupportedError || error instanceof PostgrestError) {
			response = {
				status: error instanceof UnsupportedError ? 501 : 406,
				headers: { "content-type": "application/json" },
				body: { code: error instanceof PostgrestError ? error.code : UNSUPPORTED_CODE, message: error.message, details: error instanceof PostgrestError ? error.details : null, hint: null },
			};
		} else {
			const pgError = error as { code?: string; message?: string; detail?: string; hint?: string };
			const code = pgError.code ?? "XX000";
			response = {
				status: statusForSqlState(code),
				headers: { "content-type": "application/json" },
				body: { code, message: pgError.message ?? String(error), details: pgError.detail ?? null, hint: pgError.hint ?? null },
			};
		}
	}
	return {
		response,
		entry: { method: request.method, table, filters, status: response.status, result: response.body },
	};
}
class PostgrestError extends Error {
	constructor(readonly code: string, message: string, readonly details: string | null) {
		super(message);
	}
}

function parseSelection(selection: string | null, columns: Set<string>): string[] {
	if (selection === null) throw unsupported("missing select projection");
	if (selection === "*") return [...columns];
	const selected = selection.split(",");
	if (selected.some((column) => !column || column.trim() !== column || !columns.has(column))) {
		throw unsupported(selection.includes("(") ? "embedded resource selects" : selection.includes(":") ? "aliased selects" : selection.includes("->") ? "JSON-path selects" : "select projection");
	}
	return selected;
}

function parseOrder(value: string, columns: Set<string>): string {
	const terms = value.split(",");
	return terms.map((term) => {
		const parts = term.split(".");
		const [column, direction = "asc", nulls] = parts;
		if (parts.length > 3 || !column) throw unsupported("order syntax");
		if (!columns.has(column)) throw unsupported(`order column ${column}`);
		if (direction !== "asc" && direction !== "desc") throw unsupported("order direction");
		if (nulls && nulls !== "nullsfirst" && nulls !== "nullslast") throw unsupported("order null placement");
		return `${quoteIdentifier(column)} ${direction.toUpperCase()}${nulls ? ` ${nulls === "nullsfirst" ? "NULLS FIRST" : "NULLS LAST"}` : ""}`;
	}).join(", ");
}

function parseFilter(column: string, expression: string, params: unknown[]): string {
	const not = expression.startsWith("not.");
	const body = not ? expression.slice(4) : expression;
	const separator = body.indexOf(".");
	if (separator < 1) throw unsupported("filter operator");
	const operator = body.slice(0, separator);
	const value = body.slice(separator + 1);
	const identifier = quoteIdentifier(column);
	if (operator === "is") {
		if (value === "null") return `${identifier} IS ${not ? "NOT " : ""}NULL`;
		if (value === "true" || value === "false") return `${identifier} IS ${not ? "NOT " : ""}${value.toUpperCase()}`;
		throw unsupported("is filter value");
	}
	if (operator === "in") {
		if (!value.startsWith("(") || !value.endsWith(")")) throw unsupported("in filter syntax");
		const values = splitInValues(value.slice(1, -1));
		if (values.length === 0) throw unsupported("empty in filter");
		params.push(...values);
		const list = values.map((_, index) => `$${params.length - values.length + index + 1}`).join(", ");
		return `${identifier} ${not ? "NOT " : ""}IN (${list})`;
	}
	const sqlOperator: Record<string, string> = {
		eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=", like: "LIKE", ilike: "ILIKE",
	};
	const sql = sqlOperator[operator];
	if (!sql) throw unsupported(`filter operator ${operator}`);
	params.push(value);
	const comparison = `${identifier} ${sql} $${params.length}`;
	return not ? `NOT (${comparison})` : comparison;
}
function parseOr(value: string, columns: Set<string>, params: unknown[]): string {
	if (!value.startsWith("(") || !value.endsWith(")")) throw unsupported("or filter syntax");
	const alternatives = value.slice(1, -1).split(",");
	if (!alternatives.length || alternatives.some((part) => !part)) throw unsupported("or filter syntax");
	return `(${alternatives.map((part) => {
		const first = part.indexOf(".");
		const second = part.indexOf(".", first + 1);
		if (first < 1 || second < 0) throw unsupported("or filter expression");
		const column = part.slice(0, first);
		if (!columns.has(column)) throw unsupported(`filter column ${column}`);
		return parseFilter(column, `${part.slice(first + 1, second)}.${part.slice(second + 1)}`, params);
	}).join(" OR ")})`;
}

function splitInValues(value: string): string[] {
	const values: string[] = [];
	let current = "";
	let quoted = false;
	for (let index = 0; index < value.length; index += 1) {
		const character = value[index];
		if (character === '"' && value[index - 1] !== "\\") quoted = !quoted;
		else if (character === "," && !quoted) {
			values.push(unquoteInValue(current));
			current = "";
		} else current += character;
	}
	if (current || value.length) values.push(unquoteInValue(current));
	return values;
}

function unquoteInValue(value: string): string {
	if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1).replaceAll('\\"', '"').replaceAll("\\\\", "\\");
	return value;
}

class UnsupportedError extends Error {}
function unsupported(feature: string): UnsupportedError {
	return new UnsupportedError(`not supported by the sandbox: ${feature}`);
}
function statusForSqlState(code: string): number {
	if (code === "23505" || code === "23503") return 409;
	if (code === "23502" || code === "23514") return 400;
	if (code.startsWith("23")) return 409;
	if (code.startsWith("42")) return 404;
	return 500;
}

export function quoteIdentifier(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}

