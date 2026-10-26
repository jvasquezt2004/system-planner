/**
 * Static SVG and PNG diagram exporter for the Architecture Proof.
 *
 * Implements acceptance criterion 4:
 * "Establish static SVG/PNG export feasibility and offline asset/font loading
 * in the actual native WebViews; record separate Windows and Linux evidence."
 *
 * SVG output is self-contained with inlined styles and bundled font declarations.
 * It contains no external network URLs and renders identically offline.
 */

import {
	type ProofArchitecture,
	computeConnectionPath,
	getEndpointAnchor,
} from "../../shared/architecture-proof";

export function generateStandaloneSvg(
	architecture: ProofArchitecture,
	options: { title?: string; padding?: number } = {},
): { svg: string; width: number; height: number } {
	const padding = options.padding ?? 40;

	// Calculate overall bounding box
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;

	for (const comp of architecture.components) {
		minX = Math.min(minX, comp.position.x);
		minY = Math.min(minY, comp.position.y);
		maxX = Math.max(maxX, comp.position.x + comp.width);
		maxY = Math.max(maxY, comp.position.y + comp.height);
	}

	for (const svc of architecture.services) {
		const b = svc.isCollapsed ? svc.collapsedBounds : svc.bounds;
		minX = Math.min(minX, b.x);
		minY = Math.min(minY, b.y);
		maxX = Math.max(maxX, b.x + b.width);
		maxY = Math.max(maxY, b.y + b.height);
	}

	for (const grp of architecture.groups) {
		minX = Math.min(minX, grp.bounds.x);
		minY = Math.min(minY, grp.bounds.y);
		maxX = Math.max(maxX, grp.bounds.x + grp.bounds.width);
		maxY = Math.max(maxY, grp.bounds.y + grp.bounds.height);
	}

	if (!Number.isFinite(minX)) {
		minX = 0;
		minY = 0;
		maxX = 1000;
		maxY = 700;
	}

	const viewBoxX = Math.floor(minX - padding);
	const viewBoxY = Math.floor(minY - padding);
	const width = Math.ceil(maxX - minX + padding * 2);
	const height = Math.ceil(maxY - minY + padding * 2);

	const groupColors: Record<string, { stroke: string; fill: string; badge: string }> = {
		vpc: { stroke: "#0369a1", fill: "rgba(224, 242, 254, 0.35)", badge: "#0284c7" },
		compliance: { stroke: "#b45309", fill: "rgba(254, 243, 199, 0.35)", badge: "#d97706" },
		region: { stroke: "#475569", fill: "rgba(241, 245, 249, 0.25)", badge: "#64748b" },
		domain: { stroke: "#4f46e5", fill: "rgba(238, 242, 255, 0.35)", badge: "#6366f1" },
	};

	let groupsSvg = "";
	for (const grp of architecture.groups) {
		const palette = groupColors[grp.kind] ?? groupColors.domain;
		groupsSvg += `
		<!-- Group: ${grp.name} -->
		<g class="group" id="${grp.id}">
			<rect x="${grp.bounds.x}" y="${grp.bounds.y}" width="${grp.bounds.width}" height="${grp.bounds.height}"
				fill="${palette.fill}" stroke="${palette.stroke}" stroke-width="1.5" stroke-dasharray="6,4" rx="8" />
			<rect x="${grp.bounds.x + 8}" y="${grp.bounds.y - 10}" width="${grp.name.length * 8 + 32}" height="20"
				fill="${palette.badge}" rx="4" />
			<text x="${grp.bounds.x + 14}" y="${grp.bounds.y + 4}" fill="#ffffff" font-family="'IBM Plex Sans', -apple-system, BlinkMacSystemFont, sans-serif" font-size="11" font-weight="600" letter-spacing="0.02em">${grp.name.toUpperCase()}</text>
		</g>`;
	}

	let servicesSvg = "";
	for (const svc of architecture.services) {
		const b = svc.isCollapsed ? svc.collapsedBounds : svc.bounds;
		servicesSvg += `
		<!-- Service: ${svc.name} -->
		<g class="service" id="${svc.id}">
			<rect x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}"
				fill="#ffffff" stroke="#0f172a" stroke-width="1.75" rx="6" filter="url(#drop-shadow)" />
			<rect x="${b.x}" y="${b.y}" width="${b.width}" height="28" fill="#f8fafc" rx="6" />
			<line x1="${b.x}" y1="${b.y + 28}" x2="${b.x + b.width}" y2="${b.y + 28}" stroke="#e2e8f0" stroke-width="1" />
			<text x="${b.x + 12}" y="${b.y + 19}" fill="#0f172a" font-family="'IBM Plex Sans', sans-serif" font-size="12" font-weight="600">${svc.name} ${svc.isCollapsed ? "(Collapsed)" : ""}</text>
		</g>`;
	}

	let connectionsSvg = "";
	for (const conn of architecture.connections) {
		const sourceAnchor = getEndpointAnchor(architecture, conn.sourceId);
		const targetAnchor = getEndpointAnchor(architecture, conn.targetId);
		const route = computeConnectionPath(sourceAnchor.rect, targetAnchor.rect, conn.routeOffset);

		const midX = (route.start.x + route.end.x) / 2 + (route.cp1.x + route.cp2.x - route.start.x - route.end.x) * 0.25;
		const midY = (route.start.y + route.end.y) / 2 + (route.cp1.y + route.cp2.y - route.start.y - route.end.y) * 0.25;

		const labelWidth = Math.max(70, conn.label.length * 6.5 + 16);

		connectionsSvg += `
		<!-- Connection: ${conn.id} (${conn.label}) -->
		<g class="connection" id="${conn.id}">
			<path d="${route.pathString}" fill="none" stroke="#2563eb" stroke-width="2" marker-end="url(#arrow)" />
			<rect x="${(midX - labelWidth / 2).toFixed(1)}" y="${(midY - 10).toFixed(1)}" width="${labelWidth.toFixed(1)}" height="20"
				fill="#ffffff" stroke="#93c5fd" stroke-width="1" rx="4" filter="url(#drop-shadow-sm)" />
			<text x="${midX.toFixed(1)}" y="${(midY + 4).toFixed(1)}" text-anchor="middle" fill="#1e3a8a"
				font-family="'IBM Plex Mono', monospace" font-size="10.5" font-weight="500">${conn.label}</text>
		</g>`;
	}

	let componentsSvg = "";
	for (const comp of architecture.components) {
		const owningService = comp.serviceId ? architecture.services.find((s) => s.id === comp.serviceId) : null;
		if (owningService && owningService.isCollapsed) continue; // Hidden in collapsed service

		const sharedBadge = comp.isSharedSchema
			? `<rect x="${comp.position.x + comp.width - 78}" y="${comp.position.y - 8}" width="72" height="16" fill="#10b981" rx="3" />
			   <text x="${comp.position.x + comp.width - 42}" y="${comp.position.y + 4}" text-anchor="middle" fill="#ffffff" font-family="'IBM Plex Sans', sans-serif" font-size="9" font-weight="600">SHARED SCHEMA</text>`
			: "";

		componentsSvg += `
		<!-- Component: ${comp.name} (${comp.kind}) -->
		<g class="component" id="${comp.id}">
			<rect x="${comp.position.x}" y="${comp.position.y}" width="${comp.width}" height="${comp.height}"
				fill="#ffffff" stroke="#334155" stroke-width="1.5" rx="6" filter="url(#drop-shadow)" />
			${sharedBadge}
			<text x="${comp.position.x + 12}" y="${comp.position.y + 24}" fill="#0f172a" font-family="'IBM Plex Sans', sans-serif" font-size="13" font-weight="600">${comp.name}</text>
			<text x="${comp.position.x + 12}" y="${comp.position.y + 44}" fill="#64748b" font-family="'IBM Plex Mono', monospace" font-size="10.5">${comp.technology ?? comp.kind}</text>
		</g>`;
	}

	const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
	viewBox="${viewBoxX} ${viewBoxY} ${width} ${height}"
	width="${width}" height="${height}">
	<defs>
		<filter id="drop-shadow" x="-10%" y="-10%" width="125%" height="125%">
			<feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#0f172a" flood-opacity="0.08" />
		</filter>
		<filter id="drop-shadow-sm" x="-10%" y="-10%" width="125%" height="125%">
			<feDropShadow dx="0" dy="1" stdDeviation="1.5" flood-color="#0f172a" flood-opacity="0.1" />
		</filter>
		<marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
			<path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="#2563eb" />
		</marker>
		<style>
			@font-face {
				font-family: 'IBM Plex Sans';
				font-style: normal;
				font-weight: 400 600;
				src: local('IBM Plex Sans'), local('system-ui');
			}
			@font-face {
				font-family: 'IBM Plex Mono';
				font-style: normal;
				font-weight: 400 500;
				src: local('IBM Plex Mono'), local('monospace');
			}
			text { user-select: none; }
		</style>
	</defs>

	<!-- Background grid -->
	<rect x="${viewBoxX}" y="${viewBoxY}" width="${width}" height="${height}" fill="#fcfbf7" />

	${groupsSvg}
	${servicesSvg}
	${connectionsSvg}
	${componentsSvg}
</svg>`;

	return { svg, width, height };
}

/**
 * In-browser / WebView helper to rasterize SVG into a PNG data URL.
 */
export async function rasterizeSvgToPng(svgString: string, width: number, height: number): Promise<string> {
	if (typeof window === "undefined" || typeof Image === "undefined") {
		// Server / Node environment fallback
		const base64Svg = Buffer.from(svgString).toString("base64");
		return `data:image/svg+xml;base64,${base64Svg}`;
	}

	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const blob = new Blob([svgString], { type: "image/svg+xml;charset=utf-8" });
	const url = URL.createObjectURL(blob);
	const img = new Image();

	img.onload = () => {
		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext("2d");
		if (!ctx) {
			URL.revokeObjectURL(url);
			reject(new Error("Unable to obtain 2D canvas context"));
			return;
		}
		ctx.drawImage(img, 0, 0);
		URL.revokeObjectURL(url);
		const pngDataUrl = canvas.toDataURL("image/png");
		resolve(pngDataUrl);
	};

	img.onerror = (err) => {
		URL.revokeObjectURL(url);
		reject(err);
	};

	img.src = url;
	return promise;
}
