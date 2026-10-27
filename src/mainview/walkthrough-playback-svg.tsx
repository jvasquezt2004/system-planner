import { reactionText } from "../shared/component-reactions";
import type { PlaybackMessage, PlaybackReaction } from "../shared/walkthrough-playback";

/** Kinds that take one transient item in when they receive and send it out when they release. */
const RECEPTION_KINDS: ReadonlySet<string> = new Set(["object_storage_bucket", "queue"]);
/** How far, in pixels, the item sits beyond its resting place while its reaction is below full intensity. */
const RECEPTION_TRAVEL = 26;

/**
 * SVG pieces of Walkthrough playback. Each one is a pure function of the frame
 * it is given: the message sits on the drawn route at its current progress, and
 * reactions are rings and labels whose strength is the frame's intensity. Nothing
 * here runs its own animation loop.
 */

/** The travelling message, placed on the Connection's actual curve. */
export function WalkthroughMessageDot({ message }: { message: PlaybackMessage }) {
	return (
		<circle
			data-testid="walkthrough-message"
			data-connection-id={message.connectionId}
			cx={message.point.x}
			cy={message.point.y}
			r={6}
			pointerEvents="none"
			strokeWidth={2}
			style={{ fill: "var(--color-pencil)", stroke: "var(--color-paper-raised)" }}
		/>
	);
}

/** Labels what a Component or Service is doing during playback, above its boundary. */
export function ReactionTag({ reaction, kind, x, y }: { reaction: PlaybackReaction; kind: string; x: number; y: number }) {
	return (
		<text
			data-reaction={reaction.phase}
			data-action={reaction.action}
			x={x}
			y={y}
			fontSize={10.5}
			fontWeight={600}
			letterSpacing={1.1}
			pointerEvents="none"
			style={{ fill: "var(--color-pencil)" }}
		>
			{reactionText(kind, reaction.action, reaction.operation, reaction.role).toUpperCase()}
		</text>
	);
}

/** A ring around the node whose strength follows the reaction's intensity; reduced motion holds it at full strength. */
export function ReactionRing({ reaction, width, height, radius }: { reaction: PlaybackReaction; width: number; height: number; radius: number }) {
	return (
		<rect
			x={-6}
			y={-6}
			width={width + 12}
			height={height + 12}
			rx={radius}
			fill="none"
			pointerEvents="none"
			strokeWidth={2}
			strokeOpacity={reaction.intensity}
			style={{ stroke: "var(--color-pencil)" }}
		/>
	);
}

/**
 * One transient item that a bucket or queue takes in as it receives a message
 * (arrival) and sends out as it releases one (departure). It follows the
 * reaction's intensity on the shared clock, so it is never a count: it exists
 * only while an arrival or departure reaction shows, and the outcome holds none.
 * Reduced motion keeps the same reaction at full intensity, so the item rests in place.
 */
export function ReceptionItem({ reaction, kind, width, height }: { reaction: PlaybackReaction; kind: string; width: number; height: number }) {
	if (!RECEPTION_KINDS.has(kind) || reaction.phase === "outcome") return null;
	const offset = (1 - reaction.intensity) * RECEPTION_TRAVEL;
	return (
		<rect
			data-testid="reception-item"
			data-kind={kind}
			data-phase={reaction.phase}
			x={width - 12 + offset}
			y={height / 2 - 5}
			width={16}
			height={10}
			rx={2}
			opacity={reaction.intensity}
			pointerEvents="none"
			strokeWidth={1.5}
			style={{ fill: "var(--color-paper-raised)", stroke: "var(--color-pencil)" }}
		/>
	);
}
