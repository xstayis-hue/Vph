const telegramApp = window.Telegram && window.Telegram.WebApp;
const staticPreview = document.documentElement.dataset.deployment === 'static';
const selectedPlans = new Map();
let selectedDays = 30;
let currentSubscriptionUrl = null;
let starsReady = false;
let termsReady = false;

function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.style.display = 'block';
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    toast.style.display = 'none';
  }, 3000);
}

function setLog(message) {
  document.getElementById('term-log-txt').textContent = message;
}

function setAir(mode) {
  const hero = document.getElementById('hero');
  const subtitle = document.getElementById('node-sub');
  hero.classList.remove('air-idle', 'air-on', 'air-off');
  if (mode === 'active') {
    hero.classList.add('air-on');
    subtitle.textContent = 'subscription · active';
  } else if (mode === 'expired') {
    hero.classList.add('air-off');
    subtitle.textContent = 'subscription · expired';
  } else {
    hero.classList.add('air-idle');
    subtitle.textContent = 'node · waiting';
  }
}

async function apiRequest(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (telegramApp && telegramApp.initData) {
    headers.set('Authorization', `tma ${telegramApp.initData}`);
  }
  if (options.body) headers.set('Content-Type', 'application/json');

  const response = await fetch(path, { ...options, headers, cache: 'no-store' });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(body && body.error ? body.error : `HTTP_${response.status}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

function errorMessage(error) {
  if (error.status === 503) return 'Сервис ещё не настроен. Оплата пока недоступна.';
  if (error.status === 401) return 'Открой Vph из Telegram, чтобы подтвердить аккаунт.';
  if (error.status === 429) return 'Слишком много попыток. Попробуй через минуту.';
  return 'Не удалось связаться с сервером. Попробуй позже.';
}

function renderPlans(plans, available) {
  for (const plan of plans) {
    selectedPlans.set(plan.days, plan);
    const price = document.getElementById(`price-${plan.days}`);
    if (price) price.textContent = plan.stars ? `${plan.stars} ⭐` : 'Цена не настроена';
  }
  starsReady = available && plans.length > 0 && plans.every((plan) => plan.stars);
  updateBuyButton();
}

function updateBuyButton() {
  const buyButton = document.getElementById('buy-btn');
  const termsCheckbox = document.getElementById('terms-checkbox');
  const plan = selectedPlans.get(selectedDays);
  const ready = Boolean(
    starsReady && plan && telegramApp && telegramApp.initData &&
    termsReady && termsCheckbox.checked &&
    buyButton.dataset.busy !== 'true'
  );
  buyButton.disabled = !ready;
  buyButton.textContent = plan && plan.stars
    ? `Оплатить ${plan.stars} ⭐`
    : 'Оплата пока недоступна';

  const hint = document.getElementById('payment-hint');
  if (staticPreview) {
    hint.textContent = 'Предпросмотр сайта: VPN-доступ и оплата пока не подключены.';
  } else if (!telegramApp || !telegramApp.initData) {
    hint.textContent = 'Открой приложение из Telegram, чтобы оплатить Stars.';
  } else if (!starsReady) {
    hint.textContent = 'Оплата включится после настройки бота, VPN-узла и тарифов.';
  } else if (!termsReady) {
    hint.textContent = 'Оплата включится после публикации условий сервиса и возврата.';
  } else if (!termsCheckbox.checked) {
    hint.textContent = 'Ознакомься с условиями и подтверди согласие перед оплатой.';
  } else {
    hint.textContent = 'Безопасная оплата Telegram Stars.';
  }
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
  updateBuyButton();
}

async function loadApiStatus() {
  const dot = document.getElementById('api-dot');
  const state = document.getElementById('api-state');
  const startedAt = performance.now();
  try {
    const health = await apiRequest('/api/health');
    const elapsed = Math.max(1, Math.round(performance.now() - startedAt));
    dot.classList.toggle('offline', !health.ok);
    state.textContent = health.ok ? `${elapsed} ms` : 'offline';
    setLog(health.vpnReady ? 'Vph API · online' : 'Vph API · VPN setup required');
  } catch (error) {
    dot.classList.add('offline');
    state.textContent = 'offline';
    setLog('Vph API · offline');
    console.warn('[vph] API health check failed', error.message);
  }
}

function renderSubscription(subscription) {
  const dot = document.getElementById('dot');
  const state = document.getElementById('state-text');
  const until = document.getElementById('until');
  const keyBox = document.getElementById('key-box');
  const keySerial = document.getElementById('key-serial');
  const copyButton = document.getElementById('copy-btn');
  const retryButton = document.getElementById('retry-btn');

  retryButton.hidden = true;
  copyButton.disabled = true;
  keyBox.classList.remove('show');
  keySerial.textContent = '';
  currentSubscriptionUrl = null;

  if (subscription.status === 'active' && subscription.subscriptionUrl) {
    dot.className = 'dot on';
    state.textContent = 'Активна';
    until.textContent = new Date(subscription.expiresAt).toLocaleDateString('ru-RU');
    keySerial.textContent = subscription.subscriptionUrl;
    currentSubscriptionUrl = subscription.subscriptionUrl;
    keyBox.classList.add('show');
    copyButton.disabled = false;
    setAir('active');
  } else if (subscription.status === 'expired') {
    dot.className = 'dot off';
    state.textContent = 'Истекла';
    until.textContent = subscription.expiresAt
      ? new Date(subscription.expiresAt).toLocaleDateString('ru-RU')
      : '—';
    setAir('expired');
  } else if (subscription.status === 'provisioning_failed') {
    dot.className = 'dot off';
    state.textContent = 'Оплата получена · доступ не создан';
    until.textContent = '—';
    retryButton.hidden = false;
    setAir('idle');
  } else if (subscription.status === 'provisioning') {
    dot.className = 'dot idle';
    state.textContent = 'Платёж получен · выдаю доступ';
    until.textContent = '—';
    setAir('idle');
  } else {
    dot.className = 'dot idle';
    state.textContent = 'Не активна';
    until.textContent = '—';
    setAir('idle');
  }
}

async function loadSubscription() {
  if (!telegramApp || !telegramApp.initData) {
    renderSubscription({ status: 'inactive' });
    return;
  }
  try {
    renderSubscription(await apiRequest('/api/me'));
  } catch (error) {
    if (error.status === 503) {
      renderSubscription({ status: 'inactive' });
      showToast('Сервер ещё не настроен.');
    } else {
      console.warn('[vph] subscription lookup failed', error.message);
    }
  }
}

async function pollSubscription() {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 1500));
    await loadSubscription();
    if (currentSubscriptionUrl) {
      showToast('Доступ активирован.');
      setLog('payment · access active');
      return;
    }
  }
  showToast('Платёж проверяется. Обнови экран через несколько секунд.');
  setLog('payment · awaiting confirmation');
}

async function requestAccess() {
  if (!telegramApp || !telegramApp.initData) {
    showToast('Для оплаты открой Vph в Telegram.');
    return;
  }
  const plan = selectedPlans.get(selectedDays);
  if (!starsReady || !plan || !plan.stars) {
    showToast('Оплата пока не настроена.');
    return;
  }
  const termsCheckbox = document.getElementById('terms-checkbox');
  if (!termsReady || !termsCheckbox.checked) {
    showToast('Сначала ознакомься с условиями и подтверди согласие.');
    return;
  }

  const button = document.getElementById('buy-btn');
  button.disabled = true;
  button.dataset.busy = 'true';
  setLog(`invoice · ${selectedDays}d`);
  try {
    const { invoiceUrl } = await apiRequest('/api/telegram/orders', {
      method: 'POST',
      body: JSON.stringify({ days: selectedDays, termsAccepted: true })
    });
    termsCheckbox.checked = false;
    if (typeof telegramApp.openInvoice !== 'function') {
      throw new Error('Telegram Stars invoice UI is not supported by this client');
    }
    telegramApp.openInvoice(invoiceUrl, (status) => {
      button.dataset.busy = 'false';
      updateBuyButton();
      if (status === 'paid') {
        setLog('payment · confirmed by Telegram');
        pollSubscription().catch((error) => {
          console.error('[vph] subscription refresh failed', error);
          showToast('Платёж прошёл. Не удалось обновить экран — открой его снова.');
        });
      } else if (status === 'failed') {
        setLog('payment · failed');
        showToast('Telegram не смог завершить оплату.');
      } else if (status === 'cancelled') {
        setLog('payment · cancelled');
      }
    });
  } catch (error) {
    button.dataset.busy = 'false';
    console.error('[vph] Stars checkout failed', error);
    showToast(errorMessage(error));
    setLog('invoice · unavailable');
  } finally {
    if (button.dataset.busy !== 'true') {
      button.dataset.busy = 'false';
    }
    updateBuyButton();
  }
}

async function copyKey() {
  if (!currentSubscriptionUrl) return;
  try {
    await navigator.clipboard.writeText(currentSubscriptionUrl);
    showToast('Ссылка скопирована.');
    setLog('subscription · copied');
  } catch (error) {
    console.warn('[vph] clipboard access failed', error.message);
    showToast('Не удалось скопировать. Выдели ссылку вручную.');
  }
}

async function retryProvisioning() {
  const button = document.getElementById('retry-btn');
  button.disabled = true;
  try {
    renderSubscription(await apiRequest('/api/subscription/retry', { method: 'POST' }));
    if (currentSubscriptionUrl) showToast('VPN-доступ выдан.');
  } catch (error) {
    console.error('[vph] provisioning retry failed', error);
    showToast(errorMessage(error));
  } finally {
    button.disabled = false;
  }
}

document.querySelectorAll('.plan').forEach((button) => {
  button.addEventListener('click', () => {
    selectedDays = Number(button.dataset.days);
    document.querySelectorAll('.plan').forEach((planButton) => {
      const selected = planButton === button;
      planButton.classList.toggle('selected', selected);
      planButton.setAttribute('aria-pressed', String(selected));
    });
    try {
      telegramApp?.HapticFeedback?.selectionChanged?.();
    } catch (error) {
      console.warn('[vph] Telegram haptic feedback is unavailable', error.message);
    }
    updateBuyButton();
    setLog(`plan · ${selectedDays}d`);
  });
});

document.getElementById('buy-btn').addEventListener('click', requestAccess);
document.getElementById('terms-checkbox').addEventListener('change', updateBuyButton);
document.getElementById('copy-btn').addEventListener('click', copyKey);
document.getElementById('retry-btn').addEventListener('click', retryProvisioning);

async function initialize() {
  if (telegramApp) {
    telegramApp.ready();
    telegramApp.expand();
  }
  if (staticPreview) {
    const dot = document.getElementById('api-dot');
    dot.classList.add('offline');
    document.getElementById('api-state').textContent = 'preview';
    document.getElementById('terms-consent').hidden = true;
    renderPlans([30, 90, 180].map((days) => ({ days, stars: null })), false);
    renderSubscription({ status: 'inactive' });
    setLog('Vph · static preview');
    updateBuyButton();
    return;
  }
  await Promise.all([
    loadApiStatus(),
    apiRequest('/api/plans')
      .then((result) => renderPlans(result.plans, result.starsReady))
      .catch((error) => {
        renderPlans([], false);
        console.warn('[vph] plans could not be loaded', error.message);
      }),
    apiRequest('/api/terms')
      .then(renderTerms)
      .catch((error) => {
        renderTerms({ available: false });
        console.warn('[vph] terms could not be loaded', error.message);
      }),
    loadSubscription()
  ]);
  updateBuyButton();
}

initialize().catch((error) => {
  console.error('[vph] application startup failed', error);
  showToast('Не удалось загрузить Vph.');
});
