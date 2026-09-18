import { NavLink, Route, Routes } from 'react-router-dom'
import JobsPage from './pages/JobsPage.tsx'
import JobDetailPage from './pages/JobDetailPage.tsx'
import WorkersPage from './pages/WorkersPage.tsx'
import DlqPage from './pages/DlqPage.tsx'
import HealthStrip from './components/HealthStrip.tsx'
import LoginBar from './components/LoginBar.tsx'

// Layout + routes. DLQ is a placeholder until its feature lands.
export default function App() {
  return (
    <>
      <header className="topbar">
        <span className="brand">QueueFlow</span>
        <nav>
          <NavLink to="/" end>
            Jobs
          </NavLink>
          <NavLink to="/workers">Workers</NavLink>
          <NavLink to="/dlq">DLQ</NavLink>
        </nav>
        <HealthStrip />
        <LoginBar />
      </header>

      <main>
        <Routes>
          <Route path="/" element={<JobsPage />} />
          <Route path="/jobs/:id" element={<JobDetailPage />} />
          <Route path="/workers" element={<WorkersPage />} />
          <Route path="/dlq" element={<DlqPage />} />
          <Route path="*" element={<p className="muted">Nothing here.</p>} />
        </Routes>
      </main>
    </>
  )
}
