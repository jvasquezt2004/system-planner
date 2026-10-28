import type { ComponentType } from "react";
import type { SystemComponentKind } from "../shared/system-design";
import type { CustomIcon } from "../shared/component-catalog";
import { PLAYBACK_ARRIVAL_HOLD_FRACTION, type PlaybackFrame, type PlaybackTimeline } from "../shared/walkthrough-playback";
import * as Nodes from "./system-artwork/index";
import { ArtworkTime } from "./system-artwork/timeline-motion";
import { CUSTOM_ICON_ARTWORK } from "./component-artwork";

const ARTWORK: Record<SystemComponentKind, ComponentType<Nodes.NodeProps>> = {
	person: Nodes.Person,
	browser: Nodes.Browser,
	mobile_app: Nodes.MobileApp,
	external_system: Nodes.ExternalSystem,
	dns: Nodes.Dns,
	cdn: Nodes.Cdn,
	load_balancer: Nodes.LoadBalancer,
	api_gateway: Nodes.ApiGateway,
	proxy: Nodes.Proxy,
	application: Nodes.Application,
	api: Nodes.Api,
	worker: Nodes.Worker,
	scheduled_job: Nodes.ScheduledJob,
	serverless_handler: Nodes.ServerlessHandler,
	database: Nodes.Database,
	cache: Nodes.Cache,
	object_storage_bucket: Nodes.ObjectStorageBucket,
	file_storage: Nodes.FileStorage,
	search_index: Nodes.SearchIndex,
	queue: Nodes.Queue,
	topic: Nodes.Topic,
	event_bus: Nodes.EventBus,
	event_stream: Nodes.EventStream,
	identity_provider: Nodes.IdentityProvider,
	secrets_store: Nodes.SecretsStore,
	configuration: Nodes.Configuration,
	observability: Nodes.Observability,
	generic: Nodes.GenericComponent,
	custom: Nodes.CustomNode,
};

/** Match the endpoint's winning reaction, including simultaneous steps and repeated occurrences. */
export function componentArtworkTime(id: string, frame: PlaybackFrame | null, timeline: PlaybackTimeline | null, reducedMotion: boolean): number | null {
	if (!frame || !timeline || reducedMotion || frame.complete || !frame.reactions[id]) return null;
	const reaction = frame.reactions[id]!;
	const candidates = timeline.steps.filter((candidate) => frame.activeStepIndexes.includes(candidate.index)
		&& (reaction.role === "sender" ? candidate.sourceId === id : candidate.targetId === id)
		&& reaction.phase === (frame.timeMs < candidate.arrivalMs ? "depart"
			: frame.timeMs < candidate.arrivalMs + Math.round((candidate.endMs - candidate.arrivalMs) * PLAYBACK_ARRIVAL_HOLD_FRACTION) ? "arrive" : "outcome"));
	const step = candidates[candidates.length - 1];
	if (reaction.role === "sender" && step?.sourceAnimationMs === 0) return null;
	return step ? (frame.timeMs - (reaction.role === "sender" ? step.startMs : step.arrivalMs)) / 1000 : null;
}

/** Imported artwork sampled only from the authored Walkthrough clock. */
export function ComponentArtwork({ artwork, x = 10, y = 0, icon, time = null }: {
	artwork: SystemComponentKind; x?: number; y?: number; icon?: CustomIcon; time?: number | null;
}) {
	const Glyph = ARTWORK[artwork];
	return (
		<g data-testid="component-artwork" data-artwork={artwork}
			data-icon={artwork === "custom" ? (icon ?? "rectangle") : undefined}
			transform={`translate(${x} ${y})`} pointerEvents="none">
			<ArtworkTime.Provider value={time}>
				{artwork === "custom" && icon
					? <Nodes.CustomNode isAnimating={time !== null} icon={<g transform="translate(32 12) scale(4)" fill="none" stroke="var(--color-ink)" strokeWidth={0.5} strokeLinecap="round" strokeLinejoin="round">{CUSTOM_ICON_ARTWORK[icon]()}</g>} />
					: <Glyph isAnimating={time !== null} />}
			</ArtworkTime.Provider>
		</g>
	);
}

