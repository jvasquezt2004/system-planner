import { parse } from "@pgsql/parser/v17";
import type {
	Design, DesignColumn, DesignFunction, DesignIndex, DesignManyToManyAssociation,
	DesignPolicy, DesignRelationship, DesignTable, DesignTrigger,
} from "../shared/design";
import { noColumnDefault, type ColumnDefault } from "../shared/column-defaults";
import { isSupportedColumnType, type ColumnLiteralType, type ColumnType } from "../shared/column-types";
import type { DesignWorkspace } from "./workspace";

type Node = Record<string, any>;
export type AssistantDdlResult =
	| { status: "applied"; state: Awaited<ReturnType<DesignWorkspace["applyAssistantDesign"]>> }
	| { status: "confirmation-required"; statement: string; removal: ReturnType<DesignWorkspace["describeRemoval"]> };

const id = () => crypto.randomUUID();
function last<T>(values: readonly T[]): T | undefined {
	return values[values.length - 1];
}
const nameOf = (node: Node | undefined): string | undefined => node?.relname ?? node?.RangeVar?.relname;
function unsupported(message: string): never {
	throw new Error(`Unsupported assistant DDL: ${message}`);
}
const nodeName = (node: Node | undefined): string | undefined => node?.String?.sval ?? node?.sval ?? node?.name;
function typeName(typeName: Node | undefined): string {
	return (typeName?.names ?? []).map(nodeName).filter(Boolean).join(".");
}
function getType(def: Node): { type: ColumnType; typeParameters?: DesignColumn["typeParameters"]; enumTypeId?: string } {
	const names = def.typeName?.names?.map(nodeName).filter(Boolean) ?? [];
	const rawType = last(names);
	const aliases: Record<string, ColumnType> = {
		bool: "boolean", int2: "smallint", int4: "integer", int8: "bigint", int: "integer",
		float4: "real", float8: "double precision", bpchar: "char", decimal: "numeric",
		varchar: "varchar", timestamptz: "timestamptz", timetz: "timetz",
	};
	const type = typeof rawType === "string" ? aliases[rawType.toLowerCase()] ?? rawType.toLowerCase() : undefined;
	if (type && isSupportedColumnType(type)) {
		const typmods: Node[] = def.typeName?.typmods ?? [];
		if (!typmods.length) return { type };
		const values = typmods.map((modifier) => modifier.A_Const?.ival?.ival ?? modifier.A_Const?.ival);
		if (values.some((value) => !Number.isInteger(value))) unsupported(`type modifiers for ${type} are not literal integers`);
		if ((type === "varchar" || type === "char") && values.length === 1 && values[0] > 0) return { type, typeParameters: { length: values[0] } };
		if (type === "numeric" && values.length >= 1 && values.length <= 2 && values[0] > 0 && (values[1] === undefined || values[1] >= 0)) return { type, typeParameters: { precision: values[0], ...(values[1] === undefined ? {} : { scale: values[1] }) } };
		if (["vector", "halfvec", "sparsevec"].includes(type) && values.length === 1 && values[0] > 0) return { type, typeParameters: { dimensions: values[0] } };
		unsupported(`type modifiers for ${type} are not representable`);
	}
	return unsupported(`column type ${names.join(".") || "<unknown>"} is not representable`);
}
function expressionLiteral(value: Node): { literalType: string; value: string } | null {
	const constant = value.A_Const;
	if (!constant) return null;
	if (constant.isnull) unsupported("NULL column defaults are not representable");
	if (constant.sval !== undefined) return { literalType: "text", value: constant.sval.sval ?? constant.sval };
	if (constant.ival !== undefined) return { literalType: "integer", value: String(constant.ival.ival ?? constant.ival) };
	if (constant.fval !== undefined) return { literalType: "numeric", value: String(constant.fval.fval ?? constant.fval) };
	if (constant.boolval !== undefined) return { literalType: "boolean", value: String(constant.boolval.boolval ?? constant.boolval) };
	return null;
}
function defaultValue(expr: Node | undefined, type: ColumnType): ColumnDefault {
	if (!expr) return noColumnDefault();
	if (expr.TypeCast) {
		const castType = typeName(expr.TypeCast.typeName);
		const value = expressionLiteral(expr.TypeCast.arg);
		if (!value) unsupported("typed defaults must cast a literal value");
		const targetType = last(castType.split("."))?.toLowerCase();
		const literalType = targetType === "date" ? "date" : ["time", "timetz"].includes(targetType ?? "") ? "time" : ["timestamp", "timestamptz"].includes(targetType ?? "") ? "timestamp" : ["json", "jsonb"].includes(targetType ?? "") ? "json" : value.literalType;
		return { kind: "literal", literalType: literalType as ColumnLiteralType, value: value.value };
	}
	const literal = expressionLiteral(expr);
	if (literal) {
		const literalType = type === "date" ? "date" : ["time", "timetz"].includes(type) ? "time" : ["timestamp", "timestamptz"].includes(type) ? "timestamp" : type === "json" || type === "jsonb" ? "json" : literal.literalType;
		if (!["text", "integer", "numeric", "boolean", "date", "time", "timestamp", "json"].includes(literalType)) unsupported(`literal defaults are not supported for ${type}`);
		return { kind: "literal", literalType: literalType as ColumnLiteralType, value: literal.value };
	}
	const call = expr.FuncCall;
	if (call) {
		const fn = (call.funcname ?? []).map(nodeName).filter(Boolean).join(".").toLowerCase();
		if (fn === "now" && !(call.args?.length)) return { kind: "currentTimestamp" };
		if (fn === "gen_random_uuid" && !(call.args?.length)) return { kind: "generateUuid" };
	}
	return unsupported("column defaults must be typed literals, now(), or gen_random_uuid()");
}
function constraintsOf(def: Node): Node[] {
	return (def.constraints ?? []).map((entry: Node) => entry.Constraint).filter(Boolean);
}
type AssistantColumn = DesignColumn & { __assistantReference?: Node };
function column(def: Node, enumTypes: Design["enumTypes"] = []): AssistantColumn {
	if (def.generated || def.coll_clause || def.compression || def.typeName?.arrayBounds?.length) unsupported("generated, collated, compressed, and array columns are not representable");
	let primaryKey = false, nullable = def.is_not_null !== true, unique = false, identity = Boolean(def.identity);
	let ref: Node | undefined;
	for (const c of constraintsOf(def)) {
		if (c.deferrable || c.initdeferred || c.nulls_not_distinct || c.fk_del_set_cols?.length) unsupported("deferrable constraints, NULLS NOT DISTINCT, and column-targeted referential actions are not representable");
		switch (c.contype) {
			case "CONSTR_PRIMARY": primaryKey = true; nullable = false; break;
			case "CONSTR_NOTNULL": nullable = false; break;
			case "CONSTR_NULL": nullable = true; break;
			case "CONSTR_UNIQUE": unique = true; break;
			case "CONSTR_FOREIGN": ref = c; break;
			case "CONSTR_DEFAULT": break;
			case "CONSTR_IDENTITY": identity = true; break;
			default: unsupported(`column constraint ${c.contype} is not supported`);
		}
	}
	const raw = typeName(def.typeName);
	const foundEnum = enumTypes?.find((entry) => entry.name === raw || entry.name === last(raw.split(".")));
	const resolved = foundEnum ? { type: "text" as ColumnType, enumTypeId: foundEnum.id } : getType(def);
	if (identity && !["smallint", "integer", "bigint"].includes(resolved.type)) unsupported(`identity is not supported for ${resolved.type}`);
	const defaultConstraint = constraintsOf(def).find((entry) => entry.contype === "CONSTR_DEFAULT");
	return {
		id: id(), name: def.colname, ...resolved, nullable: primaryKey ? false : nullable, primaryKey, unique, identity,
		default: identity ? noColumnDefault() : defaultValue(defaultConstraint?.raw_expr ?? def.raw_default, resolved.type), notes: "",
		...(ref ? { __assistantReference: ref } : {}),
	};
}
function constString(node: Node | undefined): string | undefined { return node?.String?.sval ?? node?.sval ?? node?.A_Const?.sval?.sval; }
function policyExpression(sql: string, clause: "USING" | "WITH CHECK" | "WHEN"): string {
	const match = new RegExp(`\\b${clause.replace(" ", "\\s+")}\\s*\\(`, "i").exec(sql);
	if (!match) return "";
	let depth = 1, quote = "", end = match.index + match[0].length;
	for (; end < sql.length; end++) {
		const ch = sql[end];
		if (quote) {
			if (ch === quote && sql[end + 1] === quote) { end++; continue; }
			if (ch === quote) quote = "";
			continue;
		}
		if (ch === "'" || ch === '"') { quote = ch; continue; }
		if (ch === "(") depth++;
		else if (ch === ")" && --depth === 0) return sql.slice(match.index + match[0].length, end).trim();
	}
	unsupported(`CREATE POLICY ${clause} expression is malformed`);
}
function resolveReference(design: Design, source: DesignTable, local: DesignColumn, constraint: Node): DesignRelationship {
	const refName = nameOf(constraint.pktable) ?? nameOf(constraint.relation);
	const target = design.tables.find(({ name }) => name === refName);
	if (!target) unsupported(`referenced table ${refName ?? "<unknown>"} does not exist`);
	if (constraint.pktable?.schemaname) unsupported("schema-qualified table names are not supported");
	const targetColumnName = constraint.pk_attrs?.[0]?.String?.sval ?? constraint.pk_attrs?.[0]?.sval;
	const targetColumn = targetColumnName ? target.columns.find(({ name }) => name === targetColumnName) : target.columns.find(({ primaryKey }) => primaryKey);
	if (!targetColumn) unsupported(`referenced column ${targetColumnName ?? "primary key"} does not exist on ${target.name}`);
	if (targetColumnName && constraint.pk_attrs?.length !== 1) unsupported("references to multiple columns are not supported");
	if (!targetColumn.primaryKey) unsupported(`references to ${target.name}.${targetColumn.name} cannot be represented; references must target its primary key`);
	if (constraint.fk_attrs?.length > 1) unsupported("references to multiple columns are not supported");
	if (local.type !== targetColumn.type && !(local.enumTypeId && local.enumTypeId === targetColumn.enumTypeId)) unsupported(`foreign-key column ${source.name}.${local.name} type does not match ${target.name}.${targetColumn.name}`);
	const action = (v: string): DesignRelationship["onDelete"] => {
		const map: Record<string, NonNullable<DesignRelationship["onDelete"]>> = { a: "NO ACTION", r: "RESTRICT", c: "CASCADE", n: "SET NULL", d: "SET DEFAULT" };
		const normalized = map[v] ?? v.toUpperCase().replaceAll("_", " ");
		if (!["NO ACTION", "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT"].includes(normalized)) unsupported(`referential action ${normalized} is not supported`);
		return normalized as NonNullable<DesignRelationship["onDelete"]>;
	};
	const uniqueReference = local.unique || (source.indexes ?? []).some((index) => index.unique && index.keys.length === 1 && index.keys[0].columnId === local.id);
	return { id: id(), cardinality: uniqueReference ? "one-to-one" : "one-to-many", referencingTableId: source.id, referencingColumnId: local.id, referencedTableId: target.id, ...(constraint.fk_del_action ? { onDelete: action(constraint.fk_del_action) } : {}), ...(constraint.fk_upd_action ? { onUpdate: action(constraint.fk_upd_action) } : {}) };
}
function removalPlanEmpty(removal: ReturnType<DesignWorkspace["describeRemoval"]>): boolean {
	return removal.relationships.length === 0 && removal.indexes.length === 0 && removal.uniqueConstraints.length === 0 && removal.triggers.length === 0;
}
function placeTable(design: Design, refs: Node[]): { x: number; y: number } {
	for (const ref of refs) {
		const name = nameOf(ref?.Constraint?.pktable ?? ref?.pktable ?? ref);
		const target = design.tables.find((table) => table.name === name);
		if (target) return { x: target.position.x + 300, y: target.position.y };
	}
	return { x: Math.max(0, ...design.tables.map(({ position }) => position.x)) + 300, y: 0 };
}
function validateAndInferJunction(design: Design, table: DesignTable, refs: DesignRelationship[]) {
	if (design.manyToManyRelationships.some((association) => association.junctionTableId === table.id)) return;
	if (refs.length !== 2 || refs.some((r) => table.columns.find((c) => c.id === r.referencingColumnId)?.nullable) || table.columns.some((c) => !c.primaryKey && !refs.some((r) => r.referencingColumnId === c.id))) return;
	const primaryKeys = table.columns.filter((column) => column.primaryKey);
	if (primaryKeys.length !== 1 || refs.some((r) => r.referencingColumnId === primaryKeys[0].id)) return;
	const pair = refs.map((r) => r.referencingColumnId);
	const unique = (table.uniqueConstraints ?? []).some((entry) => entry.columnIds.length === 2 && pair.every((columnId) => entry.columnIds.includes(columnId)))
		|| (table.indexes ?? []).some((index) => index.unique && index.keys.length === 2 && pair.every((columnId) => index.keys.some((key) => key.columnId === columnId)));
	if (!unique) return;
	const left = refs[0], right = refs[1];
	if (left.referencedTableId === right.referencedTableId) return;
	const association: DesignManyToManyAssociation = { id: id(), leftTableId: left.referencedTableId, rightTableId: right.referencedTableId, junctionTableId: table.id, leftRelationshipId: left.id, rightRelationshipId: right.id };
	design.manyToManyRelationships.push(association);
}

export type AssistantDdlOptions = { assistantTurnId?: string; confirmedDrops?: boolean };
export async function applyAssistantDdl(workspace: DesignWorkspace, sql: string, options: AssistantDdlOptions = {}): Promise<AssistantDdlResult> {
	const parsed = await parse(sql) as Node;
	const state = workspace.getState();
	if (!state.project || !state.design) throw new Error("Cannot apply assistant DDL without an open project.");
	const design: Design = structuredClone(state.design);
	const statements: Node[] = parsed.stmts ?? [];
	for (const item of statements) {
		const statement = item.stmt as Node;
		if (statement.CreateStmt) {
			const create = statement.CreateStmt, tableName = nameOf(create.relation);
			if (create.relation?.schemaname) unsupported("schema-qualified table names are not supported");
			if (!tableName || design.tables.some((table) => table.name === tableName)) unsupported(`table ${tableName ?? "<unknown>"} already exists`);
			if (create.if_not_exists) unsupported("CREATE TABLE IF NOT EXISTS is not supported");
			if (create.inh_relations?.length || create.partspec || create.partbound || create.constraints?.length || create.options?.length) unsupported("table inheritance, partitioning, and table-level storage options are not representable");
			const refs = (create.tableElts ?? []).flatMap((element: Node) => element.ColumnDef
				? (element.ColumnDef.constraints ?? []).map((entry: Node) => entry.Constraint?.pktable ? entry.Constraint.pktable : null)
				: element.Constraint?.pktable ? [element.Constraint.pktable] : []);
			const table: DesignTable = { id: id(), name: tableName, position: placeTable(design, refs), columns: [] };
			const pending: { column: DesignColumn; constraint: Node }[] = [];
			for (const element of create.tableElts ?? []) {
				if (element.ColumnDef) {
					const c = column(element.ColumnDef, design.enumTypes); const ref = c.__assistantReference; delete c.__assistantReference;
					table.columns.push(c); if (ref) pending.push({ column: c, constraint: ref });
				} else if (element.Constraint) {
					const constraint = element.Constraint;
					if (constraint.contype === "CONSTR_UNIQUE" || constraint.contype === "CONSTR_PRIMARY") {
						if (constraint.deferrable || constraint.initdeferred || constraint.nulls_not_distinct) unsupported("deferrable and NULLS NOT DISTINCT constraints are not representable");
						const names = (constraint.keys ?? []).map(nodeName).filter(Boolean);
						if (constraint.contype === "CONSTR_PRIMARY" && names.length === 1) { const target = table.columns.find(({ name }) => name === names[0]); if (!target) unsupported("table-level primary key must refer to one existing column"); target.primaryKey = true; target.nullable = false; }
						else if (constraint.contype === "CONSTR_UNIQUE" && names.length === 1) { const target = table.columns.find(({ name }) => name === names[0]); if (!target) unsupported("table-level UNIQUE must refer to one existing column"); target.unique = true; }
						else if (constraint.contype === "CONSTR_UNIQUE" && names.length > 1) {
							const columns = names.map((name: string) => table.columns.find(({ name: n }) => n === name)); if (columns.some((c: DesignColumn | undefined) => !c)) unsupported("UNIQUE references a missing column");
							(table.uniqueConstraints ??= []).push({ id: id(), name: constraint.conname, columnIds: columns.map((c: DesignColumn) => c.id) });
						} else unsupported("composite primary keys are not representable");
					} else if (constraint.contype === "CONSTR_FOREIGN") {
						if (constraint.deferrable || constraint.initdeferred || (constraint.fk_matchtype && constraint.fk_matchtype !== "s") || constraint.fk_del_set_cols?.length) unsupported("deferrable, non-simple, and column-targeted foreign keys are not representable");
						if ((constraint.fk_attrs ?? []).length !== 1) unsupported("foreign keys must reference one column");
						const localName = nodeName(constraint.fk_attrs[0]), local = table.columns.find(({ name }) => name === localName);
						if (!local) unsupported(`foreign-key column ${localName} does not exist`); pending.push({ column: local, constraint });
					} else unsupported(`table constraint ${constraint.contype} is not supported`);
				} else unsupported("table elements must be columns or supported constraints");
			}
			design.tables.push(table);
			const relationships = pending.map(({ column: c, constraint }) => resolveReference(design, table, c, constraint));
			design.relationships.push(...relationships); validateAndInferJunction(design, table, relationships);
			continue;
		}
		if (statement.RenameStmt) {
			const rename = statement.RenameStmt, table = design.tables.find(({ name }) => name === nameOf(rename.relation));
			if (!table) unsupported(`table ${nameOf(rename.relation)} does not exist`);
			if (rename.renameType === "OBJECT_TABLE") table.name = rename.newname;
			else if (rename.renameType === "OBJECT_COLUMN") { const target = table.columns.find(({ name }) => name === rename.subname); if (!target) unsupported(`column ${rename.subname} does not exist`); target.name = rename.newname; }
			else unsupported(`rename operation ${rename.renameType} is not supported`);
			continue;
		}
		if (statement.AlterTableStmt) {
			const alter = statement.AlterTableStmt;
			if (alter.relation?.schemaname) unsupported("schema-qualified table names are not supported");
			const table = design.tables.find(({ name }) => name === nameOf(alter.relation));
			if (!table) unsupported(`table ${nameOf(alter.relation)} does not exist`);
			for (const wrapped of alter.cmds ?? []) {
				const cmd = wrapped.AlterTableCmd; if (!cmd) unsupported("unknown ALTER TABLE command");
				if (cmd.subtype === "AT_AddConstraint") {
					const constraint = cmd.def?.Constraint;
					if (!constraint) unsupported("ADD CONSTRAINT definition is invalid");
					if (constraint.deferrable || constraint.initdeferred || constraint.nulls_not_distinct) unsupported("deferrable and NULLS NOT DISTINCT constraints are not representable");
					if (constraint.contype === "CONSTR_PRIMARY" || constraint.contype === "CONSTR_UNIQUE") {
						const names = (constraint.keys ?? []).map(nodeName).filter(Boolean);
						if (constraint.contype === "CONSTR_PRIMARY" && names.length !== 1) unsupported("composite primary keys are not representable");
						const columns = names.map((name: string) => {
							const found = table.columns.find(({ name: columnName }) => columnName === name);
							if (!found) unsupported(`constraint column ${name} does not exist`);
							return found;
						});
						if (!names.length) unsupported("constraint must refer to existing columns");
						if (constraint.contype === "CONSTR_PRIMARY") { columns[0].primaryKey = true; columns[0].nullable = false; }
						else if (columns.length === 1) columns[0].unique = true;
						else (table.uniqueConstraints ??= []).push({ id: id(), name: constraint.conname, columnIds: columns.map((entry: DesignColumn) => entry.id) });
					} else if (constraint.contype === "CONSTR_FOREIGN") {
						if ((constraint.fk_attrs ?? []).length !== 1 || constraint.fk_matchtype && constraint.fk_matchtype !== "s" || constraint.fk_del_set_cols?.length) unsupported("foreign keys must reference one column and use simple matching");
						const localName = nodeName(constraint.fk_attrs[0]), local = table.columns.find(({ name }) => name === localName);
						if (!local) unsupported(`foreign-key column ${localName} does not exist`);
						design.relationships.push(resolveReference(design, table, local, constraint));
					} else unsupported(`ALTER TABLE constraint ${constraint.contype} is not supported`);
				} else if (cmd.subtype === "AT_AddColumn") {
					const def = cmd.def?.ColumnDef; if (!def) unsupported("ADD COLUMN definition is invalid");
					const c = column(def, design.enumTypes); const ref = c.__assistantReference; delete c.__assistantReference; table.columns.push(c);
					if (ref) { const relationship = resolveReference(design, table, c, ref); design.relationships.push(relationship); validateAndInferJunction(design, table, [relationship]); }
				} else if (cmd.subtype === "AT_DropColumn") {
					const target = table.columns.find(({ name }) => name === cmd.name); if (!target) unsupported(`column ${cmd.name} does not exist`);
					const removal = workspace.describeRemoval({ kind: "column", tableId: table.id, columnId: target.id });
					if (!removalPlanEmpty(removal) && !options.confirmedDrops) return { status: "confirmation-required", statement: sql, removal };
					const relationshipIds = new Set(removal.relationships.map(({ relationshipId }) => relationshipId));
					const indexIds = new Set(removal.indexes.map(({ indexId }) => indexId));
					const uniqueIds = new Set(removal.uniqueConstraints.map(({ constraintId }) => constraintId));
					const triggerIds = new Set(removal.triggers.map(({ triggerId }) => triggerId));
					design.relationships = design.relationships.filter(({ id: relationshipId }) => !relationshipIds.has(relationshipId));
					design.manyToManyRelationships = design.manyToManyRelationships.filter((association) =>
						!relationshipIds.has(association.leftRelationshipId) && !relationshipIds.has(association.rightRelationshipId));
					table.indexes = (table.indexes ?? []).filter(({ id: indexId }) => !indexIds.has(indexId));
					table.uniqueConstraints = (table.uniqueConstraints ?? []).filter(({ id: uniqueId }) => !uniqueIds.has(uniqueId));
					design.triggers = (design.triggers ?? []).filter(({ id: triggerId }) => !triggerIds.has(triggerId));
					table.columns = table.columns.filter(({ id: cid }) => cid !== target.id);
				} else if (cmd.subtype === "AT_ColumnDefault") {
					const target = table.columns.find(({ name }) => name === cmd.name); if (!target) unsupported(`column ${cmd.name} does not exist`);
					target.default = cmd.def ? defaultValue(cmd.def, target.type) : noColumnDefault();
				} else if (cmd.subtype === "AT_SetNotNull" || cmd.subtype === "AT_DropNotNull") {
					const target = table.columns.find(({ name }) => name === cmd.name); if (!target) unsupported(`column ${cmd.name} does not exist`); target.nullable = cmd.subtype === "AT_DropNotNull";
				} else if (cmd.subtype === "AT_AlterColumnType") {
					const target = table.columns.find(({ name }) => name === cmd.name); if (!target) unsupported(`column ${cmd.name} does not exist`);
					const rawType = typeName(cmd.def), enumType = design.enumTypes?.find((entry) => entry.name === rawType || entry.name === last(rawType.split(".")));
					const updatedType = enumType ? { type: "text" as ColumnType, enumTypeId: enumType.id } : getType({ typeName: cmd.def });
					Object.assign(target, updatedType, { typeParameters: "typeParameters" in updatedType ? updatedType.typeParameters : undefined });
				} else if (cmd.subtype === "AT_EnableRowSecurity") table.rowLevelSecurity = true;
				else unsupported(`ALTER TABLE operation ${cmd.subtype} is not supported`);
			}
			continue;
		}
		if (statement.DropStmt) {
			const drop = statement.DropStmt;
			if (drop.removeType !== "OBJECT_TABLE") unsupported(`DROP ${drop.removeType} is not supported`);
			if (drop.missing_ok) unsupported("DROP TABLE IF EXISTS is not supported");
			if (drop.behavior === "DROP_CASCADE") unsupported("DROP ... CASCADE is not supported");
			for (const object of drop.objects ?? []) {
				const name = nodeName(last<Node>(object?.List?.items ?? [])) ?? object?.String?.sval ?? object?.relname;
				const table = design.tables.find(({ name: tableName }) => tableName === name);
				if (!table) unsupported(`table ${name} does not exist`);
				const removal = workspace.describeRemoval({ kind: "table", tableId: table.id });
				if (!removalPlanEmpty(removal) && !options.confirmedDrops) return { status: "confirmation-required", statement: sql, removal };
				design.tables = design.tables.filter(({ id: tid }) => tid !== table.id);
				design.relationships = design.relationships.filter((r) => r.referencingTableId !== table.id && r.referencedTableId !== table.id);
				design.manyToManyRelationships = design.manyToManyRelationships.filter((a) => a.junctionTableId !== table.id && a.leftTableId !== table.id && a.rightTableId !== table.id);
			}
			continue;
		}
		if (statement.IndexStmt) {
			const index = statement.IndexStmt, table = design.tables.find(({ name }) => name === nameOf(index.relation));
			if (!table) unsupported(`table ${nameOf(index.relation)} does not exist`);
			if (index.whereClause || index.indexIncludingParams?.length) unsupported("partial and INCLUDE indexes are not supported");
			if (index.if_not_exists) unsupported("CREATE INDEX IF NOT EXISTS is not supported");
			const keys = (index.indexParams ?? []).map((entry: Node) => {
				const elem = entry.IndexElem; if (!elem?.name) unsupported("index expressions are not supported");
				const c = table.columns.find(({ name }) => name === elem.name); if (!c) unsupported(`index column ${elem.name} does not exist`);
				return { columnId: c.id, ...(elem.ordering === 3 ? { order: "desc" as const } : elem.ordering === 2 ? { order: "asc" as const } : {}) };
			});
			if (!keys.length) unsupported("indexes require at least one column");
			const indexData: DesignIndex = { id: id(), name: index.idxname, method: index.accessMethod || "btree", keys, unique: !!index.unique };
			(table.indexes ??= []).push(indexData);
			if (indexData.unique && indexData.keys.length === 1) design.relationships = design.relationships.map((relationship) =>
				relationship.referencingTableId === table.id && relationship.referencingColumnId === indexData.keys[0].columnId
					? { ...relationship, cardinality: "one-to-one" } : relationship);
			validateAndInferJunction(design, table, design.relationships.filter((relationship) => relationship.referencingTableId === table.id));
			continue;
		}
		if (statement.CreateEnumStmt) {
			const create = statement.CreateEnumStmt, name = nodeName(last<Node>(create.typeName ?? []));
			if (!name || (design.enumTypes ?? []).some((entry) => entry.name === name)) unsupported(`enum type ${name ?? "<unknown>"} already exists`);
			design.enumTypes ??= []; design.enumTypes.push({ id: id(), name, labels: (create.vals ?? []).map(constString).filter(Boolean) as string[] }); continue;
		}
		if (statement.CreateFunctionStmt) {
			const create = statement.CreateFunctionStmt;
			if (!create.replace) unsupported("functions must use CREATE OR REPLACE FUNCTION");
			if (create.is_procedure) unsupported("CREATE PROCEDURE is not representable as a Function");
			const signature: string[] = (create.funcname ?? []).map((part: Node) => nodeName(part)).filter((part: string | undefined): part is string => typeof part === "string");
			const name = last(signature);
			if (!name || signature.length > 1) unsupported("schema-qualified functions are not supported");
			const options: Record<string, Node> = {};
			for (const item of create.options ?? []) { const o = item.DefElem; if (o?.defname) options[o.defname] = o.arg; }
			const unsupportedOption = Object.keys(options).find((option) => !["language", "as", "volatility", "security"].includes(option));
			if (unsupportedOption) unsupported(`function option ${unsupportedOption} is not representable`);
			const language = constString(options.language) ?? options.language?.String?.sval;
			const returnType = typeName(create.returnType);
			const body = constString(options.as) ?? options.as?.List?.items?.map(constString).join("\n");
			if (!body || !language || !returnType) unsupported("function must have a representable LANGUAGE, RETURNS type, and body");
			if (language !== "sql" && language !== "plpgsql") unsupported(`function language ${language} is not representable`);
			const args = (create.parameters ?? []).map((p: Node) => { const a = p.FunctionParameter; if (!a || (a.mode && a.mode !== "FUNC_PARAM_IN") || a.defexpr) unsupported("only IN function parameters without defaults are supported"); return { name: a.name ?? `arg${id().slice(0, 8)}`, type: typeName(a.argType) }; });
			const volatility = constString(options.volatility)?.toLowerCase();
			const security = constString(options.security)?.toLowerCase();
			const fn: DesignFunction = { id: (design.functions ?? []).find((f) => f.name === name)?.id ?? id(), name, arguments: args, returnType, returnsSet: !!create.returnType?.setof, language, volatility: volatility === "immutable" ? "immutable" : volatility === "stable" ? "stable" : "volatile", security: security === "definer" ? "definer" : "invoker", body };
			design.functions = (design.functions ?? []).filter((f) => f.name !== name); design.functions.push(fn); continue;
		}
		if (statement.CreateTrigStmt) {
			const create = statement.CreateTrigStmt, table = design.tables.find(({ name }) => name === nameOf(create.relation));
			if (!table) unsupported(`table ${nameOf(create.relation)} does not exist`);
			const fnName = last(create.funcname?.map(nodeName).filter(Boolean) ?? []), fn = design.functions?.find((entry) => entry.name === fnName);
			if (!fn) unsupported(`trigger function ${fnName ?? "<unknown>"} does not exist`);
			if (create.isconstraint || create.args?.length || create.transition_rels?.length) unsupported("constraint triggers, trigger arguments, and transition relations are not representable");
			const events: DesignTrigger["events"] = [];
			for (const [flag, event] of [[4, "INSERT"], [8, "DELETE"], [16, "UPDATE"], [32, "TRUNCATE"]] as const) {
				if (!(create.events & flag)) continue;
				const columnIds = event === "UPDATE" ? (create.columns ?? []).map((column: Node) => {
					const name = nodeName(last(column.ColumnRef?.fields ?? []) ?? column);
					const found = table.columns.find((entry) => entry.name === name);
					if (!found) unsupported(`trigger UPDATE OF column ${name ?? "<unknown>"} does not exist`);
					return found.id;
				}) : [];
				events.push({ event, ...(columnIds.length ? { columnIds } : {}) });
			}
			const timing = create.timing === 64 ? "INSTEAD OF" : create.timing === 2 ? "BEFORE" : "AFTER";
			(design.triggers ??= []).push({ id: id(), name: create.trigname, tableId: table.id, timing, events, level: create.row ? "ROW" : "STATEMENT", functionId: fn.id, when: create.whenClause ? policyExpression(sql, "WHEN") : "" }); continue;
		}
		if (statement.CreatePolicyStmt) {
			const create = statement.CreatePolicyStmt, table = design.tables.find(({ name }) => name === nameOf(create.table));
			if (!table) unsupported(`table ${nameOf(create.table)} does not exist`);
			const commands: Record<string, DesignPolicy["command"]> = { ALL: "ALL", SELECT: "SELECT", INSERT: "INSERT", UPDATE: "UPDATE", DELETE: "DELETE" };
			const command = commands[String(create.cmd_name).toUpperCase()]; if (!command) unsupported(`policy command ${create.cmd_name} is not representable`);
			const roles = (create.roles ?? []).map((role: Node) => role.RoleSpec?.rolename ?? "public");
			(table.policies ??= []).push({ id: id(), name: create.policy_name, command, roles, mode: create.permissive ? "permissive" : "restrictive", using: create.qual ? policyExpression(sql, "USING") : "", withCheck: create.with_check ? policyExpression(sql, "WITH CHECK") : "" }); continue;
		}
		if (statement.CommentStmt) {
			const comment = statement.CommentStmt;
			if (comment.objtype !== "OBJECT_COLUMN") unsupported("only COMMENT ON COLUMN is supported");
			const names = comment.object?.List?.items?.map(nodeName).filter(Boolean) ?? [];
			if (names.length !== 2) unsupported("schema-qualified or malformed column comments are not supported");
			const table = design.tables.find(({ name }) => name === names[0]), target = table?.columns.find(({ name }) => name === names[1]);
			if (!target) unsupported(`column ${names.join(".")} does not exist`);
			target.notes = comment.comment ?? ""; continue;
		}
		unsupported(Object.keys(statement)[0] ?? "empty statement");
	}
	return { status: "applied", state: await workspace.applyAssistantDesign(design, options.assistantTurnId) };
}
