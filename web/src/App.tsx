import { lazy, Suspense } from 'react'
import { Link, NavLink, Route, Routes } from 'react-router-dom'
import HealthStrip from '@/components/HealthStrip'
import LoginBar from '@/components/LoginBar'
import ModeToggle from '@/components/ModeToggle'
import SiteFooter from '@/components/SiteFooter'
import { Skeleton } from '@/components/ui/skeleton'

// ONE CHUNK PER ROUTE, rather than one bundle for the whole app.
// Load each page only when its route is visited.
const HomePage = lazy(() => import('@/pages/HomePage'))
const JobsPage = lazy(() => import('@/pages/JobsPage'))
const JobDetailPage = lazy(() => import('@/pages/JobDetailPage'))
const WorkersPage = lazy(() => import('@/pages/WorkersPage'))
const DlqPage = lazy(() => import('@/pages/DlqPage'))

// Keep Jobs active for /jobs/:id as well.
const NAV = [
  { to: '/jobs', label: 'Jobs', end: false },
  { to: '/workers', label: 'Workers', end: false },
  { to: '/dlq', label: 'DLQ', end: false },
]

export default function App() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="bg-background/80 sticky top-0 z-10 border-b backdrop-blur-xl backdrop-saturate-150">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2 sm:h-14 sm:flex-nowrap sm:px-6 sm:py-0 lg:px-8">
          <Link to="/" className="font-semibold tracking-tight">
            QueueFlow
          </Link>

          <nav className="order-last -mx-1 flex w-full items-center gap-1 overflow-x-auto px-1 pb-1 sm:order-0 sm:mx-0 sm:w-auto sm:overflow-visible sm:px-0 sm:pb-0">
            {NAV.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end}
                className={({ isActive }) =>
                  `shrink-0 rounded-md px-3 py-1.5 text-sm transition-colors ${isActive
                    ? 'bg-accent text-accent-foreground font-medium'
                    : 'text-muted-foreground hover:text-foreground'
                  }`
                }
              >
                {n.label}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-2 sm:gap-3">
            <HealthStrip />
            <LoginBar />
            <ModeToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:px-8">
        {/* Show skeletons while the route chunk loads. */}
        <Suspense fallback={<RouteFallback />}>
          <Routes>
            <Route path="/" element={<HomePage />} />
            {/* Use query params for filters; /jobs/:id identifies a job. */}
            <Route path="/jobs" element={<JobsPage />} />
            <Route path="/jobs/:id" element={<JobDetailPage />} />
            <Route path="/workers" element={<WorkersPage />} />
            <Route path="/dlq" element={<DlqPage />} />
            <Route path="*" element={<p className="text-muted-foreground">Nothing here.</p>} />
          </Routes>
        </Suspense>
      </main>

      <SiteFooter />
    </div>
  )
}

// skeleton shown while a route chunk loads (suspense).
function RouteFallback() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-7 w-48" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-60 w-full" />
    </div>
  )
}
