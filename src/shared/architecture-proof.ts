/**
 * Architecture Technical Proof Model and Fixtures
 *
 * Implements the domain contracts from docs/system-design-build-plan.md (Checkpoint 1)
 * and ADR-0005, ADR-0007, ADR-0010:
 * - Components with explicit Service ownership or system scope
 * - Overlapping and nested Groups independent of geometry and ownership
 * - Deduplicated Group movement (each member moves once)
 * - Directed labeled Connections, including parallel Connections between identical endpoints
 * - Service projection (collapse/expand, focus) preserving actual endpoint identities
 * - Authored Walkthrough timeline with deterministic time-derived playback
 * - Parallel execution branches, finite repetitions, and arrival reactions
 * - Offline static SVG export geometry
 */

export type ProofComponentKind =
	| "browser"
	| "mobile-app"
	| "person"
	| "external-system"
	| "dns"
	| "cdn"
	| "load-balancer"
	| "api-gateway"
	| "proxy"
	| "application"
	| "api"
	| "worker"
	| "scheduled-job"
	| "serverless-handler"
	| "database"
	| "cache"
	| "bucket"
	| "file-storage"
	| "search-index"
	| "queue"
	| "topic"
	| "event-bus"
	| "event-stream"
	| "identity-provider"
	| "secrets-store"
	| "configuration"
	| "observability"
	| "custom";

export type ComponentAction = "send" | "receive" | "process" | "succeed" | "fail";

export type ProofPoint = { x: number; y: number };
export type ProofRect = { x: number; y: number; width: number; height: number };

export type ProofComponent = {
	id: string;
	name: string;
	kind: ProofComponentKind;
	serviceId?: string | null;
	designId?: string | null;
	isSharedSchema?: boolean;
	position: ProofPoint;
	width: number;
	height: number;
	technology?: string;
	notes?: string;
};

export type ProofService = {
	id: string;
	name: string;
	isCollapsed: boolean;
	bounds: ProofRect;
	collapsedBounds: ProofRect;
};

export type ProofGroupKind = "vpc" | "region" | "compliance" | "domain";

export type ProofGroup = {
	id: string;
	name: string;
	kind: ProofGroupKind;
	bounds: ProofRect;
	memberComponentIds: string[];
	memberServiceIds: string[];
	memberGroupIds?: string[];
};

export type ProofConnection = {
	id: string;
	sourceId: string;
	targetId: string;
	label: string;
	protocol?: string;
	interactionType?: string;
	routeOffset?: number; // Perpendicular offset multiplier for parallel routes
};

export type ProofWalkthroughStep = {
	id: string;
	title: string;
	explanation: string;
	connectionId: string;
	durationMs: number;
	action: ComponentAction;
	targetReaction: ComponentAction;
	reactionMessage?: string;
	parallelGroupId?: string;
	repeatCount?: number;
};

export type ProofWalkthrough = {
	id: string;
	name: string;
	steps: ProofWalkthroughStep[];
};

export type ProofArchitecture = {
	components: ProofComponent[];
	services: ProofService[];
	groups: ProofGroup[];
	connections: ProofConnection[];
	walkthrough: ProofWalkthrough;
};

/**
 * Standard Image Upload System technical proof fixture (docs/system-design-build-plan.md lines 293-298).
 */
export function createDefaultProofArchitecture(): ProofArchitecture {
	const components: ProofComponent[] = [
		{
			id: "comp-client",
			name: "Client Browser",
			kind: "browser",
			serviceId: null,
			position: { x: 40, y: 160 },
			width: 170,
			height: 64,
			technology: "Web client",
		},
		{
			id: "comp-api",
			name: "Upload API",
			kind: "api",
			serviceId: "svc-ingestion",
			position: { x: 300, y: 150 },
			width: 170,
			height: 64,
			technology: "FastAPI / Node",
		},
		{
			id: "comp-queue",
			name: "Upload Queue",
			kind: "queue",
			serviceId: null,
			position: { x: 440, y: 340 },
			width: 170,
			height: 64,
			technology: "Amazon SQS",
		},
		{
			id: "comp-worker",
			name: "Image Worker",
			kind: "worker",
			serviceId: "svc-processing",
			position: { x: 620, y: 150 },
			width: 170,
			height: 64,
			technology: "Go / Libvips",
		},
		{
			id: "comp-bucket",
			name: "Raw Storage Bucket",
			kind: "bucket",
			serviceId: null,
			position: { x: 880, y: 110 },
			width: 180,
			height: 64,
			technology: "Cloudflare R2",
		},
		{
			id: "comp-db-primary",
			name: "Media DB (Primary)",
			kind: "database",
			serviceId: null,
			designId: "design-main-schema",
			position: { x: 880, y: 230 },
			width: 180,
			height: 64,
			technology: "PostgreSQL 17",
		},
		{
			id: "comp-db-replica",
			name: "Media DB (Replica)",
			kind: "database",
			serviceId: null,
			designId: "design-main-schema",
			isSharedSchema: true,
			position: { x: 880, y: 350 },
			width: 180,
			height: 64,
			technology: "PostgreSQL Replica",
		},
		{
			id: "comp-db-analytics",
			name: "Analytics DB",
			kind: "database",
			serviceId: null,
			designId: "design-analytics-schema",
			position: { x: 880, y: 470 },
			width: 180,
			height: 64,
			technology: "ClickHouse",
		},
		{
			id: "comp-telemetry",
			name: "Telemetry Service",
			kind: "observability",
			serviceId: null,
			position: { x: 620, y: 470 },
			width: 170,
			height: 64,
			technology: "OpenTelemetry",
		},
	];

	const services: ProofService[] = [
		{
			id: "svc-ingestion",
			name: "Ingestion Service",
			isCollapsed: false,
			bounds: { x: 270, y: 90, width: 230, height: 160 },
			collapsedBounds: { x: 270, y: 130, width: 210, height: 74 },
		},
		{
			id: "svc-processing",
			name: "Processing Service",
			isCollapsed: false,
			bounds: { x: 590, y: 90, width: 230, height: 160 },
			collapsedBounds: { x: 590, y: 130, width: 210, height: 74 },
		},
	];

	const groups: ProofGroup[] = [
		{
			id: "grp-vpc",
			name: "Production VPC",
			kind: "vpc",
			bounds: { x: 250, y: 60, width: 830, height: 380 },
			memberComponentIds: [
				"comp-api",
				"comp-worker",
				"comp-queue",
				"comp-db-primary",
				"comp-db-replica",
			],
			memberServiceIds: ["svc-ingestion", "svc-processing"],
		},
		{
			id: "grp-compliance",
			name: "Compliance Boundary",
			kind: "compliance",
			bounds: { x: 280, y: 80, width: 800, height: 230 },
			// Overlaps: contains comp-api (owned by Ingestion), comp-bucket (system scope), comp-db-primary (system scope)
			memberComponentIds: ["comp-api", "comp-bucket", "comp-db-primary"],
			memberServiceIds: [],
		},
		{
			id: "grp-region",
			name: "US-East Region",
			kind: "region",
			bounds: { x: 230, y: 30, width: 870, height: 530 },
			memberComponentIds: [
				"comp-api",
				"comp-worker",
				"comp-queue",
				"comp-bucket",
				"comp-db-primary",
				"comp-db-replica",
				"comp-telemetry",
			],
			memberServiceIds: ["svc-ingestion", "svc-processing"],
			memberGroupIds: ["grp-vpc", "grp-compliance"],
		},
	];

	const connections: ProofConnection[] = [
		// Duplicate endpoints with distinct labels and routes
		{
			id: "conn-upload-post",
			sourceId: "comp-client",
			targetId: "comp-api",
			label: "POST /upload",
			protocol: "HTTPS",
			interactionType: "Command",
			routeOffset: -1.2,
		},
		{
			id: "conn-upload-poll",
			sourceId: "comp-client",
			targetId: "comp-api",
			label: "GET /upload/status",
			protocol: "HTTPS",
			interactionType: "Query",
			routeOffset: 1.2,
		},
		// Abstract Service-to-Service Connection
		{
			id: "conn-svc-dispatch",
			sourceId: "svc-ingestion",
			targetId: "svc-processing",
			label: "dispatch_processing",
			protocol: "gRPC",
			interactionType: "Internal RPC",
			routeOffset: 0,
		},
		// Queue integration
		{
			id: "conn-enqueue",
			sourceId: "comp-api",
			targetId: "comp-queue",
			label: "enqueue_job",
			protocol: "SQS",
			interactionType: "Async Enqueue",
			routeOffset: 0,
		},
		{
			id: "conn-dequeue",
			sourceId: "comp-queue",
			targetId: "comp-worker",
			label: "poll_task",
			protocol: "SQS",
			interactionType: "Async Receive",
			routeOffset: 0,
		},
		// Parallel worker branches
		{
			id: "conn-store-bucket",
			sourceId: "comp-worker",
			targetId: "comp-bucket",
			label: "store_image",
			protocol: "S3 API",
			interactionType: "Blob Write",
			routeOffset: -0.6,
		},
		{
			id: "conn-write-db",
			sourceId: "comp-worker",
			targetId: "comp-db-primary",
			label: "write_metadata",
			protocol: "Postgres Wire",
			interactionType: "SQL Insert",
			routeOffset: 0.6,
		},
		// Database replication
		{
			id: "conn-replicate",
			sourceId: "comp-db-primary",
			targetId: "comp-db-replica",
			label: "replicate_wal",
			protocol: "PG Streaming",
			interactionType: "Replication",
			routeOffset: 0,
		},
		// Telemetry
		{
			id: "conn-telemetry",
			sourceId: "comp-worker",
			targetId: "comp-telemetry",
			label: "emit_metrics",
			protocol: "OTLP",
			interactionType: "Telemetry",
			routeOffset: 0,
		},
	];

	const walkthrough: ProofWalkthrough = {
		id: "wt-image-upload",
		name: "Image Upload & Parallel Processing",
		steps: [
			{
				id: "step-1-upload",
				title: "Client Upload Request",
				explanation: "Client initiates multipart upload to Upload API over HTTPS",
				connectionId: "conn-upload-post",
				durationMs: 1200,
				action: "send",
				targetReaction: "receive",
				reactionMessage: "202 Accepted",
			},
			{
				id: "step-2-enqueue",
				title: "Queue Image Task",
				explanation: "Upload API enqueues job with upload ID and metadata payload",
				connectionId: "conn-enqueue",
				durationMs: 1000,
				action: "send",
				targetReaction: "receive",
				reactionMessage: "Job #8291 Queued",
			},
			{
				id: "step-3-worker-poll",
				title: "Worker Polls Job",
				explanation: "Image Worker polls queue for pending processing jobs",
				connectionId: "conn-dequeue",
				durationMs: 1000,
				action: "receive",
				targetReaction: "process",
				reactionMessage: "Processing Image",
			},
			{
				id: "step-4a-bucket-write",
				title: "Parallel Write: Storage Bucket",
				explanation: "Worker writes processed image variants to Storage Bucket",
				connectionId: "conn-store-bucket",
				durationMs: 1800,
				action: "process",
				targetReaction: "succeed",
				reactionMessage: "Stored: 3.2MB PNG/AVIF",
				parallelGroupId: "parallel-writes",
			},
			{
				id: "step-4b-db-write",
				title: "Parallel Write: Database Metadata",
				explanation: "Simultaneously, Worker writes dimensions and storage keys to Primary DB",
				connectionId: "conn-write-db",
				durationMs: 1500,
				action: "process",
				targetReaction: "succeed",
				reactionMessage: "Row Inserted (ID: 4092)",
				parallelGroupId: "parallel-writes",
			},
			{
				id: "step-5-retry-sync",
				title: "WAL Replication with Transient Retry",
				explanation: "Primary syncs WAL to Replica; attempt 1 encounters timeout, retry succeeds",
				connectionId: "conn-replicate",
				durationMs: 2400,
				action: "process",
				targetReaction: "succeed",
				reactionMessage: "Replicated WAL LSN 0/14B2",
				repeatCount: 2,
			},
			{
				id: "step-6-metrics",
				title: "Emit Processing Telemetry",
				explanation: "Image Worker exports processing duration and memory usage to Telemetry",
				connectionId: "conn-telemetry",
				durationMs: 900,
				action: "send",
				targetReaction: "succeed",
				reactionMessage: "Metrics Pushed: latency=210ms",
			},
		],
	};

	return { components, services, groups, connections, walkthrough };
}

/**
 * Deduplicated group movement: resolves all recursive and overlapping member IDs,
 * moving each component, service, and child group exactly once.
 */
export function moveGroupDeduplicated(
	architecture: ProofArchitecture,
	groupId: string,
	delta: ProofPoint,
): ProofArchitecture {
	const group = architecture.groups.find((g) => g.id === groupId);
	if (!group) return architecture;

	const affectedComponentIds = new Set<string>();
	const affectedServiceIds = new Set<string>();
	const affectedGroupIds = new Set<string>([groupId]);

	function collectMembers(g: ProofGroup) {
		for (const cid of g.memberComponentIds) affectedComponentIds.add(cid);
		for (const sid of g.memberServiceIds) affectedServiceIds.add(sid);
		if (g.memberGroupIds) {
			for (const childGid of g.memberGroupIds) {
				if (!affectedGroupIds.has(childGid)) {
					affectedGroupIds.add(childGid);
					const child = architecture.groups.find((cand) => cand.id === childGid);
					if (child) collectMembers(child);
				}
			}
		}
	}
	collectMembers(group);

	const components = architecture.components.map((comp) => {
		if (affectedComponentIds.has(comp.id)) {
			return {
				...comp,
				position: {
					x: Math.round(comp.position.x + delta.x),
					y: Math.round(comp.position.y + delta.y),
				},
			};
		}
		return comp;
	});

	const services = architecture.services.map((svc) => {
		if (affectedServiceIds.has(svc.id)) {
			return {
				...svc,
				bounds: {
					...svc.bounds,
					x: Math.round(svc.bounds.x + delta.x),
					y: Math.round(svc.bounds.y + delta.y),
				},
				collapsedBounds: {
					...svc.collapsedBounds,
					x: Math.round(svc.collapsedBounds.x + delta.x),
					y: Math.round(svc.collapsedBounds.y + delta.y),
				},
			};
		}
		return svc;
	});

	const groups = architecture.groups.map((grp) => {
		if (affectedGroupIds.has(grp.id)) {
			return {
				...grp,
				bounds: {
					...grp.bounds,
					x: Math.round(grp.bounds.x + delta.x),
					y: Math.round(grp.bounds.y + delta.y),
				},
			};
		}
		return grp;
	});

	return { ...architecture, components, services, groups };
}

/**
 * Endpoint resolver: finds the visible anchor center and rect for a component or service.
 */
export function getEndpointAnchor(
	architecture: ProofArchitecture,
	endpointId: string,
	focusedServiceId?: string | null,
): { center: ProofPoint; rect: ProofRect; isVisible: boolean; isService: boolean } {
	const service = architecture.services.find((s) => s.id === endpointId);
	if (service) {
		const rect = service.isCollapsed ? service.collapsedBounds : service.bounds;
		return {
			center: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
			rect,
			isVisible: true,
			isService: true,
		};
	}

	const component = architecture.components.find((c) => c.id === endpointId);
	if (component) {
		const owningService = component.serviceId
			? architecture.services.find((s) => s.id === component.serviceId)
			: null;

		if (owningService && owningService.isCollapsed) {
			// Projected to collapsed service endpoint
			const rect = owningService.collapsedBounds;
			return {
				center: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
				rect,
				isVisible: true,
				isService: true,
			};
		}

		const isVisible =
			!focusedServiceId ||
			component.serviceId === focusedServiceId ||
			(!component.serviceId && focusedServiceId === null);

		const rect: ProofRect = {
			x: component.position.x,
			y: component.position.y,
			width: component.width,
			height: component.height,
		};
		return {
			center: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
			rect,
			isVisible,
			isService: false,
		};
	}

	return {
		center: { x: 0, y: 0 },
		rect: { x: 0, y: 0, width: 0, height: 0 },
		isVisible: false,
		isService: false,
	};
}

/**
 * Calculates a smooth cubic bezier route between two endpoints, with support
 * for parallel offset displacement so identical endpoints do not overlap.
 */
export function computeConnectionPath(
	sourceRect: ProofRect,
	targetRect: ProofRect,
	routeOffset: number = 0,
): { pathString: string; start: ProofPoint; end: ProofPoint; cp1: ProofPoint; cp2: ProofPoint } {
	const sourceCenter = { x: sourceRect.x + sourceRect.width / 2, y: sourceRect.y + sourceRect.height / 2 };
	const targetCenter = { x: targetRect.x + targetRect.width / 2, y: targetRect.y + targetRect.height / 2 };

	let start: ProofPoint;
	let end: ProofPoint;

	const dx = targetCenter.x - sourceCenter.x;
	const dy = targetCenter.y - sourceCenter.y;

	// Pick connection edge sides
	if (Math.abs(dx) >= Math.abs(dy)) {
		if (dx >= 0) {
			start = { x: sourceRect.x + sourceRect.width, y: sourceCenter.y };
			end = { x: targetRect.x, y: targetCenter.y };
		} else {
			start = { x: sourceRect.x, y: sourceCenter.y };
			end = { x: targetRect.x + targetRect.width, y: targetCenter.y };
		}
	} else {
		if (dy >= 0) {
			start = { x: sourceCenter.x, y: sourceRect.y + sourceRect.height };
			end = { x: targetCenter.x, y: targetRect.y };
		} else {
			start = { x: sourceCenter.x, y: sourceRect.y };
			end = { x: targetCenter.x, y: targetRect.y + targetRect.height };
		}
	}

	// Apply perpendicular displacement for parallel routes
	const distance = Math.hypot(end.x - start.x, end.y - start.y);
	const curvature = Math.max(distance * 0.35, 40);

	let cp1: ProofPoint;
	let cp2: ProofPoint;

	if (Math.abs(dx) >= Math.abs(dy)) {
		const dir = dx >= 0 ? 1 : -1;
		const offsetPx = routeOffset * 28;
		start.y += routeOffset * 10;
		end.y += routeOffset * 10;
		cp1 = { x: start.x + dir * curvature, y: start.y + offsetPx };
		cp2 = { x: end.x - dir * curvature, y: end.y + offsetPx };
	} else {
		const dir = dy >= 0 ? 1 : -1;
		const offsetPx = routeOffset * 28;
		start.x += routeOffset * 10;
		end.x += routeOffset * 10;
		cp1 = { x: start.x + offsetPx, y: start.y + dir * curvature };
		cp2 = { x: end.x + offsetPx, y: end.y - dir * curvature };
	}

	const pathString = `M ${start.x.toFixed(1)} ${start.y.toFixed(1)} C ${cp1.x.toFixed(1)} ${cp1.y.toFixed(1)}, ${cp2.x.toFixed(1)} ${cp2.y.toFixed(1)}, ${end.x.toFixed(1)} ${end.y.toFixed(1)}`;
	return { pathString, start, end, cp1, cp2 };
}

/**
 * Pure mathematical evaluation of cubic Bezier point at parameter t in [0, 1].
 */
export function sampleCubicBezier(
	p0: ProofPoint,
	p1: ProofPoint,
	p2: ProofPoint,
	p3: ProofPoint,
	t: number,
): ProofPoint {
	const clampedT = Math.max(0, Math.min(1, t));
	const u = 1 - clampedT;
	const tt = clampedT * clampedT;
	const uu = u * u;
	const uuu = uu * u;
	const ttt = tt * clampedT;

	return {
		x: uuu * p0.x + 3 * uu * clampedT * p1.x + 3 * u * tt * p2.x + ttt * p3.x,
		y: uuu * p0.y + 3 * uu * clampedT * p1.y + 3 * u * tt * p2.y + ttt * p3.y,
	};
}

export type PlaybackParticle = {
	connectionId: string;
	progress: number;
	point: ProofPoint;
};

export type ComponentReactionState = {
	action: ComponentAction;
	message: string;
	intensity: number;
	isError?: boolean;
};

export type PlaybackFrame = {
	currentTimeMs: number;
	totalDurationMs: number;
	activeStepIndex: number;
	activeStep: ProofWalkthroughStep | null;
	stepProgress: number;
	isComplete: boolean;
	activeParticles: PlaybackParticle[];
	reactions: Record<string, ComponentReactionState>;
	highlightedConnectionIds: string[];
};

/**
 * Compiles walkthrough steps into a coordinated timeline schedule.
 * Parallel steps share the same start time and finish when all complete.
 */
export type ScheduledStep = {
	step: ProofWalkthroughStep;
	startTimeMs: number;
	endTimeMs: number;
	durationMs: number;
};

export function scheduleWalkthrough(walkthrough: ProofWalkthrough): {
	scheduledSteps: ScheduledStep[];
	totalDurationMs: number;
} {
	const scheduledSteps: ScheduledStep[] = [];
	let cursorMs = 0;
	let i = 0;

	while (i < walkthrough.steps.length) {
		const step = walkthrough.steps[i];
		if (step.parallelGroupId) {
			const parallelGroup = [step];
			let j = i + 1;
			while (j < walkthrough.steps.length && walkthrough.steps[j].parallelGroupId === step.parallelGroupId) {
				parallelGroup.push(walkthrough.steps[j]);
				j++;
			}
			const groupMaxDuration = Math.max(...parallelGroup.map((s) => s.durationMs));
			for (const pStep of parallelGroup) {
				scheduledSteps.push({
					step: pStep,
					startTimeMs: cursorMs,
					endTimeMs: cursorMs + pStep.durationMs,
					durationMs: pStep.durationMs,
				});
			}
			cursorMs += groupMaxDuration;
			i = j;
		} else {
			const duration = step.durationMs;
			scheduledSteps.push({
				step,
				startTimeMs: cursorMs,
				endTimeMs: cursorMs + duration,
				durationMs: duration,
			});
			cursorMs += duration;
			i++;
		}
	}

	return { scheduledSteps, totalDurationMs: cursorMs };
}

/**
 * Evaluates the timeline at an exact timestamp T.
 * Pure and deterministic: seeking backwards, forwards, or repeating produces identical state.
 */
export function getPlaybackFrame(
	architecture: ProofArchitecture,
	currentTimeMs: number,
	options: { reducedMotion?: boolean; focusedServiceId?: string | null } = {},
): PlaybackFrame {
	const { scheduledSteps, totalDurationMs } = scheduleWalkthrough(architecture.walkthrough);
	const clampedTime = Math.max(0, Math.min(totalDurationMs, currentTimeMs));
	const isComplete = totalDurationMs > 0 && clampedTime >= totalDurationMs;

	const activeSteps = scheduledSteps.filter(
		(s) => clampedTime >= s.startTimeMs && clampedTime <= s.endTimeMs,
	);
	const primaryStep = activeSteps[0] ?? scheduledSteps[scheduledSteps.length - 1] ?? null;
	const activeStepIndex = primaryStep ? scheduledSteps.indexOf(primaryStep) : 0;

	const activeParticles: PlaybackParticle[] = [];
	const reactions: Record<string, ComponentReactionState> = {};
	const highlightedConnectionIds: string[] = [];

	for (const scheduled of activeSteps) {
		const step = scheduled.step;
		highlightedConnectionIds.push(step.connectionId);
		const conn = architecture.connections.find((c) => c.id === step.connectionId);
		if (!conn) continue;

		const elapsedInStep = clampedTime - scheduled.startTimeMs;
		const stepProgress = Math.max(0, Math.min(1, elapsedInStep / scheduled.durationMs));

		const sourceAnchor = getEndpointAnchor(architecture, conn.sourceId, options.focusedServiceId);
		const targetAnchor = getEndpointAnchor(architecture, conn.targetId, options.focusedServiceId);
		const route = computeConnectionPath(sourceAnchor.rect, targetAnchor.rect, conn.routeOffset);

		// Finite retry logic: if repeatCount > 1, first half fails, second half succeeds
		const isRepeating = (step.repeatCount ?? 1) > 1;
		const cycleProgress = isRepeating ? (stepProgress * (step.repeatCount ?? 1)) % 1 : stepProgress;
		const currentCycle = isRepeating ? Math.floor(stepProgress * (step.repeatCount ?? 1)) : 0;

		// Calculate particle position along path
		if (!options.reducedMotion) {
			const point = sampleCubicBezier(route.start, route.cp1, route.cp2, route.end, cycleProgress);
			activeParticles.push({
				connectionId: conn.id,
				progress: cycleProgress,
				point,
			});
		}

		// Arrival reactions trigger when progress reaches target
		if (cycleProgress >= 0.75) {
			const isFirstCycleOfRetry = isRepeating && currentCycle === 0;
			const reactionAction = isFirstCycleOfRetry ? "fail" : step.targetReaction;
			const reactionMsg = isFirstCycleOfRetry
				? "Transient Timeout — retrying..."
				: (step.reactionMessage ?? "Processed");

			reactions[conn.targetId] = {
				action: reactionAction,
				message: reactionMsg,
				intensity: Math.min(1, (cycleProgress - 0.75) / 0.25),
				isError: isFirstCycleOfRetry,
			};
		}

		// Sender activation reaction at step start
		if (cycleProgress < 0.4) {
			reactions[conn.sourceId] = {
				action: step.action,
				message: `${step.action.toUpperCase()} ${conn.label}`,
				intensity: 1 - cycleProgress / 0.4,
			};
		}
	}

	const stepProgress = primaryStep
		? Math.max(0, Math.min(1, (clampedTime - primaryStep.startTimeMs) / primaryStep.durationMs))
		: 1;

	return {
		currentTimeMs: clampedTime,
		totalDurationMs,
		activeStepIndex,
		activeStep: primaryStep ? primaryStep.step : null,
		stepProgress,
		isComplete,
		activeParticles,
		reactions,
		highlightedConnectionIds,
	};
}
