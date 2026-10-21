const MAX_IDENTIFIER_BYTES = 63;

function utf8CharacterByteLength(character: string): number {
	const codePoint = character.codePointAt(0);
	if (codePoint === undefined) return 0;
	return codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
}

/** Counts UTF-8 bytes without encoding or allocating a byte buffer. */
function utf8ByteLength(value: string): number {
	let bytes = 0;
	for (const character of value) bytes += utf8CharacterByteLength(character);
	return bytes;
}

/** Truncates at a Unicode character boundary within PostgreSQL's identifier limit. */
export function truncatePostgresIdentifier(
	value: string,
	maxBytes = MAX_IDENTIFIER_BYTES,
): string {
	let bytes = 0;
	let codeUnits = 0;
	for (const character of value) {
		const characterBytes = utf8CharacterByteLength(character);
		if (bytes + characterBytes > maxBytes) break;
		bytes += characterBytes;
		codeUnits += character.length;
	}
	return codeUnits === value.length ? value : value.slice(0, codeUnits);
}

/** Keeps a distinguishing suffix intact when a generated identifier is shortened. */
export function postgresIdentifierWithSuffix(value: string, suffix: string): string {
	const availableBytes = MAX_IDENTIFIER_BYTES - utf8ByteLength(suffix);
	if (availableBytes < 0) {
		throw new Error("PostgreSQL identifier suffix exceeds the identifier limit.");
	}
	return `${truncatePostgresIdentifier(value, availableBytes)}${suffix}`;
}

/** Finds the first available identifier, suffixing collisions with `_2`, `_3`, etc. */
export function uniquePostgresIdentifier(
	baseName: string,
	occupiedNames: ReadonlySet<string>,
): string {
	for (let index = 1; ; index += 1) {
		const suffix = index === 1 ? "" : `_${index}`;
		const name = postgresIdentifierWithSuffix(baseName, suffix);
		if (!occupiedNames.has(name)) return name;
	}
}

/** Mirrors PostgreSQL makeObjectName for implicit indexes and sequences. */
export function postgresGeneratedObjectName(
	name1: string,
	name2: string | null,
	label: string,
): string {
	let name1Bytes = utf8ByteLength(name1);
	let name2Bytes = name2 === null ? 0 : utf8ByteLength(name2);
	const overhead =
		(name2 === null ? 0 : 1) + utf8ByteLength(label) + 1;
	const availableBytes = MAX_IDENTIFIER_BYTES - overhead;
	if (availableBytes < 0) {
		throw new Error("PostgreSQL generated-name label exceeds the identifier limit.");
	}
	while (name1Bytes + name2Bytes > availableBytes) {
		if (name1Bytes > name2Bytes) name1Bytes -= 1;
		else name2Bytes -= 1;
	}
	const clippedName1 = truncatePostgresIdentifier(name1, name1Bytes);
	const clippedName2 =
		name2 === null ? null : truncatePostgresIdentifier(name2, name2Bytes);
	return `${clippedName1}${clippedName2 === null ? "" : `_${clippedName2}`}_${label}`;
}
