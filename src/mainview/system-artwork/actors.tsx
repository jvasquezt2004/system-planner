import { motion } from "./timeline-motion";
import { NodeFrame, Packet, S, loop, rest, useAnimating, type NodeProps } from "./kit";

export function Person(p: NodeProps) {
  const a = useAnimating(p.isAnimating);
  return (
    <NodeFrame tone="actors" code="USR" title="Person" animating={a} {...p}>
      <motion.circle
        cx={80}
        cy={46}
        fill="none"
        stroke="#6d3fe0"
        strokeWidth={1.5}
        animate={a ? { r: [13, 30], opacity: [0.7, 0] } : { r: 13, opacity: 0 }}
        transition={a ? loop(1.8, { ease: "easeOut" }) : rest}
      />
      <path d="M54 98 C54 77 66 68 80 68 C94 68 106 77 106 98 Z" fill="#e9e1f4" {...S} />
      <motion.g
        animate={a ? { y: [0, -2, 0] } : { y: 0 }}
        transition={a ? loop(1.8) : rest}
      >
        <circle cx={80} cy={46} r={11} fill="var(--color-paper-raised)" {...S} />
      </motion.g>
      <motion.circle
        cx={98}
        cy={42}
        r={4.5}
        fill="#6d3fe0"
        stroke="var(--color-paper-raised)"
        strokeWidth={1.5}
        animate={a ? { opacity: [1, 0.3, 1] } : { opacity: 1 }}
        transition={a ? loop(1.2) : rest}
      />
    </NodeFrame>
  );
}

export function Browser(p: NodeProps) {
  const a = useAnimating(p.isAnimating);
  const lineAnim = (delay: number) => ({
    animate: a ? { opacity: [0.25, 1, 1, 0.25] } : { opacity: 1 },
    transition: a ? { ...loop(2.4, { ease: "linear", delay }), times: [0, 0.25, 0.85, 1] } : rest,
  });
  return (
    <NodeFrame tone="actors" code="WEB" title="Browser" animating={a} {...p}>
      <rect x={22} y={26} width={116} height={70} rx={8} fill="var(--color-paper-raised)" {...S} />
      <path d="M22 42 V34 a8 8 0 0 1 8 -8 H130 a8 8 0 0 1 8 8 V42 Z" fill="#e9e1f4" {...S} />
      <circle cx={32} cy={34} r={2} fill="#6d3fe0" />
      <circle cx={39} cy={34} r={2} fill="#6d3fe0" opacity={0.6} />
      <circle cx={46} cy={34} r={2} fill="#6d3fe0" opacity={0.3} />
      <rect x={56} y={30} width={68} height={8} rx={4} fill="var(--color-paper-raised)" stroke="var(--color-ink)" strokeWidth={1} />
      <motion.rect
        x={22}
        y={41}
        height={2}
        rx={1}
        fill="#6d3fe0"
        animate={a ? { width: [0, 116, 116], opacity: [1, 1, 0] } : { width: 0, opacity: 0 }}
        transition={a ? { ...loop(2.4), times: [0, 0.7, 1] } : rest}
      />
      <motion.rect x={32} y={50} width={40} height={26} rx={3} fill="#e9e1f4" stroke="#6d3fe0" strokeWidth={1} {...lineAnim(0.2)} />
      <motion.rect x={80} y={50} width={46} height={5} rx={2.5} fill="#6d3fe0" {...lineAnim(0.4)} />
      <motion.rect x={80} y={61} width={36} height={4} rx={2} fill="var(--color-ink)" fillOpacity={0.25} {...lineAnim(0.6)} />
      <motion.rect x={80} y={70} width={42} height={4} rx={2} fill="var(--color-ink)" fillOpacity={0.25} {...lineAnim(0.8)} />
      <motion.rect x={32} y={82} width={94} height={4} rx={2} fill="var(--color-ink)" fillOpacity={0.15} {...lineAnim(1)} />
    </NodeFrame>
  );
}

export function MobileApp(p: NodeProps) {
  const a = useAnimating(p.isAnimating);
  const tiles: [number, number][] = [
    [66, 34],
    [82, 34],
    [66, 52],
    [82, 52],
  ];
  return (
    <NodeFrame tone="actors" code="APP" title="Mobile app" animating={a} {...p}>
      <rect x={56} y={18} width={48} height={84} rx={9} fill="var(--color-paper-raised)" {...S} />
      <rect x={72} y={22} width={16} height={3} rx={1.5} fill="var(--color-ink)" fillOpacity={0.35} />
      {tiles.map(([x, y], i) => (
        <motion.rect
          key={i}
          x={x}
          y={y}
          width={13}
          height={13}
          rx={4}
          fill={i === 0 ? "#6d3fe0" : "#e9e1f4"}
          stroke="#6d3fe0"
          strokeWidth={1}
          animate={a ? { opacity: [1, 0.45, 1] } : { opacity: 1 }}
          transition={a ? loop(1.8, { delay: i * 0.25 }) : rest}
        />
      ))}
      <rect x={66} y={72} width={29} height={4} rx={2} fill="var(--color-ink)" fillOpacity={0.25} />
      <rect x={66} y={80} width={20} height={4} rx={2} fill="var(--color-ink)" fillOpacity={0.15} />
      <rect x={72} y={95} width={16} height={2.5} rx={1.25} fill="var(--color-ink)" fillOpacity={0.4} />
      <motion.circle
        cx={80}
        cy={35}
        fill="#4a24b0"
        stroke="var(--color-paper-raised)"
        strokeWidth={1.5}
        animate={a ? { r: [0, 4.5, 3.5, 3.5, 0] } : { r: 0 }}
        transition={a ? { ...loop(2.4, { ease: "easeOut" }), times: [0, 0.2, 0.3, 0.85, 1] } : rest}
      />
      <motion.circle
        cx={72}
        cy={58}
        fill="none"
        stroke="#6d3fe0"
        strokeWidth={1.5}
        animate={a ? { r: [4, 14], opacity: [0.8, 0] } : { r: 4, opacity: 0 }}
        transition={a ? loop(1.2, { ease: "easeOut", cycle: 2.4, delay: 0.8 }) : rest}
      />
    </NodeFrame>
  );
}

export function ExternalSystem(p: NodeProps) {
  const a = useAnimating(p.isAnimating);
  return (
    <NodeFrame tone="actors" code="EXT" title="External system" animating={a} {...p}>
      <rect
        x={30}
        y={26}
        width={100}
        height={68}
        rx={10}
        fill="var(--color-paper-raised)"
        stroke="var(--color-ink)"
        strokeWidth={1.5}
        strokeDasharray="5 4"
        strokeLinecap="round"
      />
      <circle cx={80} cy={60} r={17} fill="#e9e1f4" {...S} />
      <ellipse cx={80} cy={60} rx={7} ry={17} fill="none" {...S} strokeWidth={1.2} />
      <line x1={63} y1={60} x2={97} y2={60} {...S} strokeWidth={1.2} />
      <path d="M14 54 L20 60 L14 66" fill="none" stroke="#6d3fe0" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M140 54 L146 60 L140 66" fill="none" stroke="#6d3fe0" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <Packet on={a} path={[[10, 60], [64, 60]]} dur={1} cycle={2.4} />
      <Packet on={a} path={[[96, 60], [150, 60]]} dur={1} delay={1.2} cycle={2.4} fill="var(--color-ink)" />
    </NodeFrame>
  );
}

