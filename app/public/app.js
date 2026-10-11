import { $, api, esc, money, compact, ago, until, pct, providerChip, rangeFor, inlineBar, stackedChart, tzOffsetMs, copyButton, codeBlock, toast, PROVIDER_LABEL } from './common.js';

const S = { me: null, workspaces: [], wsId: null, role: null, page: 'overview', preset: store('range') || '30d', publicUrl: location.origin };
const isAdmin = () => S.role === 'owner' || S.role === 'admin';
const W = (p) => `/api/w/${S.wsId}${p}`;

function store(k, v) {
  try {
    if (v === undefined) return localStorage.getItem('aipool.' + k);
    localStorage.setItem('aipool.' + k, v);
  } catch {}
  return null;
}

const PAGES = {
  overview: { title: 'Overview', range: true },
  capacity: { title: 'Capacity' },
  keys: { title: 'Keys', range: true },
  plans: { title: 'Plans', range: true },
  members: { title: 'Members', range: true, admin: true },
  usage: { title: 'Activity' },
  setup: { title: 'Connect your tools' },
  billing: { title: 'Billing' },
  settings: { title: 'Settings', admin: true },
  account: { title: 'Your account', hidden: true },
};
const ICON = { overview: '◧', capacity: '◔', keys: '⚿', plans: '▤', members: '☺', usage: '≣', setup: '⌘', billing: '$', settings: '⚙', account: '◉' };

// ---------- modal ----------

function modal(html, { wide = false } = {}) {
  const d = $('#modal');
  d.style.width = wide ? 'min(720px, calc(100vw - 32px))' : '';
  d.innerHTML = html;
  if (!d.open) d.showModal();
  d.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => d.close()));
  return d;
}
function confirmBox(title, text, okLabel = 'Confirm', danger = false) {
  return new Promise((resolve) => {
    const d = modal(`<h3>${esc(title)}</h3><p class="ink2">${text}</p><div class="actions"><button class="btn" data-close>Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" id="ok">${esc(okLabel)}</button></div>`);
    d.querySelector('#ok').onclick = () => {
      d.close();
      resolve(true);
    };
    d.addEventListener('close', () => resolve(false), { once: true });
  });
}

// ---------- boot & routing ----------

async function boot() {
  try {
    const me = await api('/api/me');
    S.me = me.user;
    S.workspaces = me.workspaces;
    S.publicUrl = me.public_url || location.origin;
  } catch (err) {
    if (err.status === 401) return (location.href = 'login');
    throw err;
  }
  if (!S.workspaces.length) return renderNoWorkspace();
  window.addEventListener('hashchange', route);
  route();
}

function route() {
  if ($('#modal').open) $('#modal').close();
  const m = location.hash.match(/^#\/w\/(\d+)\/?([a-z]*)/);
  const fallback = Number(store('ws')) || S.workspaces[0].id;
  let wsId = m ? Number(m[1]) : fallback;
  if (!S.workspaces.some((w) => w.id === wsId)) wsId = S.workspaces[0].id;
  let page = (m && m[2]) || 'overview';
  const ws = S.workspaces.find((w) => w.id === wsId);
  S.wsId = wsId;
  S.role = ws.role;
  store('ws', wsId);
  if (!PAGES[page] || (PAGES[page].admin && !isAdmin())) page = 'overview';
  S.page = page;
  const want = `#/w/${wsId}/${page}`;
  if (location.hash !== want) history.replaceState(null, '', want);
  renderShell();
  render();
}

const go = (page) => (location.hash = `#/w/${S.wsId}/${page}`);

function renderShell() {
  const sw = $('#ws-switch');
  sw.innerHTML = S.workspaces.map((w) => `<option value="${w.id}"${w.id === S.wsId ? ' selected' : ''}>${esc(w.name)}</option>`).join('') + '<option value="new">+ New workspace…</option>';
  sw.onchange = () => {
    if (sw.value === 'new') return newWorkspace();
    location.hash = `#/w/${sw.value}/overview`;
  };
  const items = Object.entries(PAGES).filter(([, p]) => !p.hidden && (!p.admin || isAdmin()));
  const link = (k, p) => `<a class="nav${k === S.page ? ' active' : ''}" href="#/w/${S.wsId}/${k}"><span style="width:16px;text-align:center;opacity:.7">${ICON[k]}</span>${p.title}</a>`;
  $('#nav').innerHTML = items.map(([k, p]) => link(k, p)).join('');
  $('#mnav').innerHTML = items.map(([k, p]) => `<a class="${k === S.page ? 'active' : ''}" href="#/w/${S.wsId}/${k}">${p.title}</a>`).join('');
  $('#me').innerHTML = `<a href="#/w/${S.wsId}/account" style="color:inherit;text-decoration:none"><div class="row" style="gap:6px"><span style="font-weight:600">${esc(S.me.name)}</span><span class="tag">${esc(S.role)}</span></div><div class="muted small">${esc(S.me.email)}</div></a><div class="row" style="margin-top:8px;gap:4px"><a class="btn ghost sm" href="#/w/${S.wsId}/account">Account</a><span class="spacer"></span><button class="btn ghost sm" id="logout">Log out</button></div>`;
  $('#logout').onclick = async () => {
    await api('/api/auth/logout', { method: 'POST' });
    location.href = './';
  };
  $('#page-title').textContent = PAGES[S.page].title;
  $('#range').classList.toggle('hidden', !PAGES[S.page].range);
  document.querySelectorAll('#range button').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.r === S.preset));
    b.onclick = () => {
      S.preset = b.dataset.r;
      store('range', S.preset);
      renderShell();
      render();
    };
  });
  document.title = `${PAGES[S.page].title} · ${S.workspaces.find((w) => w.id === S.wsId).name} · AI Pool`;
}

async function render() {
  const el = $('#content');
  try {
    await VIEWS[S.page](el);
  } catch (err) {
    if (err.status === 401) return (location.href = 'login');
    el.innerHTML = `<div class="notice err">${esc(err.message)}</div>`;
  }
  renderBanner();
}

let billingCache = null;
async function renderBanner() {
  try {
    billingCache = await api(W('/billing'));
  } catch {
    return;
  }
  const b = billingCache;
  const el = $('#banner');
  if (b.status === 'active') return (el.innerHTML = '');
  const owner = S.role === 'owner';
  if (b.trial_expired || b.status === 'canceled') {
    el.innerHTML = `<div class="banner err"><span><b>${b.status === 'canceled' ? 'Workspace canceled.' : 'Trial ended.'}</b> Keys are paused until billing is activated.${owner ? '' : ' Ask the workspace owner to activate it.'}</span>${owner ? `<a href="#/w/${S.wsId}/billing">Activate now →</a>` : ''}</div>`;
  } else {
    el.innerHTML = `<div class="banner"><span>Free trial: <b>${b.trial_days_left} day${b.trial_days_left === 1 ? '' : 's'} left</b>.</span>${owner ? `<a href="#/w/${S.wsId}/billing">Activate plan →</a>` : ''}</div>`;
  }
}

function renderNoWorkspace() {
  document.querySelector('.shell').innerHTML = `<div class="auth-shell"><div class="auth-card card"><h1>No workspace yet</h1><p class="ink2">Create a workspace, or open an invite link from your admin.</p><button class="btn primary" id="nw">Create workspace</button></div></div>`;
  $('#nw').onclick = newWorkspace;
}

function newWorkspace() {
  const d = modal(`<h3>New workspace</h3><p class="ink2 small">Each workspace has its own plans, keys, members and billing.</p>
    <label class="field"><span>Name</span><input type="text" id="wsname" placeholder="e.g. Acme Engineering" /></label>
    <div class="actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="create">Create</button></div>`);
  d.querySelector('#wsname').focus();
  d.querySelector('#create').onclick = async () => {
    try {
      const r = await api('/api/workspaces', { method: 'POST', body: { name: d.querySelector('#wsname').value } });
      location.href = `app#/w/${r.id}/overview`;
      location.reload();
    } catch (err) {
      toast(err.message, 'err');
    }
  };
  d.addEventListener('close', () => renderShell(), { once: true });
}

function q() {
  const r = rangeFor(S.preset);
  S.range = r;
  return `from=${r.from}&to=${r.to}&tz=${tzOffsetMs() / 60000}`;
}

// ---------- shared bits ----------

function planName(plans, key) {
  return key && plans?.[key] ? plans[key].label : key || '—';
}
function statePill(state, msg) {
  const map = { ready: ['good-mark', 'Ready'], cooling: ['warning-mark', 'Cooling down'], paused: ['muted', 'Paused'], error: ['critical-mark', 'Error'] };
  const [c, l] = map[state] || map.ready;
  return `<span class="pill" title="${esc(msg || '')}"><span class="dot" style="background:var(--${c})"></span>${l}</span>`;
}
function accountState(a) {
  if (a.disabled) return 'paused';
  if (a.unavailable || (a.next_retry_after && Date.parse(a.next_retry_after) > Date.now())) return 'cooling';
  if (a.status && !['active', 'pending'].includes(a.status)) return 'error';
  return 'ready';
}

// ---------- overview ----------

async function viewOverview(el) {
  const d = await api(W(`/overview?${q()}`));
  const s = d.summary;
  const remaining = d.onboarding.filter((x) => !x.done && !x.optional);
  const actions = {
    plan: `<button class="btn sm primary" data-act="plan">Connect</button>`,
    key: `<button class="btn sm primary" data-act="key">Create key</button>`,
    invite: `<button class="btn sm primary" data-act="invite">Invite</button>`,
    setup: `<button class="btn sm" data-act="setup">Show me how</button>`,
    billing: `<button class="btn sm" data-act="billing">Review</button>`,
  };
  const checklist = `<div class="card"><h2>${isAdmin() ? 'Get your workspace ready' : `Welcome to ${esc(d.workspace.name)}`}</h2>
    <p class="sub">${isAdmin() ? 'Five steps from zero to a working pool. You can come back to any of them later.' : 'Three quick steps and your tools run on the team pool.'}</p>
    <div class="checklist">${d.onboarding
      .map((x, i) => `<div class="check-item${x.done ? ' done' : ''}"><span class="tick">${x.done ? '✓' : i + 1}</span><span class="what">${esc(x.label)}${x.optional ? ' <span class="muted small">(optional)</span>' : ''}${!isAdmin() && x.id === 'plan' && !x.done ? '<div class="muted small" style="text-decoration:none">Already pay for Claude or ChatGPT? Connect it as private: you use it first, and the team pool covers you when it runs out.</div>' : ''}</span>${x.done ? '' : actions[x.id] || ''}</div>`)
      .join('')}</div></div>`;

  const INSIGHT = { save: ['good-mark', 'Save money'], capacity: ['warning-mark', 'Capacity'], hygiene: ['muted', 'Housekeeping'], good: ['accent', 'Working well'] };
  const insightsCard =
    isAdmin() && (d.insights || []).length
      ? `<div class="card"><h2>Insights</h2><p class="sub">What the numbers suggest for this period. Recommendations use API list prices and your plan prices from Settings.</p>
        <div class="checklist">${d.insights
          .map(
            (i) => `<div class="check-item" style="align-items:flex-start"><span class="pill" style="flex:none;margin-top:2px"><span class="dot" style="background:var(--${INSIGHT[i.kind][0]})"></span>${INSIGHT[i.kind][1]}</span>
              <span class="what"><b>${esc(i.title)}</b><div class="ink2 small">${esc(i.detail)}</div></span>
              ${i.impact_monthly > 0 ? `<span class="num" style="color:var(--good);font-weight:650;white-space:nowrap">${money(i.impact_monthly, 0)}/mo</span>` : ''}
              ${i.page ? `<a class="btn sm" href="#/w/${S.wsId}/${i.page}">Open</a>` : ''}</div>`,
          )
          .join('')}</div></div>`
      : '';

  const kpis = s.collecting && isAdmin()
    ? `<div class="card"><h2>Collecting data</h2><p class="sub">Savings figures appear once there's at least a day of traffic and 20 requests. So far: ${compact(s.usage.requests)} request${s.usage.requests === 1 ? '' : 's'} worth ${money(s.api_cost)} at API prices.</p>
        <div class="tiles"><div class="tile"><div class="label">Requests</div><div class="value">${compact(s.usage.requests)}</div><div class="foot">${s.usage.failed} failed</div></div>
        <div class="tile"><div class="label">Tokens</div><div class="value">${compact(s.usage.tokens)}</div><div class="foot">${compact(s.usage.cache_read_tokens)} cache reads</div></div>
        <div class="tile"><div class="label">Plans connected</div><div class="value">${s.accounts}</div><div class="foot">${money(s.monthly_subscriptions, 0)}/mo</div></div></div></div>`
    : isAdmin()
    ? `<div class="hero-kpi">
        <div class="card headline"><div class="label">Saved vs paying API prices</div><div class="value${s.savings_vs_api < 0 ? ' neg' : ''}">${money(s.savings_vs_api, 0)}</div>
          <div class="ink2 small">Plans delivered ${money(s.subscription_value)} of API-priced usage for ${money(s.subscription_cost)} in subscriptions.${s.overflow_cost ? ` Another ${money(s.overflow_cost)} ran on pay-per-token API keys.` : ''}</div></div>
        <div class="tiles">
          <div class="tile"><div class="label">API-equivalent value</div><div class="value">${money(s.api_cost)}</div><div class="foot">run-rate ${money(s.run_rate, 0)}/mo</div></div>
          <div class="tile"><div class="label">Subscriptions (prorated)</div><div class="value">${money(s.subscription_cost)}</div><div class="foot">${s.accounts} plan(s) · ${money(s.monthly_subscriptions, 0)}/mo</div></div>
          <div class="tile"><div class="label">Value multiple</div><div class="value">${s.value_multiple == null ? '—' : s.value_multiple.toFixed(1) + '×'}</div><div class="foot">value ÷ subscription cost</div></div>
          <div class="tile"><div class="label">Saved vs a seat each</div><div class="value">${money(s.savings_vs_seats, 0)}</div><div class="foot">${s.members.active} active × ${money(s.seat_baseline_monthly, 0)}/mo</div></div>
          <div class="tile"><div class="label">Requests</div><div class="value">${compact(s.usage.requests)}</div><div class="foot">${s.usage.failed} failed · ${s.members.active}/${s.members.total} people active</div></div>
          <div class="tile"><div class="label">Tokens</div><div class="value">${compact(s.usage.tokens)}</div><div class="foot">${compact(s.usage.cache_read_tokens)} cache reads</div></div>
        </div></div>`
    : `<div class="tiles">
        <div class="tile"><div class="label">Your requests</div><div class="value">${compact(s.usage.requests)}</div><div class="foot">${s.usage.failed} failed</div></div>
        <div class="tile"><div class="label">Your tokens</div><div class="value">${compact(s.usage.tokens)}</div><div class="foot">${compact(s.usage.cache_read_tokens)} cache reads</div></div>
        <div class="tile"><div class="label">API-equivalent value</div><div class="value">${money(s.api_cost)}</div><div class="foot">what this would cost at API prices</div></div>
      </div>`;

  const maxK = Math.max(...d.keys.map((k) => k.usage.api_cost || 0), 0);
  const keysCard = `<div class="card"><h2>${isAdmin() ? 'Top keys' : 'Your keys'}</h2><p class="sub">API-equivalent value this period.</p>${
    d.keys.length
      ? `<div class="table-wrap"><table><thead><tr><th>Key</th><th class="num">Requests</th><th class="num">Value</th><th></th></tr></thead><tbody>${d.keys
          .map((k) => `<tr><td><b>${esc(k.name)}</b><div class="muted small">${esc(k.scope_type)}${k.user_name ? ' · ' + esc(k.user_name) : ''}</div></td><td class="num">${compact(k.usage.requests)}</td><td class="num">${money(k.usage.api_cost)}</td><td class="barcell">${inlineBar(k.usage.api_cost, maxK)}</td></tr>`)
          .join('')}</tbody></table></div>`
      : `<div class="empty">No keys yet. <a href="#" data-act="key">Create one</a></div>`
  }</div>`;
  const maxM = Math.max(...d.members.map((m) => m.usage.api_cost || 0), 0);
  const peopleCard = isAdmin()
    ? `<div class="card"><h2>People</h2><p class="sub">Usage by person this period.</p>${
        d.members.length
          ? `<div class="table-wrap"><table><thead><tr><th>Person</th><th class="num">Requests</th><th class="num">Value</th><th></th></tr></thead><tbody>${d.members
              .slice(0, 8)
              .map((m) => `<tr><td><b>${esc(m.name)}</b><div class="muted small">${esc(m.role)}</div></td><td class="num">${compact(m.usage.requests)}</td><td class="num">${money(m.usage.api_cost)}</td><td class="barcell">${inlineBar(m.usage.api_cost, maxM)}</td></tr>`)
              .join('')}</tbody></table></div>`
          : ''
      }</div>`
    : `<div class="card"><h2>Models you used</h2><p class="sub">This period.</p>${
        d.models.length
          ? `<table><tbody>${d.models.map((m) => `<tr><td class="mono">${esc(m.model)}</td><td class="num">${compact(m.requests)} req</td><td class="num">${money(m.api_cost)}</td></tr>`).join('')}</tbody></table>`
          : '<div class="empty">Nothing yet.</div>'
      }</div>`;

  el.innerHTML = `${remaining.length ? checklist : ''}
    ${!isAdmin() ? `<h2 style="font-size:15px;margin:${remaining.length ? 22 : 0}px 0 0">Your usage</h2>` : ''}
    ${kpis}
    ${insightsCard}
    ${isAdmin() && s.unpriced_accounts ? `<div class="notice">${s.unpriced_accounts} plan(s) have no plan type set, so they count as $0 and savings look higher than they are. <a href="#/w/${S.wsId}/plans">Set plan types →</a></div>` : ''}
    <div class="card"><h2>API-equivalent value over time</h2><p class="sub">What ${isAdmin() ? 'this workspace\'s' : 'your'} usage would cost at pay-as-you-go API prices.</p><div id="chart"></div></div>
    <div class="grid2">${keysCard}${peopleCard}</div>
    ${!remaining.length ? `<details class="card"><summary class="card-title" style="cursor:pointer">Setup checklist (done)</summary><div style="margin-top:12px">${checklist}</div></details>` : ''}`;
  stackedChart($('#chart'), d.timeseries, S.range);
  bindActs(el);
}

function bindActs(root) {
  root.querySelectorAll('[data-act]').forEach(
    (b) =>
      (b.onclick = (e) => {
        e.preventDefault();
        const a = b.dataset.act;
        if (a === 'plan') connectPlan(isAdmin() ? 'shared' : 'private');
        else if (a === 'key') createKey();
        else if (a === 'invite') invite();
        else go(a);
      }),
  );
}

// ---------- capacity ----------

async function viewCapacity(el) {
  const d = await api(W('/capacity'));
  if (!d.accounts.length) {
    el.innerHTML = `<div class="card empty">No plans connected yet.<div style="margin-top:12px"><button class="btn primary" data-act="plan">Connect a plan</button></div></div>`;
    return bindActs(el);
  }
  const prov = d.providers
    .map(
      (p) => `<div class="card"><div class="row">${providerChip(p.provider)}<span class="spacer"></span><span class="muted small">${p.ready}/${p.accounts} ready</span></div>
      <div class="grid2" style="margin-top:14px;gap:12px">
        <div><div class="muted small">5-hour window, avg used</div><div style="font-size:22px;font-weight:650">${pct(p.avg5h)}</div><div class="meter"><i style="width:${Math.round((p.avg5h || 0) * 100)}%"></i></div></div>
        <div><div class="muted small">Weekly, avg used</div><div style="font-size:22px;font-weight:650">${pct(p.avgWeekly)}</div><div class="meter"><i style="width:${Math.round((p.avgWeekly || 0) * 100)}%"></i></div></div>
      </div>
      <div class="muted small" style="margin-top:10px">${p.next_reset ? `Next reset in ${until(p.next_reset)}` : 'Reset times appear after the first request through each plan.'}</div></div>`,
    )
    .join('');
  const win = (w) =>
    `<div style="min-width:150px"><div class="row small"><span class="ink2">${esc(w.label)}</span><span class="spacer"></span><b>${pct(w.used)}</b></div><div class="meter" style="margin:4px 0"><i style="width:${Math.round((w.used || 0) * 100)}%"></i></div><div class="muted small">${w.stale ? 'reset since last request' : w.resets_at ? 'resets in ' + until(w.resets_at) : ''}</div></div>`;
  const rows = d.accounts
    .map(
      (a) => `<tr><td>${providerChip(a.provider)}<div class="small">${esc(a.email || '')}</div><div class="muted small">${a.role === 'overflow' ? 'overflow API key' : a.visibility === 'private' ? `private · ${esc(a.owner_name || '')}` : 'shared'}${a.mine ? ' · yours' : ''}</div></td>
      <td>${statePill(a.state, a.status_message)}${a.state === 'cooling' && a.next_retry_after ? `<div class="muted small">back in ${until(Date.parse(a.next_retry_after))}</div>` : ''}</td>
      <td>${a.windows.length ? `<div class="row" style="gap:18px;align-items:flex-start">${a.windows.map(win).join('')}</div>` : `<span class="muted small">${a.kind === 'apikey' ? 'Pay-per-token, no plan window.' : 'No data yet. Appears after the first request through this plan.'}</span>`}</td>
      <td class="num">${compact(a.last_5h.requests)} req<div class="muted small">${compact(a.last_5h.tokens)} tok</div></td>
      <td>${a.weekly_unused && a.weekly_unused.share > 0.4 && a.weekly_unused.resets_at - Date.now() < 2 * 86400000 ? `<span class="pill" title="Share of this week's allowance not yet used"><span class="dot" style="background:var(--warning-mark)"></span>${pct(a.weekly_unused.share)} unused, resets in ${until(a.weekly_unused.resets_at)}</span>` : ''}</td></tr>`,
    )
    .join('');
  el.innerHTML = `<div class="grid2">${prov}</div>
    <div class="card"><h2>Plans</h2><p class="sub">Live limits reported by Anthropic and OpenAI on each response. Plans near their limit are skipped automatically.</p>
    <div class="table-wrap"><table><thead><tr><th>Plan</th><th>State</th><th>Usage windows</th><th class="num">Last 5h</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
}

// ---------- keys ----------

async function viewKeys(el) {
  const d = await api(W(`/keys?${q()}`));
  S.membersList = d.members;
  const live = d.keys.filter((k) => !k.revoked_at);
  const dead = d.keys.filter((k) => k.revoked_at);
  const budget = (k) => {
    const parts = [];
    if (k.budget_usd != null) parts.push({ used: k.month.cost || 0, cap: k.budget_usd, fmt: (v) => money(v, 0) });
    if (k.budget_tokens != null) parts.push({ used: k.month.tokens || 0, cap: k.budget_tokens, fmt: compact });
    if (!parts.length) return '<span class="muted small">No limit</span>';
    return parts
      .map((p) => {
        const r = p.cap > 0 ? Math.min(1, p.used / p.cap) : 1;
        return `<div class="small">${p.fmt(p.used)} / ${p.fmt(p.cap)}</div><div class="meter" style="width:110px"><i style="width:${Math.round(r * 100)}%;${r >= 1 ? 'background:var(--critical-mark)' : r > 0.8 ? 'background:var(--warning-mark)' : ''}"></i></div>`;
      })
      .join('');
  };
  el.innerHTML = `<div class="card">
    <div class="row"><div><h2 class="card-title">${isAdmin() ? 'Workspace keys' : 'Your keys'}</h2><div class="muted small">Keys are shown once when created. Revoking takes effect immediately.</div></div><span class="spacer"></span><button class="btn primary" id="new-key">Create key</button></div>
    ${
      live.length
        ? `<div class="table-wrap" style="margin-top:12px"><table><thead><tr><th>Name</th><th>Scope</th><th>Key</th><th>Budget this month</th><th class="num">Requests</th><th class="num">Value</th><th>Last used</th><th></th></tr></thead><tbody>${live
            .map(
              (k) => `<tr data-id="${k.id}"><td><b>${esc(k.name)}</b><div class="muted small">by ${esc(k.created_by_name || '')} · ${ago(k.created_at)}</div></td>
              <td><span class="tag">${esc(k.scope_type)}</span>${k.user_name ? `<div class="small">${esc(k.user_name)}</div>` : ''}</td>
              <td class="mono">${esc(k.key_hint)}</td><td>${budget(k)}</td>
              <td class="num">${compact(k.usage.requests)}</td><td class="num">${money(k.usage.api_cost)}</td><td class="muted">${ago(k.last_used_at)}</td>
              <td><div class="row" style="gap:6px;flex-wrap:nowrap">${isAdmin() ? '<button class="btn sm" data-edit>Budget</button>' : ''}<button class="btn sm danger" data-revoke>Revoke</button></div></td></tr>`,
            )
            .join('')}</tbody></table></div>`
        : `<div class="empty">No keys yet. Create one and run the setup script to start using the pool.</div>`
    }</div>
    ${dead.length ? `<details class="card"><summary class="card-title" style="cursor:pointer">Revoked keys (${dead.length})</summary><table style="margin-top:10px"><tbody>${dead.map((k) => `<tr><td>${esc(k.name)}</td><td class="mono muted">${esc(k.key_hint)}</td><td class="muted">revoked ${ago(k.revoked_at)}</td></tr>`).join('')}</tbody></table></details>` : ''}`;
  $('#new-key').onclick = () => createKey();
  el.querySelectorAll('[data-revoke]').forEach(
    (b) =>
      (b.onclick = async () => {
        const id = b.closest('tr').dataset.id;
        if (!(await confirmBox('Revoke key?', 'Anything using this key stops working right away. This can\'t be undone.', 'Revoke', true))) return;
        const r = await api(W(`/keys/${id}/revoke`), { method: 'POST' });
        toast(r.warning || 'Key revoked', r.warning ? 'err' : 'ok');
        render();
      }),
  );
  el.querySelectorAll('[data-edit]').forEach(
    (b) =>
      (b.onclick = () => {
        const k = live.find((x) => String(x.id) === b.closest('tr').dataset.id);
        const d2 = modal(`<h3>Budget for "${esc(k.name)}"</h3><p class="ink2 small">Monthly limits reset on the 1st. Leave empty for no limit.</p>
          <div class="grid2"><label class="field"><span>Dollar budget (API-equivalent)</span><input type="number" min="0" step="1" id="bu" value="${k.budget_usd ?? ''}" placeholder="e.g. 200"/></label>
          <label class="field"><span>Token budget</span><input type="number" min="0" step="100000" id="bt" value="${k.budget_tokens ?? ''}" placeholder="e.g. 50000000"/></label></div>
          <div class="actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="save">Save</button></div>`);
        d2.querySelector('#save').onclick = async () => {
          await api(W(`/keys/${k.id}`), { method: 'PATCH', body: { budget_usd: d2.querySelector('#bu').value, budget_tokens: d2.querySelector('#bt').value } });
          d2.close();
          toast('Budget saved');
          render();
        };
      }),
  );
}

async function createKey() {
  if (!S.membersList && isAdmin()) S.membersList = (await api(W('/keys'))).members;
  const people = (S.membersList || []).map((m) => `<option value="${m.id}"${m.id === S.me.id ? ' selected' : ''}>${esc(m.name)}</option>`).join('');
  const d = modal(`<h3>Create key</h3>
    <label class="field"><span>Name</span><input type="text" id="kname" value="${isAdmin() ? '' : esc(S.me.name.split(' ')[0] + "'s laptop")}" placeholder="e.g. Priya's laptop, Mobile team, Client: Acme" /></label>
    ${
      isAdmin()
        ? `<label class="field"><span>Scope</span><select id="kscope"><option value="person">Person: usage is attributed to them</option><option value="team">Team</option><option value="project">Project</option><option value="client">Client</option></select></label>
           <label class="field" id="kperson-wrap"><span>Person</span><select id="kperson">${people}</select></label>
           <div class="grid2"><label class="field"><span>Monthly $ budget <span class="muted">(optional)</span></span><input type="number" min="0" id="kbu" placeholder="no limit"/></label>
           <label class="field"><span>Monthly token budget <span class="muted">(optional)</span></span><input type="number" min="0" id="kbt" placeholder="no limit"/></label></div>`
        : '<p class="muted small">Your key is personal. Usage made with it is attributed to you.</p>'
    }
    <div class="actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="kcreate">Create key</button></div>`);
  const scope = d.querySelector('#kscope');
  if (scope) scope.onchange = () => d.querySelector('#kperson-wrap').classList.toggle('hidden', scope.value !== 'person');
  d.querySelector('#kname').focus();
  d.querySelector('#kcreate').onclick = async () => {
    try {
      const body = { name: d.querySelector('#kname').value };
      if (isAdmin()) Object.assign(body, { scope_type: scope.value, user_id: d.querySelector('#kperson').value, budget_usd: d.querySelector('#kbu').value, budget_tokens: d.querySelector('#kbt').value });
      const r = await api(W('/keys'), { method: 'POST', body });
      if (r.warning) toast(r.warning, 'err');
      showNewKey(r.key);
      if (S.page === 'keys' || S.page === 'overview') render();
    } catch (err) {
      toast(err.message, 'err');
    }
  };
}

function showNewKey(key) {
  const cmd = `curl -fsSL ${S.publicUrl}/setup.sh | sh`;
  const d = modal(
    `<h3>Your new key</h3><p class="ink2 small">Copy it now. For your security it won't be shown again.</p>
    <div class="keybox"><span style="flex:1" id="kval">${esc(key)}</span>${copyButton(key)}</div>
    <h3 style="font-size:14px;margin-top:18px">Test it</h3>
    <p class="ink2 small" style="margin:0 0 8px">Sends one tiny real request through your pool.</p>
    <div class="row"><button class="btn" id="ktest">Send test request</button><span id="ktest-out" class="small ink2"></span></div>
    <h3 style="font-size:14px;margin-top:18px">Set up Claude Code &amp; Codex</h3>
    <p class="ink2 small" style="margin:0">Run this in a terminal and paste the key when asked:</p>${codeBlock(cmd)}
    <div class="actions"><a class="btn" href="#/w/${S.wsId}/setup" data-close>Other tools</a><button class="btn primary" data-close>Done</button></div>`,
    { wide: true },
  );
  d.querySelector('#ktest').onclick = () => testKey(key, d.querySelector('#ktest-out'));
}

async function testKey(key, out) {
  out.textContent = 'Checking models…';
  try {
    const t0 = performance.now();
    const ml = await fetch('/v1/models', { headers: { Authorization: `Bearer ${key}` } }).then((r) => r.json());
    const ids = (ml.data || []).map((m) => m.id);
    if (!ids.length) {
      out.innerHTML = '<span style="color:var(--critical)">The key works, but no models are available. Connect a plan first.</span>';
      return;
    }
    const pick = ids.find((i) => /claude-(haiku|sonnet)/.test(i)) || ids.find((i) => i.startsWith('claude')) || ids.find((i) => /gpt-.*(luna|mini|terra)/.test(i)) || ids[0];
    out.textContent = `Asking ${pick}…`;
    let reply;
    if (pick.startsWith('claude')) {
      const r = await fetch('/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: pick, max_tokens: 20, messages: [{ role: 'user', content: 'Reply with the single word: pong' }] }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error?.message || r.statusText);
      reply = (j.content || []).map((c) => c.text || '').join('').trim();
    } else {
      const r = await fetch('/v1/responses', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: pick, input: 'Reply with the single word: pong' }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error?.message || r.statusText);
      reply = (j.output || []).flatMap((o) => o.content || []).map((c) => c.text || '').join('').trim();
    }
    out.innerHTML = `<span style="color:var(--good)">✓ ${esc(pick)} replied "${esc(reply.slice(0, 60))}" in ${((performance.now() - t0) / 1000).toFixed(1)}s</span>`;
  } catch (err) {
    out.innerHTML = `<span style="color:var(--critical)">✗ ${esc(err.message)}</span>`;
  }
}

// ---------- plans ----------

async function viewPlans(el) {
  const d = await api(W(`/accounts?${q()}`));
  const planOpts = (sel) => `<option value="">— set plan —</option>${Object.entries(d.plans).map(([k, p]) => `<option value="${esc(k)}"${k === sel ? ' selected' : ''}>${esc(p.label)}${k !== 'custom' ? ` ($${p.monthly})` : ''}</option>`).join('')}`;
  const ownerOpts = (sel) => `<option value="">Company</option>${d.members.map((m) => `<option value="${m.id}"${m.id === sel ? ' selected' : ''}>${esc(m.name)}</option>`).join('')}`;
  const rows = d.accounts
    .map((a) => {
      const st = accountState(a);
      const manage = a.can_manage;
      const isOverflow = a.role === 'overflow';
      return `<tr data-id="${a.id}">
        <td>${providerChip(a.provider)}<div class="small">${esc(a.email || a.label || '')}</div><div class="muted small">${a.kind === 'apikey' ? (isOverflow ? 'Overflow API key' : 'API key') : esc(a.account_type || 'subscription')}</div></td>
        <td>${statePill(st, a.status_message)}</td>
        <td>${
          isOverflow
            ? '<span class="muted small">pay-per-token</span>'
            : manage
              ? `<select data-f="visibility"><option value="shared"${a.visibility === 'shared' ? ' selected' : ''}>Shared with team</option><option value="private"${a.visibility === 'private' ? ' selected' : ''}>Private (owner first)</option></select>`
              : `<span class="tag">${a.visibility}</span>`
        }</td>
        <td>${isAdmin() ? `<select data-f="owner_user_id">${ownerOpts(a.owner_user_id)}</select>` : esc(a.owner_name || 'Company')}</td>
        <td>${a.kind === 'apikey' ? '<span class="muted small">—</span>' : manage ? `<select data-f="plan">${planOpts(a.plan)}</select>` : esc(planName(d.plans, a.plan))}</td>
        <td class="num">${a.kind === 'apikey' ? '—' : manage ? `<input type="number" min="0" data-f="monthly_cost" style="width:76px" placeholder="${a.effective_monthly || 0}" value="${a.monthly_cost ?? ''}" title="Override the monthly price"/>` : money(a.effective_monthly, 0)}</td>
        <td class="num">${money(a.usage.api_cost)}<div class="muted small">${compact(a.usage.requests)} req</div></td>
        <td class="num">${a.value_multiple == null ? '—' : a.value_multiple.toFixed(1) + '×'}</td>
        <td>${manage ? `<div class="row" style="gap:6px;flex-wrap:nowrap"><button class="btn sm" data-toggle="${a.disabled ? 'resume' : 'pause'}">${a.disabled ? 'Resume' : 'Pause'}</button><button class="btn sm danger" data-remove>Remove</button></div>` : ''}</td></tr>`;
    })
    .join('');
  el.innerHTML = `<div class="card">
    <div class="row"><div><h2 class="card-title">Connected plans</h2><div class="muted small">${isAdmin() ? 'Every Claude and ChatGPT plan in this workspace. Set the plan type so savings are accurate.' : 'Shared plans serve everyone. Plans you connect can be private to you.'}</div></div>
    <span class="spacer"></span><button class="btn primary" data-connect="claude">Connect Claude plan</button><button class="btn primary" data-connect="codex">Connect ChatGPT plan</button>${isAdmin() ? '<button class="btn" id="add-overflow">Add overflow API key</button>' : ''}</div>
    ${rows ? `<div class="table-wrap" style="margin-top:12px"><table><thead><tr><th>Plan</th><th>State</th><th>Sharing</th><th>Owner</th><th>Type</th><th class="num">$/mo</th><th class="num">Value</th><th class="num">Multiple</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="empty">No plans yet. Connect a Claude or ChatGPT plan to start your pool.</div>'}
    </div>
    ${
      d.unclaimed.length
        ? `<div class="card"><h2>Unassigned plans on this server</h2><p class="sub">These sign-ins exist in the routing engine but don't belong to any workspace, e.g. from an earlier setup. Claim them for this workspace.</p>
          <table><tbody>${d.unclaimed.map((u) => `<tr><td>${providerChip(u.provider)}</td><td>${esc(u.email)}</td><td><button class="btn sm" data-claim="${esc(u.auth_index)}">Claim</button></td></tr>`).join('')}</tbody></table></div>`
        : ''
    }
    <div class="card"><h2>Private vs shared</h2><p class="ink2" style="margin:0">A <b>private</b> plan serves only the person who connected it, and their requests fall back to the shared pool when it's at its limit. A <b>shared</b> plan serves everyone. Overflow API keys are used only when no plan has capacity, and the provider bills them per token.</p></div>`;

  el.querySelectorAll('[data-connect]').forEach((b) => (b.onclick = () => connectPlan(isAdmin() ? 'shared' : 'private', b.dataset.connect)));
  const ov = $('#add-overflow');
  if (ov) ov.onclick = addOverflow;
  el.querySelectorAll('[data-claim]').forEach(
    (b) =>
      (b.onclick = async () => {
        await api(W('/accounts/claim'), { method: 'POST', body: { auth_index: b.dataset.claim } }).catch((e) => toast(e.message, 'err'));
        toast('Plan claimed');
        render();
      }),
  );
  el.querySelectorAll('[data-f]').forEach(
    (inp) =>
      (inp.onchange = async () => {
        const id = inp.closest('tr').dataset.id;
        try {
          await api(W(`/accounts/${id}`), { method: 'PATCH', body: { [inp.dataset.f]: inp.value } });
          toast('Saved');
        } catch (err) {
          toast(err.message, 'err');
        }
        render();
      }),
  );
  el.querySelectorAll('[data-toggle]').forEach(
    (b) =>
      (b.onclick = async () => {
        b.disabled = true;
        await api(W(`/accounts/${b.closest('tr').dataset.id}/${b.dataset.toggle}`), { method: 'POST' }).catch((e) => toast(e.message, 'err'));
        render();
      }),
  );
  el.querySelectorAll('[data-remove]').forEach(
    (b) =>
      (b.onclick = async () => {
        if (!(await confirmBox('Remove this plan?', 'It leaves the pool and its sign-in is deleted from this server. The subscription itself is not canceled.', 'Remove', true))) return;
        await api(W(`/accounts/${b.closest('tr').dataset.id}`), { method: 'DELETE' }).catch((e) => toast(e.message, 'err'));
        toast('Plan removed');
        render();
      }),
  );
}

const CALLBACK_HOST = { claude: 'localhost:54545', codex: 'localhost:1455' };

function connectPlan(defaultVisibility, provider) {
  const step1 = () => {
    const d = modal(`<h3>Connect a plan</h3><p class="ink2 small">You'll sign in on Anthropic's or OpenAI's own page. AI Pool never sees your password.</p>
      <label class="field"><span>Provider</span></label>
      <div class="choice">
        <label><input type="radio" name="prov" value="claude"${provider !== 'codex' ? ' checked' : ''}/><div><b>Claude</b><div class="muted small">Pro, Max 5x, Max 20x, Team</div></div></label>
        <label><input type="radio" name="prov" value="codex"${provider === 'codex' ? ' checked' : ''}/><div><b>ChatGPT / Codex</b><div class="muted small">Plus, Pro, Business</div></div></label>
      </div>
      <label class="field"><span>Who can use it?</span></label>
      <div class="choice">
        <label><input type="radio" name="vis" value="private"${defaultVisibility === 'private' ? ' checked' : ''}/><div><b>Private: just me, team pool as backup</b><div class="muted small">Your requests use this plan first. Nobody else can use it.</div></div></label>
        <label><input type="radio" name="vis" value="shared"${defaultVisibility === 'shared' ? ' checked' : ''}/><div><b>Shared with the workspace</b><div class="muted small">Everyone's requests can use it. Best for company-paid plans.</div></div></label>
      </div>
      <div class="actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="next">Continue to sign-in</button></div>`);
    d.querySelector('#next').onclick = () => step2(d.querySelector('input[name=prov]:checked').value, d.querySelector('input[name=vis]:checked').value);
  };
  const step2 = async (prov, vis) => {
    let state;
    let timer;
    const d = modal(`<h3>Connect ${prov === 'claude' ? 'Claude' : 'ChatGPT'}</h3><div id="cbody"><p class="muted">Starting sign-in…</p></div>`, { wide: true });
    d.addEventListener('close', () => clearTimeout(timer), { once: true });
    try {
      const r = await api(W('/accounts/oauth/start'), { method: 'POST', body: { provider: prov, visibility: vis } });
      state = r.state;
      d.querySelector('#cbody').innerHTML = `<ol class="steps">
          <li><a class="btn primary" href="${esc(r.url)}" target="_blank" rel="noopener">Open ${prov === 'claude' ? 'Claude' : 'OpenAI'} sign-in ↗</a>
            <div class="muted small" style="margin-top:6px">Connecting a <b>second</b> account? Right-click → <i>Open link in incognito window</i>, so you're not signed in as the first one.</div></li>
          <li>Sign in with the account to add and approve access.</li>
          <li>On this computer, this window finishes by itself. If your browser ends on a <code>${CALLBACK_HOST[prov]}</code> page that won't load, copy its full address and paste it here:</li>
        </ol>
        <form id="paste" class="row"><input type="url" id="purl" placeholder="http://${CALLBACK_HOST[prov]}/…?code=…" style="flex:1;min-width:220px"/><button class="btn" type="submit">Submit</button></form>
        <p class="muted small" id="cstatus" style="margin-top:12px">Waiting for sign-in…</p>
        <div class="actions"><button class="btn" data-close>Close</button></div>`;
      d.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => d.close()));
      d.querySelector('#paste').onsubmit = async (e) => {
        e.preventDefault();
        try {
          await api(W('/accounts/oauth/callback'), { method: 'POST', body: { state, redirect_url: d.querySelector('#purl').value.trim() } });
          d.querySelector('#cstatus').textContent = 'Got it, finishing…';
        } catch (err) {
          d.querySelector('#cstatus').textContent = err.message;
        }
      };
      const poll = async () => {
        try {
          const s = await api(W(`/accounts/oauth/status?state=${encodeURIComponent(state)}`));
          if (s.status === 'ok') {
            const li = (arr) => arr.map((a) => `<li>${esc(a.email)}</li>`).join('');
            d.querySelector('#cbody').innerHTML = `${s.added.length ? `<div class="notice ok"><b>Connected.</b> Now in your pool as ${vis === 'private' ? 'a private plan' : 'a shared plan'}:<ul>${li(s.added)}</ul></div>` : ''}
              ${s.refreshed.length ? `<div class="notice info">Already in this workspace, so the sign-in was refreshed:<ul>${li(s.refreshed)}</ul></div>` : ''}
              ${s.conflicts.length ? `<div class="notice err">Already connected to another workspace on this server and not added here:<ul>${li(s.conflicts)}</ul></div>` : ''}
              ${s.ambiguous ? `<div class="notice err">${esc(s.error)}</div>` : !s.added.length && !s.refreshed.length && !s.conflicts.length ? '<div class="notice">No new plan was detected. If you did sign in, close this and try connecting again.</div>' : ''}
              ${s.added.length ? '<p class="ink2 small">Next: set the plan type (Pro, Max…) on the Plans page so savings are calculated correctly.</p>' : ''}
              <div class="actions"><button class="btn primary" id="done">Done</button></div>`;
            d.querySelector('#done').onclick = () => {
              d.close();
              if (S.page === 'plans') render();
              else go('plans');
            };
            return;
          }
          if (s.status === 'error') {
            d.querySelector('#cstatus').innerHTML = `<span style="color:var(--critical)">Sign-in failed: ${esc(s.error || 'unknown error')}. Close and try again.</span>`;
            return;
          }
        } catch (err) {
          const c = d.querySelector('#cstatus');
          if (c) c.textContent = err.message;
        }
        if (d.open) timer = setTimeout(poll, 2000);
      };
      timer = setTimeout(poll, 2000);
    } catch (err) {
      d.querySelector('#cbody').innerHTML = `<div class="notice err">${esc(err.message)}</div><div class="actions"><button class="btn" data-close>Close</button></div>`;
      d.querySelector('[data-close]').onclick = () => d.close();
    }
  };
  step1();
}

function addOverflow() {
  const d = modal(`<h3>Add an overflow API key</h3><p class="ink2 small">Used only when every plan for that provider is at its limit. The provider bills it per token. Stored encrypted.</p>
    <label class="field"><span>Provider</span><select id="op"><option value="claude">Anthropic (Claude)</option><option value="codex">OpenAI (GPT / Codex)</option></select></label>
    <label class="field"><span>Label</span><input type="text" id="ol" placeholder="e.g. Company Anthropic key"/></label>
    <label class="field"><span>API key</span><input type="password" id="ok2" autocomplete="off" placeholder="sk-…"/></label>
    <div class="actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="oadd">Add key</button></div>`);
  d.querySelector('#oadd').onclick = async () => {
    try {
      await api(W('/accounts/apikey'), { method: 'POST', body: { provider: d.querySelector('#op').value, label: d.querySelector('#ol').value, api_key: d.querySelector('#ok2').value, role: 'overflow', visibility: 'shared' } });
      d.close();
      toast('Overflow key added');
      render();
    } catch (err) {
      toast(err.message, 'err');
    }
  };
}

// ---------- members ----------

async function viewMembers(el) {
  const d = await api(W(`/members?${q()}`));
  const max = Math.max(...d.members.map((m) => m.usage?.api_cost || 0), 0);
  el.innerHTML = `<div class="card">
    <div class="row"><div><h2 class="card-title">Members</h2><div class="muted small">Everyone here can create personal keys and connect their own plans.</div></div><span class="spacer"></span><button class="btn primary" id="inv">Invite people</button></div>
    <div class="table-wrap" style="margin-top:12px"><table><thead><tr><th>Name</th><th>Role</th><th class="num">Keys</th><th class="num">Own plans</th><th class="num">Requests</th><th class="num">Value</th><th></th><th>Joined</th><th></th></tr></thead><tbody>${d.members
      .map(
        (m) => `<tr data-id="${m.id}"><td><b>${esc(m.name)}</b>${m.id === d.me ? ' <span class="muted small">(you)</span>' : ''}<div class="muted small">${esc(m.email)}</div></td>
        <td>${m.role === 'owner' || m.id === d.me ? `<span class="tag">${m.role}</span>` : `<select data-role><option value="member"${m.role === 'member' ? ' selected' : ''}>member</option><option value="admin"${m.role === 'admin' ? ' selected' : ''}>admin</option></select>`}</td>
        <td class="num">${m.keys}</td><td class="num">${m.plans}</td><td class="num">${compact(m.usage.requests)}</td><td class="num">${money(m.usage.api_cost)}</td><td class="barcell">${inlineBar(m.usage.api_cost, max)}</td>
        <td class="muted">${ago(m.created_at)}</td><td>${m.role === 'owner' || m.id === d.me ? '' : '<button class="btn sm danger" data-remove>Remove</button>'}</td></tr>`,
      )
      .join('')}</tbody></table></div>
    ${d.unattributed ? `<p class="muted small">Plus ${money(d.unattributed.api_cost)} from team, project or client keys not tied to a person.</p>` : ''}</div>
    ${
      d.invites.length
        ? `<div class="card"><h2>Pending invites</h2><table><tbody>${d.invites.map((i) => `<tr data-inv="${i.id}"><td>${esc(i.email || 'Anyone with the link')}</td><td><span class="tag">${i.role}</span></td><td class="muted">sent ${ago(i.created_at)} · expires in ${until(i.expires_at)}</td><td><button class="btn sm danger" data-revoke-inv>Revoke</button></td></tr>`).join('')}</tbody></table></div>`
        : ''
    }`;
  $('#inv').onclick = invite;
  el.querySelectorAll('[data-role]').forEach(
    (s) =>
      (s.onchange = async () => {
        await api(W(`/members/${s.closest('tr').dataset.id}`), { method: 'PATCH', body: { role: s.value } }).catch((e) => toast(e.message, 'err'));
        toast('Role updated');
      }),
  );
  el.querySelectorAll('[data-remove]').forEach(
    (b) =>
      (b.onclick = async () => {
        const name = b.closest('tr').querySelector('b').textContent;
        if (!(await confirmBox(`Remove ${name}?`, 'Their keys are revoked immediately and any plans they connected leave the pool. Their past usage stays in reports.', 'Remove', true))) return;
        await api(W(`/members/${b.closest('tr').dataset.id}`), { method: 'DELETE' });
        toast(`${name} removed`);
        render();
      }),
  );
  el.querySelectorAll('[data-revoke-inv]').forEach(
    (b) =>
      (b.onclick = async () => {
        await api(W(`/invites/${b.closest('tr').dataset.inv}`), { method: 'DELETE' });
        render();
      }),
  );
}

function invite() {
  const d = modal(`<h3>Invite people</h3><p class="ink2 small">Create a private invite link and send it however you like (Slack, email…). Links work once and expire after 14 days.</p>
    <label class="field"><span>Their email <span class="muted">(optional, pre-fills sign-up)</span></span><input type="email" id="iemail" placeholder="name@company.com"/></label>
    <label class="field"><span>Role</span><select id="irole"><option value="member">Member: personal keys, own plans, own usage</option><option value="admin">Admin: manage everything except billing</option></select></label>
    <div id="iout"></div>
    <div class="actions"><button class="btn" data-close>Close</button><button class="btn primary" id="icreate">Create invite link</button></div>`);
  d.querySelector('#icreate').onclick = async () => {
    try {
      const r = await api(W('/invites'), { method: 'POST', body: { email: d.querySelector('#iemail').value, role: d.querySelector('#irole').value } });
      d.querySelector('#iout').innerHTML = `<div class="notice ok" style="margin-top:14px">Invite link ready. Send it to them:</div>${codeBlock(r.url)}<p class="muted small">Tip: open it in a private window to try the member experience yourself.</p>`;
      d.querySelector('#icreate').textContent = 'Create another';
      d.querySelector('#iemail').value = '';
      if (S.page === 'members') render();
    } catch (err) {
      toast(err.message, 'err');
    }
  };
}

// ---------- activity ----------

async function viewUsage(el) {
  const rows = await api(W('/activity'));
  el.innerHTML = `<div class="card"><h2>Recent requests</h2><p class="sub">The latest 200 requests ${isAdmin() ? 'in this workspace' : 'made with your keys'}. AI Pool doesn't store prompt or response text.</p>
    ${
      rows.length
        ? `<div class="table-wrap"><table><thead><tr><th>When</th>${isAdmin() ? '<th>Person</th>' : ''}<th>Key</th><th>Model</th><th>Plan</th><th class="num">Tokens</th><th class="num">Latency</th><th class="num">Value</th><th>Result</th></tr></thead><tbody>${rows
            .map(
              (r) => `<tr><td class="muted nowrap" title="${new Date(r.ts).toLocaleString()}">${ago(r.ts)}</td>${isAdmin() ? `<td>${esc(r.user_name || '—')}</td>` : ''}<td>${esc(r.key_name || '—')}</td><td class="mono">${esc(r.model || '')}</td>
              <td class="small">${esc(r.account || '—')}</td><td class="num">${compact(r.tokens)}</td><td class="num">${r.latency_ms != null ? (r.latency_ms / 1000).toFixed(1) + 's' : '—'}</td><td class="num">${money(r.cost, 4)}</td>
              <td>${r.failed ? `<span class="pill"><span class="dot" style="background:var(--critical-mark)"></span>Failed ${r.status_code || ''}</span>` : '<span class="pill"><span class="dot" style="background:var(--good-mark)"></span>OK</span>'}</td></tr>`,
            )
            .join('')}</tbody></table></div>`
        : '<div class="empty">No requests yet.</div>'
    }</div>`;
}

// ---------- setup ----------

function viewSetup(el) {
  const base = S.publicUrl;
  const cmd = `curl -fsSL ${base}/setup.sh | sh`;
  el.innerHTML = `<div class="card"><h2>1 · Get a key</h2><p class="sub">Each person should use their own key, so usage and budgets are tracked per person.</p><button class="btn primary" data-act="key">Create key</button> <a class="btn" href="#/w/${S.wsId}/keys">Your keys</a></div>
    <div class="card"><h2>2 · Run the setup script</h2><p class="sub">Configures Claude Code and Codex. It asks for your key, checks it, and backs up existing config first.</p>${codeBlock(cmd)}</div>
    <div class="card"><h2>Or configure manually</h2>
      <div class="seg" id="tabs" style="margin-bottom:12px"><button data-t="claude" aria-pressed="true">Claude Code</button><button data-t="codex">Codex CLI</button><button data-t="other">Other tools</button></div>
      <div data-tab="claude"><p class="ink2 small">Add to <code>~/.claude/settings.json</code>. If Claude Code was signed in to a personal account, run <code>/logout</code> once.</p>${codeBlock(JSON.stringify({ env: { ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: 'aip_your_key' } }, null, 2))}</div>
      <div data-tab="codex" class="hidden"><p class="ink2 small">Add to <code>~/.codex/config.toml</code>:</p>${codeBlock(`model_provider = "aipool"\n\n[model_providers.aipool]\nname = "AI Pool"\nbase_url = "${base}/v1"\nenv_key = "AIPOOL_API_KEY"\nwire_api = "responses"`)}<p class="ink2 small">and to your shell profile:</p>${codeBlock('export AIPOOL_API_KEY="aip_your_key"')}</div>
      <div data-tab="other" class="hidden"><p class="ink2 small">Cursor, Cline, Continue, OpenCode, Zed and SDKs:</p>${codeBlock(`OpenAI-compatible base URL:    ${base}/v1\nAnthropic-compatible base URL: ${base}\nAPI key:                       aip_your_key`)}</div>
    </div>`;
  el.querySelectorAll('#tabs button').forEach(
    (b) =>
      (b.onclick = () => {
        el.querySelectorAll('#tabs button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        el.querySelectorAll('[data-tab]').forEach((t) => t.classList.toggle('hidden', t.dataset.tab !== b.dataset.t));
      }),
  );
  bindActs(el);
}

// ---------- billing ----------

async function viewBilling(el) {
  const b = await api(W('/billing'));
  const owner = S.role === 'owner';
  const status =
    b.status === 'active'
      ? `<span class="pill"><span class="dot" style="background:var(--good-mark)"></span>Active since ${new Date(b.activated_at).toLocaleDateString()}</span>`
      : b.status === 'canceled'
        ? '<span class="pill"><span class="dot" style="background:var(--critical-mark)"></span>Canceled</span>'
        : b.trial_expired
          ? '<span class="pill"><span class="dot" style="background:var(--critical-mark)"></span>Trial ended</span>'
          : `<span class="pill"><span class="dot" style="background:var(--warning-mark)"></span>Trial · ${b.trial_days_left} day(s) left</span>`;
  el.innerHTML = `<div class="notice info">Billing is <b>simulated</b> in this local build. No card is collected and nothing is charged.</div>
    <div class="grid2">
      <div class="card"><h2>Plan</h2><div style="margin:8px 0 14px">${status}</div>
        <table><tbody>
          <tr><td>Connected plans</td><td class="num">${b.connected_plans}</td></tr>
          <tr><td>Price per plan</td><td class="num">${money(b.price_per_plan, 0)}/mo</td></tr>
          <tr><td><b>${b.status === 'active' ? 'Monthly total' : 'Monthly total after trial'}</b></td><td class="num"><b>${money(b.monthly_total, 0)}/mo</b></td></tr>
        </tbody></table>
        <p class="muted small">Overflow API keys are billed by the provider, not by AI Pool.</p>
        ${owner ? (b.status === 'active' ? '<button class="btn danger" id="cancel">Cancel subscription</button>' : `<button class="btn primary" id="activate">${b.status === 'canceled' ? 'Reactivate' : 'Activate plan'}</button>`) : '<p class="muted small">Only the workspace owner can change billing.</p>'}
      </div>
      <div class="card"><h2>What happens when the trial ends</h2><p class="ink2" style="margin:0">If the workspace isn't activated, requests through AI Pool keys return a <code>402</code> error and tools stop working. Your plans, keys and history are kept. Activate at any time to resume.</p></div>
    </div>`;
  const a = $('#activate');
  if (a)
    a.onclick = async () => {
      if (!(await confirmBox('Activate AI Pool?', `You'll be billed ${money(b.monthly_total, 0)}/month for ${b.connected_plans} connected plan(s). (Simulated: nothing is charged.)`, 'Activate'))) return;
      await api(W('/billing/activate'), { method: 'POST' });
      toast('Workspace activated');
      render();
    };
  const c = $('#cancel');
  if (c)
    c.onclick = async () => {
      if (!(await confirmBox('Cancel subscription?', 'Keys stop working right away. Your plans and data are kept.', 'Cancel subscription', true))) return;
      await api(W('/billing/cancel'), { method: 'POST' });
      render();
    };
}

// ---------- settings ----------

async function viewSettings(el) {
  const s = await api(W('/settings'));
  const h = s.health || {};
  el.innerHTML = `<div class="card"><h2>Workspace</h2>
      <div class="grid2"><label class="field"><span>Name</span><input type="text" id="sname" value="${esc(s.name)}"/></label>
      <label class="field"><span>Seat cost per person / month</span><input type="number" min="0" id="sseat" value="${s.seat_baseline_monthly}"/><div class="hint">What you'd pay to give each person their own plans. Used for "Saved vs a seat each".</div></label></div></div>
    <div class="card"><h2>Plan prices</h2><p class="sub">Monthly price used when a plan is tagged with a type.</p><table><tbody>${Object.entries(s.plans)
      .filter(([k]) => k !== 'custom')
      .map(([k, p]) => `<tr><td>${esc(p.label)}</td><td class="num"><input type="number" min="0" data-plan="${esc(k)}" data-label="${esc(p.label)}" value="${p.monthly}" style="width:100px"/></td></tr>`)
      .join('')}</tbody></table></div>
    <div class="card"><h2>Model prices <span class="muted small">(USD per 1M tokens)</span></h2><p class="sub">API list prices used to value usage. Prices marked <i>verify</i> came from secondary sources. Saving re-prices history.</p>
      <div class="table-wrap"><table><thead><tr><th>Model</th><th class="num">Input</th><th class="num">Output</th><th class="num">Cache read</th><th class="num">Cache write</th><th></th></tr></thead><tbody>${Object.entries(s.prices)
        .map(([k, p]) => `<tr data-price="${esc(k)}"><td class="mono">${esc(k)}</td>${['in', 'out', 'cr', 'cw'].map((f) => `<td class="num"><input type="number" min="0" step="0.01" data-pf="${f}" value="${p[f] ?? 0}" style="width:80px"/></td>`).join('')}<td>${s.default_prices[k]?.verify ? '<span class="tag">verify</span>' : ''}</td></tr>`)
        .join('')}</tbody></table></div></div>
    <div class="row"><button class="btn primary" id="ssave">Save settings</button></div>
    <div class="card"><h2>System</h2><div class="ink2 small">Usage last collected ${ago(h.lastPollAt)}${h.lastPollError ? ` · <span style="color:var(--critical)">${esc(h.lastPollError)}</span>` : ''}<br/>Plans last synced ${ago(h.lastSyncAt)}${h.lastSyncError ? ` · <span style="color:var(--critical)">${esc(h.lastSyncError)}</span>` : ''}<br/>Endpoint: <code>${esc(S.publicUrl)}</code><br/>Usage history is kept for ${s.retention_days} days.</div></div>
    ${
      S.role === 'owner'
        ? `<div class="card" style="border-color:color-mix(in srgb, var(--critical-mark) 40%, var(--border))"><h2>Ownership &amp; deletion</h2><p class="sub">Only the owner sees this section.</p>
          <div class="row" style="margin-bottom:14px"><label class="field" style="margin:0;min-width:240px"><span>Transfer ownership to</span><select id="xfer-to"><option value="">Choose a member…</option></select></label><button class="btn" id="xfer" style="align-self:flex-end">Transfer</button></div>
          <p class="ink2 small">After a transfer you stay in the workspace as an admin.</p>
          <hr style="border:0;border-top:1px solid var(--grid);margin:14px 0"/>
          <p class="ink2 small" style="margin:0 0 8px">Deleting the workspace disconnects every plan, revokes every key and erases its history. This cannot be undone.</p>
          <button class="btn danger" id="ws-delete">Delete workspace…</button></div>`
        : ''
    }`;
  if (S.role === 'owner') {
    const mem = (await api(W('/members'))).members.filter((m) => m.id !== S.me.id);
    $('#xfer-to').innerHTML += mem.map((m) => `<option value="${m.id}">${esc(m.name)} (${esc(m.role)})</option>`).join('');
    $('#xfer').onclick = async () => {
      const uid = $('#xfer-to').value;
      const name = $('#xfer-to').selectedOptions[0]?.textContent;
      if (!uid) return toast('Choose who should become the owner.', 'err');
      if (!(await confirmBox('Transfer ownership?', `${esc(name)} becomes the owner and controls billing and deletion. You become an admin.`, 'Transfer', true))) return;
      try {
        await api(W('/transfer'), { method: 'POST', body: { user_id: uid } });
        toast('Ownership transferred');
        const me = await api('/api/me');
        S.workspaces = me.workspaces;
        route();
      } catch (err) {
        toast(err.message, 'err');
      }
    };
    $('#ws-delete').onclick = () => {
      const d = modal(`<h3>Delete "${esc(s.name)}"?</h3><p class="ink2">Every plan is disconnected, every key stops working and all usage history is erased. Members lose access immediately. Type the workspace name to confirm.</p>
        <label class="field"><span>Workspace name</span><input type="text" id="confirm-name" autocomplete="off"/></label>
        <div class="actions"><button class="btn" data-close>Cancel</button><button class="btn danger" id="really">Delete workspace</button></div>`);
      d.querySelector('#really').onclick = async () => {
        try {
          await api(W('/'), { method: 'DELETE', body: { confirm: d.querySelector('#confirm-name').value } });
          d.close();
          location.hash = '';
          location.reload();
        } catch (err) {
          toast(err.message, 'err');
        }
      };
    };
  }
  $('#ssave').onclick = async () => {
    const plans = {};
    el.querySelectorAll('[data-plan]').forEach((i) => (plans[i.dataset.plan] = { label: i.dataset.label, monthly: Number(i.value) }));
    plans.custom = { label: 'Custom', monthly: 0 };
    const prices = {};
    el.querySelectorAll('[data-price]').forEach((tr) => {
      const p = {};
      tr.querySelectorAll('[data-pf]').forEach((i) => (p[i.dataset.pf] = Number(i.value)));
      prices[tr.dataset.price] = p;
    });
    try {
      await api(W('/settings'), { method: 'PUT', body: { name: $('#sname').value, seat_baseline_monthly: $('#sseat').value, plans, prices } });
      const me = await api('/api/me');
      S.workspaces = me.workspaces;
      renderShell();
      toast('Settings saved');
    } catch (err) {
      toast(err.message, 'err');
    }
  };
}

// ---------- account ----------

async function viewAccount(el) {
  const me = await api('/api/me');
  S.workspaces = me.workspaces;
  const ws = me.workspaces;
  el.innerHTML = `<div class="grid2">
      <div class="card"><h2>Profile</h2><p class="sub">Signed in as ${esc(me.user.email)}.</p>
        <label class="field"><span>Name</span><input type="text" id="acc-name" value="${esc(me.user.name)}"/></label>
        <div class="row" style="margin-top:12px"><button class="btn primary" id="acc-save">Save</button></div></div>
      <div class="card"><h2>Password</h2><p class="sub">Changing it signs out every other device.</p>
        <label class="field"><span>Current password</span><input type="password" id="pw-cur" autocomplete="current-password"/></label>
        <label class="field"><span>New password</span><input type="password" id="pw-new" autocomplete="new-password"/><div class="hint">At least 8 characters.</div></label>
        <div class="row" style="margin-top:12px"><button class="btn primary" id="pw-save">Change password</button><button class="btn" id="logout-all">Sign out everywhere</button></div></div>
    </div>
    <div class="card"><h2>Your workspaces</h2><p class="sub">Leaving a workspace revokes your keys there and removes any plans you connected to it.</p>
      <table><tbody>${ws
        .map((w) => `<tr data-ws="${w.id}"><td><b>${esc(w.name)}</b></td><td><span class="tag">${esc(w.role)}</span></td><td class="num">${w.role === 'owner' ? '<span class="muted small">Owners transfer or delete under Settings</span>' : '<button class="btn sm danger" data-leave>Leave</button>'}</td></tr>`)
        .join('')}</tbody></table></div>
    <div class="card" style="border-color:color-mix(in srgb, var(--critical-mark) 40%, var(--border))"><h2>Delete account</h2><p class="sub">Removes your login and takes you out of every workspace. Workspaces you own must be transferred or deleted first (unless you're their only member).</p>
      <button class="btn danger" id="acc-delete">Delete my account…</button></div>`;
  $('#acc-save').onclick = async () => {
    try {
      await api('/api/me', { method: 'PATCH', body: { name: $('#acc-name').value } });
      S.me.name = $('#acc-name').value.trim();
      renderShell();
      toast('Saved');
    } catch (err) {
      toast(err.message, 'err');
    }
  };
  $('#pw-save').onclick = async () => {
    try {
      await api('/api/me/password', { method: 'POST', body: { current: $('#pw-cur').value, next: $('#pw-new').value } });
      $('#pw-cur').value = $('#pw-new').value = '';
      toast('Password changed. Other devices were signed out.');
    } catch (err) {
      toast(err.message, 'err');
    }
  };
  $('#logout-all').onclick = async () => {
    if (!(await confirmBox('Sign out everywhere?', 'Every other browser and device will need to log in again. This one stays signed in.', 'Sign out everywhere'))) return;
    await api('/api/me/logout-all', { method: 'POST' });
    toast('Other sessions were signed out');
  };
  el.querySelectorAll('[data-leave]').forEach(
    (b) =>
      (b.onclick = async () => {
        const id = Number(b.closest('tr').dataset.ws);
        const w = ws.find((x) => x.id === id);
        if (!(await confirmBox(`Leave ${w.name}?`, 'Your keys there stop working right away and any plans you connected leave that pool.', 'Leave', true))) return;
        try {
          await api(`/api/w/${id}/leave`, { method: 'POST' });
          toast(`You left ${w.name}`);
          const fresh = await api('/api/me');
          S.workspaces = fresh.workspaces;
          if (!S.workspaces.length) return location.reload();
          if (id === S.wsId) location.hash = `#/w/${S.workspaces[0].id}/overview`;
          else render();
        } catch (err) {
          toast(err.message, 'err');
        }
      }),
  );
  $('#acc-delete').onclick = () => {
    const d = modal(`<h3>Delete your account?</h3><p class="ink2">Your login is removed and you leave every workspace. This cannot be undone. Enter your password to confirm.</p>
      <label class="field"><span>Password</span><input type="password" id="del-pw" autocomplete="current-password"/></label>
      <div class="actions"><button class="btn" data-close>Cancel</button><button class="btn danger" id="del-go">Delete account</button></div>`);
    d.querySelector('#del-go').onclick = async () => {
      try {
        await api('/api/me', { method: 'DELETE', body: { password: d.querySelector('#del-pw').value } });
        location.href = './';
      } catch (err) {
        toast(err.message, 'err');
      }
    };
  };
}

const VIEWS = { overview: viewOverview, capacity: viewCapacity, keys: viewKeys, plans: viewPlans, members: viewMembers, usage: viewUsage, setup: viewSetup, billing: viewBilling, settings: viewSettings, account: viewAccount };

// Refresh live pages every 30s while visible (not while a dialog is open).
setInterval(() => {
  if (document.visibilityState === 'visible' && !$('#modal').open && ['overview', 'capacity', 'usage'].includes(S.page)) render();
}, 30000);

boot().catch((err) => ($('#content').innerHTML = `<div class="notice err">${esc(err.message)}</div>`));
