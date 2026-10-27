import { join } from "node:path";
import { errorMessage } from "../shared/error-message";
import type { SystemDesignSvgExportRequest, SystemDesignSvgExportResult } from "../shared/rpc";
import { writeNewFile } from "./sql-preview";

export type SystemDesignSvgExportDependencies = {
	/** The native folder picker. Null means the designer cancelled. */
	chooseExportDirectory(): Promise<string | null>;
	now(): Date;
};

export type SystemDesignSvgExports = {
	/**
	 * Writes an SVG the view already built from its snapshot into a new file in a
	 * folder the designer picks. Nothing is written on cancellation or failure, and
	 * an existing file is never overwritten.
	 */
	export(request: SystemDesignSvgExportRequest): Promise<SystemDesignSvgExportResult>;
};

export function createSystemDesignSvgExports(dependencies: SystemDesignSvgExportDependencies): SystemDesignSvgExports {
	return {
		async export({ svg, projectName }: SystemDesignSvgExportRequest): Promise<SystemDesignSvgExportResult> {
			try {
				const start = typeof svg === "string" ? svg.trimStart() : "";
				if (!start.startsWith("<svg") && !start.startsWith("<?xml")) {
					throw new Error("No System design diagram is available to export.");
				}
				const directory = await dependencies.chooseExportDirectory();
				if (directory === null) return { status: "cancelled" };
				if (directory.trim().length === 0) throw new Error("No export folder was selected.");
				const path = join(directory, systemDesignSvgFileName(projectName, dependencies.now()));
				await writeNewFile(path, svg);
				return { status: "saved", path };
			} catch (cause) {
				return { status: "failed", error: errorMessage(cause) };
			}
		},
	};
}

/** "shop-system-design-2026-10-26T21-00-00-000Z.svg": a new name each export, so a repeat never collides. */
export function systemDesignSvgFileName(projectName: string, now: Date): string {
	const slug = projectName
		.normalize("NFKD")
		.replace(/[^\p{L}\p{N}]+/gu, "-")
		.replace(/^-+|-+$/g, "")
		.toLowerCase()
		.slice(0, 60);
	const stamp = now.toISOString().replace(/[:.]/g, "-");
	return `${slug || "project"}-system-design-${stamp}.svg`;
}
