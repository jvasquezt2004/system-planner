import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

// The React view for the Tauri app. `cargo tauri dev` starts this server (see src-tauri/tauri.conf.json)
// and `cargo tauri build` bundles `dist/`.
export default defineConfig({
	plugins: [react(), tailwindcss()],
	resolve: {
		alias: [{ find: /^@\//, replacement: `${resolve(__dirname, "src")}/` }],
	},
	build: {
		outDir: "dist",
		emptyOutDir: true,
	},
	server: {
		port: 5173,
		strictPort: true,
	},
	clearScreen: false,
});
