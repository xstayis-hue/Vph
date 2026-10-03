export class CryptoPayClient {
  constructor({ token, baseUrl }, fetchImpl = fetch) {
    this.token = token;
    this.baseUrl = baseUrl;
    this.fetch = fetchImpl;
  }
  async call(method, { query, body } = {}) {
    const url = new URL(`${this.baseUrl}/${method}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        url.searchParams.set(key, String(value));
      }
    }
    const response = await this.fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: {
        'Crypto-Pay-API-Token': this.token,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000)
    });
    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error(`Crypto Pay returned invalid JSON (${response.status})`);
    }
    if (!response.ok || result?.ok !== true) {
      throw new Error(`Crypto Pay ${method} failed (${response.status})`);
    }
    return result.result;
  }

  createInvoice({ amount, payload, description }) {
    return this.call('createInvoice', {
      body: {
        asset: 'USDT',
        amount,
        payload,
        description,
        allow_comments: false,
        allow_anonymous: false,
        expires_in: 3600
      }
    });
  }

  async getInvoice(invoiceId) {
    const result = await this.call('getInvoices', { query: { invoice_ids: invoiceId } });
    const items = Array.isArray(result) ? result : result?.items;
    return Array.isArray(items) ? items[0] || null : null;
  }
}
