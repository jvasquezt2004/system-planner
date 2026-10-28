import { motion } from "./timeline-motion";
import {
  NodeFrame,
  Packet,
  S,
  Spin,
  gearPath,
  loop,
  rest,
  useAnimating,
  type NodeProps,
} from "./kit";

export function Application(p: NodeProps) {
  const a = useAnimating(p.isAnimating);
  const typed = (w: number, delay: number) => ({
    animate: a ? { width: [0, w, w, 0] } : { width: w },
    transition: a ? { ...loop(3, { ease: "linear", delay }), times: [0, 0.3, 0.85, 1] } : rest,
  });
  return (
    <NodeFrame tone="compute" code="APP" title="Application" animating={a} {...p}>
      <rect x={36} y={32} width={100} height={70} rx={9} fill="#f4e6d5" stroke="var(--color-ink)" strokeWidth={1.5} opacity={0.6} />
      <rect x={30} y={26} width={100} height={70} rx={9} fill="var(--color-paper-raised)" {...S} />
      <path d="M30 44 V35 a9 9 0 0 1 9 -9 H121 a9 9 0 0 1 9 9 V44 Z" fill="#f4e6d5" {...S} />
      <motion.circle
        cx={42}
        cy={35}
        r={3}
        fill="#d4730a"
        animate={a ? { opacity: [1, 0.3, 1] } : { opacity: 1 }}
        transition={a ? loop(1.2) : rest}
      />
      <rect x={52} y={32.5} width={40} height={5} rx={2.5} fill="var(--color-ink)" fillOpacity={0.2} />
      <motion.rect x={42} y={54} height={5} rx={2.5} fill="#d4730a" {...typed(52, 0)} />
      <motion.rect x={54} y={66} height={5} rx={2.5} fill="#8a4605" fillOpacity={0.7} {...typed(44, 0.3)} />
      <motion.rect x={54} y={78} height={5} rx={2.5} fill="var(--color-ink)" fillOpacity={0.3} {...typed(34, 0.6)} />
    </NodeFrame>
  );
}

export function Api(p: NodeProps) {
  const a = useAnimating(p.isAnimating);
  const pills = [
    { y: 34, t: "GET" },
    { y: 53, t: "POST" },
    { y: 72, t: "DEL" },
  ];
  const nudge = (dir: 1 | -1) => ({
    animate: a ? { x: [0, 4 * dir, 0] } : { x: 0 },
    transition: a ? loop(1.5) : rest,
  });
  return (
    <NodeFrame tone="compute" code="API" title="API" animating={a} {...p}>
      <path d="M52 26 C42 26 44 36 44 46 C44 54 40 58 34 60 C40 62 44 66 44 74 C44 84 42 94 52 94" fill="none" {...S} strokeWidth={2} />
      <path d="M108 26 C118 26 116 36 116 46 C116 54 120 58 126 60 C120 62 116 66 116 74 C116 84 118 94 108 94" fill="none" {...S} strokeWidth={2} />
      {pills.map((pl, i) => (
        <motion.g
          key={pl.t}
          animate={a ? { opacity: [0.45, 1, 0.45] } : { opacity: 1 }}
          transition={a ? loop(1.5, { delay: i * 0.5 }) : rest}
        >
          <rect x={58} y={pl.y} width={44} height={14} rx={7} fill="#f4e6d5" stroke="#d4730a" strokeWidth={1.2} />
          <text
            x={80}
            y={pl.y + 7.5}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={8.5}
            fontWeight={600}
            fill="#8a4605"
            style={{ fontFamily: "IBM Plex Mono, monospace" }}
          >
            {pl.t}
          </text>
        </motion.g>
      ))}
      <motion.path
        d="M10 60 H26 M21 55 L26 60 L21 65"
        fill="none"
        stroke="#d4730a"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        {...nudge(1)}
      />
      <motion.path
        d="M134 60 H150 M145 55 L150 60 L145 65"
        fill="none"
        stroke="#8a4605"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        {...nudge(1)}
      />
    </NodeFrame>
  );
}

export function Worker(p: NodeProps) {
  const a = useAnimating(p.isAnimating);
  return (
    <NodeFrame tone="compute" code="JOB" title="Worker" animating={a} {...p}>
      <Spin on={a} cx={60} cy={48} dur={6}>
        <path d={gearPath(60, 48, 10, 26, 20)} fill="#f4e6d5" {...S} />
        <circle cx={60} cy={48} r={7} fill="var(--color-paper-raised)" {...S} />
      </Spin>
      <Spin on={a} cx={90} cy={69} dur={3.6} dir={-1}>
        <path d={gearPath(90, 69, 7, 15, 11)} fill="var(--color-paper-raised)" {...S} />
        <circle cx={90} cy={69} r={4} fill="#d4730a" />
      </Spin>
      <circle cx={60} cy={48} r={2.5} fill="#d4730a" />
      <line x1={22} y1={98} x2={138} y2={98} {...S} />
      <circle cx={22} cy={98} r={3} fill="var(--color-paper-raised)" {...S} />
      <circle cx={138} cy={98} r={3} fill="var(--color-paper-raised)" {...S} />
      <rect x={30} y={89} width={9} height={9} rx={2} fill="#f4e6d5" {...S} strokeWidth={1.2} />
      <rect x={43} y={89} width={9} height={9} rx={2} fill="#f4e6d5" {...S} strokeWidth={1.2} />
      <rect x={118} y={89} width={9} height={9} rx={2} fill="#d4730a" {...S} strokeWidth={1.2} />
      <Packet on={a} path={[[22, 93.5], [138, 93.5]]} dur={2.4} r={4.5} square />
      <Packet on={a} path={[[22, 93.5], [138, 93.5]]} dur={2.4} delay={1.2} r={4.5} square fill="#8a4605" />
    </NodeFrame>
  );
}

export function ScheduledJob(p: NodeProps) {
  const a = useAnimating(p.isAnimating);
  const cx = 72;
  const cy = 56;
  return (
    <NodeFrame tone="compute" code="CRON" title="Scheduled job" animating={a} {...p}>
      <circle cx={cx} cy={cy} r={29} fill="var(--color-paper-raised)" {...S} />
      {Array.from({ length: 12 }, (_, i) => {
        const t = (i * 30 * Math.PI) / 180;
        const r1 = i % 3 === 0 ? 20 : 23;
        return (
          <line
            key={i}
            x1={cx + Math.sin(t) * r1}
            y1={cy - Math.cos(t) * r1}
            x2={cx + Math.sin(t) * 26}
            y2={cy - Math.cos(t) * 26}
            {...S}
            strokeWidth={i % 3 === 0 ? 2 : 1}
          />
        );
      })}
      <g transform={`rotate(120 ${cx} ${cy})`}>
        <Spin on={a} cx={cx} cy={cy} dur={6.4} turns={6.4 / 72}>
          <line x1={cx} y1={cy} x2={cx} y2={cy - 13} stroke="var(--color-ink)" strokeWidth={2.5} strokeLinecap="round" />
        </Spin>
      </g>
      <Spin on={a} cx={cx} cy={cy} dur={6}>
        <line x1={cx} y1={cy} x2={cx} y2={cy - 20} stroke="#d4730a" strokeWidth={2} strokeLinecap="round" />
      </Spin>
      <circle cx={cx} cy={cy} r={3} fill="#d4730a" stroke="var(--color-paper-raised)" strokeWidth={1} />
      <motion.circle
        cx={122}
        cy={84}
        fill="none"
        stroke="#d4730a"
        strokeWidth={1.5}
        animate={a ? { r: [11, 20], opacity: [0.8, 0] } : { r: 11, opacity: 0 }}
        transition={a ? loop(0.6, { ease: "easeOut", delay: 5.8, cycle: 6 }) : rest}
      />
      <circle cx={122} cy={84} r={11} fill="#f4e6d5" {...S} />
      <path d="M118 78 L129 84 L118 90 Z" fill="#d4730a" />
    </NodeFrame>
  );
}

export function ServerlessHandler(p: NodeProps) {
  const a = useAnimating(p.isAnimating);
  const dots: [number, number][] = [
    [28, 42],
    [132, 78],
    [34, 88],
  ];
  return (
    <NodeFrame tone="compute" code="FN" title="Serverless handler" animating={a} {...p}>
      <Spin on={a} cx={80} cy={58} dur={4}>
        <polygon
          points="80,22 111,40 111,76 80,94 49,76 49,40"
          fill="none"
          stroke="#d4730a"
          strokeWidth={1.2}
          strokeDasharray="4 4"
          strokeLinecap="round"
        />
      </Spin>
      <polygon points="80,28 106,43 106,73 80,88 54,73 54,43" fill="#f4e6d5" {...S} />
      <text
        x={80}
        y={59}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={36}
        fontWeight={600}
        fill="#8a4605"
        style={{ fontFamily: "Newsreader Variable, Georgia, serif" }}
      >
        λ
      </text>
      {dots.map(([x, y], i) => (
        <motion.circle
          key={i}
          cx={x}
          cy={y}
          fill="#d4730a"
          stroke="var(--color-paper-raised)"
          strokeWidth={1.5}
          animate={a ? { r: [0, 6, 6, 0] } : { r: 0 }}
          transition={a ? { ...loop(2.4, { delay: i * 0.8, ease: "easeOut" }), times: [0, 0.2, 0.7, 1] } : rest}
        />
      ))}
      <motion.path
        d="M126 22 L116 38 H124 L120 52 L134 32 H125 Z"
        fill="#d4730a"
        animate={a ? { opacity: [1, 0.2, 1, 0.2, 1] } : { opacity: 1 }}
        transition={a ? { ...loop(2.4, { ease: "linear" }), times: [0, 0.1, 0.2, 0.3, 0.4] } : rest}
      />
    </NodeFrame>
  );
}

