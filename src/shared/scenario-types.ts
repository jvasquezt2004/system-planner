import type { DesignFunction } from "./design";
import type { DesignEnumType, SandboxAppliedTable } from "./design";

export const scenarioSupabaseTypePaths = {
	"@supabase/supabase-js": ["node_modules/@supabase/supabase-js/dist/index.d.mts"],
	"@supabase/postgrest-js": ["node_modules/@supabase/postgrest-js/dist/index.d.mts"],
	"@supabase/auth-js": ["node_modules/@supabase/auth-js/dist/module/index.d.ts"],
	"@supabase/functions-js": ["node_modules/@supabase/functions-js/dist/module/index.d.ts"],
	"@supabase/realtime-js": ["node_modules/@supabase/realtime-js/dist/module/index.d.ts"],
	"@supabase/storage-js": ["node_modules/@supabase/storage-js/dist/index.d.mts"],
	"@supabase/phoenix": ["node_modules/@supabase/phoenix/priv/static/types/index.d.ts"],
	"iceberg-js": ["node_modules/iceberg-js/dist/index.d.ts"],
};

export function scenarioTypeLibraryUri(globPath: string): string {
	return `file:///node_modules/${globPath.replace(/^\.\.\/\.\.\/node_modules\//, "")}`;
}

export function scenarioDatabaseTypeUri(designId: string): string {
	return `file:///designs/${encodeURIComponent(designId)}/scenario-database.d.ts`;
}

function typeScriptType(dataType: string, enumTypeName?: string): string {
	if (enumTypeName) return `Database["public"]["Enums"][${JSON.stringify(enumTypeName)}]`;
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
		case "void":
			return "null";
		default:
			return "unknown";
	}
}

function propertyName(name: string): string {
	return /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
}
function functionTypeScriptType(
	dataType: string,
	tables: SandboxAppliedTable[],
	enumTypes: DesignEnumType[],
): string {
	if (enumTypes.some((candidate) => candidate.name === dataType)) {
		return `Database["public"]["Enums"][${JSON.stringify(dataType)}]`;
	}
	const rowType = tables.find((table) => table.name === dataType);
	if (rowType) return `Database["public"]["Tables"][${JSON.stringify(rowType.name)}]["Row"]`;
	const tableReturn = /^TABLE\s*\((.*)\)$/is.exec(dataType.trim());
	if (tableReturn) {
		const properties = tableReturn[1]!.split(",").map((column) => {
			const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s+(.+?)\s*$/.exec(column);
			return match ? `          ${propertyName(match[1]!)}: ${functionTypeScriptType(match[2]!, tables, enumTypes)};` : "";
		}).filter(Boolean);
		return `{\n${properties.join("\n")}\n        }`;
	}
	return typeScriptType(dataType);
}


/** Emits supabase gen types-shaped declarations for one applied revision. */
export function generateScenarioDatabaseTypes(
	tables: SandboxAppliedTable[],
	enumTypes: DesignEnumType[] = [],
	functions: DesignFunction[] = [],
): string {
	const tableEntries = tables.map((table) => {
		const rowProperties = table.columns.map((column) => {
			const nullable = column.nullable ? " | null" : "";
			return `          ${propertyName(column.name)}: ${typeScriptType(column.dataType, column.enumTypeName)}${nullable};`;
		}).join("\n");
		const insertProperties = table.columns.map((column) => {
			const optional = column.nullable || column.isIdentity || column.defaultExpression !== null ? "?" : "";
			const nullable = column.nullable ? " | null" : "";
			return `          ${propertyName(column.name)}${optional}: ${typeScriptType(column.dataType, column.enumTypeName)}${nullable};`;
		}).join("\n");
		const updateProperties = table.columns.map((column) => {
			const nullable = column.nullable ? " | null" : "";
			return `          ${propertyName(column.name)}?: ${typeScriptType(column.dataType, column.enumTypeName)}${nullable};`;
		}).join("\n");
		return `      ${propertyName(table.name)}: {\n        Row: {\n${rowProperties}\n        };\n        Insert: {\n${insertProperties}\n        };\n        Update: {\n${updateProperties}\n        };\n        Relationships: [];\n      };`;
	});
	const enumEntries = enumTypes.map((enumType) =>
		`      ${propertyName(enumType.name)}: ${enumType.labels.map((label) => JSON.stringify(label)).join(" | ") || "never"};`,
	);
	const functionEntries = functions.map((fn) => {
		const args = fn.arguments.map((argument) =>
			`          ${propertyName(argument.name)}: ${functionTypeScriptType(argument.type, tables, enumTypes)};`,
		).join("\n");
		const returns = functionTypeScriptType(fn.returnType, tables, enumTypes);
		return `      ${propertyName(fn.name)}: {\n        Args: {\n${args}\n        };\n        Returns: ${returns}${fn.returnsSet ? "[]" : ""};\n      };`;
	});
	return `type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

import type { SupabaseClient } from "@supabase/supabase-js";
declare global {
  interface Database {
  public: {
    Tables: {
${tableEntries.join("\n")}
    };
    Views: Record<string, never>;
    Functions: {
${functionEntries.join("\n")}
    };
    Enums: {
${enumEntries.join("\n")}
    };
    CompositeTypes: Record<string, never>;
  };
  }
}
declare global {
  const supabase: SupabaseClient<Database>;
  function asUser(userId: string, claims?: Record<string, unknown>): SupabaseClient<Database>;
  function asServiceRole(): SupabaseClient<Database>;
  interface ScenarioExpectation {
    succeeds(): ScenarioExpectation;
    fails(code?: string): ScenarioExpectation;
    returnsDataEqual(expected: unknown): ScenarioExpectation;
  }
  const expect: (result: { data: unknown; error: { code: string; message: string } | null }) => ScenarioExpectation;
}
export {};`;
}
