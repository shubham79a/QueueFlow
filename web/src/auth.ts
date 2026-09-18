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

  return {
    authenticated: me.data?.authenticated ?? false,
    loginEnabled: me.data?.loginEnabled ?? false,
    ready: me.isSuccess,
    signIn,
    signOut,
  }
}
