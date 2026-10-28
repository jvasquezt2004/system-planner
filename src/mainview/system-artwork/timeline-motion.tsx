import { interpolate, easeIn, easeOut, easeInOut } from "framer-motion";
import { createContext, createElement, useContext, type SVGProps } from "react";

/** No local clock: pause, seek, speed and repetitions all come from the Walkthrough. */
export const ArtworkTime = createContext<number | null>(null);
/** Used to validate the completion budget against the actual rendered artwork. */
export const ArtworkDurationReporter = createContext<((seconds: number) => void) | null>(null);
type Tween = {
	duration?: number;
	delay?: number;
	repeat?: number;
	repeatDelay?: number;
	repeatType?: "loop" | "mirror";
	times?: number[];
	ease?: "linear" | "easeIn" | "easeOut" | "easeInOut";
};
type Transition = Tween & { [property: string]: Tween | number | string | number[] | undefined };
const easings = { linear: (v: number) => v, easeIn, easeOut, easeInOut };

/** Play one pass, or one out-and-back pass for a mirrored animation, then hold. */
export function finiteTween(tween: Tween): Tween {
	return { ...tween, repeat: tween.repeatType === "mirror" ? 1 : 0, repeatDelay: 0 };
}

/** Sample the imported Motion keyframes at an authored time, including delay and holds. */
export function sampleKeyframes(values: number[], tween: Tween, seconds: number): number {
	if (values.length === 1) return values[0]!;
	const duration = tween.duration ?? 0.3;
	const elapsed = Math.max(0, seconds - (tween.delay ?? 0));
	const cycle = duration + (tween.repeatDelay ?? 0);
	const repeats = tween.repeat ?? 0;
	const iteration = cycle > 0 ? Math.min(Math.floor(elapsed / cycle), repeats) : 0;
	let progress = duration > 0 ? Math.min(1, (elapsed - iteration * cycle) / duration) : 1;
	if (progress > 1 - 1e-9) progress = 1;
	if (tween.repeatType === "mirror" && iteration % 2 === 1) progress = 1 - progress;
	const times = tween.times ?? values.map((_, i) => i / (values.length - 1));
	return interpolate(times, values, { ease: easings[tween.ease ?? "easeInOut"] })(progress);
}

type Props = Omit<SVGProps<SVGElement>, "ref"> & {
	initial?: false;
	animate?: Record<string, number | number[]>;
	transition?: Transition;
};

/** Small SVG adapter for the library's numeric Motion vocabulary. Renders static SVG attributes. */
function timelineElement(tag: "g" | "rect" | "circle" | "path" | "line") {
	return function TimelineElement({ animate = {}, transition = {}, initial: _initial, ...props }: Props) {
		const seconds = useContext(ArtworkTime) ?? 0;
		const report = useContext(ArtworkDurationReporter);
		const attributes: Record<string, number | string> = {};
		const transforms: string[] = [];
		for (const [property, target] of Object.entries(animate)) {
			const local = transition[property];
			const tween = finiteTween(typeof local === "object" && !Array.isArray(local) ? local : transition);
			if (Array.isArray(target)) report?.((tween.delay ?? 0) + (tween.duration ?? 0.3) * (tween.repeatType === "mirror" ? 2 : 1));
			const value = Array.isArray(target) ? sampleKeyframes(target, tween, seconds) : target;
			if (property === "x") transforms.push(`translate(${value} 0)`);
			else if (property === "y") transforms.push(`translate(0 ${value})`);
			else if (property === "scale") transforms.push(`scale(${value})`);
			else if (property === "pathLength") {
				attributes.pathLength = 1;
				attributes.strokeDasharray = "1 1";
				attributes.strokeDashoffset = 1 - value;
			} else attributes[property] = value;
		}
		return createElement(tag, {
			...props, ...attributes,
			...(animate.scale !== undefined ? { style: { ...props.style, transformBox: "fill-box", transformOrigin: "center" } } : {}),
			...(transforms.length ? { transform: [props.transform, ...transforms].filter(Boolean).join(" ") } : {}),
		});
	};
}

export const motion = {
	g: timelineElement("g"), rect: timelineElement("rect"), circle: timelineElement("circle"),
	path: timelineElement("path"), line: timelineElement("line"),
};
