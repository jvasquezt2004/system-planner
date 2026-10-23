import type { Design } from "../design";

/** PostgreSQL-only logic requires migrations beyond these ORM schemas. */
export function hasUnrepresentedRowLevelSecurity(design: Design): boolean {
	return design.tables.some((table) => table.rowLevelSecurity === true || (table.policies?.length ?? 0) > 0)
		|| (design.functions?.length ?? 0) > 0;
}
