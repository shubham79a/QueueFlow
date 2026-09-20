import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { listJobs } from '@/api/jobs'
import { getHealth } from '@/api/health'
import type { JobStatus } from '@/types'

const PAGE_SIZE = 50
const REFRESH_MS = 2000

/**
 * A paged, self-refreshing list of jobs. Shared by the Jobs page and the DLQ, which
 * differ only in whether a status filter is set.
 *
 * useInfiniteQuery rather than useQuery because the answer is several pages rather
 * than one. It keeps them as a list of pages and, on each refetch, re-fetches every
 * loaded page in order — recomputing each cursor from the page before it. So a job
 * moving from `running` to `dead` three pages down still updates, and rows shifting
 * between pages stays coherent.
 *
 * New jobs land at the top because page one is fetched with no cursor, which always
 * means "the newest N".
 */
export function useJobList(status: JobStatus | '' = '') {
  const query = useInfiniteQuery({
    // The status is part of the key, so switching the filter is a separate cached
    // list — flipping back shows the old rows instantly while fresh ones load.
    queryKey: ['jobs', status],
    queryFn: ({ pageParam }) => listJobs(status, pageParam, PAGE_SIZE),
    // undefined means "no cursor", which the API reads as "start at the newest".
    initialPageParam: undefined as string | undefined,
    // Returning undefined is how hasNextPage becomes false. The server sends null
    // once the page it just returned was the last one.
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: REFRESH_MS,
  })

  /**
   * How many there are in total, for "showing 50 of 321".
   *
   * Taken from the health endpoint's status tally rather than a COUNT(*) of its own:
   * that query already runs for the stat cards, and a count on every poll of every
   * open tab is exactly the thing keyset pagination was chosen to avoid.
   *
   * It is therefore a count of ROWS BY STATUS, which is what both callers want — the
   * DLQ wants dead, the unfiltered list wants everything.
   */
  const health = useQuery({ queryKey: ['health'], queryFn: getHealth, refetchInterval: 5000 })
  const tally = health.data?.jobs
  const total = tally
    ? status
      ? (tally[status] ?? 0)
      : Object.values(tally).reduce((a, b) => a + b, 0)
    : undefined

  return {
    // pages is an array of pages, not a flat list. Keeping them separate is what lets
    // a refetch replace page one without discarding pages two and three.
    rows: query.data?.pages.flatMap((p) => p.jobs) ?? [],
    total,
    isPending: query.isPending,
    isError: query.isError,
    error: query.error,
    hasNextPage: query.hasNextPage,
    fetchNextPage: query.fetchNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
  }
}
