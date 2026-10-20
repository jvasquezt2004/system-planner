import type { ElectrobunConfig } from "electrobun";

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
			"node_modules/@electric-sql/pglite/dist/pglite.data": "bun/pglite.data",
			"node_modules/@electric-sql/pglite/dist/initdb.wasm": "bun/initdb.wasm",
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
