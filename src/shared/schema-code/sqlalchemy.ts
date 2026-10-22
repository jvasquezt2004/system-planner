import type { Design } from "../design";
import type { SchemaCodeGeneration } from "./types";

/**
 * Generates the SQLAlchemy models for a design PostgreSQL already accepts.
 * Placeholder until the SQLAlchemy generator lands.
 */
export function generateSqlAlchemyModels(_design: Design): SchemaCodeGeneration {
	return { ok: false, errors: ["SQLAlchemy models generation is not available yet."] };
}
