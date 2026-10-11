// Builds the public, static demo of AI Pool (for GitHub Pages) into site/dist.
// It reuses the real app's frontend (app/public) and swaps the server for an
// in-browser simulation (site/demo/demo-api.js). Run: node site/build.mjs
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const src = join(root, 'app', 'public');
const dist = join(here, 'dist');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
cpSync(src, dist, { recursive: true });
cpSync(join(root, 'app', 'lib', 'pricing.mjs'), join(dist, 'pricing.mjs'));
cpSync(join(here, 'demo', 'demo-api.js'), join(dist, 'demo-api.js'));
cpSync(join(here, 'demo', 'demo-signin.html'), join(dist, 'demo-signin.html'));

const edit = (file, fn) => writeFileSync(join(dist, file), fn(readFileSync(join(dist, file), 'utf8')));
const must = (s, a, b) => {
  if (!s.includes(a)) throw new Error(`build: expected to find ${JSON.stringify(a.slice(0, 60))}`);
  return s.replace(a, b);
};

// Every page loads the simulated backend before any app code runs.
const SHIM = '<link rel="stylesheet" href="style.css" />\n  <script type="module" src="demo-api.js"></script>\n  <style>body{padding-bottom:72px}</style>';
for (const f of readdirSync(dist).filter((f) => f.endsWith('.html') && f !== 'demo-signin.html')) {
  edit(f, (s) => must(s, '<link rel="stylesheet" href="style.css" />', SHIM));
}

edit('landing.html', (s) => {
  s = must(s, '>Start your 7-day trial</a>', '>Try the interactive demo</a>');
  s = must(s, '<div class="eyebrow">For teams on Claude &amp; ChatGPT</div>', '<div class="eyebrow">Concept preview · for teams on Claude &amp; ChatGPT</div>');
  s = must(s, '<p class="lede" style="margin:0 auto 22px">Free for 7 days. No card needed.</p>', '<p class="lede" style="margin:0 auto 22px">This is a concept preview. Click through the demo, then tell us what you think.</p>');
  return s;
});
edit('auth.html', (s) =>
  must(s, '<p id="err"', '<p class="hint" style="margin-top:12px">Demo: use any made-up email and password. They\'re stored only in this browser.</p>\n        <p id="err"'),
);
edit('docs.html', (s) => must(s, 'const base = location.origin;', "const base = 'https://ai.yourcompany.com';"));

// Clean URLs: GitHub Pages serves /foo from foo.html.
cpSync(join(dist, 'landing.html'), join(dist, 'index.html'));
cpSync(join(dist, 'auth.html'), join(dist, 'login.html'));
cpSync(join(dist, 'auth.html'), join(dist, 'signup.html'));
writeFileSync(join(dist, '.nojekyll'), '');
console.log('built', readdirSync(dist).length, 'files into', dist);
