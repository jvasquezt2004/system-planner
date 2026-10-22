import type { Design } from "../design";
import type { SchemaCodeGeneration } from "./types";

/**
 * Generates the Prisma schema for a design PostgreSQL already accepts.
 * Placeholder until the Prisma generator lands.
 */
export function generatePrismaSchema(_design: Design): SchemaCodeGeneration {
	return { ok: false, errors: ["Prisma schema generation is not available yet."] };
}
