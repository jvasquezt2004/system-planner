import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";
import { electrobunViteAliases } from "./.hutch/devkit/api/config/electrobun-vite";

export default defineConfig({
	plugins: [react(), tailwindcss()],
	resolve: {
		alias: [
			...electrobunViteAliases(resolve(__dirname, ".hutch/devkit")),
			{ find: /^@\//, replacement: `${resolve(__dirname, "src/mainview")}/` },
		],
	},
	root: "src/mainview",
	build: {
		outDir: "../../dist",
		emptyOutDir: true,
		rollupOptions: {
			input: {
				main: resolve(__dirname, "src/mainview/index.html"),
				sql: resolve(__dirname, "src/mainview/sql.html"),
			},
		},
	},
	server: {
		port: 5173,
		strictPort: true,
	},
});
