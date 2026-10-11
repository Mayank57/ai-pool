import { api } from './common.js';
// Signed-in visitors go straight to their workspace.
api('/api/me').then(() => {
  document.getElementById('nav-login').classList.add('hidden');
  const cta = document.getElementById('nav-cta');
  cta.textContent = 'Open app';
  cta.href = 'app';
}).catch(() => {});

const state = { people: 10, cpro: 0, cmax5: 2, cmax20: 1, gplus: 2, gpro: 0 };
const price = { cpro: 20, cmax5: 100, cmax20: 200, gplus: 20, gpro: 200 };
const fmt = (n) => '$' + Math.round(n).toLocaleString();
function render() {
  document.querySelectorAll('.stepper').forEach((s) => (s.querySelector('output').value = state[s.dataset.k]));
  const cap = state.cpro + state.cmax5 * 5 + state.cmax20 * 20;
  const plans = state.cpro + state.cmax5 + state.cmax20 + state.gplus + state.gpro;
  const spend = Object.keys(price).reduce((s, k) => s + price[k] * state[k], 0);
  const fee = plans * 20;
  const seats = state.people * 120;
  document.getElementById('b-cap').textContent = cap ? `${cap}× Pro` : '—';
  document.getElementById('b-cap-foot').textContent = state.people ? `≈ ${(cap / state.people).toFixed(1)}× a Pro plan per person, shared` : '';
  document.getElementById('b-plans').textContent = fmt(spend);
  document.getElementById('b-fee').textContent = fmt(fee);
  document.getElementById('b-total').textContent = fmt(spend + fee);
  const diff = seats - (spend + fee);
  document.getElementById('b-seats').textContent = diff >= 0 ? `save ${fmt(diff)}/mo` : `${fmt(-diff)}/mo more`;
}
document.querySelectorAll('.stepper').forEach((s) => {
  const [minus, plus] = s.querySelectorAll('button');
  minus.onclick = () => { state[s.dataset.k] = Math.max(s.dataset.k === 'people' ? 1 : 0, state[s.dataset.k] - 1); render(); };
  plus.onclick = () => { state[s.dataset.k] = Math.min(200, state[s.dataset.k] + 1); render(); };
});
render();
