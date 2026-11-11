import { motion } from "./timeline-motion";
import { NodeFrame, S, loop, rest, useAnimating, type NodeProps } from "./kit";

export function IdentityProvider(p: NodeProps) {
  const a = useAnimating(p.isAnimating);
  return (
    <NodeFrame tone="platform" code="IDP" title="Identity provider" animating={a} {...p}>
      <rect x={30} y={28} width={86} height={58} rx={8} fill="var(--color-paper-raised)" {...S} />
      <circle cx={52} cy={50} r={9} fill="#dcebdd" {...S} />
      <circle cx={52} cy={48} r={3.2} fill="#1a9a4a" />
      <path d="M45 56 C46 52 49 51 52 51 C55 51 58 52 59 56" fill="none" stroke="#1a9a4a" strokeWidth={2} strokeLinecap="round" />
      <rect x={68} y={42} width={36} height={5} rx={2.5} fill="var(--color-ink)" fillOpacity={0.28} />
      <rect x={68} y={53} width={26} height={4} rx={2} fill="var(--color-ink)" fillOpacity={0.16} />
      <rect x={40} y={70} width={44} height={4} rx={2} fill="var(--color-ink)" fillOpacity={0.16} />
      <motion.circle
        cx={112}
        cy={82}
        fill="none"
        stroke="#1a9a4a"
        strokeWidth={1.5}
        animate={a ? { r: [16, 28], opacity: [0.7, 0] } : { r: 16, opacity: 0 }}
        transition={a ? loop(1.2, { ease: "easeOut", delay: 0.5, cycle: 2.4 }) : rest}
      />
      <path d="M112 66 L126 71 V82 C126 91 120 97 112 100 C104 97 98 91 98 82 V71 Z" fill="#1a9a4a" stroke="var(--color-paper-raised)" strokeWidth={2} strokeLinejoin="round" />
      <motion.path
        d="M105 82 L110 87 L119 76"
        fill="none"
        stroke="var(--color-paper-raised)"
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        animate={a ? { pathLength: [0, 1, 1, 0] } : { pathLength: 1 }}
        transition={a ? { ...loop(2.4, { ease: "easeOut" }), times: [0, 0.25, 0.85, 1] } : rest}
      />
    </NodeFrame>
  );
}

export function SecretsStore(p: NodeProps) {
  const a = useAnimating(p.isAnimating);
  const dots = (x: number, y: number, delay: number) => (
    <g>
      <rect x={x} y={y} width={30} height={12} rx={6} fill="var(--color-paper-raised)" stroke="#1a9a4a" strokeWidth={1.2} />
      {[0, 1, 2].map((i) => (
        <motion.circle
          key={i}
          cx={x + 9 + i * 6}
          cy={y + 6}
          r={1.8}
          fill="#0f6a30"
          animate={a ? { opacity: [0.25, 1, 0.25] } : { opacity: 1 }}
          transition={a ? loop(1.2, { delay: delay + i * 0.2 }) : rest}
        />
      ))}
    </g>
  );
  return (
    <NodeFrame tone="platform" code="VAULT" title="Secrets store" animating={a} {...p}>
      {dots(12, 46, 0)}
      {dots(118, 70, 0.5)}
      <motion.path
        d="M66 56 V46 a14 14 0 0 1 28 0 V56"
        fill="none"
        stroke="var(--color-ink)"
        strokeWidth={4.5}
        strokeLinecap="round"
        animate={a ? { y: [0, -6, -6, 0] } : { y: 0 }}
        transition={a ? { ...loop(2.4), times: [0, 0.25, 0.7, 1] } : rest}
      />
      <rect x={58} y={54} width={44} height={38} rx={7} fill="#dcebdd" {...S} />
      <motion.circle
        cx={80}
        cy={68}
        fill="none"
        stroke="#1a9a4a"
        strokeWidth={1.5}
        animate={a ? { r: [5, 13], opacity: [0.8, 0] } : { r: 5, opacity: 0 }}
        transition={a ? loop(1.2, { ease: "easeOut", cycle: 2.4 }) : rest}
      />
      <circle cx={80} cy={68} r={5} fill="#1a9a4a" />
      <rect x={78} y={70} width={4} height={11} rx={2} fill="#1a9a4a" />
    </NodeFrame>
  );
}

export function Configuration(p: NodeProps) {
  const a = useAnimating(p.isAnimating);
  const slider = (y: number, from: number, to: number, delay: number) => {
    const t = a ? { ...loop(2.8, { delay, mirror: true }) } : rest;
    return (
      <g>
        <rect x={36} y={y - 2} width={14} height={4} rx={2} fill="var(--color-ink)" fillOpacity={0.3} />
        <rect x={58} y={y - 1.5} width={62} height={3} rx={1.5} fill="var(--color-ink)" fillOpacity={0.18} />
        <motion.rect
          x={58}
          y={y - 1.5}
          height={3}
          rx={1.5}
          fill="#1a9a4a"
          animate={a ? { width: [from - 58, to - 58] } : { width: from - 58 }}
          transition={t}
        />
        <motion.circle
          cy={y}
          r={5.5}
          fill="var(--color-paper-raised)"
          stroke="#1a9a4a"
          strokeWidth={2}
          animate={a ? { cx: [from, to] } : { cx: from }}
          transition={t}
        />
      </g>
    );
  };
  return (
    <NodeFrame tone="platform" code="CFG" title="Configuration" animating={a} {...p}>
      <rect x={28} y={24} width={104} height={72} rx={8} fill="var(--color-paper-raised)" {...S} />
      {slider(40, 78, 104, 0)}
      {slider(58, 100, 70, 0.5)}
      <rect x={36} y={74} width={40} height={4} rx={2} fill="var(--color-ink)" fillOpacity={0.3} />
      <rect x={92} y={69} width={28} height={14} rx={7} fill="var(--color-paper-raised)" {...S} strokeWidth={1.2} />
      <motion.rect
        x={92}
        y={69}
        width={28}
        height={14}
        rx={7}
        fill="#1a9a4a"
        animate={a ? { opacity: [1, 0, 0, 1] } : { opacity: 1 }}
        transition={a ? { ...loop(2.8), times: [0, 0.2, 0.7, 0.9] } : rest}
      />
      <motion.circle
        cy={76}
        r={5}
        fill="var(--color-paper-raised)"
        stroke="var(--color-ink)"
        strokeWidth={1.2}
        animate={a ? { cx: [113, 99, 99, 113] } : { cx: 113 }}
        transition={a ? { ...loop(2.8), times: [0, 0.2, 0.7, 0.9] } : rest}
      />
    </NodeFrame>
  );
}

export function Observability(p: NodeProps) {
  const a = useAnimating(p.isAnimating);
  const d = "M36 82 L50 72 L62 78 L76 58 L90 66 L104 44 L124 52";
  return (
    <NodeFrame tone="platform" code="OBS" title="Observability" animating={a} {...p}>
      <rect x={26} y={24} width={108} height={72} rx={8} fill="var(--color-paper-raised)" {...S} />
      <circle cx={38} cy={34} r={2.5} fill="#1a9a4a" />
      <circle cx={47} cy={34} r={2.5} fill="#0f6a30" />
      <circle cx={56} cy={34} r={2.5} fill="var(--color-ink)" fillOpacity={0.4} />
      {[52, 66, 80].map((y) => (
        <line key={y} x1={36} y1={y} x2={124} y2={y} stroke="var(--color-ink)" strokeOpacity={0.12} strokeWidth={1} />
      ))}
      <path d={`${d} L124 88 L36 88 Z`} fill="#1a9a4a" fillOpacity={0.1} />
      <motion.path
        d={d}
        fill="none"
        stroke="#1a9a4a"
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        animate={a ? { pathLength: [0, 1, 1] } : { pathLength: 1 }}
        transition={a ? { ...loop(2.4), times: [0, 0.7, 1] } : rest}
      />
      <motion.line
        x1={36}
        x2={36}
        y1={44}
        y2={88}
        stroke="#0f6a30"
        strokeWidth={1}
        strokeDasharray="2 3"
        animate={a ? { x: [0, 88], opacity: [0.8, 0.8] } : { x: 0, opacity: 0 }}
        transition={a ? loop(2.4 * 0.7, { ease: "easeInOut", cycle: 2.4 }) : rest}
      />
      <motion.circle
        cx={104}
        cy={44}
        fill="none"
        stroke="#0f6a30"
        strokeWidth={1.5}
        animate={a ? { r: [3, 12], opacity: [0.8, 0] } : { r: 3, opacity: 0 }}
        transition={a ? loop(0.9, { ease: "easeOut", delay: 1.5, cycle: 2.4 }) : rest}
      />
      <circle cx={104} cy={44} r={3} fill="#0f6a30" stroke="var(--color-paper-raised)" strokeWidth={1} />
    </NodeFrame>
  );
}

