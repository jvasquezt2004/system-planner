/**
 * Shared contract for the read-only schema code generated from a design.
 * See GLOSSARY.md: Schema code, Code format.
 */

import type { Design } from "../design";

/** Every code format the SQL preview can show. PostgreSQL is the reference. */
export type SchemaCodeTarget = "sql" | "prisma" | "drizzle" | "sqlalchemy" | "django";

/** ORM formats, which are derived from a design PostgreSQL already accepts. */
export type OrmTarget = Exclude<SchemaCodeTarget, "sql">;

export type SchemaCodeFormat = {
	target: SchemaCodeTarget;
	/** Short name for the format switch. */
	label: string;
	/** Heading above the generated code. */
	title: string;
	/** Suggested export file name. */
	defaultFileName: string;
	/** Lowercase extensions, with the dot, an export file name may end in. */
	fileExtensions: readonly string[];
	/** Line-comment prefix, so the galley can set comments apart. */
	lineComment: string;
};

/**
 * The result of generating one ORM format. A generator only ever receives a
 * design the SQL generator has accepted, so its errors describe what the ORM
 * itself cannot represent, never ordinary draft validation.
 */
export type SchemaCodeGeneration =
	| { ok: true; code: string }
	| { ok: false; errors: string[] };

export type SchemaCodeGenerator = (design: Design) => SchemaCodeGeneration;

/** Exactly the generated code visible when a copy or export starts. */
export type SchemaCodeSnapshot = Readonly<{
	target: OrmTarget;
	revision: number;
	code: string;
}>;
