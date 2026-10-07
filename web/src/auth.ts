import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getMe, login, logout } from './api/auth.ts'

// Shared auth state lives in the React Query cache.
export function useAuth() {
  const qc = useQueryClient()

  const me = useQuery({ queryKey: ['me'], queryFn: getMe })

  // Refresh auth state after login.
  const signIn = useMutation({
    mutationFn: login,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  })

  // Refresh auth state after logout.
  const signOut = useMutation({
    mutationFn: logout,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  })

  const authenticated = me.data?.authenticated ?? false
  const writeOpen = me.data?.writeOpen ?? false

  return {
    authenticated,
    loginEnabled: me.data?.loginEnabled ?? false,
    // Mirrors server write access for UI controls.
    canWrite: authenticated || writeOpen,
    ready: me.isSuccess,
    signIn,
    signOut,
  }
}
