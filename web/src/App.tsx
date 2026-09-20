import { NavLink, Route, Routes } from 'react-router-dom'
import JobsPage from '@/pages/JobsPage'
import JobDetailPage from '@/pages/JobDetailPage'
import WorkersPage from '@/pages/WorkersPage'
import DlqPage from '@/pages/DlqPage'
import HealthStrip from '@/components/HealthStrip'
import LoginBar from '@/components/LoginBar'
import ModeToggle from '@/components/ModeToggle'

const NAV = [
  { to: '/', label: 'Jobs', end: true },
  { to: '/workers', label: 'Workers', end: false },
  { to: '/dlq', label: 'DLQ', end: false },
]

export default function App() {
  return (
    <div className="min-h-screen">
      <header className="bg-background/80 sticky top-0 z-10 border-b backdrop-blur">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-4">
          <span className="font-semibold tracking-tight">QueueFlow</span>

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
          <Route path="/" element={<JobsPage />} />
          <Route path="/jobs/:id" element={<JobDetailPage />} />
          <Route path="/workers" element={<WorkersPage />} />
          <Route path="/dlq" element={<DlqPage />} />
          <Route path="*" element={<p className="text-muted-foreground">Nothing here.</p>} />
        </Routes>
      </main>
    </div>
  )
}
