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
