const URL_RE = /https?:\/\/[^\s<>"'）】，。；：！？、]+/g;
const MD_URL_RE = /\]\((https?:\/\/[^)\s]+)\)/g;
const TRAILING = /[.,;:!?，。；：！？、）】》]+$/;

/** 从 Markdown 的“参考链接”章节提取外链；返回 Map<url, Set<pagePath>>。 */
export function extractReferenceLinks(markdown, pagePath = '') {
  const lines = String(markdown || '').split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s+参考链接\s*$/.test(line.trim()));
  if (start < 0) return new Map();
  const result = new Map();
  const add = (raw) => {
    const url = raw.replace(TRAILING, '');
    if (!result.has(url)) result.set(url, new Set());
    if (pagePath) result.get(url).add(pagePath);
  };
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) break;
    const line = lines[i];
    let rest = line;
    for (const match of line.matchAll(MD_URL_RE)) {
      add(match[1]);
      rest = rest.replace(match[0], ' ');
    }
    for (const match of rest.matchAll(URL_RE)) add(match[0]);
  }
  return result;
}

/** 合并多个页面的外链，返回 Map<url, Set<pagePath>>。 */
export function mergeReferenceLinks(pageMarkdowns) {
  const merged = new Map();
  for (const [pagePath, markdown] of Object.entries(pageMarkdowns)) {
    for (const [url, pages] of extractReferenceLinks(markdown, pagePath)) {
      if (!merged.has(url)) merged.set(url, new Set());
      for (const page of pages) merged.get(url).add(page);
    }
  }
  return merged;
}

async function probe(url, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const headers = { 'user-agent': 'command-hub-link-check/1.0 (+https://www.dos2unix.cn)' };
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'HEAD',
      redirect: 'follow',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    response = null;
  }
  if (!response || response.status === 405 || response.status === 403 || response.status === 501) {
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'follow',
        headers: { ...headers, range: 'bytes=0-0' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      return { ok: false, status: null, error: error?.name || 'fetch failed' };
    }
  }
  const status = response.status;
  return { ok: status >= 200 && status < 400, status, error: null };
}

/** 并发检查外链；返回 [{url, pages, ok, status, error}]。 */
export async function checkExternalLinks(entries, options = {}) {
  const { concurrency = 12, timeoutMs = 8000, fetchImpl = fetch } = options;
  const list = entries instanceof Map ? [...entries.entries()] : entries;
  const results = new Array(list.length);
  let cursor = 0;

  async function worker() {
    while (cursor < list.length) {
      const index = cursor++;
      const [url, pages] = list[index];
      const probeResult = await probe(url, { fetchImpl, timeoutMs });
      results[index] = {
        url,
        pages: [...(pages || [])].sort(),
        ...probeResult,
      };
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(1, list.length)) }, () => worker())
  );
  return results;
}
