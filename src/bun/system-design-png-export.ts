import { join } from "node:path";
import { errorMessage } from "../shared/error-message";
import type { SystemDesignExportResult, SystemDesignPngExportRequest } from "../shared/rpc";
import { systemDesignFileName } from "./system-design-svg-export";
import { writeNewFile } from "./sql-preview";

export type SystemDesignPngExportDependencies = {
	/** The native folder picker. Null means the designer cancelled. */
	chooseExportDirectory(): Promise<string | null>;
	now(): Date;
};

export type SystemDesignPngExports = {
	/**
	 * Writes a PNG the view rasterized from its snapshot into a new file in a folder
	 * the designer picks. The bytes are checked to be a complete PNG before the
	 * picker opens. Nothing is written on cancellation or failure, and an existing
	 * file is never overwritten.
	 */
	export(request: SystemDesignPngExportRequest): Promise<SystemDesignExportResult>;
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Every PNG ends with this zero-length IEND chunk, so its presence shows the file was not cut short. */
const PNG_TRAILER = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

export function createSystemDesignPngExports(dependencies: SystemDesignPngExportDependencies): SystemDesignPngExports {
	return {
		async export({ png, projectName }: SystemDesignPngExportRequest): Promise<SystemDesignExportResult> {
			try {
				const bytes = decodePng(png);
				const directory = await dependencies.chooseExportDirectory();
				if (directory === null) return { status: "cancelled" };
				if (directory.trim().length === 0) throw new Error("No export folder was selected.");
				const path = join(directory, systemDesignFileName(projectName, dependencies.now(), "png"));
				await writeNewFile(path, bytes);
				return { status: "saved", path };
			} catch (cause) {
				return { status: "failed", error: errorMessage(cause) };
			}
		},
	};
}

/**
 * Decodes base64 PNG bytes and refuses anything that is not a complete PNG: the
 * signature, a leading IHDR chunk with positive dimensions, and the IEND trailer.
 */
export function decodePng(base64: string): Buffer {
	if (typeof base64 !== "string" || base64.length === 0) {
		throw new Error("No System design diagram is available to export.");
	}
	const bytes = Buffer.from(base64, "base64");
	const headerEnd = PNG_SIGNATURE.length + 25;
	const looksLikePng =
		bytes.length >= headerEnd + PNG_TRAILER.length &&
		bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) &&
		bytes.readUInt32BE(PNG_SIGNATURE.length) === 13 &&
		bytes.subarray(PNG_SIGNATURE.length + 4, PNG_SIGNATURE.length + 8).toString("latin1") === "IHDR" &&
		bytes.readUInt32BE(PNG_SIGNATURE.length + 8) > 0 &&
		bytes.readUInt32BE(PNG_SIGNATURE.length + 12) > 0 &&
		bytes.subarray(bytes.length - PNG_TRAILER.length).equals(PNG_TRAILER);
	if (!looksLikePng) throw new Error("The System design image is not a complete PNG.");
	return bytes;
}
