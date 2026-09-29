// The system in one picture, for someone who has not read the README.
//
// Inline SVG rather than an image: every colour resolves through the same CSS
// variables as the rest of the app, so it follows the theme instead of needing a
// light and a dark export that drift apart.
//
// The shapes carry meaning, and the legend says so. A dashed box is a Redis key —
// volatile, a transport. A solid box with a primary border is Postgres — the
// durable record. Everything else is a process.

// Arrow geometry is repeated enough to be worth naming.
const EDGE = 'var(--border)'
const INK = 'var(--foreground)'
const DIM = 'var(--muted-foreground)'

export default function ArchitectureDiagram() {
  return (
    <figure className="m-0">
      {/* Below ~700px the diagram would be too small to read if it scaled down to
          fit, so it scrolls instead — the same choice the jobs table makes. */}
      <div className="overflow-x-auto">
        <svg
          viewBox="0 0 900 400"
          role="img"
          aria-label="A client posts a job to the API, which writes it to Postgres and pushes the id onto a Redis list. A worker moves the id to its own list with BLMOVE and runs the job. A scheduler and reaper return due retries and stranded jobs to the queue."
          className="h-auto w-full min-w-[720px]"
        >
          <defs>
            <marker
              id="arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill={EDGE} />
            </marker>
          </defs>

          {/* ---- processes ---- */}
          <Box x={20} y={28} w={104} h={44} label="Client" />
          <Box x={196} y={28} w={150} h={44} label="Express API" sub=":4000" />
          <Box x={716} y={150} w={164} h={44} label="Worker" sub="pool of N" />
          <Box x={196} y={296} w={180} h={44} label="scheduler + reaper" />

          {/* ---- the durable record ---- */}
          <Box
            x={716}
            y={28}
            w={164}
            h={44}
            label="Postgres"
            sub="payloads · outcomes"
            tone="record"
          />

          {/* ---- Redis keys ---- */}
          <Box x={196} y={150} w={180} h={44} label="pending" sub="LIST" tone="redis" />
          <Box x={446} y={150} w={190} h={44} label="processing:w1" sub="LIST" tone="redis" />
          <Box x={446} y={296} w={190} h={44} label="delayed" sub="ZSET, scored by run-at" tone="redis" />
          <Box x={716} y={296} w={164} h={44} label="worker:w1:alive" sub="STRING + TTL" tone="redis" />

          {/* ---- edges ---- */}
          {/* Client → API */}
          <Edge d="M 124 50 H 190" />
          <EdgeLabel x={157} y={42} text="POST /jobs" />

          {/* API → Postgres. The long span across the top is the point: the row is
              written before the id is pushed, so this happens first. */}
          <Edge d="M 346 50 H 710" />
          <EdgeLabel x={528} y={42} text="INSERT row — before the push" />

          {/* API → pending */}
          <Edge d="M 271 72 V 144" />
          <EdgeLabel x={271} y={112} text="LPUSH id" />

          {/* pending → processing. The gap here is only 70px wide, so the labels sit
              close to the line rather than at the spacing the longer edges use — at 32px
              out they floated free and read as belonging to the boxes instead of the
              arrow. */}
          <Edge d="M 376 172 H 440" />
          <EdgeLabel x={408} y={164} text="BLMOVE" />
          <EdgeLabel x={408} y={187} text="atomic" dim />

          {/* processing → worker */}
          <Edge d="M 636 172 H 710" />

          {/* worker → Postgres */}
          <Edge d="M 798 150 V 78" />
          <EdgeLabel x={798} y={116} text="claim · run · settle" />

          {/* worker → heartbeat */}
          <Edge d="M 798 194 V 290" />
          <EdgeLabel x={798} y={248} text="refreshes TTL" />

          {/* processing → delayed, on failure.
              The label names the WORKER because the arrow cannot. It is drawn between
              two Redis structures, like BLMOVE above it, so without the actor a reader
              reads it as another Redis-to-Redis operation — but Redis does not move
              anything here. The worker writes the row, then ZADDs the id. */}
          <Edge d="M 541 194 V 290" />
          <EdgeLabel x={541} y={248} text="worker ZADDs on failure" />

          {/* delayed → scheduler */}
          <Edge d="M 440 318 H 382" />

          {/* heartbeat → scheduler, routed under everything rather than straight
              through the delayed box. The final `V 344` turns the arrow up into the
              scheduler; without it the head stops in open space below the box, pointing
              left at nothing, and this is the one edge in the diagram that would not
              land anywhere. */}
          <Edge d="M 798 340 V 372 H 286 V 344" />
          <EdgeLabel x={560} y={388} text="expiry = the death notice" dim />

          {/* scheduler → pending, closing the loop */}
          <Edge d="M 286 296 V 200" />
          <EdgeLabel x={286} y={250} text="returns due" />
          <EdgeLabel x={286} y={266} text="+ stranded" />
        </svg>
      </div>

      <figcaption className="text-muted-foreground mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
        <LegendKey tone="redis">Redis — transport, holds ids only</LegendKey>
        <LegendKey tone="record">Postgres — the system of record</LegendKey>
        <LegendKey>process</LegendKey>
      </figcaption>
    </figure>
  )
}

type Tone = 'redis' | 'record' | undefined

function Box({
  x,
  y,
  w,
  h,
  label,
  sub,
  tone,
}: {
  x: number
  y: number
  w: number
  h: number
  label: string
  sub?: string
  tone?: Tone
}) {
  const stroke = tone === 'record' ? 'var(--primary)' : EDGE
  const fill = tone === 'redis' ? 'var(--muted)' : 'var(--card)'

  return (
    <g>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={8}
        fill={fill}
        stroke={stroke}
        strokeWidth={tone === 'record' ? 1.5 : 1}
        strokeDasharray={tone === 'redis' ? '4 3' : undefined}
      />
      <text
        x={x + w / 2}
        y={sub ? y + 20 : y + h / 2 + 5}
        textAnchor="middle"
        fontSize={14}
        fontWeight={500}
        fill={INK}
        fontFamily="ui-monospace, monospace"
      >
        {label}
      </text>
      {sub && (
        <text x={x + w / 2} y={y + 35} textAnchor="middle" fontSize={11} fill={DIM}>
          {sub}
        </text>
      )}
    </g>
  )
}

function Edge({ d }: { d: string }) {
  return <path d={d} fill="none" stroke={EDGE} strokeWidth={1.5} markerEnd="url(#arrow)" />
}

function EdgeLabel({ x, y, text, dim }: { x: number; y: number; text: string; dim?: boolean }) {
  return (
    <text
      x={x}
      y={y}
      textAnchor="middle"
      fontSize={11}
      fill={dim ? DIM : INK}
      // The label sits on top of its own line, so it needs to knock a hole in it.
      paintOrder="stroke"
      stroke="var(--background)"
      strokeWidth={6}
      strokeLinejoin="round"
    >
      {text}
    </text>
  )
}

function LegendKey({ tone, children }: { tone?: Tone; children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-2">
      <svg width="20" height="14" aria-hidden="true">
        <rect
          x={0.75}
          y={0.75}
          width={18.5}
          height={12.5}
          rx={3}
          fill={tone === 'redis' ? 'var(--muted)' : 'var(--card)'}
          stroke={tone === 'record' ? 'var(--primary)' : EDGE}
          strokeWidth={tone === 'record' ? 1.5 : 1}
          strokeDasharray={tone === 'redis' ? '3 2' : undefined}
        />
      </svg>
      {children}
    </span>
  )
}
