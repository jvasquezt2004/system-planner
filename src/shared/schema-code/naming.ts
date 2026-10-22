/**
 * Language-neutral naming shared by the ORM generators, so Prisma, Drizzle,
 * SQLAlchemy, and Django name the same model and relationship the same way.
 * Names are planned as lowercase words; each generator applies its own casing
 * and reserved-word rules. Database names never come from here: generators
 * always map back to the design's exact table and column names.
 */

import type { Design, DesignTable } from "../design";
import { resolveRelationships } from "../relationships";

/** A name as lowercase words, e.g. `["author", "posts"]`. */
export type NameWords = readonly string[];

/** Names a relationship contributes to the two models it connects. */
export type RelationshipNames = {
	/** On the referencing model: the referenced record (`author`, `parent`). */
	forward: NameWords;
	/** On the referenced model: the referencing records (`authorPosts`, `children`). */
	backward: NameWords;
	/** False for a one-to-one relationship, whose back-reference is one record. */
	backwardIsList: boolean;
};

/** Convenience names that skip a many-to-many junction (`Post.tags`, `Tag.posts`). */
export type ManyToManyNames = {
	/** On the left endpoint model: the right endpoint's records. */
	left: NameWords;
	/** On the right endpoint model: the left endpoint's records. */
	right: NameWords;
};

export type RelationshipNamePlan = {
	/** By relationship id. */
	relationships: Map<string, RelationshipNames>;
	/** By many-to-many association id. */
	manyToMany: Map<string, ManyToManyNames>;
};

const IRREGULAR_PLURALS: Readonly<Record<string, string>> = {
	person: "people",
	child: "children",
	man: "men",
	woman: "women",
	mouse: "mice",
	goose: "geese",
	foot: "feet",
	tooth: "teeth",
};

const IRREGULAR_SINGULARS: Readonly<Record<string, string>> = Object.fromEntries(
	Object.entries(IRREGULAR_PLURALS).map(([singular, plural]) => [plural, singular]),
);

/** Words whose singular and plural are the same. */
const UNCOUNTABLE = new Set([
	"data",
	"media",
	"metadata",
	"information",
	"equipment",
	"news",
	"series",
	"species",
	"settings",
	"feedback",
	"history",
	"audit",
	"staff",
]);

/**
 * Splits any identifier into lowercase words: snake_case, camelCase,
 * PascalCase, kebab-case, spaces, and digit boundaries all separate words.
 */
export function splitWords(name: string): string[] {
	return name
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.split(/[^A-Za-z0-9]+/)
		.filter((word) => word.length > 0)
		.map((word) => word.toLowerCase());
}

export function singularize(word: string): string {
	const lower = word.toLowerCase();
	if (UNCOUNTABLE.has(lower)) return lower;
	if (IRREGULAR_SINGULARS[lower]) return IRREGULAR_SINGULARS[lower];
	if (/[^aeiou]ies$/.test(lower)) return `${lower.slice(0, -3)}y`;
	if (/(ss|sh|ch|x|z)es$/.test(lower)) return lower.slice(0, -2);
	if (/(ss|us|is)$/.test(lower)) return lower;
	if (lower.endsWith("s") && lower.length > 1) return lower.slice(0, -1);
	return lower;
}

export function pluralize(word: string): string {
	const lower = singularize(word);
	if (UNCOUNTABLE.has(lower)) return lower;
	if (IRREGULAR_PLURALS[lower]) return IRREGULAR_PLURALS[lower];
	if (/[^aeiou]y$/.test(lower)) return `${lower.slice(0, -1)}ies`;
	if (/(s|sh|ch|x|z)$/.test(lower)) return `${lower}es`;
	return `${lower}s`;
}

/** The words of a table name with its last word made singular (`post_tags` → post tag). */
export function singularWords(name: string): string[] {
	return replaceLastWord(splitWords(name), singularize);
}

/** The words of a table name with its last word made plural (`person` → people). */
export function pluralWords(name: string): string[] {
	return replaceLastWord(splitWords(name), pluralize);
}

/** The singular model name for a table, as words (`users` → user). */
export function modelWords(table: DesignTable): string[] {
	const words = singularWords(table.name);
	return words.length > 0 ? words : ["model"];
}

/**
 * Plans relationship names for every model:
 *
 * - forward: the foreign-key column without its `id` suffix (`author_id` →
 *   author), or the referenced model's name;
 * - backward: the referencing table's plural name (`comments`), singular for
 *   one-to-one (`profile`); when one table references another more than once,
 *   it is prefixed with the forward role (`author posts`, `editor posts`); a
 *   self-reference named `parent` gets `children`;
 * - many-to-many: each endpoint gets the other endpoint's plural name.
 *
 * Names stay unique within each model, including against its column names.
 */
export function planRelationshipNames(design: Design): RelationshipNamePlan {
	const views = resolveRelationships(design);
	const taken = new Map<string, Set<string>>();
	const takenFor = (tableId: string) => {
		let names = taken.get(tableId);
		if (!names) {
			const table = design.tables.find((candidate) => candidate.id === tableId);
			names = new Set((table?.columns ?? []).map((column) => key(splitWords(column.name))));
			taken.set(tableId, names);
		}
		return names;
	};

	const pairCounts = new Map<string, number>();
	for (const view of views) {
		const pair = `${view.referencingTable.id}→${view.referencedTable.id}`;
		pairCounts.set(pair, (pairCounts.get(pair) ?? 0) + 1);
	}

	const relationships = new Map<string, RelationshipNames>();
	for (const view of views) {
		const columnWords = splitWords(view.referencingColumn.name);
		const role =
			columnWords.length > 1 && columnWords[columnWords.length - 1] === "id"
				? columnWords.slice(0, -1)
				: [];
		const forwardBase = role.length > 0 ? role : modelWords(view.referencedTable);
		const forward = claim(takenFor(view.referencingTable.id), [
			forwardBase,
			[...forwardBase, "ref"],
		]);

		const oneToOne = view.oneToOne;
		const tableWords = oneToOne
			? singularWords(view.referencingTable.name)
			: pluralWords(view.referencingTable.name);
		const selfReference = view.referencingTable.id === view.referencedTable.id;
		const repeated =
			(pairCounts.get(`${view.referencingTable.id}→${view.referencedTable.id}`) ?? 0) > 1;
		let backwardBase = tableWords;
		if (selfReference && key(forward) === "parent") {
			backwardBase = oneToOne ? ["child"] : ["children"];
		} else if (selfReference || repeated) {
			backwardBase = [...forward, ...tableWords];
		}
		const backward = claim(takenFor(view.referencedTable.id), [
			backwardBase,
			[...backwardBase, "by", ...forward],
		]);

		relationships.set(view.relationship.id, {
			forward,
			backward,
			backwardIsList: !oneToOne,
		});
	}

	const manyToMany = new Map<string, ManyToManyNames>();
	for (const association of design.manyToManyRelationships ?? []) {
		const left = design.tables.find((table) => table.id === association.leftTableId);
		const right = design.tables.find((table) => table.id === association.rightTableId);
		const junction = design.tables.find((table) => table.id === association.junctionTableId);
		if (!left || !right || !junction) continue;
		const via = singularWords(junction.name);
		const rights = pluralWords(right.name);
		const lefts = pluralWords(left.name);
		manyToMany.set(association.id, {
			left: claim(takenFor(left.id), [rights, [...rights, "via", ...via]]),
			right: claim(takenFor(right.id), [lefts, [...lefts, "via", ...via]]),
		});
	}

	return { relationships, manyToMany };
}

/**
 * Reserves a name in a model: the first free candidate, otherwise the first
 * candidate with a numeric suffix.
 */
function claim(names: Set<string>, candidates: readonly NameWords[]): string[] {
	for (const candidate of candidates) {
		if (!names.has(key(candidate))) {
			names.add(key(candidate));
			return [...candidate];
		}
	}
	for (let index = 2; ; index += 1) {
		const candidate = [...candidates[0], String(index)];
		if (!names.has(key(candidate))) {
			names.add(key(candidate));
			return candidate;
		}
	}
}

function key(words: NameWords): string {
	return words.join("_");
}

function replaceLastWord(words: string[], transform: (word: string) => string): string[] {
	if (words.length === 0) return words;
	return [...words.slice(0, -1), transform(words[words.length - 1])];
}
