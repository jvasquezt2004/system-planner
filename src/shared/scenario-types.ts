import type { SandboxAppliedTable } from "./design";

function typeScriptType(dataType: string): string {
	switch (dataType.toLowerCase()) {
		case "smallint":
		case "integer":
		case "bigint":
		case "numeric":
		case "decimal":
		case "real":
		case "double precision":
		case "smallserial":
		case "serial":
		case "bigserial":
			return "number";
		case "boolean":
			return "boolean";
		case "json":
		case "jsonb":
			return "Json";
		case "uuid":
		case "text":
		case "character varying":
		case "character":
		case "date":
		case "time without time zone":
		case "time with time zone":
		case "timestamp without time zone":
		case "timestamp with time zone":
			return "string";
		default:
			return "unknown";
	}
}

function propertyName(name: string): string {
	return /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
}

/** Emits supabase gen types-shaped declarations for one applied revision. */
export function generateScenarioDatabaseTypes(tables: SandboxAppliedTable[]): string {
	const tableEntries = tables.map((table) => {
		const rowProperties = table.columns.map((column) => {
			const nullable = column.nullable ? " | null" : "";
			return `          ${propertyName(column.name)}: ${typeScriptType(column.dataType)}${nullable};`;
		}).join("\n");
		const insertProperties = table.columns.map((column) => {
			const optional = column.nullable || column.isIdentity || column.defaultExpression !== null ? "?" : "";
			const nullable = column.nullable ? " | null" : "";
			return `          ${propertyName(column.name)}${optional}: ${typeScriptType(column.dataType)}${nullable};`;
		}).join("\n");
		const updateProperties = table.columns.map((column) => {
			const nullable = column.nullable ? " | null" : "";
			return `          ${propertyName(column.name)}?: ${typeScriptType(column.dataType)}${nullable};`;
		}).join("\n");
		return `      ${propertyName(table.name)}: {\n        Row: {\n${rowProperties}\n        };\n        Insert: {\n${insertProperties}\n        };\n        Update: {\n${updateProperties}\n        };\n        Relationships: [];\n      };`;
	});
	return `type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export interface Database {
  public: {
    Tables: {
${tableEntries.join("\n")}
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
type ScenarioTables = Database["public"]["Tables"];
type ScenarioRow<T extends keyof ScenarioTables> = ScenarioTables[T]["Row"];
type ScenarioQuery<T> = {
  select(columns?: keyof T | "*"): ScenarioQuery<T>;
  eq(column: keyof T, value: T[keyof T]): ScenarioQuery<T>;
  then<TResult1 = { data: T[]; error: null }, TResult2 = never>(
    onfulfilled?: ((value: { data: T[]; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2>;
};
type ScenarioClient = { from<T extends keyof ScenarioTables>(table: T): ScenarioQuery<ScenarioRow<T>> };
declare const supabase: ScenarioClient;
declare function asUser(userId: string, claims?: Record<string, unknown>): ScenarioClient;
declare function asServiceRole(): ScenarioClient;
declare const expect: (result: unknown) => { succeeds(): void; fails(code?: string): void; returnsData(expected: unknown): void };`;
}
