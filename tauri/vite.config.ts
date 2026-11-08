import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

// Builds the repository's existing React view for Tauri without touching it.
// The view imports Electrobun's RPC client; here those imports resolve to shims
// that speak Tauri's invoke/listen instead, so src/mainview stays unchanged.
const repo = resolve(__dirname, "..");

export default defineConfig({
	plugins: [react(), tailwindcss()],
	resolve: {
		alias: [
			{ find: /^electrobun\/view$/, replacement: resolve(__dirname, "shims/electrobun-view.ts") },
			{ find: /^electrobun\/rpc$/, replacement: resolve(__dirname, "shims/electrobun-rpc.ts") },
			{ find: /^@\//, replacement: `${resolve(repo, "src/mainview")}/` },
		],
	},
	root: resolve(repo, "src/mainview"),
	// Tauri reads this from the directory it was started in (tauri/), not the Vite root.
	cacheDir: resolve(__dirname, "node_modules/.vite"),
	build: {
		outDir: resolve(__dirname, "dist"),
		emptyOutDir: true,
	},
	server: {
		port: 5173,
		strictPort: true,
		fs: { allow: [repo] },
	},
	clearScreen: false,
});
