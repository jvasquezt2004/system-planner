import { describe, expect, test } from "bun:test";
import type { SandboxAppliedTable } from "./design";
import { generateScenarioDatabaseTypes } from "./scenario-types";

describe("Scenario Database type generation", () => {
	test("emits applied table and column types with insert optionality", () => {
		const tables: SandboxAppliedTable[] = [{
			name: "Library Items",
			columns: [
				{ name: "item_id", dataType: "integer", isIdentity: true, defaultExpression: "generated", nullable: false, primaryKey: true, unique: false },
				{ name: "title", dataType: "text", isIdentity: false, defaultExpression: null, nullable: false, primaryKey: false, unique: false },
				{ name: "published", dataType: "boolean", isIdentity: false, defaultExpression: null, nullable: true, primaryKey: false, unique: false },
			],
		}];
		const generated = generateScenarioDatabaseTypes(tables);
		expect(generated).toContain('"Library Items":');
		expect(generated).toContain("item_id: number;");
		expect(generated).toContain("title: string;");
		expect(generated).toContain("published: boolean | null;");
		expect(generated).toContain("item_id?: number;");
		expect(generated).toContain("title: string;");
		expect(generated).toContain("published?: boolean | null;");
	});
});
