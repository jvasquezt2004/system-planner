import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

function findFiles(root: string): string[] {
	if (!existsSync(root)) return [];
	const found: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) found.push(...findFiles(path));
		else found.push(path);
	}
	return found;
}

async function main() {
	if (process.platform !== "linux" && process.platform !== "win32") {
		throw new Error(`Packaged proof is supported on Linux and Windows, not ${process.platform}`);
	}
	const platform = process.platform === "win32" ? "stable-win-x64" : "stable-linux-x64";
	const root = join(import.meta.dir, "..");
	const buildDir = join(root, "build", platform);
	if (!existsSync(buildDir)) throw new Error(`Missing packaged build directory: ${buildDir}`);
	const assets = join(root, "dist", "assets");
	const fonts = existsSync(assets)
		? readdirSync(assets).filter((file) => /ibm-plex|newsreader/i.test(file))
		: [];
	if (fonts.length === 0) throw new Error(`No bundled font assets found in ${assets}`);

	const files = findFiles(buildDir);
	const packagedLauncher = process.platform === "win32"
		? files.find((file) => /[\\/]bin[\\/]launcher\.exe$/i.test(file))
		: files.find((file) => /\/bin\/launcher$/.test(file));
	if (!packagedLauncher) throw new Error(`No packaged native launcher found under ${buildDir}`);
	console.log(`Packaged launcher: ${packagedLauncher}`);

	const reportPath = join(root, "build", "webview-proof-report.json");
	rmSync(reportPath, { force: true });
	const env = { ...process.env, SCHEMA_DESIGNER_PROOF_REPORT_PATH: reportPath };
	let launcher = packagedLauncher;
	if (process.platform === "linux") {
		const installedLauncher = join(process.env.HOME ?? "", ".local/share/com.dbplanner.schema-designer/stable/app/bin/launcher");
		const installer = Bun.spawn([packagedLauncher], { cwd: root, env, stdout: "inherit", stderr: "inherit" });
		await installer.exited;
		if (installer.exitCode !== 0) throw new Error(`Packaged installer exited ${installer.exitCode}`);
		if (!existsSync(installedLauncher)) throw new Error(`Packaged application was not installed at ${installedLauncher}`);
		launcher = installedLauncher;
	}
	if (process.platform === "win32") {
		const setup = files.find((file) => /schema.?designer-setup\.exe$/i.test(file));
		if (!setup) throw new Error(`No packaged Windows setup executable found under ${buildDir}`);
		// Electrobun's Windows setup rejects NSIS-style "/S" (InvalidArguments) and treats "--quiet" as an
		// uninstall request (InvalidUninstallLocation), so it runs with no arguments, matching the Linux self-extractor.
		const installer = Bun.spawn([setup], { cwd: root, env, stdout: "inherit", stderr: "inherit" });
		const timedOut = await Promise.race([
			installer.exited.then(() => false),
			Bun.sleep(180_000).then(() => true),
		]);
		if (timedOut) {
			installer.kill();
			throw new Error("Packaged Windows installer did not finish within 180 seconds; it may be waiting on an interactive dialog");
		}
		if (installer.exitCode !== 0) throw new Error(`Packaged Windows installer exited ${installer.exitCode}`);
		const installRoot = join(process.env.LOCALAPPDATA ?? "", "com.dbplanner.schema-designer");
		const installedLauncher = findFiles(installRoot).find((file) => /[\\/]app[\\/]bin[\\/]launcher\.exe$/i.test(file));
		if (!installedLauncher) throw new Error(`Packaged application was not installed under ${installRoot}`);
		launcher = installedLauncher;
	}
	const command = process.platform === "linux" && !process.env.DISPLAY
		? ["xvfb-run", "-a", launcher]
		: [launcher];
	const child = Bun.spawn(command, { cwd: root, env, stdout: "inherit", stderr: "inherit" });
	const deadline = Date.now() + 120_000;
	while (!existsSync(reportPath) && Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error(`Packaged application exited ${child.exitCode} without a WebView report`);
		await Bun.sleep(250);
	}
	if (!existsSync(reportPath)) {
		child.kill();
		throw new Error("Timed out waiting for the native WebView proof report");
	}
	const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
		allPassed?: boolean;
		checks?: { name: string; passed: boolean; error?: string }[];
		userAgent?: string;
		platform?: string;
	};
	if (!Array.isArray(report.checks) || report.checks.length === 0) {
		child.kill();
		throw new Error("Native WebView report omitted its checks");
	}
	const requiredChecks = [
		"offlineBundledFonts",
		"noExternalNetworkAssets",
		"componentDragUpdatesConnectedPath",
		"overlappingGroupMovesMemberOnce",
		"serviceCollapseExpandPreservesEndpoint",
		"serviceFocusRetainsExternalContext",
		"parallelConnectionsRenderDistinctPaths",
		"nativeSvgPathSampling",
		"playbackSeekForward",
		"playbackSeekBackward",
		"playbackPlayPause",
		"playbackSpeedChange",
		"parallelWalkthroughStep",
		"finiteRetryStep",
		"reducedMotionToggle",
		"inWebViewSvgPngExport",
	];
	const checkNames = report.checks.map(({ name }) => name);
	const missing = requiredChecks.filter((name) => !checkNames.includes(name));
	const duplicateNames = checkNames.filter((name, index) => checkNames.indexOf(name) !== index);
	if (missing.length || duplicateNames.length) {
		child.kill();
		throw new Error(`Native WebView report omitted required checks (${missing.join(", ")}) or duplicated names (${duplicateNames.join(", ")})`);
	}
	for (const check of report.checks) {
		console.log(`${check.passed ? "PASS" : "FAIL"} ${check.name}${check.error ? `: ${check.error}` : ""}`);
	}
	const failed = report.checks.filter((check) => !check.passed);
	if (report.allPassed !== true || failed.length > 0) {
		child.kill();
		throw new Error(`Native WebView proof failed ${failed.length} of ${report.checks.length} checks`);
	}
	console.log(`Native WebView proof passed (${report.platform}; ${report.userAgent}); report: ${reportPath}`);
	await child.exited;
	if (child.exitCode !== 0) throw new Error(`Packaged application exited with ${child.exitCode}`);
}

main().catch((error: unknown) => {
	console.error("Packaged WebView verification failed:", error);
	process.exit(1);
});
