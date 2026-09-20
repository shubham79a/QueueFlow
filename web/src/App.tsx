import { Link, NavLink, Route, Routes } from 'react-router-dom'
import HomePage from '@/pages/HomePage'
import JobsPage from '@/pages/JobsPage'
import JobDetailPage from '@/pages/JobDetailPage'
import WorkersPage from '@/pages/WorkersPage'
import DlqPage from '@/pages/DlqPage'
import HealthStrip from '@/components/HealthStrip'
import LoginBar from '@/components/LoginBar'
import ModeToggle from '@/components/ModeToggle'

// `end` controls when a tab counts as active. Jobs needs end:false so that
// /jobs/<id> keeps the Jobs tab lit while you are reading one job.
const NAV = [
  { to: '/jobs', label: 'Jobs', end: false },
  { to: '/workers', label: 'Workers', end: false },
  { to: '/dlq', label: 'DLQ', end: false },
]

export default function App() {
  return (
    <div className="min-h-screen">
      <header className="bg-background/80 sticky top-0 z-10 border-b backdrop-blur">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-4">
          <Link to="/" className="font-semibold tracking-tight">
            QueueFlow
          </Link>

          <nav className="flex items-center gap-1">
            {NAV.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end}
                className={({ isActive }) =>
                  `rounded-md px-3 py-1.5 text-sm transition-colors ${
                    isActive
                      ? 'bg-accent text-accent-foreground font-medium'
                      : 'text-muted-foreground hover:text-foreground'
                  }`
                }
              >
                {n.label}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <HealthStrip />
            <LoginBar />
            <ModeToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6">
        <Routes>
          <Route path="/" element={<HomePage />} />
          {/* The status filter is /jobs?status=dead rather than /jobs/dead, because
              /jobs/:id already means one job — a path segment could not tell a
              status from an id. */}
          <Route path="/jobs" element={<JobsPage />} />
          <Route path="/jobs/:id" element={<JobDetailPage />} />
          <Route path="/workers" element={<WorkersPage />} />
          <Route path="/dlq" element={<DlqPage />} />
          <Route path="*" element={<p className="text-muted-foreground">Nothing here.</p>} />
        </Routes>
      </main>
    </div>
  )
}
