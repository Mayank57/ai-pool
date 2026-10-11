// Shared helpers for the admin dashboard and the employee portal.

export const $ = (sel, root = document) => root.querySelector(sel);

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export async function api(path, opts = {}) {
  const method = opts.method || 'GET';
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: method !== 'GET' ? { 'Content-Type': 'application/json' } : {},
      body: method !== 'GET' ? JSON.stringify(opts.body ?? {}) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    throw Object.assign(new Error("Can't reach AI Pool. Check your connection and try again."), { status: 0 });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

export function money(v, digits) {
  const n = Number(v) || 0;
  const d = digits ?? (Math.abs(n) >= 1000 ? 0 : 2);
  return (n < 0 ? '−$' : '$') + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function compact(v) {
  const n = Number(v) || 0;
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (Math.abs(n) >= 1e4) return (n / 1e3).toFixed(0) + 'K';
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}

export function ago(ts) {
  if (!ts) return '—';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export const PROVIDER_LABEL = { claude: 'Claude', codex: 'ChatGPT / Codex' };
export function providerKey(p) {
  return p === 'claude' || p === 'codex' ? p : 'other';
}
export function providerChip(p) {
  const k = providerKey(p);
  return `<span class="prov"><span class="sw" style="background:var(--series-${k})"></span>${esc(PROVIDER_LABEL[p] || p || 'unknown')}</span>`;
}

export function rangeFor(preset) {
  const now = Date.now();
  if (preset === 'mtd') {
    const d = new Date();
    return { from: new Date(d.getFullYear(), d.getMonth(), 1).getTime(), to: now };
  }
  const days = { '24h': 1, '7d': 7, '30d': 30, '90d': 90 }[preset] || 30;
  return { from: now - days * 86400000, to: now };
}

// Inline bar for table rows: one series, one color.
export function inlineBar(value, max) {
  const pct = max > 0 ? Math.max(0, (value / max) * 100) : 0;
  return `<div class="bar" style="width:${pct.toFixed(1)}%"></div>`;
}

export function copyButton(text) {
  return `<button class="btn sm copy" data-copy="${esc(text)}">Copy</button>`;
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-copy]');
  if (!b) return;
  navigator.clipboard.writeText(b.dataset.copy).then(() => {
    const t = b.textContent;
    b.textContent = 'Copied';
    setTimeout(() => (b.textContent = t), 1200);
  });
});

// Stacked column chart of API-equivalent cost per time bucket, by provider.
// rows: [{bucket, provider, api_cost, requests, tokens}], bucketMs, range.
export function stackedChart(el, { rows, bucket_ms: bucketMs }, range) {
  const providers = ['claude', 'codex', 'other'];
  const buckets = new Map();
  // Pre-fill empty buckets (aligned to local midnight / hour like the server) so time reads evenly.
  const offset = ((tzOffsetMs() % bucketMs) + bucketMs) % bucketMs;
  const start = Math.floor((range.from - offset) / bucketMs) * bucketMs + offset;
  for (let t = start; t < range.to; t += bucketMs) buckets.set(t, { t, claude: 0, codex: 0, other: 0, requests: 0, tokens: 0 });
  for (const r of rows) {
    const b = buckets.get(r.bucket) || buckets.set(r.bucket, { t: r.bucket, claude: 0, codex: 0, other: 0, requests: 0, tokens: 0 }).get(r.bucket);
    b[providerKey(r.provider)] += r.api_cost || 0;
    b.requests += r.requests;
    b.tokens += r.tokens || 0;
  }
  const data = [...buckets.values()].sort((a, b) => a.t - b.t);
  const present = providers.filter((p) => data.some((d) => d[p] > 0));
  const legend = (present.length ? present : ['claude', 'codex'])
    .map((p) => `<span><span class="sw" style="background:var(--series-${p})"></span>${p === 'other' ? 'Other' : PROVIDER_LABEL[p]}</span>`)
    .join('');

  const W = Math.max(el.clientWidth || 600, 280);
  const H = 260;
  const m = { l: 52, r: 8, t: 8, b: 24 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const max = Math.max(...data.map((d) => d.claude + d.codex + d.other), 0);
  const niceMax = niceCeil(max || 1);
  const step = iw / Math.max(data.length, 1);
  const bw = Math.max(Math.min(step - 2, 28), 1);
  const y = (v) => m.t + ih - (v / niceMax) * ih;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * niceMax);
  const hourly = bucketMs < 86400000;
  const fmtT = (t) =>
    hourly
      ? new Date(t).toLocaleTimeString(undefined, { hour: 'numeric' })
      : new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const labelEvery = Math.ceil(data.length / Math.max(Math.floor(iw / 64), 1));

  let svg = `<g class="grid">${ticks.map((v) => `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/>`).join('')}</g>`;
  // Tick precision follows the axis scale, so sub-dollar charts don't read "$0.00" on every line.
  const tickDigits = niceMax >= 20 ? 0 : niceMax >= 1 ? 1 : niceMax >= 0.05 ? 2 : 3;
  svg += ticks.map((v) => `<text x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">${money(v, tickDigits)}</text>`).join('');
  data.forEach((d, i) => {
    const x = m.l + i * step + (step - bw) / 2;
    let acc = 0;
    let segs = '';
    const stack = providers.filter((p) => d[p] > 0);
    stack.forEach((p, j) => {
      const y0 = y(acc);
      acc += d[p];
      const y1 = y(acc);
      const top = j === stack.length - 1;
      const h = Math.max(y0 - y1 - (top ? 0 : 2), 0.5); // 2px surface gap between segments
      segs += top
        ? `<path d="${roundTop(x, y1, bw, h, Math.min(4, bw / 2, h))}" fill="var(--series-${p})"/>`
        : `<rect x="${x}" y="${y1 + 2}" width="${bw}" height="${h}" fill="var(--series-${p})"/>`;
    });
    svg += `<g class="col" data-i="${i}"><rect class="hit" x="${m.l + i * step}" y="${m.t}" width="${step}" height="${ih}"/>${segs}</g>`;
    if (i % labelEvery === 0) svg += `<text x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${fmtT(d.t)}</text>`;
  });
  svg += `<line class="baseline" x1="${m.l}" x2="${W - m.r}" y1="${y(0)}" y2="${y(0)}"/>`;

  el.innerHTML = `<div class="legend">${legend}</div><div class="chart-wrap"><svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="API-equivalent cost over time by provider">${svg}</svg><div class="tooltip hidden"></div></div>`;
  const tip = el.querySelector('.tooltip');
  const wrap = el.querySelector('.chart-wrap');
  el.querySelectorAll('g.col').forEach((g) => {
    g.addEventListener('mousemove', (e) => {
      const d = data[+g.dataset.i];
      const total = d.claude + d.codex + d.other;
      tip.innerHTML =
        `<div style="font-weight:600;margin-bottom:4px">${hourly ? new Date(d.t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' }) : new Date(d.t).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</div>` +
        providers
          .filter((p) => d[p] > 0)
          .map((p) => `<div class="r"><span><span class="sw" style="display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px;background:var(--series-${p})"></span>${p === 'other' ? 'Other' : PROVIDER_LABEL[p]}</span><span class="num">${money(d[p])}</span></div>`)
          .join('') +
        `<div class="r" style="margin-top:4px;border-top:1px solid var(--grid);padding-top:4px"><span>Total</span><span class="num">${money(total)}</span></div>` +
        `<div class="r muted"><span>${d.requests} requests</span><span>${compact(d.tokens)} tokens</span></div>`;
      tip.classList.remove('hidden');
      const r = wrap.getBoundingClientRect();
      let left = e.clientX - r.left + 14;
      if (left + 200 > r.width) left = e.clientX - r.left - 200;
      tip.style.left = `${Math.max(0, left)}px`;
      tip.style.top = `${Math.max(0, e.clientY - r.top - 20)}px`;
    });
    g.addEventListener('mouseleave', () => tip.classList.add('hidden'));
  });
}

export function tzOffsetMs() {
  return new Date().getTimezoneOffset() * 60000;
}

function roundTop(x, y, w, h, r) {
  return `M${x},${y + h} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h} Z`;
}

function niceCeil(v) {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const f of [1, 2, 2.5, 5, 10]) if (f * p >= v) return f * p;
  return 10 * p;
}

export function until(ts) {
  if (!ts) return '—';
  const s = Math.round((ts - Date.now()) / 1000);
  if (s <= 0) return 'now';
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

export function pct(v) {
  return v == null ? '—' : `${Math.round(v * 100)}%`;
}

export function codeBlock(text) {
  return `<pre class="code">${copyButton(text)}${esc(text)}</pre>`;
}

let toastTimer;
export function toast(msg, kind = 'ok') {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:50;max-width:min(560px,calc(100vw - 32px))';
    document.body.appendChild(el);
  }
  el.innerHTML = `<div class="notice ${kind}" style="box-shadow:0 10px 30px rgba(0,0,0,.18)">${esc(msg)}</div>`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.innerHTML = ''), 4000);
}
