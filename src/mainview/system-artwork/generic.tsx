import { motion } from "./timeline-motion";
import type { ReactNode } from "react";
import { NodeFrame, Packet, S, Spin, loop, rest, useAnimating, type NodeProps } from "./kit";

export function GenericComponent(p: NodeProps) {
  const a = useAnimating(p.isAnimating);
  const port = (y: number, delay: number) => (
    <motion.rect
      x={36}
      y={y}
      width={16}
      height={8}
      rx={2}
      fill="#e2e3e3"
      stroke="#5b6577"
      strokeWidth={1.5}
      animate={a ? { fillOpacity: [1, 0.2, 1] } : { fillOpacity: 1 }}
      transition={a ? loop(1.6, { delay }) : rest}
    />
  );
  return (
    <NodeFrame tone="generic" code="CMP" title="Component" animating={a} {...p}>
      <line x1={14} y1={46} x2={36} y2={46} {...S} strokeOpacity={0.4} />
      <line x1={120} y1={60} x2={146} y2={60} {...S} strokeOpacity={0.4} />
      <Packet on={a} path={[[14, 46], [44, 46], [80, 60], [146, 60]]} dur={1.6} cycle={2.4} />
      <rect x={44} y={28} width={76} height={62} rx={6} fill="var(--color-paper-raised)" {...S} />
      {port(42, 0)}
      {port(64, 0.4)}
      <rect x={62} y={40} width={44} height={6} rx={3} fill="#5b6577" />
      <rect x={62} y={53} width={34} height={4} rx={2} fill="var(--color-ink)" fillOpacity={0.25} />
      <rect x={62} y={63} width={40} height={4} rx={2} fill="var(--color-ink)" fillOpacity={0.25} />
      <rect x={62} y={73} width={22} height={4} rx={2} fill="var(--color-ink)" fillOpacity={0.15} />
    </NodeFrame>
  );
}

/**
 * Configurable node. Pass `icon` as SVG children drawn in the 160×120 node box
 * (keep them inside x 20–140, y 24–98), plus `code` for the badge and `title`
 * for the accessible name. Without `icon` it renders a dashed "add" placeholder.
 */
export function CustomNode({
  icon,
  code = "NEW",
  title = "Custom",
  ...p
}: NodeProps & { icon?: ReactNode; code?: string; title?: string }) {
  const a = useAnimating(p.isAnimating);
  return (
    <NodeFrame tone="generic" code={code} title={title} animating={a} {...p}>
      {icon ?? (
        <>
          <motion.rect
            x={40}
            y={28}
            width={80}
            height={62}
            rx={12}
            fill="#e2e3e3"
            stroke="#5b6577"
            strokeWidth={2}
            strokeDasharray="6 5"
            strokeLinecap="round"
            animate={a ? { strokeDashoffset: [0, -22] } : { strokeDashoffset: 0 }}
            transition={a ? loop(1.4, { ease: "linear" }) : rest}
          />
          <Spin on={a} cx={80} cy={59} dur={4}>
            <path d="M80 47 V71 M68 59 H92" fill="none" stroke="#3b4352" strokeWidth={3} strokeLinecap="round" />
          </Spin>
        </>
      )}
    </NodeFrame>
  );
}

