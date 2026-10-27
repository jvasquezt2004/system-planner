import { createDefaultProofArchitecture } from "../../shared/architecture-proof";
import { generateStandaloneSvg, rasterizeSvgToPng } from "./svg-export";

type Check = { name: string; passed: boolean; details?: unknown; error?: string };

export async function runWebViewProof(reportUrl: string): Promise<void> {
	const checks: Check[] = [];
	const record = (name: string, passed: boolean, details?: unknown) => checks.push({ name, passed, details });
	const fail = (name: string, cause: unknown) => checks.push({ name, passed: false, error: String(cause) });
	const requireElement = <T extends Element>(selector: string): T => {
		const element = document.querySelector<T>(selector);
		if (!element) throw new Error(`Missing rendered element: ${selector}`);
		return element;
	};
	const wait = async (ms = 120) => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, ms);
		await promise;
	};
	const rect = (selector: string) => {
		const { x, y, width, height } = requireElement<HTMLElement>(selector).getBoundingClientRect();
		return { x, y, width, height };
	};
	const click = (el: Element) => {
		if (el instanceof HTMLElement) el.click();
		else el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
	};
	const drag = async (selector: string, dx: number, dy: number) => {
		const node = requireElement<HTMLElement>(selector);
		const box = node.getBoundingClientRect();
		const x = box.left + box.width / 2;
		const y = box.top + box.height / 2;
		node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, buttons: 1, clientX: x, clientY: y, view: window }));
		await wait();
		const viewport = requireElement<HTMLElement>("[data-proof-viewport]");
		viewport.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, buttons: 1, clientX: x + dx, clientY: y + dy, view: window }));
		await wait();
		viewport.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: x + dx, clientY: y + dy, view: window }));
		await wait();
	};

	try {
		await Promise.all([
			document.fonts.load('14px "IBM Plex Sans Variable"'),
			document.fonts.load('14px "IBM Plex Mono"'),
			document.fonts.load('14px "Newsreader Variable"'),
		]);
		await document.fonts.ready;
		const fontChecks = {
			ibmPlexSans: document.fonts.check('14px "IBM Plex Sans Variable"'),
			ibmPlexMono: document.fonts.check('14px "IBM Plex Mono"'),
			newsreader: document.fonts.check('14px "Newsreader Variable"'),
		};
		const fontStyle = getComputedStyle(document.body).fontFamily;
		record("offlineBundledFonts", Object.values(fontChecks).every(Boolean) && /IBM Plex Sans/.test(fontStyle), { fontChecks, fontStyle, fontStatus: document.fonts.status, userAgent: navigator.userAgent, viewport: { width: innerWidth, height: innerHeight } });
		const externalUrls = performance.getEntriesByType("resource").map((entry) => entry.name).filter((name) => {
			if (!/^https?:/i.test(name)) return false;
			const hostname = new URL(name).hostname;
			return hostname !== "127.0.0.1" && hostname !== "localhost";
		});
		record("noExternalNetworkAssets", externalUrls.length === 0, externalUrls);
	} catch (error) { fail("offlineBundledFonts", error); }

	try {
		const componentSelector = '[data-component-id="comp-api"]';
		const beforeRect = rect(componentSelector);
		const connection = requireElement<SVGPathElement>('[data-connection-id="conn-upload-post"]');
		const endpointIds = [connection.dataset.sourceId, connection.dataset.targetId];
		const beforePath = connection.getAttribute("d");
		await drag(componentSelector, 32, 18);
		const afterRect = rect(componentSelector);
		const afterPath = requireElement<SVGPathElement>('[data-connection-id="conn-upload-post"]').getAttribute("d");
		const moved = afterRect.x > beforeRect.x + 20 && afterRect.y > beforeRect.y + 10;
		const updated = beforePath !== afterPath;
		const afterEndpoints = [connection.dataset.sourceId, connection.dataset.targetId];
		record("componentDragUpdatesConnectedPath", moved && updated && JSON.stringify(endpointIds) === JSON.stringify(afterEndpoints), { beforeRect, afterRect, beforePath, afterPath, endpointIds: afterEndpoints });
	} catch (error) { fail("componentDragUpdatesConnectedPath", error); }

	try {
		const groupSelector = '[data-group-id="grp-compliance"]';
		const memberSelector = '[data-component-id="comp-api"]';
		const before = rect(memberSelector);
		const owner = requireElement<HTMLElement>(memberSelector).dataset.ownerServiceId;
		await drag(groupSelector, 28, 14);
		const after = rect(memberSelector);
		const currentOwner = requireElement<HTMLElement>(memberSelector).dataset.ownerServiceId;
		const delta = { x: after.x - before.x, y: after.y - before.y };
		record("overlappingGroupMovesMemberOnce", Math.abs(delta.x - 28) < 2 && Math.abs(delta.y - 14) < 2 && owner === currentOwner, { before, after, delta, ownerServiceId: currentOwner });
	} catch (error) { fail("overlappingGroupMovesMemberOnce", error); }

	try {
		const collapseButton = requireElement<HTMLButtonElement>('[data-service-id="svc-ingestion"] [title="Collapse Service"]');
		collapseButton.click();
		await wait(300);
		const collapsed = Boolean(document.querySelector('[data-service-id="svc-ingestion"][data-collapsed="true"]'));
		const targetId = requireElement<SVGPathElement>('[data-connection-id="conn-upload-post"]').dataset.targetId;
		const visiblePathCount = document.querySelectorAll('[data-connection-id]').length;
		requireElement<HTMLButtonElement>('[data-service-id="svc-ingestion"] [title="Expand Service"]').click();
		await wait(300);
		const expanded = Boolean(document.querySelector('[data-service-id="svc-ingestion"][data-collapsed="false"]'));
		record("serviceCollapseExpandPreservesEndpoint", collapsed && expanded && targetId === "comp-api" && visiblePathCount > 0, { collapsed, expanded, targetId, visiblePathCount });
	} catch (error) { fail("serviceCollapseExpandPreservesEndpoint", error); }

	try {
		const service = requireElement<HTMLElement>('[data-service-id="svc-ingestion"]');
		click(service.querySelector("[data-proof-focus]")!);
		await wait();
		const focused = document.querySelector('[data-proof-focus-context]')?.textContent?.includes("Focusing:") ?? false;
		const outsideContextVisible = Number.parseFloat(getComputedStyle(requireElement('[data-component-id="comp-client"]')).opacity) > 0;
		click(requireElement('[data-proof-focus-context] button'));
		record("serviceFocusRetainsExternalContext", focused && outsideContextVisible, { focused, outsideContextVisible });
	} catch (error) { fail("serviceFocusRetainsExternalContext", error); }

	try {
		const parallel = [...document.querySelectorAll<SVGPathElement>('[data-connection-id]')].filter((path) => ["conn-upload-post", "conn-upload-poll"].includes(path.dataset.connectionId ?? ""));
		const paths = parallel.map((path) => ({ id: path.dataset.connectionId, d: path.getAttribute("d"), length: path.getTotalLength(), rect: path.getBoundingClientRect().toJSON() }));
		record("parallelConnectionsRenderDistinctPaths", paths.length === 2 && paths[0].d !== paths[1].d && (paths[0].rect.x !== paths[1].rect.x || paths[0].rect.y !== paths[1].rect.y), paths);
	} catch (error) { fail("parallelConnectionsRenderDistinctPaths", error); }

	try {
		const paths = [...document.querySelectorAll<SVGPathElement>("[data-connection-id]")];
		const samples = paths.map((path) => {
			const length = path.getTotalLength();
			const point = path.getPointAtLength(length * 0.5);
			return { id: path.dataset.connectionId, length, midpoint: { x: point.x, y: point.y } };
		});
		record("nativeSvgPathSampling", samples.length > 0 && samples.every(({ length, midpoint }) => length > 0 && Number.isFinite(midpoint.x + midpoint.y)), samples);
		const range = requireElement<HTMLInputElement>('input[type="range"]');
		const setRangeValue = (value: number) => {
			const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
			if (!setter) throw new Error("Native range value setter is unavailable");
			setter.call(range, String(value));
			range.dispatchEvent(new Event("input", { bubbles: true }));
			range.dispatchEvent(new Event("change", { bubbles: true }));
		};
		const initial = Number(range.value);
		const forward = Number(range.max) / 2;
		setRangeValue(forward);
		await wait();
		record("playbackSeekForward", Number(range.value) > initial, { initial, seekTo: Number(range.value) });
		const backward = forward * 0.75;
		setRangeValue(backward);
		await wait();
		record("playbackSeekBackward", Number(range.value) < forward, { seekFrom: forward, seekTo: Number(range.value) });
		const playButton = requireElement<HTMLButtonElement>("[data-proof-play]");
		playButton.click();
		await wait(100);
		playButton.click();
		await wait();
		record("playbackPlayPause", playButton.textContent?.includes("Play") ?? false);
		const speed = requireElement<HTMLButtonElement>('[data-proof-speed="2"]');
		speed.click();
		await wait();
		record("playbackSpeedChange", speed.className.includes("bg-pencil"), { selectedSpeed: speed.textContent, className: speed.className });
		const parallelStep = requireElement<HTMLButtonElement>('[data-step-id="step-4a-bucket-write"]');
		click(parallelStep);
		await wait();
		record("parallelWalkthroughStep", parallelStep.className.includes("bg-pencil") && Boolean(document.querySelector('[data-step-id="step-4b-db-write"]')), { activeStep: parallelStep.dataset.stepId, concurrentStep: "step-4b-db-write" });
		const retryStep = requireElement<HTMLButtonElement>('[data-step-id="step-5-retry-sync"]');
		click(retryStep);
		await wait();
		record("finiteRetryStep", retryStep.className.includes("bg-pencil") && retryStep.textContent?.includes("retry ×2") === true, { activeStep: retryStep.dataset.stepId, label: retryStep.textContent });
		const reducedMotion = requireElement<HTMLButtonElement>("[data-proof-reduced-motion]");
		reducedMotion.click();
		await wait();
		record("reducedMotionToggle", reducedMotion.textContent?.includes("ON") ?? false, { text: reducedMotion.textContent });
	} catch (error) { fail("nativeSvgSamplingAndPlayback", error); }

	try {
		const architecture = createDefaultProofArchitecture();
		const { svg, width, height } = generateStandaloneSvg(architecture);
		const pngUrl = await rasterizeSvgToPng(svg, width, height);
		const image = new Image();
		image.src = pngUrl;
		await image.decode();
		const base64 = pngUrl.slice(pngUrl.indexOf(",") + 1);
		const bytes = atob(base64);
		const pngBytes = Uint8Array.from(bytes, (character) => character.charCodeAt(0));
		const png = new DataView(pngBytes.buffer);
		const pngWidth = png.getUint32(16, false);
		const pngHeight = png.getUint32(20, false);
		record("inWebViewSvgPngExport", pngUrl.startsWith("data:image/png;base64,") && pngBytes.length > 100 && pngWidth === width && pngHeight === height && image.naturalWidth === width, { pngBytes: pngBytes.length, width: pngWidth, height: pngHeight, svgDimensions: { width, height }, hasEmbeddedFontCss: svg.includes("IBM Plex Sans") });
	} catch (error) { fail("inWebViewSvgPngExport", error); }

	const report = {
		platform: navigator.platform,
		userAgent: navigator.userAgent,
		viewport: { width: innerWidth, height: innerHeight },
		fontFaceFamilies: [...document.fonts].map((font) => ({ family: font.family, status: font.status })),
		checks,
		allPassed: checks.length > 0 && checks.every(({ passed }) => passed),
	};
	try {
		const response = await fetch(reportUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(report) });
		if (!response.ok) throw new Error(`Report callback returned HTTP ${response.status}`);
	} catch (error) {
		console.error("[webview-proof] failed to submit proof report", error);
	}
}
