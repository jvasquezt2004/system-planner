import { Pause, Play, RotateCcw, SkipBack, SkipForward, Camera } from "lucide-react";
import { PLAYBACK_SPEEDS, type PlaybackSpeed } from "../shared/walkthrough-playback";
import type { WalkthroughPlaybackControls } from "./use-walkthrough-playback";
import { Button } from "@/components/ui/button";

/**
 * Play/Pause, step, restart, time scrubbing, step selection, speed, and optional
 * camera following for one Walkthrough. Playback is unavailable while a step
 * needs repair; the reasons are listed.
 */
export function WalkthroughTransport({
	controls,
	follow,
}: {
	controls: WalkthroughPlaybackControls;
	/** Whether the overview camera centers each step as it starts. Manual pan or zoom turns it off. */
	follow?: { enabled: boolean; onChange: (enabled: boolean) => void };
}) {
	const { problems, timeline, active } = controls;
	const canPlay = problems.length === 0 && timeline !== null;
	const playing = active?.playing ?? false;
	const stepIndex = active?.frame.stepIndex ?? 0;
	const finished = active?.frame.complete ?? false;
	const totalMs = timeline?.totalMs ?? 0;
	const timeMs = active?.frame.timeMs ?? 0;
	const running = active?.frame.activeStepIndexes.length ?? 0;
	const repetition = active?.frame.step.repetition;

	return (
		<section aria-label="Playback" className="flex flex-col gap-2 rounded-md border border-rule-soft p-3">
			{problems.length > 0 && (
				<ul role="alert" className="flex flex-col gap-1 rounded-sm bg-proof-red-wash px-2.5 py-2 text-[12.5px] text-proof-red">
					{problems.map((problem) => (
						<li key={problem}>{problem}</li>
					))}
				</ul>
			)}

			<div className="flex flex-wrap items-center gap-1.5">
				<Button
					type="button"
					size="icon-xs"
					variant="ghost"
					aria-label="Previous step"
					disabled={!canPlay}
					onClick={controls.previous}
				>
					<SkipBack />
				</Button>
				<Button
					type="button"
					size="sm"
					variant="outline"
					aria-label={playing ? "Pause walkthrough" : "Play walkthrough"}
					disabled={!canPlay}
					onClick={playing ? controls.pause : controls.play}
				>
					{playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
					{playing ? "Pause" : "Play"}
				</Button>
				<Button
					type="button"
					size="icon-xs"
					variant="ghost"
					aria-label="Next step"
					disabled={!canPlay}
					onClick={controls.next}
				>
					<SkipForward />
				</Button>
				<Button
					type="button"
					size="icon-xs"
					variant="ghost"
					aria-label="Restart walkthrough"
					disabled={!canPlay || active === null}
					onClick={controls.restart}
				>
					<RotateCcw />
				</Button>
			</div>

			<label className="flex flex-col gap-1">
				<span className="text-ink-3">Time</span>
				<input
					type="range"
					aria-label="Playback time"
					min={0}
					max={totalMs}
					step={10}
					value={timeMs}
					disabled={!canPlay}
					onChange={(event) => controls.seekTime(Number(event.target.value))}
					className="w-full accent-pencil disabled:opacity-50"
				/>
			</label>

			<div className="grid grid-cols-[1fr_auto] gap-2">
				<label className="flex min-w-0 flex-col gap-1">
					<span className="text-ink-3">Playback step</span>
					<select
						aria-label="Playback step"
						value={stepIndex}
						disabled={!canPlay}
						onChange={(event) => controls.seekStep(Number(event.target.value))}
						className="h-8 min-w-0 rounded-md border border-input bg-paper-raised px-2 text-[12.5px] disabled:opacity-50"
					>
						{(timeline?.steps ?? []).map((step) => (
							<option key={step.stepId} value={step.index}>
								{step.index + 1}. {step.title || "Untitled step"}
							</option>
						))}
					</select>
				</label>
				<label className="flex flex-col gap-1">
					<span className="text-ink-3">Speed</span>
					<select
						aria-label="Playback speed"
						value={active?.speed ?? 1}
						disabled={!canPlay}
						onChange={(event) => controls.setSpeed(Number(event.target.value) as PlaybackSpeed)}
						className="h-8 rounded-md border border-input bg-paper-raised px-2 text-[12.5px] disabled:opacity-50"
					>
						{PLAYBACK_SPEEDS.map((speed) => (
							<option key={speed} value={speed}>{speed}×</option>
						))}
					</select>
				</label>
			</div>

			{follow && (
				<Button
					type="button"
					size="sm"
					variant={follow.enabled ? "pencil" : "outline"}
					aria-pressed={follow.enabled}
					disabled={!canPlay}
					onClick={() => follow.onChange(!follow.enabled)}
					className="self-start"
				>
					<Camera className="size-3.5" />
					Follow camera
				</Button>
			)}

			<p className="text-[11.5px] text-ink-3" aria-live="polite">
				{active
					? [
						`Step ${stepIndex + 1} of ${timeline?.steps.length ?? 0}`,
						repetition ? `Pass ${repetition.iteration} of ${repetition.count}` : null,
						running > 1 ? `${running} steps running together` : null,
						finished ? "Finished" : null,
					].filter(Boolean).join(" · ")
					: "Not started"}
				{" · Illustrative timing; no infrastructure runs"}
			</p>
		</section>
	);
}
