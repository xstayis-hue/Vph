export class MarzbanClient {
  constructor(config, fetchImpl = fetch) {
    this.config = config;
    this.fetch = fetchImpl;
    this.accessToken = null;
    this.tokenExpiresAt = 0;
  }
  async request(path, options = {}) {
    const response = await this.fetch(`${this.config.url}${path}`, {
      ...options,
      signal: AbortSignal.timeout(15000),
      headers: {
        ...(options.headers || {}),
        ...(this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {})
      }
    });
    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error(`Marzban returned invalid JSON (${response.status})`);
      }
    }
    return { response, body };
  }

  async authenticate() {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) return;
    const form = new URLSearchParams({
      username: this.config.username,
      password: this.config.password
    });
    const { response, body } = await this.request('/api/admin/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form
    });
    if (!response.ok || typeof body?.access_token !== 'string') {
      throw new Error(`Marzban authentication failed (${response.status})`);
    }
    this.accessToken = body.access_token;
    const lifetime = Number(body.expires_in) || 300;
    this.tokenExpiresAt = Date.now() + Math.max(30, lifetime - 30) * 1000;
  }

  async getUser(username) {
    await this.authenticate();
    const { response, body } = await this.request(`/api/user/${encodeURIComponent(username)}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Marzban user lookup failed (${response.status})`);
    return body;
  }

  async provision({ username, days, targetExpiresAt, accountId }) {
    await this.authenticate();
    const existing = await this.getUser(username);
    const expire = Math.ceil(targetExpiresAt / 1000);
    const payload = existing
      ? { expire, status: 'active' }
      : {
          username,
          status: 'active',
          expire,
          data_limit: 0,
          data_limit_reset_strategy: 'no_reset',
          proxies: { [this.config.protocol]: {} },
          inbounds: { [this.config.protocol]: [this.config.inbound] },
          note: `Vph account ${accountId}; ${days}-day subscription`
        };

    const path = existing
      ? `/api/user/${encodeURIComponent(username)}`
      : '/api/user';
    const { response, body } = await this.request(path, {
      method: existing ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!response.ok || typeof body?.subscription_url !== 'string' || !body.subscription_url) {
      throw new Error(`Marzban provisioning failed (${response.status})`);
    }
    return {
      subscriptionUrl: body.subscription_url,
      expiresAt: expire * 1000
    };
  }
}
