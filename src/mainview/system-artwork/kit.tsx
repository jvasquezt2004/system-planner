import { motion, ArtworkTime, ArtworkDurationReporter } from "./timeline-motion";
import { useContext, useId, type ReactNode } from "react";

/** Category hue from the imported component library. */
export type Tone =
  | "actors"
  | "edge"
  | "compute"
  | "data"
  | "messaging"
  | "platform"
  | "generic";

export interface NodeProps {
  /** `false` = idle (static). `true` = sample the active Walkthrough reaction. */
  isAnimating?: boolean;
  /** Optional caption drawn inside the node, under the glyph. */
  label?: string;
  /** Optional CSS color that overrides the category accent. */
  accent?: string;
  /** Rendered width in px. Height follows the fixed 4:3 box. Default 160. */
  size?: number;
  className?: string;
}

export type Pt = readonly [number, number];

/** Shared outline style for every glyph. */
export const S = {
  stroke: "var(--color-ink)",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

type Ease = "linear" | "easeIn" | "easeOut" | "easeInOut";

/** Infinite-loop transition. `cycle` > `dur` holds the end state between iterations. */
export function loop(
  dur: number,
  o: { delay?: number; ease?: Ease; cycle?: number; mirror?: boolean } = {},
) {
  return {
    duration: dur,
    delay: o.delay ?? 0,
    ease: o.ease ?? "easeInOut",
    repeat: Infinity,
    repeatType: o.mirror ? ("mirror" as const) : ("loop" as const),
    repeatDelay: Math.max(0, (o.cycle ?? dur) - dur),
  };
}

/** Imported idle transition descriptor; scalar idle values render immediately. */
export const rest = { duration: 0.25 };

/** True only when the node should move: requested and the user allows motion. */
export function useAnimating(isAnimating?: boolean) {
  const time = useContext(ArtworkTime);
  return !!isAnimating && time !== null;
}

/** SVG-safe unique id (React ids contain colons). */
export function useUid(prefix: string) {
  return `${prefix}${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
}

/** Fixed 160×120 illustration; the app card owns its frame and caption. */
export function NodeFrame({
  tone,
  code,
  title,
  animating,
  label,
  accent,
  size = 160,
  className,
  children,
}: NodeProps & {
  tone: Tone;
  code: string;
  title: string;
  animating: boolean;
  children: ReactNode;
}) {
  return (
    <svg viewBox="0 0 160 120" width={size} height={(size * 3) / 4}
      role="img" aria-label={label ?? title} data-tone={tone}
      data-state={animating ? "animated" : "idle"} data-code={code}
      className={className} style={{ color: accent ?? ({ actors: "#6d3fe0", edge: "#0a86a3", compute: "#d4730a", data: "#2b63e0", messaging: "#d6204f", platform: "#1a9a4a", generic: "#5b6577" })[tone] }}>
      {children}
    </svg>
  );
}

/**
 * A dot (or square) that travels along a polyline, then fades out.
 * Idle: hidden. `cycle` is the full loop length (>= dur).
 */
export function Packet({
  on,
  path,
  dur = 1,
  delay = 0,
  cycle,
  r = 3,
  fill = "currentColor",
  square,
}: {
  on: boolean;
  path: readonly Pt[];
  dur?: number;
  delay?: number;
  cycle?: number;
  r?: number;
  fill?: string;
  square?: boolean;
}) {
  const xs = path.map((p) => p[0]);
  const ys = path.map((p) => p[1]);
  const lens = path
    .slice(1)
    .map((p, i) => Math.hypot(p[0] - path[i][0], p[1] - path[i][1]));
  const total = lens.reduce((s, l) => s + l, 0) || 1;
  let acc = 0;
  const times = [0, ...lens.map((l) => (acc += l) / total)];
  times[times.length - 1] = 1;
  const base = {
    duration: dur,
    delay,
    repeat: Infinity,
    repeatDelay: Math.max(0, (cycle ?? dur) - dur),
    ease: "linear" as const,
  };
  return (
    <motion.g
      initial={false}
      animate={
        on
          ? { x: xs, y: ys, opacity: [0, 1, 1, 0] }
          : { x: xs[0], y: ys[0], opacity: 0 }
      }
      transition={
        on
          ? {
              x: { ...base, times },
              y: { ...base, times },
              opacity: { ...base, times: [0, 0.12, 0.88, 1] },
            }
          : { duration: 0 }
      }
    >
      {square ? (
        <rect
          x={-r}
          y={-r}
          width={r * 2}
          height={r * 2}
          rx={1.5}
          fill={fill}
          stroke="var(--color-paper-raised)"
          strokeWidth={1}
        />
      ) : (
        <circle r={r} fill={fill} stroke="var(--color-paper-raised)" strokeWidth={1} />
      )}
    </motion.g>
  );
}

/** Rotates children about (cx, cy) at the authored time. Idle: renders them untouched. */
export function Spin({
  on,
  cx,
  cy,
  dur,
  dir = 1,
  turns = 1,
  children,
}: {
  on: boolean;
  cx: number;
  cy: number;
  dur: number;
  dir?: 1 | -1;
  turns?: number;
  children: ReactNode;
}) {
  const seconds = useContext(ArtworkTime) ?? 0;
  const report = useContext(ArtworkDurationReporter);
  if (on) report?.(dur);
  return <g transform={on ? `rotate(${Math.min(1, seconds / dur) * 360 * dir * turns} ${cx} ${cy})` : undefined}>{children}</g>;
}

/** Closed gear outline centred on (cx, cy). */
export function gearPath(
  cx: number,
  cy: number,
  teeth: number,
  ro: number,
  ri: number,
) {
  const step = (Math.PI * 2) / teeth;
  const pt = (a: number, r: number) =>
    `${(cx + Math.cos(a) * r).toFixed(2)} ${(cy + Math.sin(a) * r).toFixed(2)}`;
  let d = "";
  for (let i = 0; i < teeth; i++) {
    const a = i * step;
    d += `${i === 0 ? "M" : "L"}${pt(a - 0.34 * step, ri)} `;
    d += `L${pt(a - 0.2 * step, ro)} L${pt(a + 0.2 * step, ro)} L${pt(a + 0.34 * step, ri)} `;
    d += `A ${ri} ${ri} 0 0 1 ${pt(a + step - 0.34 * step, ri)} `;
  }
  return `${d}Z`;
}

