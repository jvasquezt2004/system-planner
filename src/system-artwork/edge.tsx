import { motion } from "./timeline-motion";
import { NodeFrame, Packet, S, loop, rest, useAnimating, type NodeProps, type Pt } from "./kit";

export function Dns(p: NodeProps) {
  const a = useAnimating(p.isAnimating);
  const rows = [
    { y: 36, chip: "A", w: 52 },
    { y: 54, chip: "AAAA", w: 40 },
    { y: 72, chip: "CNAME", w: 30 },
  ];
  return (
    <NodeFrame tone="edge" code="DNS" title="DNS" animating={a} {...p}>
      <rect x={28} y={28} width={104} height={66} rx={8} fill="var(--color-paper-raised)" {...S} />
      <motion.g
        animate={a ? { y: [0, 0, 18, 18, 36, 36] } : { y: 0 }}
        transition={a ? { ...loop(3.6, { ease: "linear" }), times: [0, 0.3, 0.33, 0.63, 0.66, 1] } : rest}
      >
        <rect
          x={33}
          y={34}
          width={94}
          height={18}
          rx={5}
          fill="#0a86a3"
          fillOpacity={0.18}
          stroke="#0a86a3"
          strokeWidth={1.2}
        />
      </motion.g>
      {rows.map((r) => (
        <g key={r.chip}>
          <rect x={38} y={r.y} width={30} height={14} rx={4} fill="#dbe9e9" stroke="#0a86a3" strokeWidth={1} />
          <text
            x={53}
            y={r.y + 7.5}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={7.5}
            fontWeight={600}
            fill="#076378"
            style={{ fontFamily: "IBM Plex Mono, monospace" }}
          >
            {r.chip}
          </text>
          <rect x={76} y={r.y + 4.5} width={r.w} height={5} rx={2.5} fill="var(--color-ink)" fillOpacity={0.22} />
        </g>
      ))}
    </NodeFrame>
  );
}

export function Cdn(p: NodeProps) {
  const a = useAnimating(p.isAnimating);
  const edges: Pt[] = [
    [34, 36],
    [126, 36],
    [34, 86],
    [126, 86],
  ];
  return (
    <NodeFrame tone="edge" code="CDN" title="CDN" animating={a} {...p}>
      {edges.map(([x, y], i) => (
        <g key={i}>
          <line x1={80} y1={61} x2={x} y2={y} {...S} strokeOpacity={0.4} strokeDasharray="3 3" />
          <motion.circle
            cx={x}
            cy={y}
            fill="none"
            stroke="#0a86a3"
            strokeWidth={1.5}
            animate={a ? { r: [9, 18], opacity: [0.7, 0] } : { r: 9, opacity: 0 }}
            transition={a ? loop(1, { ease: "easeOut", delay: 1 + i * 0.25, cycle: 2.4 }) : rest}
          />
        </g>
      ))}
      {edges.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={9} fill="#dbe9e9" {...S} />
      ))}
      {edges.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={3} fill="#0a86a3" />
      ))}
      <rect x={67} y={48} width={26} height={26} rx={7} fill="var(--color-paper-raised)" {...S} />
      <rect x={73} y={54} width={14} height={14} rx={3} fill="#0a86a3" />
      {edges.map(([x, y], i) => (
        <Packet key={i} on={a} path={[[80, 61], [x, y]]} dur={1} delay={i * 0.25} cycle={2.4} />
      ))}
    </NodeFrame>
  );
}

export function LoadBalancer(p: NodeProps) {
  const a = useAnimating(p.isAnimating);
  const ys = [34, 60, 86];
  return (
    <NodeFrame tone="edge" code="LB" title="Load balancer" animating={a} {...p}>
      <line x1={14} y1={60} x2={46} y2={60} {...S} strokeOpacity={0.4} />
      {ys.map((y) => (
        <path key={y} d={`M70 60 C88 60 90 ${y} 108 ${y}`} fill="none" {...S} strokeOpacity={0.4} />
      ))}
      {ys.map((y, i) => (
        <g key={y}>
          <rect x={108} y={y - 9} width={32} height={18} rx={4} fill="var(--color-paper-raised)" {...S} />
          <motion.rect
            x={108}
            y={y - 9}
            width={32}
            height={18}
            rx={4}
            fill="#0a86a3"
            animate={a ? { opacity: [0, 0.35, 0] } : { opacity: 0 }}
            transition={a ? loop(0.7, { delay: 1.1 + i, cycle: 3 }) : rest}
          />
          <rect x={114} y={y - 3} width={14} height={2.5} rx={1.25} fill="var(--color-ink)" fillOpacity={0.35} />
          <rect x={114} y={y + 1.5} width={9} height={2.5} rx={1.25} fill="var(--color-ink)" fillOpacity={0.2} />
          <circle cx={134} cy={y} r={2} fill="#0a86a3" />
        </g>
      ))}
      <circle cx={58} cy={60} r={13} fill="#dbe9e9" {...S} />
      <path d="M52 60 H58 M58 60 L64 53 M58 60 H65 M58 60 L64 67" fill="none" stroke="#0a86a3" strokeWidth={2} strokeLinecap="round" />
      {ys.map((y, i) => (
        <g key={y}>
          <Packet on={a} path={[[14, 60], [46, 60]]} dur={0.5} delay={i} cycle={3} />
          <Packet on={a} path={[[70, 60], [88, y], [108, y]]} dur={0.7} delay={0.5 + i} cycle={3} />
        </g>
      ))}
    </NodeFrame>
  );
}

export function ApiGateway(p: NodeProps) {
  const a = useAnimating(p.isAnimating);
  const ys = [38, 60, 82];
  return (
    <NodeFrame tone="edge" code="GW" title="API gateway" animating={a} {...p}>
      {ys.map((y) => (
        <g key={y}>
          <line x1={14} y1={y} x2={140} y2={y} {...S} strokeOpacity={0.3} />
          <circle cx={146} cy={y} r={4} fill="var(--color-paper-raised)" {...S} />
        </g>
      ))}
      {ys.map((y, i) => (
        <Packet key={y} on={a} path={[[14, y], [146, y]]} dur={1.6} delay={i} cycle={3} />
      ))}
      <rect x={64} y={22} width={32} height={76} rx={8} fill="#dbe9e9" {...S} />
      <motion.rect
        x={62}
        y={20}
        width={36}
        height={80}
        rx={9}
        fill="none"
        stroke="#0a86a3"
        strokeWidth={2}
        animate={a ? { opacity: [0, 0.9, 0] } : { opacity: 0 }}
        transition={a ? loop(0.5, { delay: 0.55, cycle: 1 }) : rest}
      />
      <path d="M80 46 L91 50 V60 C91 67 86 72 80 75 C74 72 69 67 69 60 V50 Z" fill="#0a86a3" />
      <path d="M75 60 L79 64 L86 56" fill="none" stroke="var(--color-paper-raised)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </NodeFrame>
  );
}

export function Proxy(p: NodeProps) {
  const a = useAnimating(p.isAnimating);
  return (
    <NodeFrame tone="edge" code="PRX" title="Proxy" animating={a} {...p}>
      {[52, 68].map((y) => (
        <g key={y}>
          <line x1={30} y1={y} x2={58} y2={y} {...S} strokeOpacity={0.35} />
          <line x1={102} y1={y} x2={120} y2={y} {...S} strokeOpacity={0.35} />
        </g>
      ))}
      <circle cx={22} cy={60} r={8} fill="var(--color-paper-raised)" {...S} />
      <rect x={120} y={44} width={22} height={32} rx={5} fill="var(--color-paper-raised)" {...S} />
      <rect x={125} y={50} width={12} height={3} rx={1.5} fill="var(--color-ink)" fillOpacity={0.35} />
      <rect x={125} y={57} width={12} height={3} rx={1.5} fill="var(--color-ink)" fillOpacity={0.35} />
      <Packet on={a} path={[[30, 52], [120, 52]]} dur={1.4} cycle={2.8} />
      <Packet on={a} path={[[120, 68], [30, 68]]} dur={1.4} delay={1.4} cycle={2.8} fill="var(--color-ink)" />
      <rect x={58} y={34} width={44} height={52} rx={11} fill="#dbe9e9" {...S} />
      <path d="M68 52 H92 M86 46 L92 52 L86 58" fill="none" stroke="#0a86a3" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M92 68 H68 M74 62 L68 68 L74 74" fill="none" stroke="#076378" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
    </NodeFrame>
  );
}

