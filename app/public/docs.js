const base = location.origin;
document.querySelectorAll('code.base').forEach((e) => (e.textContent = base));
document.querySelectorAll('code.base-v1').forEach((e) => (e.textContent = base + '/v1'));
document.querySelector('.setup-cmd').textContent = `curl -fsSL ${base}/setup.sh | sh`;
document.querySelector('.claude-json').textContent = JSON.stringify({ env: { ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: 'aip_…' } }, null, 2);
document.querySelector('.codex-toml').textContent = `model_provider = "aipool"\n\n[model_providers.aipool]\nname = "AI Pool"\nbase_url = "${base}/v1"\nenv_key = "AIPOOL_API_KEY"\nwire_api = "responses"`;
