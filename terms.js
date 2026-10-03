async function loadTermsDetails() {
  const response = await fetch('/api/terms', { cache: 'no-store' });
  if (!response.ok) throw new Error(`Terms endpoint returned HTTP ${response.status}`);
  const details = await response.json();

  document.getElementById('version').textContent = details.version || 'не опубликована';
  document.getElementById('footer-version').textContent = details.version || '—';
  document.getElementById('operator-name').textContent =
    details.operatorName || 'реквизиты ещё не настроены';
  document.getElementById('operator-email').textContent =
    details.operatorEmail || 'не указана';
  document.getElementById('support-contact').textContent =
    details.supportContact || 'не указана';
  document.getElementById('setup-note').hidden =
    Boolean(details.operatorName && details.operatorEmail);
}

loadTermsDetails().catch((error) => {
  console.error('[vph] terms details could not be loaded', error);
  document.getElementById('version').textContent = 'не удалось загрузить';
  document.getElementById('setup-note').hidden = false;
});
