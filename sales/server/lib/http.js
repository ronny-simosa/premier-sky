// Shared fetch wrapper: timeout, retry with exponential backoff, structured
// errors. Every external call in the app goes through this.

export class HttpError extends Error {
  constructor(message, { status = null, url = null, cause = null } = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.url = url;
    this.cause = cause;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * fetchJson(url, opts)
 *  - timeoutMs: per-attempt timeout (default 15s)
 *  - retries:   additional attempts after the first (default 2)
 *  - backoffMs: base backoff, doubles each retry (default 800ms)
 * Retries on network errors, timeouts, and 5xx. Does NOT retry 4xx.
 */
export async function fetchJson(url, opts = {}) {
  const { timeoutMs = 15000, retries = 2, backoffMs = 800, headers = {} } = opts;
  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers, signal: controller.signal });
      if (!res.ok) {
        const err = new HttpError(`HTTP ${res.status} from ${new URL(url).host}`, {
          status: res.status,
          url,
        });
        if (res.status >= 500 && attempt < retries) {
          lastErr = err;
          await sleep(backoffMs * 2 ** attempt);
          continue;
        }
        throw err;
      }
      return await res.json();
    } catch (e) {
      if (e instanceof HttpError && e.status && e.status < 500) throw e;
      lastErr =
        e.name === "AbortError"
          ? new HttpError(`Timed out after ${timeoutMs}ms: ${new URL(url).host}`, { url, cause: e })
          : e instanceof HttpError
            ? e
            : new HttpError(`Network error: ${e.message}`, { url, cause: e });
      if (attempt < retries) await sleep(backoffMs * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}
