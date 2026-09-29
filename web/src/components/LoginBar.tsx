import { useState } from 'react'
import { toast } from 'sonner'
import { LogInIcon, LogOutIcon } from 'lucide-react'
import { useAuth } from '@/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'

// Sign in / sign out.
//
// A DIALOG RATHER THAN A ROUTE, still: there is one field, and /login would mean
// navigating away from whatever you were watching and finding your way back. The
// dashboard never blocks on this — everything is readable signed out.
//
// It used to expand in place, turning the header into a password field, a Go button
// and a Cancel button squeezed beside the health dots. That worked at desk width and
// fell apart on a phone, where the header already wraps to two rows. A dialog is the
// same idea with somewhere to put itself.
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
      <Button
        variant="ghost"
        size="sm"
        onClick={() => signOut.mutate()}
        disabled={signOut.isPending}
      >
        <LogOutIcon className="h-4 w-4" />
        Sign out
      </Button>
    )
  }

  function close(next: boolean) {
    setOpen(next)
    if (!next) {
      // Clear on the way out rather than the way in, so a password is never left
      // sitting in state behind a closed dialog. reset() clears a previous error too,
      // which would otherwise still be showing when it reopens.
      setPassword('')
      signIn.reset()
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <LogInIcon className="h-4 w-4" />
          Sign in
        </Button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Sign in</DialogTitle>
          <DialogDescription>
            Reading is open to everyone. Signing in unlocks the two actions that write —
            creating a job and replaying a dead one.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault()
            signIn.mutate(password, {
              onSuccess: () => {
                close(false)
                toast.success('Signed in')
              },
              // The API distinguishes a wrong password from being throttled; show
              // whichever it said rather than a generic failure.
              onError: (err) => toast.error(err.message),
            })
          }}
        >
          {/* space-y-2.5 rather than the 1.5 used in dense inline forms. In a dialog
              the label and its field are the only thing on the line, and 6px between
              them reads as the label sitting on top of the box rather than belonging
              to it. */}
          <div className="space-y-2.5">
            <Label htmlFor="operator-password">Operator password</Label>
            <Input
              id="operator-password"
              type="password"
              // The label already says what this is; repeating it in the placeholder
              // just puts the same words twice on two adjacent lines.
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={signIn.isPending || !password}>
              {signIn.isPending ? 'Signing in…' : 'Sign in'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
