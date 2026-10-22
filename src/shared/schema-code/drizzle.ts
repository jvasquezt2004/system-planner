import type { Design } from "../design";
import type { SchemaCodeGeneration } from "./types";

/**
 * Generates the Drizzle ORM schema for a design PostgreSQL already accepts.
 * Placeholder until the Drizzle generator lands.
 */
export function generateDrizzleSchema(_design: Design): SchemaCodeGeneration {
	return { ok: false, errors: ["Drizzle ORM schema generation is not available yet."] };
}
