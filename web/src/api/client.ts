// One place that knows the API lives under /api and speaks JSON.
//
// Relative URL on purpose: in dev Vite proxies /api to :4000, in prod Express serves
// both the UI and the API from one origin. Either way the browser never needs to know
// where the API actually is.

export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })

  if (!res.ok) {
    // The API always answers errors as { error: "..." }. Surface that message rather
    // than a bare status code, so the UI can show what actually went wrong.
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new ApiError(res.status, body.error ?? res.statusText)
  }

  return res.json() as Promise<T>
}
