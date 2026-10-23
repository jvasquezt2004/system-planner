import type { Design } from "../design";

/** Names PostgreSQL-only logic that cannot be represented by the ORM schemas. */
export function unrepresentedPostgresqlLogicNotice(design: Design): string | null {
	const omitted = [
		...(design.tables.some((table) => table.rowLevelSecurity === true) ? ["Row-level security"] : []),
		...(design.tables.some((table) => (table.policies?.length ?? 0) > 0) ? ["policies"] : []),
		...((design.functions?.length ?? 0) > 0 ? ["functions"] : []),
	];
	if (omitted.length === 0) return null;
	const subject = omitted.length === 1
		? omitted[0]!
		: `${omitted.slice(0, -1).join(", ")} and ${omitted[omitted.length - 1]}`;
	const verb = omitted.length === 1 && omitted[0] === "Row-level security" ? "is" : "are";
	return `${subject} ${verb} not represented; preserve them in PostgreSQL migrations.`;
}
