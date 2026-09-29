import { Link } from 'react-router-dom'

const REPO = 'https://github.com/shubham79a/QueueFlow'

// The same footer on every page.
//
// It used to live inside the landing page, which meant the four operator views simply
// stopped — the jobs table ended at "Load more" and then nothing, and the workers page
// with nothing running was one small card above half a screen of empty. A page that
// ends without ending reads as one that failed to finish loading.
//
// Kept to one line of text and a row of links on purpose. The landing page can afford a
// paragraph about why the project exists; the jobs table cannot, because anything down
// there competes with the thing somebody actually came to read.
export default function SiteFooter() {
  return (
    <footer className="mt-12 border-t">
      <div className="text-muted-foreground mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-6 text-sm sm:px-6 lg:px-8">
        <span>
          <span className="text-foreground font-medium">QueueFlow</span> — a distributed job queue
          on raw Redis primitives.
        </span>

        <nav className="flex flex-wrap gap-x-5 gap-y-2 sm:ml-auto">
          <a
            href={REPO}
            target="_blank"
            rel="noreferrer"
            className="hover:text-foreground underline underline-offset-4"
          >
            Source
          </a>
          <Link to="/jobs" className="hover:text-foreground underline underline-offset-4">
            Jobs
          </Link>
          <Link to="/workers" className="hover:text-foreground underline underline-offset-4">
            Workers
          </Link>
          <Link to="/dlq" className="hover:text-foreground underline underline-offset-4">
            DLQ
          </Link>
        </nav>
      </div>
    </footer>
  )
}
