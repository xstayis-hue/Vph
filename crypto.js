let selectedDays = 30;
let cryptoReady = false;
let termsReady = false;
let selectedPlans = new Map();
let pollTimer = null;

function setStatus(message, isError = false) {
  const status = document.getElementById('status');
  status.textContent = message;
  status.classList.toggle('error', isError);
}

async function apiRequest(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body) headers.set('Content-Type', 'application/json');
  const response = await fetch(path, { ...options, headers, cache: 'no-store' });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(body?.error || `HTTP_${response.status}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

function updateButton() {
  const plan = selectedPlans.get(selectedDays);
  const button = document.getElementById('buy-button');
  const termsAccepted = document.getElementById('terms-checkbox').checked;
  button.disabled = !cryptoReady || !termsReady || !termsAccepted || !plan ||
    Boolean(pollTimer) || button.dataset.busy === 'true';
  button.textContent = plan?.amount
    ? `Оплатить ${plan.amount} USDT`
    : 'Оплата пока недоступна';
}

function renderTerms(policy) {
  const checkbox = document.getElementById('terms-checkbox');
  const link = document.getElementById('terms-link');
  const unavailable = document.getElementById('terms-unavailable');
  termsReady = Boolean(policy.available && policy.url && policy.version);
  checkbox.disabled = !termsReady;
  link.hidden = !termsReady;
  unavailable.hidden = termsReady;
  if (termsReady) link.href = policy.url;
  updateButton();
}

function renderOrder(order) {
  const link = document.getElementById('invoice-link');
  const key = document.getElementById('subscription-key');
  const copyButton = document.getElementById('copy-button');
  const retryButton = document.getElementById('retry-button');
  const hasCurrentSubscription = Boolean(
    order.subscriptionUrl && Number(order.expiresAt) > Date.now()
  );

  if (hasCurrentSubscription) {
    key.textContent = order.subscriptionUrl;
    key.classList.add('show');
    copyButton.hidden = false;
  } else {
    key.classList.remove('show');
    key.textContent = '';
    copyButton.hidden = true;
  }

  if (order.status === 'none') {
    link.hidden = true;
    retryButton.hidden = true;
    setStatus('Выбери срок и создай счёт для продолжения.');
  } else if (order.status === 'pending') {
    setStatus('Ожидаю подтверждение оплаты в Crypto Pay…');
    retryButton.hidden = true;
  } else if (order.status === 'provisioning' || order.status === 'paid') {
    setStatus('Платёж подтверждён. Выдаю доступ к VPN…');
    retryButton.hidden = true;
  } else if (order.status === 'provisioning_failed') {
    setStatus('Платёж прошёл, но VPN-узел временно не выдал доступ. Нажми «Повторить выдачу».', true);
    retryButton.hidden = false;
  } else if (order.status === 'fulfilled' && order.subscriptionUrl) {
    setStatus(`Доступ активен до ${new Date(order.expiresAt).toLocaleDateString('ru-RU')}.`);
    key.textContent = order.subscriptionUrl;
    key.classList.add('show');
    copyButton.hidden = false;
    retryButton.hidden = true;
    if (pollTimer) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
  } else if (order.status === 'expired' || order.status === 'failed') {
    setStatus('Счёт истёк или не был создан. Выбери тариф и попробуй ещё раз.', true);
    link.hidden = true;
    retryButton.hidden = true;
    if (pollTimer) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
  }
  updateButton();
}

async function checkOrder() {
  const order = await apiRequest('/api/crypto/order');
  renderOrder(order);
  return order;
}

function beginPolling() {
  if (pollTimer) window.clearInterval(pollTimer);
  pollTimer = window.setInterval(() => {
    checkOrder().catch((error) => {
      console.error('[vph] crypto payment status check failed', error);
      setStatus('Не удалось проверить оплату. Обнови страницу, чтобы продолжить.', true);
    });
  }, 3000);
}

async function createInvoice() {
  const button = document.getElementById('buy-button');
  const termsCheckbox = document.getElementById('terms-checkbox');
  if (!termsReady || !termsCheckbox.checked) {
    setStatus('Сначала ознакомься с условиями и подтверди согласие.', true);
    return;
  }
  button.disabled = true;
  button.dataset.busy = 'true';
  try {
    const result = await apiRequest('/api/crypto/orders', {
      method: 'POST',
      body: JSON.stringify({ days: selectedDays, termsAccepted: true })
    });
    termsCheckbox.checked = false;
    const link = document.getElementById('invoice-link');
    link.href = result.checkoutUrl;
    link.hidden = false;
    setStatus('Счёт создан. Открой Crypto Pay и заверши оплату.');
    beginPolling();
  } catch (error) {
    console.error('[vph] crypto checkout failed', error);
    setStatus(error.status === 503
      ? 'Криптооплата ещё не настроена.'
      : 'Не удалось создать счёт. Попробуй позже.', true);
  } finally {
    button.dataset.busy = 'false';
    updateButton();
  }
}

async function retryProvisioning() {
  const button = document.getElementById('retry-button');
  button.disabled = true;
  try {
    renderOrder(await apiRequest('/api/crypto/order/retry', { method: 'POST' }));
  } catch (error) {
    console.error('[vph] crypto provisioning retry failed', error);
    setStatus('Не удалось повторить выдачу. Попробуй ещё раз позже.', true);
  } finally {
    button.disabled = false;
  }
}

async function copySubscription() {
  const key = document.getElementById('subscription-key').textContent;
  if (!key) return;
  try {
    await navigator.clipboard.writeText(key);
    setStatus('Ссылка скопирована. Не пересылай её другим.');
  } catch (error) {
    console.warn('[vph] clipboard access failed', error.message);
    setStatus('Не удалось скопировать. Выдели ссылку и скопируй вручную.', true);
  }
}

document.querySelectorAll('.plan').forEach((button) => {
  button.addEventListener('click', () => {
    selectedDays = Number(button.dataset.days);
    document.querySelectorAll('.plan').forEach((plan) => {
      const selected = plan === button;
      plan.classList.toggle('selected', selected);
      plan.setAttribute('aria-pressed', String(selected));
    });
    updateButton();
  });
});
document.getElementById('buy-button').addEventListener('click', createInvoice);
document.getElementById('retry-button').addEventListener('click', retryProvisioning);
document.getElementById('copy-button').addEventListener('click', copySubscription);
document.getElementById('terms-checkbox').addEventListener('change', updateButton);

async function initialize() {
  try {
    const [result, policy] = await Promise.all([
      apiRequest('/api/crypto/plans'),
      apiRequest('/api/terms')
    ]);
    renderTerms(policy);
    cryptoReady = result.cryptoReady;
    for (const plan of result.plans) {
      selectedPlans.set(plan.days, plan);
      document.getElementById(`price-${plan.days}`).textContent = plan.amount
        ? `${plan.amount} ${plan.asset}`
        : 'Цена не настроена';
    }
    updateButton();
    try {
      const order = await checkOrder();
      if (['pending', 'paid', 'provisioning'].includes(order.status)) beginPolling();
    } catch (error) {
      if (error.status !== 401 && error.status !== 404) throw error;
    }
  } catch (error) {
    console.error('[vph] crypto checkout setup failed', error);
    setStatus(error.status === 404
      ? 'Внешний checkout должен открываться по отдельному адресу оплаты.'
      : 'Криптооплата пока недоступна. Сервер ещё не настроен.', true);
    updateButton();
  }
}

initialize().catch((error) => {
  console.error('[vph] crypto checkout failed to initialize', error);
  setStatus('Не удалось загрузить страницу оплаты.', true);
});
