import { NavLink, Route, Routes } from 'react-router-dom'
import JobsPage from './pages/JobsPage.tsx'

// Layout + routes. Workers and DLQ are placeholders until their features land.
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
      </header>

      <main>
        <Routes>
          <Route path="/" element={<JobsPage />} />
          <Route path="/workers" element={<Placeholder name="Workers" />} />
          <Route path="/dlq" element={<Placeholder name="Dead-letter queue" />} />
          <Route path="*" element={<p className="muted">Nothing here.</p>} />
        </Routes>
      </main>
    </>
  )
}

function Placeholder({ name }: { name: string }) {
  return (
    <p className="muted">
      {name} — coming next.
    </p>
  )
}
