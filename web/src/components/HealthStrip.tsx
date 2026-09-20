import { useQuery } from '@tanstack/react-query'
import { getHealth } from '@/api/health'

// Two dots in the header: is Redis up, is Postgres up.
//
// The counts this used to carry moved to StatCards, where they are readable. What is
// left is the part that genuinely belongs in a header — a persistent indicator that
// the two things the system cannot work without are reachable.
export default function HealthStrip() {
  const health = useQuery({ queryKey: ['health'], queryFn: getHealth, refetchInterval: 5000 })

  // The API itself is unreachable — a different thing from the API reporting that a
  // dependency is down, which arrives as data with status 'degraded'.
  if (health.isError) {
    return <span className="text-bad text-xs font-medium">API unreachable</span>
  }

  if (!health.data) return null

  const h = health.data

  return (
    <div className="hidden items-center gap-3 text-xs sm:flex">
      <Dot up={h.redis === 'PONG'} label="redis" detail={h.redis} />
      <Dot up={h.postgres === 'ok'} label="postgres" detail={h.postgres} />
    </div>
  )
}

function Dot({ up, label, detail }: { up: boolean; label: string; detail?: string }) {
  return (
    <span
      className="text-muted-foreground flex items-center gap-1.5"
      title={up ? `${label} up` : `${label}: ${detail}`}
    >
      <span className={`h-2 w-2 rounded-full ${up ? 'bg-ok' : 'bg-bad animate-pulse'}`} />
      {label}
    </span>
  )
}
