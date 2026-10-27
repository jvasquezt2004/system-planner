import { reactionLabel } from "../shared/component-reactions";
import type { PlaybackMessage, PlaybackReaction } from "../shared/walkthrough-playback";

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
			{reactionLabel(kind, reaction.action).toUpperCase()}
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
