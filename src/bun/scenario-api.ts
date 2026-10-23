import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import type { PGlite as PGliteInstance } from "@electric-sql/pglite";
import type { SandboxApiRequest, SandboxApiResponse, SandboxAppliedTable, ScenarioRequestLogEntry } from "../shared/design";
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
		const schemaTable = tables.find((candidate) => candidate.name === tableName);
		if (!schemaTable) throw unsupported("unknown endpoint or table");
		const columns = new Set(schemaTable.columns.map((column) => column.name));
		const select = url.searchParams.get("select");
		const preferences = (request.headers.prefer ?? "").split(",").map((value) => value.trim()).filter(Boolean);
		if (request.headers.accept?.includes("vnd.pgrst.object")) throw unsupported("single-object responses");
		if (request.headers.range || request.headers["range-unit"]) throw unsupported("range headers");
		if (request.method === "GET") {
			if (preferences.length > 0) throw unsupported("Prefer options on select");
			if (select !== "*") throw unsupported("selecting anything except *");
			const filterEntries = [...url.searchParams.entries()].filter(([key]) => key !== "select");
			if (filterEntries.length !== 1) throw unsupported("select requires exactly one eq filter");
			const [column, expression] = filterEntries[0];
			if (!columns.has(column) || !expression.startsWith("eq.")) throw unsupported("select filters other than eq");
			const result = await database.query(`SELECT * FROM ${quoteIdentifier(tableName)} WHERE ${quoteIdentifier(column)} = $1`, [expression.slice(3)]);
			response = { status: 200, headers: { "content-type": "application/json", "content-range": `0-${Math.max(0, result.rows.length - 1)}/*` }, body: result.rows };
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
		const pgError = error as { code?: string; message?: string; detail?: string; hint?: string };
		const code = pgError.code ?? (error instanceof UnsupportedError ? UNSUPPORTED_CODE : "XX000");
		const message = pgError.message ?? String(error);
		response = {
			status: error instanceof UnsupportedError ? 501 : statusForSqlState(code),
			headers: { "content-type": "application/json" },
			body: { code, message, details: pgError.detail ?? null, hint: pgError.hint ?? null },
		};
	}
	return {
		response,
		entry: { method: request.method, table, filters, status: response.status, result: response.body },
	};
}

export function quoteIdentifier(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
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
