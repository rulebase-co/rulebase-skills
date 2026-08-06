/**
 * Minimal HTTP helpers. Zero dependencies: this runs via npx in someone else's
 * project, so an install step is a reason for it not to run.
 */

const DEFAULT_TIMEOUT_MS = 15000;

/**
 * Returns a result object rather than throwing, because every caller here wants
 * to report a failure rather than crash on one — a doctor that dies on the first
 * unreachable host is useless.
 */
export async function probe(url, { headers = {}, method = 'GET', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { 'User-Agent': 'rulebase-cli', ...headers },
      signal: controller.signal,
      redirect: 'manual',
    });
    const text = await res.text().catch(() => '');
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON bodies are reported as text */
    }
    return { ok: true, status: res.status, body: text.slice(0, 400), json, headers: res.headers };
  } catch (err) {
    const reason = err?.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : String(err?.message || err);
    return { ok: false, status: null, error: reason };
  } finally {
    clearTimeout(timer);
  }
}

export const bearer = (key) => ({ Authorization: `Bearer ${key}`, Accept: 'application/json' });
