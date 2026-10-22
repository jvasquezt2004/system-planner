import type { Design } from "../design";
import type { SchemaCodeGeneration } from "./types";

/**
 * Generates the Django ORM models for a design PostgreSQL already accepts.
 * Placeholder until the Django generator lands.
 */
export function generateDjangoModels(_design: Design): SchemaCodeGeneration {
	return { ok: false, errors: ["Django ORM models generation is not available yet."] };
}
