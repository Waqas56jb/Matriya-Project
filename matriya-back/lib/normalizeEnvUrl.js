/**
 * Normalize API base URLs from env (Vercel / .env). Users sometimes paste the full line
 * "MANAGEMENT_BACK_URL=https://host" into the value field, or duplicate keys inside the URL,
 * producing ENOTFOUND for hostnames like "management_back_url=https".
 */

const LINE_PREFIX_KEYS = [
  'MANAGEMENT_BACK_URL',
  'MATRIYA_MANAGEMENT_BACK_URL',
  'MATRIYA_MANAGEMENT_API_URL',
  'management_back_url',
];

function stripAccidentalEnvLinePrefix(s) {
  let t = String(s ?? '').trim();
  for (let k = 0; k < 4 && t; k++) {
    let changed = false;
    for (const key of LINE_PREFIX_KEYS) {
      const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*`, 'i');
      const next = t.replace(re, '').trim();
      if (next !== t) {
        t = next;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return t;
}

function salvageLastValidHttpBase(s) {
  const hits = [];
  const lower = s.toLowerCase();
  for (let i = 0; i < s.length; i++) {
    if (lower.slice(i, i + 8) === 'https://' || lower.slice(i, i + 7) === 'http://') {
      let j = i;
      while (j < s.length && !/[\s"'<>]/.test(s[j])) j++;
      const cand = s.slice(i, j).replace(/\/$/, '');
      try {
        const p = new URL(cand);
        if (p.hostname && !p.hostname.includes('=') && /^https?:$/i.test(p.protocol)) {
          hits.push(cand.replace(/\/$/, ''));
        }
      } catch {
        /* skip */
      }
    }
  }
  return hits.length ? hits[hits.length - 1] : '';
}

/**
 * @param {string} raw - raw env value
 * @returns {string} normalized base URL or '' if invalid / empty
 */
export function normalizeHttpServiceBaseUrl(raw) {
  let u = stripAccidentalEnvLinePrefix(String(raw ?? '').trim());
  if (!u) return '';
  if ((u.startsWith('"') && u.endsWith('"')) || (u.startsWith("'") && u.endsWith("'"))) {
    u = u.slice(1, -1).trim();
  }
  u = stripAccidentalEnvLinePrefix(u);

  const salvaged = salvageLastValidHttpBase(u);
  if (salvaged) u = salvaged;

  u = u.replace(/\/$/, '');
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) {
    const isLoopback = /^localhost\b/i.test(u) || /^127\.0\.0\.1\b/.test(u);
    u = `${isLoopback ? 'http' : 'https'}://${u.replace(/^\/+/, '')}`;
  }
  try {
    const parsed = new URL(u);
    if (!parsed.hostname || parsed.hostname.includes('=')) return '';
  } catch {
    return '';
  }
  return u.replace(/\/$/, '');
}
