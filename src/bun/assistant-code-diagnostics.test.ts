import { describe, expect, test } from "bun:test";
import { getAssistantCodeDiagnostics } from "./assistant-code-diagnostics";
import type { SandboxAppliedTable } from "../shared/design";

describe("assistant code diagnostics", () => {
	test("top-level await in a valid scenario yields zero diagnostics", () => {
		const tables: SandboxAppliedTable[] = [
			{
				name: "people",
				columns: [
					{ name: "id", dataType: "integer", isIdentity: true, defaultExpression: null, nullable: false, primaryKey: true, unique: false },
					{ name: "name", dataType: "text", isIdentity: false, defaultExpression: null, nullable: false, primaryKey: false, unique: false },
				],
			},
		];

		const scenarioSource = `
const { data, error } = await supabase.from("people").select("*");
expect({ data, error }).succeeds();
`;

		const diagnostics = getAssistantCodeDiagnostics("scenario", scenarioSource, tables);
		expect(diagnostics).toEqual([]);
	});
});
