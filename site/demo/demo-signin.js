const p = new URLSearchParams(location.search);
const provider = p.get('provider') === 'codex' ? 'codex' : 'claude';
const state = (p.get('state') || '').replace(/[^A-Za-z0-9]/g, '');
document.getElementById('t').textContent = provider === 'claude' ? 'Connect a Claude plan (simulated)' : 'Connect a ChatGPT plan (simulated)';
const plans = provider === 'claude'
  ? [['claude-pro', 'Claude Pro'], ['claude-max-5x', 'Claude Max 5x'], ['claude-max-20x', 'Claude Max 20x']]
  : [['chatgpt-plus', 'ChatGPT Plus'], ['chatgpt-pro', 'ChatGPT Pro'], ['chatgpt-business', 'ChatGPT Business']];
document.getElementById('plan').innerHTML = plans.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
document.getElementById('f').onsubmit = (e) => {
  e.preventDefault();
  try {
    localStorage.setItem('aipool_demo_oauth_' + state, JSON.stringify({ email: document.getElementById('email').value, plan: document.getElementById('plan').value }));
  } catch {}
  document.getElementById('f').classList.add('hidden');
  document.getElementById('done').classList.remove('hidden');
  setTimeout(() => window.close(), 1200);
};
