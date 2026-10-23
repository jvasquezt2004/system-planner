import type { Design } from "../design";

/** RLS and policy definitions require PostgreSQL SQL outside these ORM schemas. */
export function hasUnrepresentedRowLevelSecurity(design: Design): boolean {
	return design.tables.some((table) => table.rowLevelSecurity === true || (table.policies?.length ?? 0) > 0);
}
