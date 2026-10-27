import { describe, expect, test } from "bun:test";
import { createDefaultProofArchitecture } from "../../shared/architecture-proof";
import { generateStandaloneSvg } from "./svg-export";

describe("svg export feasibility", () => {
	test("generates valid standalone SVG with all nodes, groups, services, and connections", () => {
		const arch = createDefaultProofArchitecture();
		const { svg, width, height } = generateStandaloneSvg(arch);

		expect(width).toBeGreaterThan(600);
		expect(height).toBeGreaterThan(400);
		expect(svg).toContain('<?xml version="1.0" encoding="UTF-8"?>');
		expect(svg).toContain("<svg xmlns=\"http://www.w3.org/2000/svg\"");

		// Check self-contained fonts and style definitions
		expect(svg).toContain("font-family: 'IBM Plex Sans'");
		expect(svg).toContain("font-family: 'IBM Plex Mono'");
		// No external network assets or remote stylesheets
		expect(svg).not.toContain("href=\"http");
		expect(svg).not.toContain("src=\"http");
		expect(svg).not.toContain("@import");

		// Check groups
		expect(svg).toContain('id="grp-vpc"');
		expect(svg).toContain('id="grp-compliance"');
		expect(svg).toContain("PRODUCTION VPC");
		expect(svg).toContain("COMPLIANCE BOUNDARY");

		// Check services
		expect(svg).toContain('id="svc-ingestion"');
		expect(svg).toContain('id="svc-processing"');

		// Check components
		expect(svg).toContain('id="comp-client"');
		expect(svg).toContain('id="comp-api"');
		expect(svg).toContain('id="comp-db-primary"');
		expect(svg).toContain('id="comp-db-replica"');
		expect(svg).toContain("SHARED SCHEMA");

		// Check parallel connections
		expect(svg).toContain('id="conn-upload-post"');
		expect(svg).toContain('id="conn-upload-poll"');
		expect(svg).toContain("POST /upload");
		expect(svg).toContain("GET /upload/status");

		// Check abstract service connection
		expect(svg).toContain('id="conn-svc-dispatch"');
		expect(svg).toContain("dispatch_processing");
	});
});
