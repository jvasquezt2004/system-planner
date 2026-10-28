import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("Button preserves the Radix menu anchor and catalog selections add components", () => {
	const result = Bun.spawnSync([process.execPath, fileURLToPath(new URL("./test-dom/component-menu.tsx", import.meta.url))], {
		stdout: "pipe", stderr: "pipe",
	});
	expect({ exitCode: result.exitCode, output: result.stdout.toString() + result.stderr.toString() }).toEqual({
		exitCode: 0, output: "Button refs and Add component catalog interactions passed\n",
	});
});
