/**
 * Rasterizes a System design SVG to PNG in the view's own engine. The SVG is
 * self-contained (colours resolved, font embedded as a data URL), so the image
 * decodes without network access in the packaged WebView, and the bytes match
 * the SVG export drawn from the same snapshot.
 */

/** Pixels per SVG unit. Two keeps the labels crisp on high-density screens and when printed. */
export const PNG_EXPORT_SCALE = 2;
/** A canvas larger than this is refused by some WebViews, so a very large diagram is drawn at a lower scale. */
export const MAX_PNG_PIXELS = 16_777_216;
/** The largest side a canvas can have in the supported WebViews. */
export const MAX_PNG_SIDE = 16_384;

export type SvgSize = { width: number; height: number };
export type PngRasterSize = SvgSize & { scale: number };

/** Reads the root `<svg>` width and height that the SVG renderer writes. */
export function svgSize(svg: string): SvgSize {
	const root = svg.match(/<svg\b[^>]*>/)?.[0] ?? "";
	const width = Number(root.match(/\swidth="([\d.]+)"/)?.[1]);
	const height = Number(root.match(/\sheight="([\d.]+)"/)?.[1]);
	if (!(width > 0) || !(height > 0)) throw new Error("The System design diagram has no drawable size.");
	return { width, height };
}

/**
 * The canvas size for a drawing: the requested scale, reduced only when the
 * drawing would exceed the canvas limits. The result is never smaller than one
 * pixel on either side.
 */
export function pngRasterSize({ width, height }: SvgSize): PngRasterSize {
	if (!(width > 0) || !(height > 0)) throw new Error("The System design diagram has no drawable size.");
	const scale = Math.min(
		PNG_EXPORT_SCALE,
		Math.sqrt(MAX_PNG_PIXELS / (width * height)),
		MAX_PNG_SIDE / Math.max(width, height),
	);
	return {
		width: Math.max(1, Math.round(width * scale)),
		height: Math.max(1, Math.round(height * scale)),
		scale,
	};
}

/** Draws the SVG onto a canvas and returns the canvas's PNG bytes. */
export async function rasterizeSystemDesignSvg(svg: string): Promise<Uint8Array> {
	const size = pngRasterSize(svgSize(svg));
	const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
	try {
		const image = new Image();
		image.src = url;
		await image.decode();

		const canvas = document.createElement("canvas");
		canvas.width = size.width;
		canvas.height = size.height;
		const context = canvas.getContext("2d");
		if (!context) throw new Error("The System design image could not be drawn.");
		context.drawImage(image, 0, 0, size.width, size.height);

		const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
		if (!png) throw new Error("The System design image could not be encoded as PNG.");
		return new Uint8Array(await png.arrayBuffer());
	} finally {
		URL.revokeObjectURL(url);
	}
}

/** Base64 for the RPC bridge, built in chunks so a large image does not overflow the argument list. */
export function bytesToBase64(bytes: Uint8Array): string {
	const chunkSize = 0x8000;
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
	}
	return btoa(binary);
}
