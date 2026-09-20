import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ThemeProvider } from 'next-themes'
import { Toaster } from '@/components/ui/sonner'
import './index.css'
import App from './App.tsx'

// One QueryClient for the whole app. Every useQuery below shares its cache, so two
// components asking for the same thing make one request.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A dashboard should not go stale-and-silent when a request fails once.
      retry: 1,
      // Don't refetch just because the user clicked back into the tab — the polling
      // interval on each query already keeps things current.
      refetchOnWindowFocus: false,
    },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* next-themes despite the name — it is plain React, and it is what the shadcn
        Toaster reads its theme from. attribute="class" puts .dark on <html>, which is
        what the @custom-variant in index.css keys off. */}
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
          <Toaster />
        </BrowserRouter>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
)
