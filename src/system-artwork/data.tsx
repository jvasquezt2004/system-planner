import { motion } from "./timeline-motion";
import { NodeFrame, Packet, S, loop, rest, useAnimating, type NodeProps } from "./kit";

export function Database(p: NodeProps) {
  const a = useAnimating(p.isAnimating);
  const bands = [48, 66];
  const leds = [47, 65, 82];
  return (
    <NodeFrame tone="data" code="DB" title="Database" animating={a} {...p}>
      <path d="M44 30 V82 A36 10 0 0 0 116 82 V30" fill="#e0e6f1" {...S} />
      {bands.map((y, i) => (
        <g key={y}>
          <path d={`M44 ${y} A36 10 0 0 0 116 ${y}`} fill="none" {...S} />
          <motion.path
            d={`M44 ${y} A36 10 0 0 0 116 ${y}`}
            fill="none"
            stroke="#2b63e0"
            strokeWidth={3}
            strokeLinecap="round"
            animate={a ? { opacity: [0, 1, 0] } : { opacity: 0 }}
            transition={a ? loop(0.9, { delay: 0.9 + i * 0.3, cycle: 1.8 }) : rest}
          />
        </g>
      ))}
      <ellipse cx={80} cy={30} rx={36} ry={10} fill="var(--color-paper-raised)" {...S} />
      {leds.map((y, i) => (
        <motion.circle
          key={y}
          cx={102}
          cy={y}
          r={2.5}
          fill="#2b63e0"
          animate={a ? { opacity: [1, 0.2, 1] } : { opacity: 1 }}
          transition={a ? loop(0.9, { delay: i * 0.3 }) : rest}
        />
      ))}
      <Packet on={a} path={[[80, 6], [80, 32]]} dur={0.9} cycle={1.8} r={3.5} />
    </NodeFrame>
  );
}

export function Cache(p: NodeProps) {
  const a = useAnimating(p.isAnimating);
  const pins = [58, 73, 88, 103];
  return (
    <NodeFrame tone="data" code="KV" title="Cache" animating={a} {...p}>
      {pins.map((x) => (
        <g key={x}>
          <line x1={x} y1={22} x2={x} y2={30} {...S} />
          <line x1={x} y1={86} x2={x} y2={94} {...S} />
        </g>
      ))}
      <rect x={46} y={30} width={68} height={56} rx={8} fill="#e0e6f1" {...S} />
      <motion.path
        d="M86 38 L68 62 H79 L74 78 L94 52 H82 Z"
        fill="#2b63e0"
        stroke="var(--color-paper-raised)"
        strokeWidth={1}
        strokeLinejoin="round"
        animate={a ? { scale: [1, 1.14, 1] } : { scale: 1 }}
        transition={a ? loop(0.5, { delay: 0.4, cycle: 1.6 }) : rest}
      />
      <line x1={14} y1={52} x2={46} y2={52} {...S} strokeOpacity={0.35} />
      <line x1={14} y1={68} x2={46} y2={68} {...S} strokeOpacity={0.35} />
      <Packet on={a} path={[[14, 52], [46, 52]]} dur={0.4} cycle={1.6} fill="var(--color-ink)" />
      <Packet on={a} path={[[46, 68], [14, 68]]} dur={0.4} delay={0.7} cycle={1.6} />
    </NodeFrame>
  );
}

export function ObjectStorageBucket(p: NodeProps) {
  const a = useAnimating(p.isAnimating);
  const items = [
    { x: 66, fill: "#2b63e0" },
    { x: 80, fill: "var(--color-ink)" },
    { x: 94, fill: "#1c47a8" },
  ];
  return (
    <NodeFrame tone="data" code="OBJ" title="Object-storage bucket" animating={a} {...p}>
      <ellipse cx={80} cy={46} rx={36} ry={9} fill="var(--color-ink)" fillOpacity={0.18} />
      {items.map((it, i) => (
        <Packet
          key={it.x}
          on={a}
          path={[[it.x, 6], [it.x, 54]]}
          dur={1.1}
          delay={i * 0.55}
          cycle={1.8}
          r={5}
          square
          fill={it.fill}
        />
      ))}
      <path d="M44 46 A36 9 0 0 0 116 46 L106 94 H54 Z" fill="#e0e6f1" {...S} />
      <ellipse cx={80} cy={46} rx={36} ry={9} fill="none" {...S} />
      <rect x={66} y={68} width={28} height={12} rx={3} fill="var(--color-paper-raised)" stroke="#2b63e0" strokeWidth={1.2} />
      <rect x={71} y={72} width={18} height={2.5} rx={1.25} fill="#2b63e0" />
      <rect x={71} y={76} width={11} height={2.5} rx={1.25} fill="var(--color-ink)" fillOpacity={0.3} />
    </NodeFrame>
  );
}

export function FileStorage(p: NodeProps) {
  const a = useAnimating(p.isAnimating);
  return (
    <NodeFrame tone="data" code="FS" title="File storage" animating={a} {...p}>
      <path d="M24 40 Q24 34 30 34 H58 L66 42 H130 Q136 42 136 48 V94 H24 Z" fill="#e0e6f1" {...S} />
      {[40, 64, 88].map((x, i) => (
        <motion.g
          key={x}
          animate={a ? { y: [0, -9, 0] } : { y: 0 }}
          transition={a ? loop(1.8, { delay: i * 0.35 }) : rest}
        >
          <rect x={x} y={38} width={32} height={44} rx={3} fill="var(--color-paper-raised)" {...S} />
          <rect x={x + 5} y={44} width={22} height={3} rx={1.5} fill="#2b63e0" />
          <rect x={x + 5} y={51} width={16} height={3} rx={1.5} fill="var(--color-ink)" fillOpacity={0.25} />
        </motion.g>
      ))}
      <rect x={24} y={58} width={112} height={36} rx={5} fill="#2b63e0" {...S} />
      <rect x={34} y={68} width={30} height={5} rx={2.5} fill="var(--color-paper-raised)" fillOpacity={0.9} />
      <rect x={34} y={77} width={20} height={4} rx={2} fill="var(--color-paper-raised)" fillOpacity={0.55} />
    </NodeFrame>
  );
}

export function SearchIndex(p: NodeProps) {
  const a = useAnimating(p.isAnimating);
  const track = {
    animate: a ? { y: [0, 14, 28, 42, 0] } : { y: 0 },
    transition: a ? loop(3.6, { cycle: 3.6 }) : rest,
  };
  return (
    <NodeFrame tone="data" code="IDX" title="Search index" animating={a} {...p}>
      <rect x={30} y={26} width={100} height={70} rx={8} fill="var(--color-paper-raised)" {...S} />
      <motion.g {...track}>
        <rect x={37} y={35} width={86} height={12} rx={4} fill="#2b63e0" fillOpacity={0.18} stroke="#2b63e0" strokeWidth={1} />
      </motion.g>
      {[0, 1, 2, 3].map((i) => (
        <g key={i}>
          <circle cx={42} cy={41 + i * 14} r={2.2} fill="#2b63e0" />
          <rect x={50} y={39 + i * 14} width={[28, 20, 26, 16][i]} height={4} rx={2} fill="var(--color-ink)" fillOpacity={0.28} />
        </g>
      ))}
      <motion.g {...track}>
        <circle cx={100} cy={41} r={12} fill="#e0e6f1" fillOpacity={0.7} stroke="#2b63e0" strokeWidth={2.2} />
        <line x1={109} y1={50} x2={118} y2={59} stroke="#2b63e0" strokeWidth={3.5} strokeLinecap="round" />
      </motion.g>
    </NodeFrame>
  );
}

