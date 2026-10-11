// Client for the CLIProxyAPI v8 management API (see CLIProxyAPI/docs/management-api-v8.md).

export class CPA {
  constructor({ baseUrl, managementKey }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.key = managementKey;
  }

  async call(method, path, body) {
    const res = await fetch(`${this.baseUrl}/v8/management${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.key}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const msg = (data && data.error) || text || res.statusText;
      throw Object.assign(new Error(`proxy ${method} ${path.split('?')[0]} -> ${res.status}: ${msg}`), { status: res.status });
    }
    return data;
  }

  // Usage events are popped: only one consumer may read the queue.
  popUsage(count = 1000) {
    return this.call('GET', `/observability/usage/queue?count=${count}`);
  }

  async listCredentials() {
    const data = await this.call('GET', '/credentials');
    return (data && data.files) || [];
  }

  // Sets arbitrary top-level fields in an OAuth credential file (e.g. prefix, priority).
  patchCredential(name, fields) {
    return this.call('PATCH', '/credentials/fields', { name, ...fields });
  }

  setCredentialDisabled(name, disabled) {
    return this.call('PATCH', '/credentials/status', { name, disabled });
  }

  deleteCredential(name) {
    return this.call('DELETE', `/credentials?name=${encodeURIComponent(name)}`);
  }

  patchConfig(partial) {
    return this.call('PATCH', '/config', partial);
  }

  async getClientKeys() {
    const data = await this.call('GET', '/config/access/api-keys');
    return Array.isArray(data) ? data : [];
  }

  setClientKeys(keys) {
    return this.call('PUT', '/config/access/api-keys', keys);
  }

  // Upstream API-key groups (provider = claude | codex).
  async getProviderKeys(provider) {
    try {
      const data = await this.call('GET', `/config/api-keys/${provider}`);
      return Array.isArray(data) ? data : [];
    } catch (err) {
      if (err.status === 404) return [];
      throw err;
    }
  }

  setProviderKeys(provider, groups) {
    return this.call('PUT', `/config/api-keys/${provider}`, groups);
  }

  startOAuth(provider) {
    // is_webui=true: the proxy listens on the provider's localhost callback port
    // (54545 Claude, 1455 Codex) so same-machine logins finish automatically.
    return this.call('GET', `/oauth/auth-url?provider=${encodeURIComponent(provider)}&is_webui=true`);
  }

  oauthStatus(state) {
    return this.call('GET', `/oauth/status?state=${encodeURIComponent(state)}`);
  }

  submitOAuthRedirect(redirectUrl) {
    return this.call('POST', '/oauth/callback', { redirect_url: redirectUrl });
  }
}
