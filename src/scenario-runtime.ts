import ts from "typescript";

export function findRuntimeImport(source: string, allowed: (specifier: string) => boolean): string | null {
	const file = ts.createSourceFile("worker.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	let message: string | null = null;
	const visit = (node: ts.Node): void => {
		if (message) return;
		if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
			const specifier = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : "";
			if (!allowed(specifier)) message = `Runtime import is not supported: ${specifier || "unknown module"}.`;
		}
		if (ts.isExportDeclaration(node) && node.moduleSpecifier && !node.isTypeOnly) {
			const specifier = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : "";
			if (!allowed(specifier)) message = `Runtime import is not supported: ${specifier || "unknown module"}.`;
		}
		if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly) message = "Runtime imports are not supported.";
		if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) message = "Dynamic imports are not supported.";
		ts.forEachChild(node, visit);
	};
	visit(file);
	return message;
}

export type ScenarioExpectationResult = {
	description: string;
	passed: boolean;
	message: string;
};

export type RecordExpectation = (description: string, passed: boolean, message: string) => void;

export type ScenarioExpectation = {
	succeeds(): ScenarioExpectation;
	fails(code?: string): ScenarioExpectation;
	returnsDataEqual(expected: unknown): ScenarioExpectation;
};

export type ScenarioRequestResult = {
	data?: unknown;
	error?: { code?: string; message?: string } | null;
};

export function isScenarioRequestResult(value: unknown): value is ScenarioRequestResult {
	if (typeof value !== "object" || value === null) return false;
	if ("then" in value && typeof value.then === "function") return false;
	return "data" in value || "error" in value;
}

export function deepEqual(actual: unknown, expected: unknown): boolean {
	if (Object.is(actual, expected)) return true;
	if (typeof actual !== "object" || actual === null || typeof expected !== "object" || expected === null) return false;
	if (Array.isArray(actual) !== Array.isArray(expected)) return false;
	const actualRecord: Record<string, unknown> = actual as Record<string, unknown>;
	const expectedRecord: Record<string, unknown> = expected as Record<string, unknown>;
	const actualKeys = Object.keys(actual);
	const expectedKeys = Object.keys(expected);
	return actualKeys.length === expectedKeys.length
		&& expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(actual, key) && deepEqual(actualRecord[key], expectedRecord[key]));
}

export function stringify(value: unknown): string {
	if (typeof value === "string") return value;
	try { return JSON.stringify(value); } catch { return String(value); }
}

export function createScenarioExpect(recordExpectation: RecordExpectation): (value: unknown) => ScenarioExpectation {
	return (value: unknown): ScenarioExpectation => {
		const pending = value !== null && typeof value === "object" && "then" in value && typeof value.then === "function";
		const valid = isScenarioRequestResult(value);
		const invalidReason = pending
			? "expect() received a pending request; await it first"
			: valid ? null : "expect() requires an awaited request result";
		const result: ScenarioRequestResult = valid ? value : {};
		const recordInvalidInput = (description: string): boolean => {
			if (!invalidReason) return false;
			recordExpectation(description, false, invalidReason);
			return true;
		};
		const expectation: ScenarioExpectation = {
			succeeds() {
				if (!recordInvalidInput("request succeeds")) {
					const passed = !result.error;
					recordExpectation("request succeeds", passed, passed ? "Request succeeded." : `Request failed: ${result.error?.message ?? result.error?.code ?? "unknown error"}`);
				}
				return expectation;
			},
			fails(code?: string) {
				if (!recordInvalidInput(code ? `request fails with ${code}` : "request fails")) {
					const matchesFailure = Boolean(result.error) && (!code || result.error?.code === code);
					recordExpectation(
						code ? `request fails with ${code}` : "request fails",
						matchesFailure,
						matchesFailure ? `Request failed${code ? ` with ${code}` : ""}.` : result.error ? `Expected error ${code}, received ${result.error?.code ?? "unknown error"}.` : "Expected request to fail, but it succeeded.",
					);
				}
				return expectation;
			},
			returnsDataEqual(expected: unknown) {
				if (!recordInvalidInput("request returns expected data")) {
					const passed = deepEqual(result.data, expected);
					recordExpectation("request returns expected data", passed, passed ? "Returned data matched." : `Expected ${stringify(expected)}, received ${stringify(result.data)}.`);
				}
				return expectation;
			},
		};
		return expectation;
	};
}
