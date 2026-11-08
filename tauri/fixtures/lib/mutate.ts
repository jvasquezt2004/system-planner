/**
 * Deterministic structural mutation of JSON documents, used to build
 * differential fixtures: the TypeScript normalizers are the oracle, and the Rust
 * port must accept and reject exactly the same inputs with the same messages.
 */

export type Rng = () => number;

/** mulberry32: small, fast, and stable across runtimes, so fixtures regenerate identically. */
export function seededRng(seed: number): Rng {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Path = (string | number)[];

function pick<T>(rng: Rng, items: readonly T[]): T {
	return items[Math.floor(rng() * items.length)]!;
}

function isContainer(value: unknown): value is Json[] | { [key: string]: Json } {
	return value !== null && typeof value === "object";
}

/** Every path to a value inside the document, including the containers themselves. */
function collectPaths(value: Json, prefix: Path = [], out: Path[] = []): Path[] {
	if (prefix.length > 0) out.push(prefix);
	if (Array.isArray(value)) value.forEach((item, index) => collectPaths(item, [...prefix, index], out));
	else if (isContainer(value)) for (const key of Object.keys(value)) collectPaths(value[key]!, [...prefix, key], out);
	return out;
}

function collectStrings(value: Json, out: string[] = []): string[] {
	if (typeof value === "string") out.push(value);
	else if (Array.isArray(value)) for (const item of value) collectStrings(item, out);
	else if (isContainer(value)) for (const item of Object.values(value)) collectStrings(item, out);
	return out;
}

function getAt(root: Json, path: Path): Json {
	let current: Json = root;
	for (const step of path) current = (current as never)[step as never] as Json;
	return current;
}

/** Sets or removes the value at a path. `remove` splices array members and deletes object keys. */
function writeAt(root: Json, path: Path, value: Json | undefined, remove = false) {
	const parent = getAt(root, path.slice(0, -1)) as never as Record<string | number, Json>;
	const last = path[path.length - 1]!;
	if (remove) {
		if (Array.isArray(parent)) parent.splice(last as number, 1);
		else delete parent[last];
	} else parent[last] = value as Json;
}

const REPLACEMENTS: readonly Json[] = [
	null,
	true,
	false,
	"",
	" ",
	"\t padded \n",
	"unknown-id",
	"x".repeat(81),
	"x".repeat(121),
	"x".repeat(2001),
	"é".repeat(79),
	"💥".repeat(41),
	0,
	-1,
	1,
	2,
	7,
	10,
	11,
	99,
	100,
	10000,
	10001,
	1.5,
	-2.5,
	2.675,
	1.005,
	1234.5678,
	1e9,
	-0.5,
	[],
	{},
	[null],
	[{}],
	{ x: 1 },
	{ x: "a", y: 2 },
	{ x: -2.5, y: 0.125 },
	// Negative and positive ties after the x100 scaling, where Math.round and Rust's round disagree.
	{ x: -0.005, y: 0.005 },
	{ x: -0.025, y: -0.035 },
	{ x: -0.005, y: -0.015 },
	-0.005,
	-0.025,
	{ width: 10, height: 10 },
	{ width: 400.6, height: 301.2 },
	"top",
	"auto",
	"diagonal",
	"custom",
	"nonsense",
];

/** Applies one random mutation to the document in place. Returns a short description. */
export function mutateOnce(doc: Json, rng: Rng): string {
	const paths = collectPaths(doc);
	if (paths.length === 0) return "none";
	const path = pick(rng, paths);
	const where = path.join(".");
	const strings = collectStrings(doc).filter((value) => value.length > 0 && value.length < 40);
	const roll = rng();
	if (roll < 0.22) {
		writeAt(doc, path, undefined, true);
		return `delete ${where}`;
	}
	if (roll < 0.38) {
		const parentPath = path.slice(0, -1);
		const parent = parentPath.length === 0 ? doc : getAt(doc, parentPath);
		if (Array.isArray(parent)) {
			parent.splice(path[path.length - 1] as number, 0, structuredClone(getAt(doc, path)));
			return `duplicate ${where}`;
		}
	}
	if (roll < 0.55 && strings.length > 0 && typeof getAt(doc, path) === "string") {
		writeAt(doc, path, pick(rng, strings));
		return `swap ${where}`;
	}
	if (roll < 0.62 && isContainer(getAt(doc, path))) {
		const value = getAt(doc, path);
		if (Array.isArray(value) && value.length > 1) {
			value.reverse();
			return `reverse ${where}`;
		}
	}
	writeAt(doc, path, structuredClone(pick(rng, REPLACEMENTS)));
	return `replace ${where}`;
}

/** Applies between `min` and `max` mutations to a clone of the document. */
export function mutate(base: Json, rng: Rng, min = 1, max = 3): { doc: Json; notes: string[] } {
	const doc = structuredClone(base);
	const count = min + Math.floor(rng() * (max - min + 1));
	const notes: string[] = [];
	for (let index = 0; index < count; index += 1) notes.push(mutateOnce(doc, rng));
	return { doc, notes };
}
