import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getMe, login, logout } from './api/auth.ts'

// Auth state, without a context provider.
//
// The query cache is already shared across the whole app, so ['me'] IS the shared state —
// every component calling useAuth() reads the same cached answer and re-renders together
// when it changes. A provider would be a second copy of something React Query already has.
export function useAuth() {
  const qc = useQueryClient()

  const me = useQuery({ queryKey: ['me'], queryFn: getMe })

  // On success, invalidate ['me'] so the header re-reads the new state. Feature 5's
  // buttons will read the same flag.
  const signIn = useMutation({
    mutationFn: login,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  })

  const signOut = useMutation({
    mutationFn: logout,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  })

  const authenticated = me.data?.authenticated ?? false
  const writeOpen = me.data?.writeOpen ?? false

  return {
    authenticated,
    loginEnabled: me.data?.loginEnabled ?? false,
    // What the action buttons check. Mirrors requireWrite on the server: a session,
    // or a server with no auth configured at all. (An API key is the third way in,
    // but a browser never holds one.)
    canWrite: authenticated || writeOpen,
    ready: me.isSuccess,
    signIn,
    signOut,
  }
}
