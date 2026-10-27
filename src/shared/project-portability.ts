import type { Design } from "./design";
import { errorMessage } from "./error-message";
import { normalizeSystemDesign, type SystemDesign, type SystemViewName } from "./system-design";
import { normalizeWalkthroughs, type Walkthrough } from "./walkthrough";

/**
 * The portable Project document: a versioned, editable copy of one Project's
 * System design, every database Design with its Scenarios and Edge functions,
 * and its named Walkthroughs. It is deliberately narrow. Provider credentials
 * and Assistant conversation history are never part of it. An import reads the
 * fields listed here and ignores any other top-level field.
 *
 * Imports never reuse stored identities for the Project or its Designs; they
 * get fresh ones, and every Database component's link follows its Design. The
 * other ids (Components, Services, Connections, Walkthroughs, steps, handlers,
 * Scenarios) stay as authored because they are scoped to their Project or Design.
 */
export const PROJECT_EXPORT_FORMAT = "schema-designer.project";
export const PROJECT_EXPORT_VERSION = 1;
export const PROJECT_EXPORT_FILE_SUFFIX = ".schema-designer.json";

/** Scenario and Edge function identities are scoped to their Design. */
export type ProjectExportScenario = { id: string; name: string; source: string };
export type ProjectExportEdgeFunction = { id: string; name: string; source: string };

export type ProjectExportDesign = {
	id: string;
	/** Empty for Designs created before names existed. */
	name: string;
	design: Design;
	scenarios: ProjectExportScenario[];
	edgeFunctions: ProjectExportEdgeFunction[];
};

export type ProjectExportDocument = {
	format: typeof PROJECT_EXPORT_FORMAT;
	version: typeof PROJECT_EXPORT_VERSION;
	project: {
		name: string;
		activeDesignId: string;
		/** The view the Project reopens to. */
		activeView: SystemViewName;
	};
	/** Components, Services, Groups, Connections, and saved presentation: viewport and collapsed Services. */
	systemDesign: SystemDesign;
	designs: ProjectExportDesign[];
	walkthroughs: Walkthrough[];
};

export type ProjectExportInput = {
	projectName: string;
	activeDesignId: string;
	activeView: SystemViewName;
	systemDesign: SystemDesign;
	walkthroughs: Walkthrough[];
	designs: ProjectExportDesign[];
};

/** What an import creates: every identity is new, and every reference is already remapped. */
export type PreparedProjectImport = {
	project: { id: string; name: string };
	activeDesignId: string;
	activeView: SystemViewName;
	designs: Array<ProjectExportDesign & { id: string }>;
	systemDesign: SystemDesign;
	walkthroughs: Walkthrough[];
};

/** The outcome of a file-level export or import, as the view receives it. */
export type ProjectTransferResult =
	| { status: "exported"; path: string; name: string }
	| { status: "imported"; projectId: string; name: string }
	| { status: "cancelled" }
	| { status: "failed"; error: string };

/** A file or document that cannot be imported. The message says what is wrong and where. */
export class ProjectImportError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProjectImportError";
	}
}

const EDGE_FUNCTION_NAME_PATTERN = /^[a-z0-9_-]+$/;
const SCENARIO_NAME_LIMIT = 80;

export function createProjectExportDocument(input: ProjectExportInput): ProjectExportDocument {
	const systemDesign = input.systemDesign;
	return structuredClone({
		format: PROJECT_EXPORT_FORMAT,
		version: PROJECT_EXPORT_VERSION,
		project: {
			name: input.projectName,
			activeDesignId: input.activeDesignId,
			activeView: input.activeView,
		},
		systemDesign: {
			services: systemDesign.services,
			groups: systemDesign.groups,
			components: systemDesign.components,
			connections: systemDesign.connections,
			viewport: systemDesign.viewport,
			collapsedServiceIds: systemDesign.collapsedServiceIds,
			focusedServiceId: systemDesign.focusedServiceId,
			focusViewport: systemDesign.focusViewport,
		},
		designs: input.designs.map((design) => ({
			id: design.id,
			name: design.name,
			design: design.design,
			scenarios: design.scenarios.map(({ id, name, source }) => ({ id, name, source })),
			edgeFunctions: design.edgeFunctions.map(({ id, name, source }) => ({ id, name, source })),
		})),
		walkthroughs: input.walkthroughs,
	});
}

/**
 * Validates an untrusted document and returns what an import should create. It
 * throws a ProjectImportError naming the first malformed part, and it never
 * returns a partial result, so a caller can write everything or nothing.
 *
 * Structural problems are malformed: a missing or duplicated identity, a link
 * to a Design the file does not contain, or a System design that cannot be
 * loaded. Walkthrough references are not checked here. A step whose Connection
 * is gone is an unfinished explanation, so it is kept as it was saved.
 */
export function prepareProjectImport(
	value: unknown,
	options: { createId(): string; normalizeDesign(value: unknown): Design },
): PreparedProjectImport {
	const root = requireRecord(value, "file");
	if (root.format !== PROJECT_EXPORT_FORMAT) {
		throw new ProjectImportError("This file is not a Schema Designer project export.");
	}
	if (root.version !== PROJECT_EXPORT_VERSION) {
		const version = typeof root.version === "number" ? String(root.version) : "unknown";
		throw new ProjectImportError(
			`This project export uses format version ${version}, which this version of Schema Designer cannot read. It reads version ${PROJECT_EXPORT_VERSION}.`,
		);
	}

	const project = requireRecord(root.project, "project");
	const projectName = requireText(project.name, "project.name");
	const activeView = requireView(project.activeView, "project.activeView");

	const rawDesigns = requireArray(root.designs, "designs");
	if (rawDesigns.length === 0) malformed("designs", "must list at least one design");
	const designIds = new Set<string>();
	const designs = rawDesigns.map((raw, index) => {
		const path = `designs[${index}]`;
		const record = requireRecord(raw, path);
		const id = requireId(record.id, `${path}.id`);
		if (designIds.has(id)) malformed(`${path}.id`, `repeats design "${id}"`);
		designIds.add(id);
		return {
			id,
			name: requireString(record.name, `${path}.name`),
			design: normalizeDesignDocument(record.design, `${path}.design`, options.normalizeDesign),
			scenarios: requireUniqueList(record.scenarios, `${path}.scenarios`, (item, itemPath) => ({
				id: requireId(item.id, `${itemPath}.id`),
				name: requireBoundedName(item.name, `${itemPath}.name`, SCENARIO_NAME_LIMIT),
				source: requireString(item.source, `${itemPath}.source`),
			})),
			edgeFunctions: requireUniqueList(record.edgeFunctions, `${path}.edgeFunctions`, (item, itemPath) => {
				const name = requireId(item.name, `${itemPath}.name`);
				if (!EDGE_FUNCTION_NAME_PATTERN.test(name)) {
					malformed(`${itemPath}.name`, `"${name}" must use lowercase letters, digits, hyphens, or underscores`);
				}
				return {
					id: requireId(item.id, `${itemPath}.id`),
					name,
					source: requireString(item.source, `${itemPath}.source`),
				};
			}, (edgeFunction) => edgeFunction.name),
		};
	});

	const activeDesignId = requireId(project.activeDesignId, "project.activeDesignId");
	if (!designIds.has(activeDesignId)) {
		malformed("project.activeDesignId", `names design "${activeDesignId}", which the file does not contain`);
	}

	const systemDesign = loadSystemDesign(root.systemDesign);
	systemDesign.components.forEach((component, index) => {
		if (component.designId !== undefined && !designIds.has(component.designId)) {
			malformed(
				`systemDesign.components[${index}].designId`,
				`links design "${component.designId}", which the file does not contain`,
			);
		}
	});

	const walkthroughs = loadWalkthroughs(root.walkthroughs);

	// Fresh identities: the Project and each Design are new, so nothing an import
	// creates can overwrite what already exists.
	const newDesignIds = new Map(designs.map((design) => [design.id, options.createId()] as const));
	return {
		project: { id: options.createId(), name: projectName },
		activeDesignId: newDesignIds.get(activeDesignId)!,
		activeView,
		designs: designs.map((design) => ({ ...design, id: newDesignIds.get(design.id)! })),
		systemDesign: {
			...systemDesign,
			components: systemDesign.components.map((component) =>
				component.designId === undefined
					? component
					: { ...component, designId: newDesignIds.get(component.designId)! },
			),
		},
		walkthroughs,
	};
}

function normalizeDesignDocument(value: unknown, path: string, normalizeDesign: (value: unknown) => Design): Design {
	const record = requireRecord(value, path);
	if (!Array.isArray(record.tables)) malformed(`${path}.tables`, "must be a list");
	try {
		return normalizeDesign(record);
	} catch (cause) {
		throw new ProjectImportError(malformedMessage(path, errorMessage(cause)));
	}
}

function loadSystemDesign(value: unknown): SystemDesign {
	try {
		return normalizeSystemDesign(value);
	} catch (cause) {
		throw new ProjectImportError(malformedMessage("systemDesign", errorMessage(cause)));
	}
}

function loadWalkthroughs(value: unknown): Walkthrough[] {
	try {
		return normalizeWalkthroughs(value);
	} catch (cause) {
		throw new ProjectImportError(malformedMessage("walkthroughs", errorMessage(cause)));
	}
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		malformed(path, "must be an object");
	}
	return value as Record<string, unknown>;
}

function requireArray(value: unknown, path: string): unknown[] {
	if (!Array.isArray(value)) malformed(path, "must be a list");
	return value;
}

function requireString(value: unknown, path: string): string {
	if (typeof value !== "string") malformed(path, "must be text");
	return value;
}

function requireId(value: unknown, path: string): string {
	if (typeof value !== "string" || value.trim().length === 0) malformed(path, "is required");
	return value;
}

function requireText(value: unknown, path: string): string {
	if (typeof value !== "string" || value.trim().length === 0) malformed(path, "is required");
	return value.trim();
}

function requireBoundedName(value: unknown, path: string, limit: number): string {
	const name = requireText(value, path);
	if (name.length > limit) malformed(path, `must be ${limit} characters or fewer`);
	return name;
}

function requireView(value: unknown, path: string): SystemViewName {
	if (value !== "system" && value !== "database") malformed(path, 'must be "system" or "database"');
	return value;
}

/** Reads a list whose items each need unique identities within it. */
function requireUniqueList<T extends { id: string }>(
	value: unknown,
	path: string,
	read: (item: Record<string, unknown>, itemPath: string) => T,
	keyOf: (item: T) => string = (item) => item.id,
): T[] {
	const seen = new Set<string>();
	return requireArray(value, path).map((raw, index) => {
		const itemPath = `${path}[${index}]`;
		const item = read(requireRecord(raw, itemPath), itemPath);
		const key = keyOf(item);
		if (seen.has(key)) malformed(itemPath, `repeats "${key}"`);
		seen.add(key);
		return item;
	});
}

function malformed(path: string, problem: string): never {
	throw new ProjectImportError(malformedMessage(path, problem));
}

function malformedMessage(path: string, problem: string): string {
	return `The project file is malformed: ${path} ${problem.replace(/\.$/, "")}. Export the project again from Schema Designer.`;
}
