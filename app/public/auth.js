import { api, esc } from './common.js';
const path = location.pathname;
const params = new URLSearchParams(location.search);
const inviteToken = (params.get('invite') || '').replace(/[^A-Za-z0-9-]/g, '') || null;
let mode = /\/login(\.html)?$/.test(path) || params.get('mode') === 'login' ? 'login' : 'signup';
const $ = (s) => document.querySelector(s);

function apply() {
  document.querySelectorAll('[data-mode="signup"]').forEach((el) => el.classList.toggle('hidden', mode !== 'signup'));
  document.querySelectorAll('[data-hide-invite]').forEach((el) => inviteToken && el.classList.add('hidden'));
  $('input[name=password]').autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
  if (inviteToken) {
    $('#title').textContent = mode === 'signup' ? 'Create your login' : 'Log in to join';
    $('#subtitle').textContent = mode === 'signup' ? 'You only need this once. It works for every workspace you join.' : 'Use your existing AI Pool login.';
    $('#submit').textContent = mode === 'signup' ? 'Create login & join' : 'Log in & join';
    $('#switch').innerHTML = mode === 'signup' ? 'Already have an AI Pool login? <a href="#" id="sw">Log in</a>' : 'New to AI Pool? <a href="#" id="sw">Create a login</a>';
  } else if (mode === 'signup') {
    $('#title').textContent = 'Create your workspace';
    $('#subtitle').textContent = 'Start a 7-day free trial. No card needed.';
    $('#submit').textContent = 'Create workspace';
    $('#switch').innerHTML = 'Already have an account? <a href="login">Log in</a>';
  } else {
    $('#title').textContent = 'Welcome back';
    $('#subtitle').textContent = 'Log in to your AI Pool workspace.';
    $('#submit').textContent = 'Log in';
    $('#switch').innerHTML = 'New here? <a href="signup">Create a workspace</a>';
  }
  const sw = document.getElementById('sw');
  if (sw) sw.onclick = (e) => { e.preventDefault(); mode = mode === 'signup' ? 'login' : 'signup'; apply(); };
}

$('#form').onsubmit = async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  $('#err').classList.add('hidden');
  $('#submit').disabled = true;
  try {
    const r = await api(mode === 'signup' ? '/api/auth/signup' : '/api/auth/login', { method: 'POST', body: { ...f, invite_token: inviteToken || undefined } });
    location.href = r.redirect || 'app';
  } catch (err) {
    $('#err').textContent = err.message;
    $('#err').classList.remove('hidden');
    $('#submit').disabled = false;
  }
};

async function boot() {
  if (inviteToken) {
    try {
      const inv = await api(`/api/invites/${inviteToken}`);
      const b = $('#invite-banner');
      b.classList.remove('hidden');
      if (!inv.valid) {
        b.innerHTML = `<b>This invite can't be used.</b><div class="ink2 small">It was already used, revoked or has expired. Ask ${esc(inv.inviter)} for a new link.</div>`;
        $('#form').classList.add('hidden');
        $('#title').classList.add('hidden');
        $('#subtitle').classList.add('hidden');
        return;
      }
      b.innerHTML = `<div class="small muted">You're invited</div><div style="font-size:17px;font-weight:650">${esc(inv.inviter)} invited you to <span style="color:var(--accent)">${esc(inv.workspace)}</span></div><div class="ink2 small">as ${inv.role === 'admin' ? 'an admin' : 'a member'}. You'll get your own key for Claude Code, Codex and other tools.</div>`;
      if (inv.email) {
        // The invite is bound to this address; it can't be used with another one.
        const em = $('input[name=email]');
        em.value = inv.email;
        em.readOnly = true;
        em.title = 'This invite was created for this address.';
      }
      if (inv.user) {
        // Already signed in: one click to join.
        $('#form').classList.add('hidden');
        $('#switch').classList.add('hidden');
        $('#title').textContent = 'Join workspace';
        $('#subtitle').textContent = '';
        $('#joined-as').classList.remove('hidden');
        $('#joined-as').innerHTML = `<button class="btn primary lg" style="width:100%" id="join">Join as ${esc(inv.user.name)}</button><p class="muted small" style="text-align:center">Not you? <a href="#" id="out">Log out</a></p>`;
        $('#join').onclick = async () => { const r = await api(`/api/invites/${inviteToken}`, { method: 'POST' }); location.href = r.redirect; };
        $('#out').onclick = async (e) => { e.preventDefault(); await api('/api/auth/logout', { method: 'POST' }); location.reload(); };
        return;
      }
    } catch {
      $('#invite-banner').classList.remove('hidden');
      $('#invite-banner').innerHTML = '<b>Invite not found.</b> Check the link or ask your admin for a new one.';
      $('#form').classList.add('hidden');
      return;
    }
  } else {
    try { await api('/api/me'); location.href = 'app'; return; } catch {}
  }
  apply();
  $(mode === 'signup' && !inviteToken ? 'input[name=name]' : 'input[name=email]').focus();
}
apply();
boot();
