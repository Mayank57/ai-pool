// Drives the static demo (site/dist) through the admin and employee journey in
// headless Chrome, served the way GitHub Pages serves it (under a sub-path).
//   node site/build.mjs && node site/test/demo-flow.mjs [screenshot-dir]
// Set BASE_URL to run against the live site instead of a local server.
import { spawn } from 'node:child_process';
import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFile as _rf, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, '..', 'dist');
const out = process.argv[2];
if (out) mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME = [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && existsSync(p));
if (!CHROME) {
  console.error('No Chrome found. Set CHROME_BIN.');
  process.exit(2);
}

// Static server that mimics GitHub Pages: /ai-pool/foo -> foo.html.
let server;
let B = process.env.BASE_URL;
if (!B) {
  if (!existsSync(join(dist, 'index.html'))) {
    console.error('site/dist is missing. Run: node site/build.mjs');
    process.exit(2);
  }
  const T = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };
  server = http.createServer(async (req, res) => {
    let p = new URL(req.url, 'http://x').pathname;
    if (!p.startsWith('/ai-pool/')) return res.writeHead(404).end();
    p = p.slice('/ai-pool/'.length) || 'index.html';
    for (const c of [p, p + '.html']) {
      try {
        const d = await readFile(join(dist, c));
        res.writeHead(200, { 'content-type': T[extname(c)] || 'application/octet-stream' });
        return res.end(d);
      } catch {}
    }
    res.writeHead(404).end('404');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  B = `http://127.0.0.1:${server.address().port}/ai-pool/`;
}
if (!B.endsWith('/')) B += '/';

const port = 9400 + Math.floor(Math.random() * 400);
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'aipool-chrome-'))}`, '--no-first-run', '--no-sandbox', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
let list;
for (let i = 0; i < 100; i++) {
  try {
    list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    if (list.find((t) => t.type === 'page')) break;
  } catch {}
  await sleep(200);
}
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
const errors = [];
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) {
    pending.get(d.id)(d);
    pending.delete(d.id);
  }
  if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
  if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errors.push(JSON.stringify(d.params.args.map((a) => a.value)));
  if (d.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true });
};
const send = (method, params = {}) =>
  new Promise((r) => {
    const i = ++id;
    pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

// Evaluates in the page; a trailing navigation is scheduled via setTimeout so the eval returns first.
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true });
  if (!r.result) throw new Error('page went away');
  if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval error');
  return r.result.result.value;
};
const nav = async (p, w = 1500) => {
  await send('Page.navigate', { url: p.startsWith('http') ? p : B + p });
  await sleep(w);
};
const shot = async (name) => {
  if (!out) return;
  const h = await ev('return document.documentElement.scrollHeight');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: Math.min(h, 3200), deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  const s = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(out, `${name}.png`), Buffer.from(s.result.data, 'base64'));
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
};
const sampleWs = () => ev(`const r = await (await fetch('/api/me')).json(); return r.workspaces.find(w=>w.name.includes('sample')).id`);

const log = [];
const step = async (name, fn) => {
  try {
    const v = await fn();
    log.push(`✓ ${name}${v !== undefined ? ' — ' + JSON.stringify(v).slice(0, 110) : ''}`);
  } catch (e) {
    log.push(`✗ ${name} — ${e.message}`);
  }
};

await step('landing loads with demo bar', async () => {
  await nav('');
  await ev(`localStorage.clear(); return 1`);
  await nav('');
  return ev(`return !!document.getElementById('demo-bar') && document.querySelector('.btn.primary.lg').textContent`);
});
await step('signup as admin', async () => {
  await nav('signup');
  await ev(`const f=document.getElementById('form'); f.name.value='Asha Admin'; f.email.value='asha@example.com'; f.password.value='demo-password'; f.workspace_name.value='Asha Co'; setTimeout(()=>f.requestSubmit(),50); return 1;`);
  await sleep(2500);
  return ev('return location.hash');
});
await step('fresh workspace shows checklist and collecting state', async () => ev(`return document.querySelectorAll('.check-item').length + ' steps; ' + [...document.querySelectorAll('.card h2')].map(h=>h.textContent).slice(0,2).join(' | ')`));
await shot('1-fresh-overview');
await step('connect a plan (simulated sign-in)', async () =>
  ev(`document.querySelector('[data-act=plan]').click(); await new Promise(r=>setTimeout(r,400));
    document.getElementById('next').click(); await new Promise(r=>setTimeout(r,800));
    const a=document.querySelector('#cbody a.btn'); const u=new URL(a.href); const state=u.searchParams.get('state');
    localStorage.setItem('aipool_demo_oauth_'+state, JSON.stringify({email:'asha-claude@example.com', plan:'claude-max-20x'}));
    await new Promise(r=>setTimeout(r,3000)); return document.querySelector('#cbody').innerText.slice(0,60);`),
);
await step('create + test a key', async () => {
  await ev(`setTimeout(()=>{location.hash='#/w/'+location.hash.match(/w\\/(\\d+)/)[1]+'/keys'},10); return 1`);
  await sleep(1500);
  return ev(`document.getElementById('new-key').click(); await new Promise(r=>setTimeout(r,400)); document.getElementById('kname').value='My laptop'; document.getElementById('kcreate').click(); await new Promise(r=>setTimeout(r,800));
    document.getElementById('ktest').click(); await new Promise(r=>setTimeout(r,3500)); return document.getElementById('ktest-out').innerText;`);
});
await shot('2-key-modal');
await step('invite link', async () => {
  await ev(`setTimeout(()=>{location.hash='#/w/'+location.hash.match(/w\\/(\\d+)/)[1]+'/members'},10); return 1`);
  await sleep(1500);
  return ev(`document.getElementById('inv').click(); await new Promise(r=>setTimeout(r,300)); document.getElementById('iemail').value='bo@example.com'; document.getElementById('icreate').click(); await new Promise(r=>setTimeout(r,800)); const t=document.querySelector('#iout pre').innerText.replace('Copy','').trim(); localStorage.setItem('__inv', t); return t;`);
});
const invite = await ev(`return localStorage.getItem('__inv')`);
await step('sample workspace has data and insights', async () => {
  await nav('pricing', 500);
  const id = await sampleWs();
  await nav(`app#/w/${id}/overview`, 2500);
  return ev(`return document.querySelector('.hero-kpi .value').textContent + ' saved; insights: ' + [...document.querySelectorAll('.check-item .what b')].map(b=>b.textContent).join(' / ')`);
});
await shot('3-sample-overview');
await step('capacity and account pages render', async () => {
  const id = await sampleWs();
  await nav(`app#/w/${id}/capacity`, 1800);
  await shot('4-sample-capacity');
  const cap = await ev(`return document.querySelectorAll('tbody tr').length`);
  await nav(`app#/w/${id}/account`, 1500);
  await shot('5-account');
  const acc = await ev(`return document.getElementById('acc-name').value + ' / ' + document.querySelectorAll('[data-leave]').length + ' leave buttons'`);
  return { plans: cap, account: acc };
});
await step('employee joins via invite (email locked to the invite)', async () => {
  await nav(invite, 1500);
  const banner = await ev(`return document.getElementById('invite-banner').innerText.slice(0,60)`);
  await ev(`setTimeout(()=>document.getElementById('out').click(),50); return 1`);
  await sleep(2000);
  const locked = await ev(`const e=document.querySelector('input[name=email]'); return e.readOnly + ':' + e.value`);
  await ev(`const f=document.getElementById('form'); f.name.value='Bo Employee'; f.password.value='demo-password'; setTimeout(()=>f.requestSubmit(),50); return 1`);
  await sleep(2500);
  return { banner, locked, hash: await ev('return location.hash') };
});
await step('employee view: member nav, welcome steps', async () => ev(`return [...document.querySelectorAll('#nav a')].map(a=>a.textContent.trim()).join(',') + ' | ' + document.querySelector('.card h2').textContent`));
await shot('6-employee-overview');
await step('employee cannot see others\' private plans on capacity', async () => {
  const id = await sampleWs().catch(() => null);
  // Bo isn't in the sample workspace; use the real one: Asha Co has only Asha's shared plan.
  return ev(`const r = await (await fetch('/api/w/' + location.hash.match(/w\\/(\\d+)/)[1] + '/capacity')).json(); return r.accounts.map(a=>a.email+':'+a.visibility).join(',')`);
});
await step('switch back to admin via demo bar', async () => {
  await ev(`const s=document.getElementById('demo-switch'); s.value=[...s.options].find(o=>o.text.startsWith('Asha')).value; setTimeout(()=>s.dispatchEvent(new Event('change')),50); return 1;`);
  await sleep(2500);
  return ev(`return document.querySelector('#me').innerText.split('\\n')[0]`);
});

console.log(log.join('\n'));
console.log('page errors:', errors.length ? errors : 'none');
ws.close();
chrome.kill();
server?.close();
const failed = log.filter((l) => l.startsWith('✗')).length + (errors.length ? 1 : 0);
process.exit(failed ? 1 : 0);
