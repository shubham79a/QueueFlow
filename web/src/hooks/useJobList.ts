import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { listJobs } from '@/api/jobs'
import { getHealth } from '@/api/health'
import type { JobStatus } from '@/types'

const PAGE_SIZE = 50
const REFRESH_MS = 2000

// Fetch paginated jobs with automatic refresh.
export function useJobList(status: JobStatus | '' = '') {
  const query = useInfiniteQuery({
    // Keep filtered and unfiltered lists in separate caches.
    queryKey: ['jobs', status],
    queryFn: ({ pageParam }) => listJobs(status, pageParam, PAGE_SIZE),
    // Start with the newest jobs.
    initialPageParam: undefined as string | undefined,
    // Continue until the server returns no next cursor.
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    // Refresh the loaded pages every 2 seconds.
    refetchInterval: REFRESH_MS,
  })

  // Use health status counts for the total instead of an extra COUNT query.
  const health = useQuery({ queryKey: ['health'], queryFn: getHealth, refetchInterval: 5000 })
  const tally = health.data?.jobs
  const total = tally
    ? status
      ? (tally[status] ?? 0)
      : Object.values(tally).reduce((a, b) => a + b, 0)
    : undefined

  return {
    // Flatten the loaded pages into rows for the UI.
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
