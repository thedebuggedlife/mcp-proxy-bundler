import { CookieJar } from 'tough-cookie'
import { createTestHttp, undiciFetch, type TestHttp } from './http-client.ts'

// A manual-redirect fetch with a shared tough-cookie jar, layered over the
// Phase 7 test agent (alias 'authelia.test' -> 127.0.0.1 + test CA). The
// Tier-2 OAuth flow bounces between the proxy (http://localhost:8080) and
// Authelia (https://authelia.test:9091), each setting its own cookies, so the
// jar must persist Set-Cookie across origins and the caller must inspect each
// 3xx Location to drive the flow. We therefore disable automatic redirects.

export interface CookieFetch {
  /** Single request: applies jar cookies, never auto-follows redirects. */
  fetch: (
    url: string,
    init?: Parameters<typeof undiciFetch>[1],
  ) => ReturnType<typeof undiciFetch>
  /** Follows 3xx hops (up to maxHops), stopping at the first non-3xx or a
   *  Location whose URL matches `stopWhen`. Returns the final response and its
   *  URL. Used to walk the proxy<->Authelia redirect chain. */
  follow: (
    startUrl: string,
    opts?: {
      maxHops?: number
      stopWhen?: (url: URL) => boolean
      init?: Parameters<typeof undiciFetch>[1]
    },
  ) => Promise<{ response: Awaited<ReturnType<typeof undiciFetch>>; url: string }>
  jar: CookieJar
  close: () => Promise<void>
}

export function createCookieFetch(): CookieFetch {
  const http: TestHttp = createTestHttp()
  const jar = new CookieJar()

  const fetch: CookieFetch['fetch'] = async (url, init) => {
    const cookieHeader = await jar.getCookieString(url)
    // Normalize the caller's headers into a plain record to sidestep the
    // undici-types vs global Headers clash, then layer in the jar's cookies.
    const headers: Record<string, string> = {}
    const provided = init?.headers
    if (provided) {
      if (Array.isArray(provided)) {
        for (const [k, v] of provided) headers[k] = v
      } else if (typeof (provided as Headers).forEach === 'function') {
        ;(provided as Headers).forEach((v, k) => {
          headers[k] = v
        })
      } else {
        Object.assign(headers, provided as Record<string, string>)
      }
    }
    if (cookieHeader) headers.cookie = cookieHeader
    const res = await http.fetch(url, {
      ...init,
      headers,
      redirect: 'manual',
    })
    // tough-cookie's setCookie wants one cookie per call; undici exposes the
    // raw per-header values via getSetCookie().
    const setCookies = res.headers.getSetCookie?.() ?? []
    for (const sc of setCookies) {
      await jar.setCookie(sc, url, { ignoreError: true })
    }
    return res
  }

  const follow: CookieFetch['follow'] = async (startUrl, opts) => {
    const maxHops = opts?.maxHops ?? 12
    let currentUrl = startUrl
    let response = await fetch(currentUrl, opts?.init)
    for (let hop = 0; hop < maxHops; hop++) {
      if (response.status < 300 || response.status >= 400) break
      const location = response.headers.get('location')
      if (!location) break
      const next = new URL(location, currentUrl)
      if (opts?.stopWhen?.(next)) {
        currentUrl = next.toString()
        break
      }
      currentUrl = next.toString()
      // A 303 (and conventionally 302 after a POST) becomes a GET; the proxy
      // and Authelia only emit redirect-to-GET hops in this flow.
      response = await fetch(currentUrl)
    }
    return { response, url: currentUrl }
  }

  return { fetch, follow, jar, close: () => http.close() }
}
