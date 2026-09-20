import { useState } from 'react'
import { toast } from 'sonner'
import { LogInIcon, LogOutIcon } from 'lucide-react'
import { useAuth } from '@/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

// Sign in / sign out, in the header.
//
// Inline rather than a /login route: there is one field, and a route would mean
// navigating away from whatever you were watching and finding your way back. The
// dashboard never blocks on this — everything is readable signed out.
export default function LoginBar() {
  const { authenticated, loginEnabled, ready, signIn, signOut } = useAuth()
  const [open, setOpen] = useState(false)
  const [password, setPassword] = useState('')

  // Wait for /auth/me rather than flashing "Sign in" and then correcting itself.
  if (!ready) return null

  // No password configured on the server, so there is nothing to sign in to.
  if (!loginEnabled) return null

  if (authenticated) {
    return (
      <Button variant="ghost" size="sm" onClick={() => signOut.mutate()} disabled={signOut.isPending}>
        <LogOutIcon className="h-4 w-4" />
        Sign out
      </Button>
    )
  }

  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <LogInIcon className="h-4 w-4" />
        Sign in
      </Button>
    )
  }

  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        signIn.mutate(password, {
          onSuccess: () => {
            setPassword('')
            setOpen(false)
            toast.success('Signed in')
          },
          // The API distinguishes a wrong password from being throttled; show whichever
          // it said rather than a generic failure.
          onError: (err) => toast.error(err.message),
        })
      }}
    >
      <Input
        type="password"
        placeholder="operator password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="h-8 w-44"
        autoFocus
      />
      <Button type="submit" size="sm" disabled={signIn.isPending || !password}>
        {signIn.isPending ? '…' : 'Go'}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => {
          setOpen(false)
          setPassword('')
          signIn.reset()
        }}
      >
        Cancel
      </Button>
    </form>
  )
}
