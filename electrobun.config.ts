import type { ElectrobunConfig } from "electrobun";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

function copyDeclarationFiles(source: string, destination: string, include: (fileName: string) => boolean): Record<string, string> {
	const copies: Record<string, string> = {};
	const visit = (sourcePath: string, relativePath: string) => {
		for (const entry of readdirSync(sourcePath, { withFileTypes: true })) {
			const relativeEntry = join(relativePath, entry.name);
			const sourceEntry = join(sourcePath, entry.name);
			if (entry.isDirectory()) visit(sourceEntry, relativeEntry);
			else if (entry.isFile() && include(entry.name)) {
				copies[join(source, relativeEntry).replaceAll("\\", "/")] = join(destination, relativeEntry).replaceAll("\\", "/");
			}
		}
	};
	visit(resolve(import.meta.dir, source), "");
	return copies;
}

const assistantTypeCopies = {
	...copyDeclarationFiles("node_modules/typescript/lib", "bun/assistant-types/typescript/lib", (fileName) => /^lib\..*\.d\.ts$/.test(fileName)),
	...copyDeclarationFiles("node_modules/@supabase/supabase-js/dist", "bun/assistant-types/node_modules/@supabase/supabase-js/dist", (fileName) => /\.(?:d\.ts|d\.mts|d\.cts)$/.test(fileName)),
	...copyDeclarationFiles("node_modules/@supabase/postgrest-js/dist", "bun/assistant-types/node_modules/@supabase/postgrest-js/dist", (fileName) => /\.(?:d\.ts|d\.mts|d\.cts)$/.test(fileName)),
	...copyDeclarationFiles("node_modules/@supabase/auth-js/dist", "bun/assistant-types/node_modules/@supabase/auth-js/dist", (fileName) => /\.(?:d\.ts|d\.mts|d\.cts)$/.test(fileName)),
	...copyDeclarationFiles("node_modules/@supabase/functions-js/dist", "bun/assistant-types/node_modules/@supabase/functions-js/dist", (fileName) => /\.(?:d\.ts|d\.mts|d\.cts)$/.test(fileName)),
	...copyDeclarationFiles("node_modules/@supabase/realtime-js/dist", "bun/assistant-types/node_modules/@supabase/realtime-js/dist", (fileName) => /\.(?:d\.ts|d\.mts|d\.cts)$/.test(fileName)),
	...copyDeclarationFiles("node_modules/@supabase/storage-js/dist", "bun/assistant-types/node_modules/@supabase/storage-js/dist", (fileName) => /\.(?:d\.ts|d\.mts|d\.cts)$/.test(fileName)),
	...copyDeclarationFiles("node_modules/@supabase/phoenix/priv/static/types", "bun/assistant-types/node_modules/@supabase/phoenix/priv/static/types", (fileName) => /\.(?:d\.ts|d\.mts|d\.cts)$/.test(fileName)),
	...copyDeclarationFiles("node_modules/iceberg-js/dist", "bun/assistant-types/node_modules/iceberg-js/dist", (fileName) => /\.(?:d\.ts|d\.mts|d\.cts)$/.test(fileName)),
};

export default {
	app: {
		name: "Schema Designer",
		identifier: "com.dbplanner.schema-designer",
		version: "0.0.1",
	},
	build: {
		mainProcess: "bun",
		bun: {
			entrypoint: "src/bun/index.ts",
		},
		// Vite builds to dist/, we copy from there
		copy: {
			"dist/index.html": "views/mainview/index.html",
			"dist/assets": "views/mainview/assets",
			// PGlite resolves its WebAssembly runtime relative to the bundled
			// main process, so the assets ship beside it in the packaged app.
			"node_modules/@electric-sql/pglite/dist/pglite.wasm": "bun/pglite.wasm",
			// The PostgreSQL 17 libpg_query parser is pure WASM; ship its module asset beside the Bun process.
			"node_modules/@pgsql/parser/wasm/v17/libpg-query.wasm": "bun/libpg-query.wasm",
			"node_modules/@electric-sql/pglite/dist/pglite.data": "bun/pglite.data",
			"node_modules/@electric-sql/pglite/dist/initdb.wasm": "bun/initdb.wasm",
			// pgvector is loaded as an extension bundle from the same place.
			"node_modules/@electric-sql/pglite-pgvector/dist/vector.tar.gz": "bun/vector.tar.gz",
			...assistantTypeCopies,
		},
		// Ignore Vite output in watch mode — HMR handles view rebuilds separately
		watchIgnore: ["dist/**"],
		mac: {
			bundleCEF: false,
		},
		linux: {
			bundleCEF: false,
		},
		win: {
			bundleCEF: false,
		},
	},
} satisfies ElectrobunConfig;
