import type { DesignRawStatement } from "../shared/design";

type Node = Record<string, any>;

/** Data statements are not part of a Design: the sandbox is rebuilt from the Design alone, so they would be lost or re-run on every rebuild. */
export const DATA_STATEMENTS = ["InsertStmt", "UpdateStmt", "DeleteStmt", "SelectStmt", "MergeStmt", "CopyStmt", "CallStmt"];

/** Statements that only make sense inside one script run. */
export const IGNORED_STATEMENTS = ["TransactionStmt"];

const BEFORE_TABLES = ["CreateExtensionStmt", "CreateSchemaStmt", "CreateDomainStmt", "CompositeTypeStmt", "CreateRangeStmt"];

const lastName = (items: Node[] | undefined): string | undefined => {
	const item = items?.[items.length - 1];
	return item?.String?.sval ?? item?.sval;
};

/** What a kept statement creates and what it alters, so DROP can take it out again. */
export function classifyRawStatement(statement: Node): Pick<DesignRawStatement, "phase" | "creates" | "attachedTo"> {
	const kind = Object.keys(statement)[0] ?? "";
	const body = statement[kind] ?? {};
	let creates: string | undefined;
	let attachedTo: string | undefined = body.relation?.relname ?? body.table?.relname;
	switch (kind) {
		case "ViewStmt": creates = `view:${body.view?.relname}`; attachedTo = undefined; break;
		case "CreateSeqStmt": creates = `sequence:${body.sequence?.relname}`; attachedTo = undefined; break;
		case "CreateExtensionStmt": creates = `extension:${body.extname}`; break;
		case "CreateSchemaStmt": creates = `schema:${body.schemaname}`; break;
		case "CreateDomainStmt": creates = `domain:${lastName(body.domainname)}`; break;
		case "CompositeTypeStmt": creates = `type:${body.typevar?.relname}`; break;
		case "CreateRangeStmt": creates = `type:${lastName(body.typeName)}`; break;
		case "CreateStmt": creates = `table:${body.relation?.relname}`; attachedTo = undefined; break;
		case "CreateTableAsStmt": creates = `${body.objtype === "OBJECT_MATVIEW" ? "matview" : "table"}:${body.into?.rel?.relname}`; attachedTo = undefined; break;
		case "IndexStmt": creates = body.idxname ? `index:${body.idxname}` : undefined; break;
	}
	if (creates?.endsWith(":undefined")) creates = undefined;
	return { phase: BEFORE_TABLES.includes(kind) ? "before" : "after", ...(creates ? { creates } : {}), ...(attachedTo ? { attachedTo } : {}) };
}

const DROP_KINDS: Record<string, string> = {
	OBJECT_TABLE: "table", OBJECT_VIEW: "view", OBJECT_MATVIEW: "matview", OBJECT_SEQUENCE: "sequence", OBJECT_INDEX: "index",
	OBJECT_EXTENSION: "extension", OBJECT_SCHEMA: "schema", OBJECT_DOMAIN: "domain", OBJECT_TYPE: "type",
};

/** The `creates` key a DROP of this object refers to, or null for kinds that are never kept as raw SQL. */
export function dropKey(removeType: string, object: Node): string | null {
	const kind = DROP_KINDS[removeType];
	if (!kind) return null;
	const name = object?.TypeName ? lastName(object.TypeName.names) : object?.List ? lastName(object.List.items) : object?.String?.sval;
	return name ? `${kind}:${name}` : null;
}

/** Kept statements that create the object, plus the ones that only alter its relation. */
export function removeRawFor(statements: DesignRawStatement[], key: string): DesignRawStatement[] {
	const [kind, name] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
	const relationLike = ["table", "view", "matview"].includes(kind);
	return statements.filter((raw) => raw.creates !== key && !(relationLike && raw.attachedTo === name));
}
