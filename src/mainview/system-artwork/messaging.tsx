import { motion } from "./timeline-motion";
import { NodeFrame, Packet, S, loop, rest, useAnimating, useUid, type NodeProps } from "./kit";

export function Queue(p: NodeProps) {
  const a = useAnimating(p.isAnimating);
  const cid = useUid("q");
  return (
    <NodeFrame tone="messaging" code="Q" title="Queue" animating={a} {...p}>
      <defs>
        <clipPath id={cid}>
          <rect x={26} y={46} width={108} height={28} rx={14} />
        </clipPath>
      </defs>
      <rect x={22} y={42} width={116} height={36} rx={18} fill="var(--color-paper-raised)" />
      <g clipPath={`url(#${cid})`}>
        {[-1, 0, 1, 2, 3, 4].map((i) => {
          const edge = i === -1 || i === 4;
          return (
            <motion.g
              key={i}
              initial={false}
              animate={
                a
                  ? { x: [0, 24], opacity: i === -1 ? [0, 1] : i === 4 ? [1, 0] : 1 }
                  : { x: 0, opacity: edge ? 0 : 1 }
              }
              transition={a ? loop(1.2, { ease: "linear" }) : rest}
            >
              <rect x={34 + i * 24} y={52} width={18} height={16} rx={4} fill="#d6204f" />
            </motion.g>
          );
        })}
      </g>
      <rect x={22} y={42} width={116} height={36} rx={18} fill="none" {...S} />
      <path d="M8 54 L14 60 L8 66" fill="none" stroke="#d6204f" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M146 54 L152 60 L146 66" fill="none" stroke="#a3123a" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </NodeFrame>
  );
}

export function Topic(p: NodeProps) {
  const a = useAnimating(p.isAnimating);
  const subs = [30, 60, 90];
  return (
    <NodeFrame tone="messaging" code="PUB/SUB" title="Topic" animating={a} {...p}>
      <line x1={30} y1={60} x2={56} y2={60} {...S} strokeOpacity={0.4} />
      {subs.map((y) => (
        <path key={y} d={`M104 60 C118 60 120 ${y} 128 ${y}`} fill="none" {...S} strokeOpacity={0.4} />
      ))}
      <rect x={14} y={52} width={16} height={16} rx={4} fill="var(--color-paper-raised)" {...S} />
      <rect x={18} y={58} width={8} height={3} rx={1.5} fill="var(--color-ink)" fillOpacity={0.35} />
      {subs.map((y) => (
        <g key={y}>
          <motion.circle
            cx={136}
            cy={y}
            fill="none"
            stroke="#d6204f"
            strokeWidth={1.5}
            animate={a ? { r: [8, 16], opacity: [0.7, 0] } : { r: 8, opacity: 0 }}
            transition={a ? loop(0.8, { ease: "easeOut", delay: 1.3, cycle: 2.4 }) : rest}
          />
          <circle cx={136} cy={y} r={8} fill="var(--color-paper-raised)" {...S} />
          <circle cx={136} cy={y} r={3} fill="#d6204f" />
        </g>
      ))}
      <Packet on={a} path={[[30, 60], [56, 60]]} dur={0.5} cycle={2.4} fill="var(--color-ink)" />
      {subs.map((y) => (
        <Packet key={y} on={a} path={[[104, 60], [116, y], [128, y]]} dur={0.8} delay={0.5} cycle={2.4} />
      ))}
      <rect x={56} y={46} width={48} height={28} rx={14} fill="#f4dfe2" {...S} />
      <text
        x={80}
        y={60.5}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={10}
        fontWeight={600}
        fill="#a3123a"
        style={{ fontFamily: "IBM Plex Mono, monospace" }}
      >
        topic
      </text>
    </NodeFrame>
  );
}

export function EventBus(p: NodeProps) {
  const a = useAnimating(p.isAnimating);
  const xs = [44, 80, 116];
  return (
    <NodeFrame tone="messaging" code="BUS" title="Event bus" animating={a} {...p}>
      {xs.map((x) => (
        <g key={x}>
          <line x1={x} y1={28} x2={x} y2={52} {...S} strokeOpacity={0.4} />
          <line x1={x} y1={66} x2={x} y2={92} {...S} strokeOpacity={0.4} />
          <circle cx={x} cy={24} r={6} fill="var(--color-paper-raised)" {...S} />
          <rect x={x - 6} y={92} width={12} height={12} rx={3} fill="var(--color-paper-raised)" {...S} />
        </g>
      ))}
      <rect x={14} y={52} width={132} height={14} rx={7} fill="#f4dfe2" {...S} />
      <line x1={24} y1={59} x2={136} y2={59} stroke="#d6204f" strokeWidth={1.5} strokeDasharray="2 5" strokeLinecap="round" />
      <Packet on={a} path={[[44, 24], [44, 59], [116, 59], [116, 98]]} dur={1.5} cycle={2.7} />
      <Packet on={a} path={[[80, 24], [80, 59], [44, 59], [44, 98]]} dur={1.5} delay={0.9} cycle={2.7} fill="var(--color-ink)" />
      <Packet on={a} path={[[116, 24], [116, 59], [80, 59], [80, 98]]} dur={1.5} delay={1.8} cycle={2.7} fill="#a3123a" />
    </NodeFrame>
  );
}

export function EventStream(p: NodeProps) {
  const a = useAnimating(p.isAnimating);
  const cid = useUid("s");
  const lanes = [
    { y: 36, dur: 1.6 },
    { y: 58, dur: 2 },
    { y: 80, dur: 1.3 },
  ];
  return (
    <NodeFrame tone="messaging" code="LOG" title="Event stream" animating={a} {...p}>
      <defs>
        <clipPath id={cid}>
          <rect x={16} y={20} width={128} height={78} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${cid})`}>
        {lanes.map((l) =>
          [-1, 0, 1, 2, 3, 4, 5, 6, 7].map((k) => {
            const edge = k === -1 || k === 7;
            return (
              <motion.g
                key={`${l.y}-${k}`}
                initial={false}
                animate={
                  a
                    ? { x: [0, 18], opacity: k === -1 ? [0, 1] : k === 7 ? [1, 0] : 1 }
                    : { x: 0, opacity: edge ? 0 : 1 }
                }
                transition={a ? loop(l.dur, { ease: "linear" }) : rest}
              >
                <rect x={20 + k * 18} y={l.y - 6} width={14} height={12} rx={3} fill="#f4dfe2" stroke="#d6204f" strokeWidth={1.2} />
              </motion.g>
            );
          }),
        )}
      </g>
      <line x1={70} y1={26} x2={70} y2={94} stroke="var(--color-ink)" strokeWidth={1.5} strokeDasharray="3 3" strokeLinecap="round" />
      <path d="M63 18 H77 L70 27 Z" fill="#d6204f" />
      {lanes.map((l, i) => (
        <motion.circle
          key={l.y}
          cx={150}
          cy={l.y}
          r={3}
          fill="#d6204f"
          animate={a ? { opacity: [1, 0.2, 1] } : { opacity: 1 }}
          transition={a ? loop(0.9, { delay: i * 0.3 }) : rest}
        />
      ))}
    </NodeFrame>
  );
}

