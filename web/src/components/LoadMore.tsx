import { Button } from '@/components/ui/button'

// "showing 50 of 321", and the button to see more.
//
// A button rather than numbered pages, deliberately: numbered pages promise a stable
// set, and this list gains rows while you are reading it. There is no page 7 to go
// back to — only "older than what I have".
export default function LoadMore({
  shown,
  total,
  hasNextPage,
  isFetching,
  onLoadMore,
}: {
  shown: number
  total: number | undefined
  hasNextPage: boolean
  isFetching: boolean
  onLoadMore: () => void
}) {
  if (shown === 0) return null

  return (
    <div className="flex items-center justify-center gap-4 py-2">
      <span className="text-muted-foreground text-xs tabular-nums">
        showing {shown.toLocaleString()}
        {total !== undefined && ` of ${total.toLocaleString()}`}
      </span>

      {hasNextPage && (
        <Button variant="outline" size="sm" onClick={onLoadMore} disabled={isFetching}>
          {isFetching ? 'Loading…' : 'Load more'}
        </Button>
      )}
    </div>
  )
}
