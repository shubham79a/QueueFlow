import { lazy, Suspense } from 'react'
import { Link, NavLink, Route, Routes } from 'react-router-dom'
import HealthStrip from '@/components/HealthStrip'
import LoginBar from '@/components/LoginBar'
import ModeToggle from '@/components/ModeToggle'
import SiteFooter from '@/components/SiteFooter'
import { Skeleton } from '@/components/ui/skeleton'

// ONE CHUNK PER ROUTE, rather than one bundle for the whole app.
//
// A static import here means the first visitor downloads every page: the landing
// page pulled in the jobs table, the DLQ, the detail view and the SVG diagram
// whether or not they ever clicked through. That pushed the bundle past 500kB and
// it lands hardest on exactly the page where it matters least — somebody arriving
// at "/" to find out what this is.
//
// lazy() turns each of these into its own chunk, fetched when its route is first
// visited. The header stays in the main bundle because it is on every page.
//
// The trade is a short blank moment on first navigation to a route, which the
// Suspense fallback below covers. Preloading on hover would remove even that, and
// is not worth the machinery at five routes.
const HomePage = lazy(() => import('@/pages/HomePage'))
const JobsPage = lazy(() => import('@/pages/JobsPage'))
const JobDetailPage = lazy(() => import('@/pages/JobDetailPage'))
const WorkersPage = lazy(() => import('@/pages/WorkersPage'))
const DlqPage = lazy(() => import('@/pages/DlqPage'))

// `end` controls when a tab counts as active. Jobs needs end:false so that
// /jobs/<id> keeps the Jobs tab lit while you are reading one job.
const NAV = [
  { to: '/jobs', label: 'Jobs', end: false },
  { to: '/workers', label: 'Workers', end: false },
  { to: '/dlq', label: 'DLQ', end: false },
]

export default function App() {
  return (
    // A column, so the footer can be pushed to the bottom of the viewport by the
    // flex-1 on <main> below. Without it, a short page — the workers view with nothing
    // running is the extreme case — leaves the footer floating in the middle of the
    // screen with empty space beneath it, which looks more broken than no footer.
    <div className="flex min-h-screen flex-col">
      {/* Two rows on a phone, one on a laptop.
          The brand and the controls keep the top row; the tabs drop below it rather
          than being squeezed into the same 56px alongside a sign-in form. `order`
          does the moving, so the DOM order stays brand → nav → controls for anyone
          tabbing through it. */}
      {/* Frosted, but MORE OPAQUE THAN .glass ON PURPOSE.
          The cards on the landing page sit over a gradient and nothing else, so 62%
          is safe there. This bar is sticky over the jobs table, and at that opacity
          rows of uuids scroll through the nav and make it hard to read. 80% keeps the
          effect while the text stays the most legible thing in its own bar.
          Blur and saturation match .glass so the two read as the same material. */}
      <header className="bg-background/80 sticky top-0 z-10 border-b backdrop-blur-xl backdrop-saturate-150">
        {/* The gutter grows with the screen: 16px on a phone, 24px from sm, 32px from
            lg. A single px-4 was enough at phone width and far too tight on a laptop,
            where max-w-7xl is 1280px and most windows are barely wider — the cap
            stops biting and the content runs to both edges. */}
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
                  `shrink-0 rounded-md px-3 py-1.5 text-sm transition-colors ${
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

          <div className="ml-auto flex items-center gap-2 sm:gap-3">
            <HealthStrip />
            <LoginBar />
            <ModeToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:px-8">
        {/* Skeletons rather than a spinner: a chunk arrives in a few hundred
            milliseconds on a warm connection, and a spinner that flashes for that long
            reads as breakage. A block holding the shape of what is coming does not. */}
        <Suspense fallback={<RouteFallback />}>
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
        </Suspense>
      </main>

      <SiteFooter />
    </div>
  )
}

// Deliberately generic. Every route here opens with a heading and then a block —
// cards, a table, a diagram — so one shape covers all of them, and it is on screen
// too briefly to be worth five bespoke versions.
function RouteFallback() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-7 w-48" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-60 w-full" />

    </div>
  )
}
