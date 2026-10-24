import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import type { PGlite as PGliteInstance } from "@electric-sql/pglite";
import type { SandboxApiRequest, SandboxApiResponse, SandboxAppliedRelationship, SandboxAppliedTable, ScenarioIdentity, ScenarioRequestLogEntry, ScenarioResultGrid, DesignFunction } from "../shared/design";
import { SUPABASE_SANDBOX_BOOTSTRAP, SUPABASE_SANDBOX_GRANTS } from "./sandbox";
export type ScenarioRunDatabase = PGliteInstance;

export async function createScenarioRunDatabase(sql: string): Promise<ScenarioRunDatabase> {
	const database = new PGlite({ extensions: { vector } });
	try {
		await database.waitReady;
		await database.exec(SUPABASE_SANDBOX_BOOTSTRAP);
		await database.exec(sql);
		await database.exec(SUPABASE_SANDBOX_GRANTS);
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
const ROLE_NAMES: Record<string, true> = { anon: true, authenticated: true, service_role: true };
const BUILTIN_FUNCTION_TYPES: Record<string, true> = {
	smallint: true, integer: true, int: true, bigint: true, numeric: true, decimal: true, real: true,
	"double precision": true, smallserial: true, serial: true, bigserial: true, text: true, varchar: true,
	"character varying": true, char: true, character: true, boolean: true, bool: true, uuid: true,
	date: true, time: true, "time without time zone": true, "time with time zone": true, timestamp: true,
	"timestamp without time zone": true, "timestamp with time zone": true, interval: true, json: true,
	jsonb: true, bytea: true, inet: true, cidr: true, macaddr: true, void: true,
};

export async function handleSandboxApiRequest(
	database: PGlite,
	tables: SandboxAppliedTable[],
	request: SandboxApiRequest,
	relationships: SandboxAppliedRelationship[] = [],
	functions: DesignFunction[] = [],
): Promise<{ response: SandboxApiResponse; entry: Omit<ScenarioRequestLogEntry, "order"> }> {
	if (request.invocation) {
		const response = { status: request.invocation.status, headers: { "content-type": "application/json" }, body: request.invocation.response };
		return {
			response,
			entry: {
				method: "INVOKE",
				table: `functions/${request.invocation.functionName}`,
				filters: {},
				identity: identityFromHeaders(request.headers),
				status: response.status,
				result: response.body,
				invocation: request.invocation,
			},
		};
	}
	const url = new URL(request.path + (request.query ? `?${request.query}` : ""), "http://sandbox.local");
	const segments = url.pathname.split("/").filter(Boolean);
	const tableName = segments.length === 3 && segments[0] === "rest" && segments[1] === "v1"
		? decodeURIComponent(segments[2])
		: "";
	const filters = Object.fromEntries([...url.searchParams.entries()].filter(([key]) => key !== "select" && key !== "columns"));
	const identity = identityFromHeaders(request.headers);
	let response: SandboxApiResponse;
	let table = tableName;
	try {
		response = await database.transaction(async (transaction) => {
			await transaction.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify(identity.claims)]);
			await transaction.query("SELECT set_config('request.jwt.claim.role', $1, true)", [identity.role]);
			await transaction.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [identity.userId ?? ""]);
			await transaction.query(`SET LOCAL ROLE ${identity.role}`);
			if (segments.length === 4 && segments[0] === "rest" && segments[1] === "v1" && segments[2] === "rpc") {
				const functionName = decodeURIComponent(segments[3]!);
				table = `rpc/${functionName}`;
				return await executeFunctionRpc(transaction, url, request, functionName, functions, tables, relationships);
			}
			if (segments.length !== 3 || segments[0] !== "rest" || segments[1] !== "v1") {
				throw unsupported("endpoint");
			}
			const schemaTable = tables.find((candidate) => candidate.name === tableName);
			if (!schemaTable) throw missingTable(tableName, tables);
			const columns = new Set(schemaTable.columns.map((column) => column.name));
			const select = url.searchParams.get("select");
			const preferences = (request.headers.prefer ?? "").split(",").map((value) => value.trim()).filter(Boolean);
			let transactionResponse: SandboxApiResponse | null = null;
			if (request.method === "GET" || request.method === "HEAD") {
				const accept = request.headers.accept ?? "application/json";
				const countPreferences = preferences.filter((preference) => preference.startsWith("count="));
				if (countPreferences.some((preference) => preference !== "count=exact")) {
					throw unsupported("planned and estimated row counts");
				}
				if (preferences.some((preference) => !preference.startsWith("count="))) {
					throw unsupported("Prefer options on reads");
				}
				if (!accept.includes("application/json") && !accept.includes("vnd.pgrst.object")) {
					throw unsupported(accept.includes("csv") ? "CSV responses" : accept.includes("plan") ? "explain responses" : "response media type");
				}
				const exactCount = countPreferences.includes("count=exact");
				const projection = select === null
					? { columns: [...columns], embeds: [] as EmbedSelection[] }
					: parseProjection(select, columns, tables, tableName);
				const embeddedOptions = applyEmbeddedOptions(projection, url.searchParams, tables);
				const params: unknown[] = [];
				const projectionSql = buildProjection(tableName, "sandbox_table", projection, tables, relationships, params);
				const countParams: unknown[] = [];
				const innerEmbeds = projection.embeds.filter((embed) => embed.inner);
				const where = innerEmbeds.map((embed) => buildInnerCondition(tableName, "sandbox_table", embed, relationships, params));
				const countWhere = innerEmbeds.map((embed) => buildInnerCondition(tableName, "sandbox_table", embed, relationships, countParams));
				let orderBy = "";
				let offset = 0;
				let limit: number | null = null;
				for (const [key, value] of url.searchParams.entries()) {
					if (key === "select" || embeddedOptions.has(key)) continue;
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
						countWhere.push(parseOr(value, columns, countParams));
					} else if (key === "and") {
						throw unsupported("and filters");
					} else {
						if (!columns.has(key)) throw unsupported(`filter column ${key}`);
						where.push(parseFilter(key, value, params));
						countWhere.push(parseFilter(key, value, countParams));
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
				const sql = [
					`SELECT ${projectionSql} AS result FROM ${quoteIdentifier(tableName)} AS sandbox_table`,
					where.length ? `WHERE ${where.join(" AND ")}` : "",
					orderBy ? `ORDER BY ${orderBy}` : "",
					limit === null ? "" : `LIMIT ${limit}`,
					offset ? `OFFSET ${offset}` : "",
				].filter(Boolean).join(" ");
				const total = exactCount
					? Number((await transaction.query<{ total: number }>(
						`SELECT count(*)::int AS total FROM ${quoteIdentifier(tableName)} AS sandbox_table${countWhere.length ? ` WHERE ${countWhere.join(" AND ")}` : ""}`,
						countParams,
					)).rows[0]?.total ?? 0)
					: null;
				const result = await transaction.query<{ result: unknown }>(sql, params);
				const records = result.rows.map((row) => row.result);
				const start = offset;
				const end = records.length ? start + records.length - 1 : start;
				const contentRange = total === null
					? records.length ? `${start}-${end}/*` : "*/*"
					: records.length ? `${start}-${end}/${total}` : `*/${total}`;
				const partial = total !== null && (start > 0 || total > records.length);
				const responseHeaders = {
					"content-type": accept.includes("vnd.pgrst.object") ? "application/vnd.pgrst.object+json" : "application/json",
					"content-range": contentRange,
				};
				if (accept.includes("vnd.pgrst.object")) {
					if (records.length !== 1) {
						throw new PostgrestError("PGRST116", "JSON object requested, multiple (or no) rows returned", `The result contains ${records.length} rows`);
					}
					transactionResponse = { status: partial ? 206 : 200, headers: responseHeaders, body: records[0] };
				} else {
					transactionResponse = {
						status: partial ? 206 : 200,
						headers: responseHeaders,
						body: request.method === "HEAD" ? null : records,
					};
				}
			} else if (request.method === "POST" || request.method === "PATCH" || request.method === "DELETE") {
				if ([...url.searchParams.keys()].some((key) =>
					key !== "select" && key !== "on_conflict" && key !== "columns" && key !== "or" && key !== "and" && !columns.has(key)
				)) {
					throw unsupported("write query options");
				}
				const countPreferences = preferences.filter((preference) => preference.startsWith("count="));
				if (countPreferences.some((preference) => preference !== "count=exact")) {
					throw unsupported("planned and estimated row counts");
				}
				const exactCount = countPreferences.includes("count=exact");
				const selected = select === null ? { columns: [...columns], embeds: [] as EmbedSelection[] } : parseProjection(select, columns, tables, tableName);
				const returnPreference = preferences.find((value) => value.startsWith("return="))?.slice(7) ?? "minimal";
				if (preferences.some((value) => value.startsWith("return=") && value !== "return=minimal" && value !== "return=representation")) {
					throw unsupported("write return preference");
				}
				const representation = returnPreference === "representation";
				const resolution = preferences.find((value) => value.startsWith("resolution="));
				if (resolution && resolution !== "resolution=merge-duplicates" && resolution !== "resolution=ignore-duplicates") {
					throw unsupported("upsert resolution preference");
				}
				if (request.method !== "POST" && (resolution || url.searchParams.has("on_conflict"))) {
					throw unsupported("upsert options on non-POST write");
				}
				const missingDefault = preferences.includes("missing=default");
				const where: string[] = [];
				const filterParams: unknown[] = [];
				for (const [key, value] of url.searchParams.entries()) {
					if (key === "select" || key === "on_conflict" || key === "columns") continue;
					if (key === "or") where.push(parseOr(value, columns, filterParams));
					else {
						if (!columns.has(key)) throw unsupported(`filter column ${key}`);
						where.push(parseFilter(key, value, filterParams));
					}
				}
				if (request.method === "POST") {
					const body: unknown = request.body ? JSON.parse(request.body) : null;
					const records = Array.isArray(body) ? body : [body];
					if (!records.length || records.some((record) => !record || typeof record !== "object" || Array.isArray(record))) {
						throw unsupported("insert requires one or more JSON records");
					}
					const fields = [...new Set(records.flatMap((record) => Object.keys(record as object)))];
					if (fields.some((field) => !columns.has(field))) throw unsupported("insert columns outside the applied table");
					const names = fields.map(quoteIdentifier).join(", ");
					const params: unknown[] = [];
					const values = records.map((record) => fields.length === 0 ? "(DEFAULT)" : `(${fields.map((field) => {
						const item = record as Record<string, unknown>;
						if (!(field in item) && missingDefault) return "DEFAULT";
						params.push(item[field] ?? null);
						return `$${params.length}`;
					}).join(", ")})`).join(", ");
					let conflict = "";
					if (resolution || url.searchParams.has("on_conflict")) {
						const target = (url.searchParams.get("on_conflict") ?? schemaTable.columns.filter((column) => column.primaryKey).map((column) => column.name).join(",")).split(",").filter(Boolean);
						if (!target.length || target.some((column) => !columns.has(column))) throw unsupported("upsert on_conflict columns");
						conflict = resolution === "resolution=ignore-duplicates"
							? ` ON CONFLICT (${target.map(quoteIdentifier).join(", ")}) DO NOTHING`
							: ` ON CONFLICT (${target.map(quoteIdentifier).join(", ")}) DO UPDATE SET ${fields.filter((field) => !target.includes(field)).map((field) => `${quoteIdentifier(field)} = EXCLUDED.${quoteIdentifier(field)}`).join(", ") || `${quoteIdentifier(target[0]!)} = EXCLUDED.${quoteIdentifier(target[0]!)}`}`;
					}
					const statement = fields.length === 0
						? records.length === 1
							? `INSERT INTO ${quoteIdentifier(tableName)} DEFAULT VALUES${conflict}`
							: `INSERT INTO ${quoteIdentifier(tableName)} VALUES ${values}${conflict}`
						: `INSERT INTO ${quoteIdentifier(tableName)} (${names}) VALUES ${values}${conflict}`;
					let result: unknown[] | null = null;
					let count: number | null = null;
					if (representation) {
						result = await queryWriteRepresentation(transaction, statement, selected, tableName, tables, relationships, params);
						if (exactCount) count = result.length;
					} else if (exactCount) {
						count = await queryWriteCount(transaction, statement, params);
					} else {
						await transaction.query(statement, params);
					}
					transactionResponse = writeResponse(201, result, representation, count, request.headers.accept);
				} else {
					if (!where.length) throw unsupported("update or delete without filters");
					const clause = ` WHERE ${where.join(" AND ")}`;
					if (request.method === "PATCH") {
						const body: unknown = request.body ? JSON.parse(request.body) : null;
						if (!body || typeof body !== "object" || Array.isArray(body)) throw unsupported("update requires a JSON object");
						const entries = Object.entries(body as Record<string, unknown>);
						if (!entries.length || entries.some(([field]) => !columns.has(field))) throw unsupported("update columns outside the applied table");
						const params = entries.map(([, value]) => value);
						const assignments = entries.map(([field], index) => `${quoteIdentifier(field)} = $${index + 1}`).join(", ");
						const filters = where.map((part) => part.replace(/\$(\d+)/g, (_, n: string) => `$${Number(n) + params.length}`));
						const statement = `UPDATE ${quoteIdentifier(tableName)} SET ${assignments} WHERE ${filters.join(" AND ")}`;
						const writeParams = [...params, ...filterParams];
						let result: unknown[] | null = null;
						let count: number | null = null;
						if (representation) {
							result = await queryWriteRepresentation(transaction, statement, selected, tableName, tables, relationships, writeParams);
							if (exactCount) count = result.length;
						} else if (exactCount) {
							count = await queryWriteCount(transaction, statement, writeParams);
						} else {
							await transaction.query(statement, writeParams);
						}
						transactionResponse = writeResponse(representation ? 200 : 204, result, representation, count, request.headers.accept);
					} else {
						const statement = `DELETE FROM ${quoteIdentifier(tableName)}${clause}`;
						let result: unknown[] | null = null;
						let count: number | null = null;
						if (representation) {
							result = await queryWriteRepresentation(transaction, statement, selected, tableName, tables, relationships, filterParams);
							if (exactCount) count = result.length;
						} else if (exactCount) {
							count = await queryWriteCount(transaction, statement, filterParams);
						} else {
							await transaction.query(statement, filterParams);
						}
						transactionResponse = writeResponse(representation ? 200 : 204, result, representation, count, request.headers.accept);
					}
					}
			} else {
				throw unsupported(`HTTP ${request.method}`);
			}
			if (!transactionResponse) throw unsupported("request returned no response");
			return transactionResponse;
		});
	} catch (error) {
		if (error instanceof UnsupportedError || error instanceof PostgrestError) {
			response = {
				status: error instanceof UnsupportedError ? 501 : error.code === "PGRST202" || error.code === "PGRST205" ? 404 : error.code === "PGRST201" ? 300 : error.code === "PGRST200" ? 400 : 406,
				headers: { "content-type": "application/json" },
				body: {
					code: error instanceof PostgrestError ? error.code : UNSUPPORTED_CODE,
					message: error.message,
					details: error instanceof PostgrestError ? error.details : null,
					hint: error instanceof PostgrestError ? error.hint : null,
				},
			};

		} else {
			const pgError = error as { code?: string; message?: string; detail?: string; hint?: string };
			const code = pgError.code ?? "XX000";
			response = {
				status: statusForSqlState(code, identity.role),
				headers: { "content-type": "application/json" },
				body: { code, message: pgError.message ?? String(error), details: pgError.detail ?? null, hint: pgError.hint ?? null },
			};
		}
	}
	return { response, entry: { method: request.method, table, filters, identity, status: response.status, result: response.body, ...(request.invocationRef ? { invocationRef: request.invocationRef } : {}) } };
}
type RpcTransaction = { query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> };

async function executeFunctionRpc(
	transaction: RpcTransaction,
	url: URL,
	request: SandboxApiRequest,
	name: string,
	functions: DesignFunction[],
	tables: SandboxAppliedTable[],
	relationships: SandboxAppliedRelationship[],
): Promise<SandboxApiResponse> {
	const fn = functions.find((candidate) => candidate.name === name);
	if (!fn) throw new PostgrestError("PGRST202", `Could not find the function public.${name} without parameters in the schema cache`, null);
	if (request.method !== "POST" && request.method !== "GET") throw unsupported("function HTTP method");
	if (request.method === "GET" && fn.volatility === "volatile") {
		throw unsupported("GET for volatile functions");
	}
	const argumentNames = new Set(fn.arguments.map((argument) => argument.name));
	const resultTable = tables.find((table) => table.name === fn.returnType);
	const tableColumns = resultTable?.columns.map((column) => column.name) ?? functionTableReturnColumns(fn.returnType);
	const queryKeys = [...url.searchParams.keys()];
	const unsupportedOptions = queryKeys.filter((key) =>
		!argumentNames.has(key) && !(key === "select" || key.includes(".")) &&
		["order", "limit", "offset", "or", "and"].includes(key),
	);
	if (unsupportedOptions.length > 0) throw unsupported("filters or query options on function results");
	const supplied: Record<string, unknown> = {};
	if (request.method === "GET") {
		for (const [key, value] of url.searchParams) {
			if (argumentNames.has(key)) supplied[key] = value;
			else if (!(key === "select" || key.includes("."))) {
				if (tableColumns?.includes(key)) throw unsupported("filters on function results");
				throw new PostgrestError("PGRST202", `Could not find the function public.${name} with the supplied parameter names`, null);
			}
		}
	} else {
		if (queryKeys.some((key) => !(key === "select" || key.includes(".")))) {
			throw unsupported("query options on POST function calls");
		}
		const body: unknown = request.body ? JSON.parse(request.body) : {};
		if (!body || typeof body !== "object" || Array.isArray(body)) throw unsupported("function arguments must be a JSON object");
		Object.assign(supplied, body);
	}
	if (Object.keys(supplied).some((key) => !argumentNames.has(key))) {
		throw new PostgrestError("PGRST202", `Could not find the function public.${name} with the supplied parameter names`, null);
	}
	if (fn.arguments.some((argument) => !(argument.name in supplied))) {
		throw new PostgrestError("PGRST202", `Could not find the function public.${name} with the supplied parameter names`, null);
	}
	const params = fn.arguments.map((argument) => supplied[argument.name]);
	const invocation = `public.${quoteIdentifier(name)}(${fn.arguments.map((argument, index) => `${quoteIdentifier(argument.name)} => $${index + 1}::${renderRpcArgumentType(argument.type, tables)}`).join(", ")})`;
	const select = url.searchParams.get("select");
	const resultOptionKeys = queryKeys.filter((key) => !argumentNames.has(key) && (key === "select" || key.includes(".")));
	if (!tableColumns && resultOptionKeys.length) throw unsupported("function result projection");
	if (fn.returnType.trim().toLowerCase() === "void" && !fn.returnsSet) {
		await transaction.query(`SELECT ${invocation}`, params);
		return { status: 200, headers: { "content-type": "application/json" }, body: null };
	}
	if (tableColumns) {
		const sourceName = resultTable?.name ?? fn.returnType;
		const projection = select === null
			? { columns: tableColumns, embeds: [] as EmbedSelection[] }
			: parseProjection(select, new Set(tableColumns), tables, sourceName);
		const handledOptions = applyEmbeddedOptions(projection, url.searchParams, tables);
		if (resultOptionKeys.some((key) => key !== "select" && !handledOptions.has(key))) {
			throw unsupported("function result query options");
		}
		const queryParams = [...params];
		const projectionSql = buildProjection(sourceName, "_rpc_result", projection, tables, relationships, queryParams);
		const result = await transaction.query<{ result: unknown }>(
			`SELECT ${projectionSql} AS result FROM ${invocation} AS _rpc_result`,
			queryParams,
		);
		const body = fn.returnsSet ? result.rows.map((row) => row.result) : result.rows[0]?.result ?? null;
		return { status: 200, headers: { "content-type": "application/json" }, body };
	}
	const result = fn.returnsSet
		? await transaction.query<{ result: unknown }>(`SELECT to_jsonb(_rpc_result) AS result FROM ${invocation} AS _rpc_result`, params)
		: await transaction.query<{ result: unknown }>(`SELECT to_jsonb(${invocation}) AS result`, params);
	const body = fn.returnsSet ? result.rows.map((row) => row.result) : result.rows[0]?.result ?? null;
	return { status: 200, headers: { "content-type": "application/json" }, body };
}

function functionTableReturnColumns(returnType: string): string[] | null {
	const match = /^\s*TABLE\s*\((.*)\)\s*$/is.exec(returnType);
	if (!match) return null;
	return splitSelection(match[1]!).map((definition) => {
		const column = /^\s*(?:"((?:[^"]|"")*)"|([A-Za-z_][A-Za-z0-9_$]*))\s+/.exec(definition);
		if (!column) throw unsupported("function TABLE return columns");
		return column[1]?.replaceAll('""', '"') ?? column[2]!;
	});
}

function renderRpcArgumentType(value: string, tables: SandboxAppliedTable[]): string {
	const normalized = value.trim();
	const baseType = normalized.replace(/\[\]$/, "").trim().toLowerCase();
	if (tables.some((table) => table.name === normalized)) return quoteIdentifier(normalized);
	if (!BUILTIN_FUNCTION_TYPES[baseType] && /^[A-Za-z_][A-Za-z0-9_]*$/.test(baseType)) {
		return `${quoteIdentifier(normalized.replace(/\[\]$/, ""))}${normalized.endsWith("[]") ? "[]" : ""}`;
	}
	return normalized;
}

function identityFromHeaders(headers: Record<string, string>): ScenarioIdentity {
	const authorization = Object.entries(headers).find(([name]) => name.toLowerCase() === "authorization")?.[1] ?? "";
	const token = authorization.match(/^Bearer\s+[^.]+\.([^.]+)\./i)?.[1];
	if (!token) return { role: "anon", claims: { role: "anon" } };
	try {
		const payload = JSON.parse(atob(token.replaceAll("-", "+").replaceAll("_", "/"))) as Record<string, unknown>;
		const role = typeof payload.role === "string" && ROLE_NAMES[payload.role] ? payload.role as ScenarioIdentity["role"] : "anon";
		const claims = { ...payload, role };
		const userId = typeof payload.sub === "string" ? payload.sub : undefined;
		return { role, ...(userId ? { userId } : {}), claims };
	} catch {
		return { role: "anon", claims: { role: "anon" } };
	}
}
class PostgrestError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly details: unknown,
		readonly hint: string | null = null,
	) {
		super(message);
	}
}
function missingTable(name: string, tables: SandboxAppliedTable[]): PostgrestError {
	const normalizedName = name.toLowerCase();
	let bestMatch: { name: string; similarity: number } | null = null;
	for (const table of tables) {
		const candidate = table.name.toLowerCase();
		const maxLength = Math.max(normalizedName.length, candidate.length);
		const similarity = maxLength === 0 ? 1 : 1 - editDistance(normalizedName, candidate) / maxLength;
		if (similarity >= 0.75 && (!bestMatch || similarity > bestMatch.similarity)) {
			bestMatch = { name: table.name, similarity };
		}
	}
	const hint = bestMatch ? `Perhaps you meant the table 'public.${bestMatch.name}'` : null;
	return new PostgrestError(
		"PGRST205",
		`Could not find the table 'public.${name}' in the schema cache`,
		null,
		hint,
	);
}
function editDistance(left: string, right: string): number {
	const distances = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let row = 1; row <= left.length; row += 1) {
		let diagonal = distances[0]!;
		distances[0] = row;
		for (let column = 1; column <= right.length; column += 1) {
			const above = distances[column]!;
			distances[column] = Math.min(
				distances[column]! + 1,
				distances[column - 1]! + 1,
				diagonal + (left[row - 1] === right[column - 1] ? 0 : 1),
			);
			diagonal = above;
		}
	}
	return distances[right.length]!;
}
function missingRelationship(source: string, target: string): PostgrestError {
	return new PostgrestError(
		"PGRST200",
		`Could not find a relationship between '${source}' and '${target}' in the schema cache`,
		null,
		`Verify that '${source}' and '${target}' exist in the schema 'public' and that a foreign key relationship exists between them. If a new relationship was created, try reloading the schema cache.`,
	);
}

type EmbedSelection = {
	resource: string;
	hint?: string;
	inner: boolean;
	columns: string[];
	embeds: EmbedSelection[];
	filters: [string, string][];
	orderBy?: string;
	limit?: number;
};
type Projection = { columns: string[]; embeds: EmbedSelection[] };

function parseProjection(selection: string, columns: Set<string>, tables: SandboxAppliedTable[], tableName: string): Projection {
	const tokens = splitSelection(selection);
	const projection: Projection = { columns: [], embeds: [] };
	for (const token of tokens) {
		if (token === "*") {
			projection.columns.push(...columns);
			continue;
		}
		const parsed = parseProjectionToken(token);
		if (!parsed) {
			if (token.includes(":")) throw unsupported("aliased selects");
			if (token.includes("->")) throw unsupported("JSON-path selects");
			throw unsupported("select projection");
		}
		const { resource, hint, nested } = parsed;
		if (nested === null) {
			if (!columns.has(resource)) throw unsupported("select projection");
			projection.columns.push(resource);
			continue;
		}
		const inner = hint === "inner" || hint?.endsWith("!inner") === true;
		const foreignKeyHint = inner && hint === "inner" ? undefined : hint?.replace(/!inner$/, "");
		const targetTable = tables.find((candidate) => candidate.name === resource);
		if (!targetTable) throw missingRelationship(tableName, resource);
		const targetColumns = new Set(targetTable.columns.map((column) => column.name));
		const child = nested === "*" ? { columns: [...targetColumns], embeds: [] as EmbedSelection[] } : parseProjection(nested, targetColumns, tables, resource);
		projection.embeds.push({
			resource,
			...(foreignKeyHint ? { hint: foreignKeyHint } : {}),
			inner,
			columns: child.columns,
			embeds: child.embeds,
			filters: [],
		});
	}
	return projection;
}

function parseProjectionToken(token: string): { resource: string; hint?: string; nested: string | null } | null {
	let index = 0;
	const readIdentifier = (): string | null => {
		if (token[index] === '"') {
			index += 1;
			let value = "";
			while (index < token.length) {
				const character = token[index++]!;
				if (character !== '"') value += character;
				else if (token[index] === '"') {
					value += '"';
					index += 1;
				} else return value;
			}
			return null;
		}
		const start = index;
		while (index < token.length && !["!", "(", ")"].includes(token[index]!)) index += 1;
		return index > start ? token.slice(start, index) : null;
	};
	const resource = readIdentifier();
	if (!resource) return null;
	let hint: string | undefined;
	if (token[index] === "!") {
		index += 1;
		hint = readIdentifier() ?? undefined;
		if (!hint) return null;
		while (token[index] === "!") {
			index += 1;
			const modifier = readIdentifier();
			if (!modifier) return null;
			hint += `!${modifier}`;
		}
	}
	let nested: string | null = null;
	if (token[index] === "(") {
		const start = ++index;
		let depth = 1;
		let quoted = false;
		while (index < token.length && depth) {
			const character = token[index]!;
			if (character === '"' && token[index + 1] === '"' && quoted) index += 1;
			else if (character === '"') quoted = !quoted;
			else if (!quoted && character === "(") depth += 1;
			else if (!quoted && character === ")") depth -= 1;
			index += 1;
		}
		if (depth !== 0) return null;
		nested = token.slice(start, index - 1);
	}
	return index === token.length ? { resource, ...(hint ? { hint } : {}), nested } : null;
}
function applyEmbeddedOptions(
	projection: Projection,
	query: URLSearchParams,
	tables: SandboxAppliedTable[],
): Set<string> {
	const handled = new Set<string>();
	for (const embed of projection.embeds) {
		const table = tables.find((candidate) => candidate.name === embed.resource);
		if (!table) continue;
		const columns = new Set(table.columns.map((column) => column.name));
		for (const [key, value] of query.entries()) {
			const prefix = `${embed.resource}.`;
			if (!key.startsWith(prefix)) continue;
			const option = key.slice(prefix.length);
			if (option === "limit") {
				if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw unsupported("embedded limit value");
				embed.limit = Number(value);
			} else if (option === "order") {
				if (embed.orderBy) throw unsupported("multiple embedded order clauses");
				embed.orderBy = parseOrder(value, columns);
			} else {
				if (!columns.has(option)) throw unsupported(`embedded filter column ${option}`);
				embed.filters.push([option, value]);
			}
			handled.add(key);
		}
	}
	return handled;
}


function splitSelection(value: string): string[] {
	const parts: string[] = [];
	let start = 0;
	let depth = 0;
	let quoted = false;
	for (let index = 0; index < value.length; index += 1) {
		if (value[index] === '"' && value[index + 1] === '"' && quoted) {
			index += 1;
			continue;
		}
		if (value[index] === '"') quoted = !quoted;
		else if (!quoted && value[index] === "(") depth += 1;
		else if (!quoted && value[index] === ")") depth -= 1;
		else if (!quoted && value[index] === "," && depth === 0) {
			parts.push(value.slice(start, index));
			start = index + 1;
		}
		if (depth < 0) throw unsupported("select syntax");
	}
	if (depth !== 0 || quoted) throw unsupported("select syntax");
	parts.push(value.slice(start));
	return parts;
}

function buildProjection(
	tableName: string,
	alias: string,
	projection: Projection,
	tables: SandboxAppliedTable[],
	relationships: SandboxAppliedRelationship[],
	params: unknown[],
): string {
	const expressions = projection.columns.map((column) => {
		params.push(column);
		return `$${params.length}::text, ${alias}.${quoteIdentifier(column)}`;
	});
	for (const embed of projection.embeds) {
		const candidates: {
			relationship: SandboxAppliedRelationship;
			side: "to-one" | "to-many" | "many-to-many";
			through?: SandboxAppliedRelationship;
		}[] = [];
		for (const relationship of relationships) {
			if (relationship.referencingTable === tableName && relationship.referencedTable === embed.resource) {
				candidates.push({ relationship, side: "to-one" });
			} else if (relationship.referencedTable === tableName && relationship.referencingTable === embed.resource) {
				candidates.push({ relationship, side: "to-many" });
			}
		}
		if (!candidates.length) {
			for (const fromParent of relationships.filter((relationship) => relationship.referencedTable === tableName)) {
				for (const toTarget of relationships.filter((relationship) =>
					relationship.referencingTable === fromParent.referencingTable && relationship.referencedTable === embed.resource
				)) {
					candidates.push({ relationship: fromParent, through: toTarget, side: "many-to-many" });
				}
			}
		}
		const matching = candidates.filter(({ relationship, through }) =>
			!embed.hint || relationship.name === embed.hint || relationship.referencingColumn === embed.hint ||
			through?.name === embed.hint || through?.referencingColumn === embed.hint
		);
		if (!matching.length) {
			throw missingRelationship(tableName, embed.resource);
		}
		if (matching.length > 1) {
			const message = `Could not embed because more than one relationship was found for '${tableName}' and '${embed.resource}'`;
			const details = matching.map(({ relationship, side, through }) => {
				const target = tables.find((candidate) => candidate.name === embed.resource);
				const unique = side === "to-many" && target?.columns.some((column) => column.name === relationship.referencingColumn && column.unique);
				const cardinality = side === "to-one" ? "many-to-one" : side === "many-to-many" ? "many-to-many" : unique ? "one-to-one" : "one-to-many";
				const reference = through ?? relationship;
				return {
					cardinality,
					embedding: `${tableName} with ${embed.resource}`,
					relationship: `${reference.name} using ${reference.referencingTable}(${reference.referencingColumn}) and ${reference.referencedTable}(${reference.referencedColumn})`,
				};
			});
			const hint = `Try changing '${embed.resource}' to one of the following: ${matching.map(({ relationship, through }) => `'${embed.resource}!${through?.name ?? relationship.name}'`).join(", ")}. Find the desired relationship in the 'details' key.`;
			throw new PostgrestError("PGRST201", message, details, hint);
		}
		const { relationship, side, through } = matching[0]!;
		const target = tables.find((table) => table.name === embed.resource);
		if (!target) throw new PostgrestError("PGRST200", `Could not find table '${embed.resource}' in the schema cache`, null);
		const childAlias = `embed_${params.length}`;
		const junctionAlias = `junction_${params.length}`;
		const selected = embed.columns.length ? embed.columns : target.columns.map((column) => column.name);
		const childProjection = buildProjection(embed.resource, childAlias, { columns: selected, embeds: embed.embeds }, tables, relationships, params);
		params.push(embed.resource);
		const label = `$${params.length}::text`;
		const unique = side === "to-one" || (side === "to-many" && target.columns.some((column) => column.name === relationship.referencingColumn && column.unique));
		const from = side === "many-to-many"
			? `${quoteIdentifier(embed.resource)} AS ${childAlias} JOIN ${quoteIdentifier(relationship.referencingTable)} AS ${junctionAlias} ON ${junctionAlias}.${quoteIdentifier(through!.referencingColumn)} = ${childAlias}.${quoteIdentifier(through!.referencedColumn)}`
			: `${quoteIdentifier(embed.resource)} AS ${childAlias}`;
		const link = side === "to-one"
			? `${alias}.${quoteIdentifier(relationship.referencingColumn)} = ${childAlias}.${quoteIdentifier(relationship.referencedColumn)}`
			: side === "many-to-many"
				? `${junctionAlias}.${quoteIdentifier(relationship.referencingColumn)} = ${alias}.${quoteIdentifier(relationship.referencedColumn)}`
				: `${childAlias}.${quoteIdentifier(relationship.referencingColumn)} = ${alias}.${quoteIdentifier(relationship.referencedColumn)}`;
		const childWhere = [link, ...embed.filters.map(([column, value]) => parseFilter(column, value, params))].join(" AND ");
		const order = embed.orderBy ? ` ORDER BY ${embed.orderBy}` : "";
		const rowLimit = embed.limit === undefined ? "" : ` LIMIT ${embed.limit}`;
		const subquery = unique
			? `(SELECT ${childProjection} FROM ${from} WHERE ${childWhere}${order}${rowLimit})`
			: `(SELECT COALESCE(jsonb_agg(embed_rows.payload), '[]'::jsonb) FROM (SELECT ${childProjection} AS payload FROM ${from} WHERE ${childWhere}${order}${rowLimit}) AS embed_rows)`;
		expressions.push(`${label}, ${unique ? `COALESCE(${subquery}, 'null'::jsonb)` : subquery}`);
	}
	if (!expressions.length) throw unsupported("empty select projection");
	return `jsonb_build_object(${expressions.join(", ")})`;
}
function buildInnerCondition(
	tableName: string,
	alias: string,
	embed: EmbedSelection,
	relationships: SandboxAppliedRelationship[],
	params: unknown[],
): string {
	const direct = relationships.filter((relationship) =>
		(relationship.referencingTable === tableName && relationship.referencedTable === embed.resource) ||
		(relationship.referencedTable === tableName && relationship.referencingTable === embed.resource)
	).filter((relationship) =>
		!embed.hint || relationship.name === embed.hint || relationship.referencingColumn === embed.hint
	);
	if (direct.length === 1) {
		const relationship = direct[0]!;
		const sourceReferencesTarget = relationship.referencingTable === tableName;
		const targetAlias = "inner_embed";
		const link = sourceReferencesTarget
			? `${alias}.${quoteIdentifier(relationship.referencingColumn)} = ${targetAlias}.${quoteIdentifier(relationship.referencedColumn)}`
			: `${targetAlias}.${quoteIdentifier(relationship.referencingColumn)} = ${alias}.${quoteIdentifier(relationship.referencedColumn)}`;
		const filters = embed.filters.map(([column, value]) => parseFilter(column, value, params));
		return `EXISTS (SELECT 1 FROM ${quoteIdentifier(embed.resource)} AS ${targetAlias} WHERE ${[link, ...filters].join(" AND ")})`;
	}
	if (direct.length > 1) throw new PostgrestError("PGRST201", `Could not embed because more than one relationship was found for '${tableName}' and '${embed.resource}'`, direct.map((relationship) => relationship.name).join(", "));
	const junctionCandidates = relationships.flatMap((fromParent) =>
		relationships.filter((toTarget) => fromParent.referencingTable === toTarget.referencingTable &&
			fromParent.referencedTable === tableName && toTarget.referencedTable === embed.resource)
			.map((toTarget) => ({ fromParent, toTarget }))
	).filter(({ fromParent, toTarget }) =>
		!embed.hint || fromParent.name === embed.hint || fromParent.referencingColumn === embed.hint ||
		toTarget.name === embed.hint || toTarget.referencingColumn === embed.hint
	);
	if (junctionCandidates.length === 1) {
		const { fromParent, toTarget } = junctionCandidates[0]!;
		const junctionAlias = "inner_junction";
		const targetAlias = "inner_target";
		const filters = embed.filters.map(([column, value]) => parseFilter(column, value, params));
		return `EXISTS (SELECT 1 FROM ${quoteIdentifier(fromParent.referencingTable)} AS ${junctionAlias} JOIN ${quoteIdentifier(embed.resource)} AS ${targetAlias} ON ${junctionAlias}.${quoteIdentifier(toTarget.referencingColumn)} = ${targetAlias}.${quoteIdentifier(toTarget.referencedColumn)} WHERE ${junctionAlias}.${quoteIdentifier(fromParent.referencingColumn)} = ${alias}.${quoteIdentifier(fromParent.referencedColumn)}${filters.length ? ` AND ${filters.join(" AND ")}` : ""})`;
	}
	if (junctionCandidates.length > 1) {
		throw new PostgrestError("PGRST201", `Could not embed because more than one relationship was found for '${tableName}' and '${embed.resource}'`, junctionCandidates.map(({ fromParent }) => fromParent.name).join(", "));
	}
	throw missingRelationship(tableName, embed.resource);
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

async function queryWriteRepresentation(
	transaction: { query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> },
	statement: string,
	projection: Projection,
	tableName: string,
	tables: SandboxAppliedTable[],
	relationships: SandboxAppliedRelationship[],
	params: unknown[],
): Promise<unknown[]> {
	const queryParams = [...params];
	const jsonProjection = buildProjection(tableName, "written", projection, tables, relationships, queryParams);
	const result = await transaction.query<{ result: unknown }>(
		`WITH written AS (${statement} RETURNING *) SELECT ${jsonProjection} AS result FROM written AS written`,
		queryParams,
	);
	return result.rows.map((row) => row.result);
}

async function queryWriteCount(
	transaction: { query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> },
	statement: string,
	params: unknown[],
): Promise<number> {
	const result = await transaction.query<{ total: number }>(
		`WITH written AS (${statement} RETURNING *) SELECT count(*)::int AS total FROM written`,
		params,
	);
	return Number(result.rows[0]?.total ?? 0);
}

function writeResponse(
	status: number,
	rows: unknown[] | null,
	representation: boolean,
	count: number | null,
	accept = "application/json",
): SandboxApiResponse {
	const singular = accept.includes("vnd.pgrst.object");
	if (representation && singular && rows?.length !== 1) {
		throw new PostgrestError("PGRST116", "JSON object requested, multiple (or no) rows returned", `The result contains ${rows?.length ?? 0} rows`);
	}
	const headers: Record<string, string> = {};
	if (representation) headers["content-type"] = singular ? "application/vnd.pgrst.object+json" : "application/json";
	if (count !== null) headers["content-range"] = rows?.length ? `0-${rows.length - 1}/${count}` : `*/${count}`;
	return { status, headers, body: representation ? singular ? rows![0] : rows ?? [] : null };
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
	params.push(operator === "like" || operator === "ilike" ? value.replaceAll("*", "%") : value);
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
function statusForSqlState(code: string, role: string): number {
	if (/^PT\d{3}$/.test(code)) return Number(code.slice(2));
	if (code.startsWith("08")) return 503;
	if (code === "42501") return role === "anon" ? 401 : 403;
	if (code === "25006") return 405;
	if (code === "42P01" || code === "42883") return 404;
	if (code === "23505" || code === "23503") return 409;
	if (code === "23502" || code === "23514" || code === "P0001" || code === "42601") return 400;
	if (code.startsWith("22")) return 400;
	return 400;
}

export function quoteIdentifier(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}

