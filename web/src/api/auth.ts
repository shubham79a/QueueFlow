import { apiFetch } from './client.ts'

export interface Me {
  authenticated: boolean
  // False when no ADMIN_PASSWORD is configured — the UI then offers no Sign in at all,
  // rather than a button that cannot work.
  loginEnabled: boolean
}

export function getMe(): Promise<Me> {
  return apiFetch<Me>('/auth/me')
}

// A wrong password comes back 401, which apiFetch turns into an ApiError carrying the
// API's message — so the form can show "wrong password" rather than a status code.
export function login(password: string): Promise<{ ok: true }> {
  return apiFetch('/auth/login', { method: 'POST', body: JSON.stringify({ password }) })
}

export function logout(): Promise<{ ok: true }> {
  return apiFetch('/auth/logout', { method: 'POST' })
}
