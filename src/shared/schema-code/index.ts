import type { Design } from "../design";
import { errorMessage } from "../error-message";
import { generateDjangoModels } from "./django";
import { generateDrizzleSchema } from "./drizzle";
import { generatePrismaSchema } from "./prisma";
import { generateSqlAlchemyModels } from "./sqlalchemy";
import type {
	OrmTarget,
	SchemaCodeFormat,
	SchemaCodeGeneration,
	SchemaCodeGenerator,
	SchemaCodeTarget,
} from "./types";

export type {
	OrmTarget,
	SchemaCodeFormat,
	SchemaCodeGeneration,
	SchemaCodeGenerator,
	SchemaCodeSnapshot,
	SchemaCodeTarget,
} from "./types";

/** The formats in the order the SQL preview offers them. */
export const SCHEMA_CODE_FORMATS: readonly SchemaCodeFormat[] = [
	{
		target: "sql",
		label: "SQL",
		title: "Generated PostgreSQL",
		defaultFileName: "schema.sql",
		fileExtensions: [".sql"],
		lineComment: "--",
	},
	{
		target: "prisma",
		label: "Prisma",
		title: "Prisma schema",
		defaultFileName: "schema.prisma",
		fileExtensions: [".prisma"],
		lineComment: "//",
	},
	{
		target: "drizzle",
		label: "Drizzle",
		title: "Drizzle ORM schema",
		defaultFileName: "schema.ts",
		fileExtensions: [".ts"],
		lineComment: "//",
	},
	{
		target: "sqlalchemy",
		label: "SQLAlchemy",
		title: "SQLAlchemy models",
		defaultFileName: "models.py",
		fileExtensions: [".py"],
		lineComment: "#",
	},
	{
		target: "django",
		label: "Django",
		title: "Django ORM models",
		defaultFileName: "models.py",
		fileExtensions: [".py"],
		lineComment: "#",
	},
];

/** Each ORM generator lives in its own module so they evolve independently. */
const ORM_GENERATORS: Record<OrmTarget, SchemaCodeGenerator> = {
	prisma: generatePrismaSchema,
	drizzle: generateDrizzleSchema,
	sqlalchemy: generateSqlAlchemyModels,
	django: generateDjangoModels,
};

export function isSchemaCodeTarget(value: unknown): value is SchemaCodeTarget {
	return SCHEMA_CODE_FORMATS.some((format) => format.target === value);
}

export function isOrmTarget(value: unknown): value is OrmTarget {
	return isSchemaCodeTarget(value) && value !== "sql";
}

export function schemaCodeFormat(target: SchemaCodeTarget): SchemaCodeFormat {
	const format = SCHEMA_CODE_FORMATS.find((candidate) => candidate.target === target);
	if (!format) throw new Error(`Unknown schema code format: ${target}`);
	return format;
}

/**
 * Generates one ORM format. A generator that throws is reported as an error
 * instead of breaking the preview.
 */
export function generateOrmSchema(target: OrmTarget, design: Design): SchemaCodeGeneration {
	try {
		return ORM_GENERATORS[target](design);
	} catch (cause) {
		return {
			ok: false,
			errors: [
				`${schemaCodeFormat(target).title} could not be generated: ${errorMessage(cause)}`,
			],
		};
	}
}
