const REPO = 'https://github.com/shubham79a/QueueFlow'
const AUTHOR = 'https://github.com/shubham79a'

const YEAR = '2026'

export default function SiteFooter() {
  return (
    <footer className="mt-16 border-t">
      <div className="text-muted-foreground mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-8 text-sm sm:px-6 lg:px-8">
        <span>
          Built by{' '}
          <a
            href={AUTHOR}
            target="_blank"
            rel="noreferrer"
            className="text-foreground hover:text-primary font-medium underline-offset-4 transition-colors hover:underline"
          >
            Shubham Kumar
          </a>
          <span aria-hidden="true" className="px-1.5">
            ·
          </span>
          {YEAR}
        </span>

        <a
          href={REPO}
          target="_blank"
          rel="noreferrer"
          className="hover:text-foreground inline-flex items-center gap-1.5 underline-offset-4 transition-colors hover:underline sm:ml-auto"
        >
          <GithubMark />
          Source
        </a>
      </div>
    </footer>
  )
}

// Inline rather than from lucide — lucide v1 dropped its brand icons.
function GithubMark() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  )
}
