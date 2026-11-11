/// <reference types="vite/client" />

/**
 * The bundled IBM Plex Sans (Latin, variable weight) as a data URL. It is loaded
 * only when an SVG export starts, so the font stays out of the main bundle and the
 * exported file needs no network access to render.
 */
export async function systemDesignSvgFontDataUrl(): Promise<string> {
	const { default: dataUrl } = await import("@fontsource-variable/ibm-plex-sans/files/ibm-plex-sans-latin-wght-normal.woff2?inline");
	return dataUrl;
}
