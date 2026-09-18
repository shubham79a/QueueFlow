import { useState } from 'react'
import { useAuth } from '../auth.ts'

// Sign in / sign out, in the header.
//
// Inline rather than a /login route: there is one field, and a route would mean navigating
// away from whatever you were watching and finding your way back. The dashboard never
// blocks on this — everything is readable signed out.
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
      <div className="loginbar">
        <span className="muted">signed in</span>
        <button onClick={() => signOut.mutate()} disabled={signOut.isPending}>
          Sign out
        </button>
      </div>
    )
  }

  if (!open) {
    return (
      <div className="loginbar">
        <button onClick={() => setOpen(true)}>Sign in</button>
      </div>
    )
  }

  return (
    <form
      className="loginbar"
      onSubmit={(e) => {
        e.preventDefault()
        signIn.mutate(password, {
          onSuccess: () => {
            setPassword('')
            setOpen(false)
          },
        })
      }}
    >
      <input
        type="password"
        placeholder="operator password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoFocus
      />
      <button type="submit" disabled={signIn.isPending || !password}>
        {signIn.isPending ? '…' : 'Go'}
      </button>
      <button
        type="button"
        onClick={() => {
          setOpen(false)
          setPassword('')
          signIn.reset()
        }}
      >
        Cancel
      </button>
      {signIn.isError && <span className="error">{signIn.error.message}</span>}
    </form>
  )
}
