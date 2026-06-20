// dialog.js — PWA standalone でも動く prompt / confirm / alert（HTML モーダル）

let _promptResolve = null;
let _confirmResolve = null;
let _alertResolve = null;
let _wired = false;

function $(id) {
  return document.getElementById(id);
}

function _wireOnce() {
  if (_wired) return;
  _wired = true;

  const promptModal = $('app-prompt-modal');
  const promptInput = $('app-prompt-input');
  const promptOk = $('app-prompt-ok');
  const promptCancel = $('app-prompt-cancel');

  const finishPrompt = (value) => {
    if (!_promptResolve) return;
    const resolve = _promptResolve;
    _promptResolve = null;
    promptModal.hidden = true;
    resolve(value);
  };

  promptOk?.addEventListener('click', () => {
    finishPrompt(promptInput.value);
  });
  promptCancel?.addEventListener('click', () => finishPrompt(null));
  promptInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finishPrompt(promptInput.value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finishPrompt(null);
    }
  });

  const confirmModal = $('app-confirm-modal');
  const confirmOk = $('app-confirm-ok');
  const confirmCancel = $('app-confirm-cancel');

  const finishConfirm = (value) => {
    if (!_confirmResolve) return;
    const resolve = _confirmResolve;
    _confirmResolve = null;
    confirmModal.hidden = true;
    resolve(value);
  };

  confirmOk?.addEventListener('click', () => finishConfirm(true));
  confirmCancel?.addEventListener('click', () => finishConfirm(false));
  confirmModal?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') finishConfirm(false);
  });

  const alertModal = $('app-alert-modal');
  const alertOk = $('app-alert-ok');

  const finishAlert = () => {
    if (!_alertResolve) return;
    const resolve = _alertResolve;
    _alertResolve = null;
    alertModal.hidden = true;
    resolve();
  };

  alertOk?.addEventListener('click', finishAlert);
  alertModal?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' || e.key === 'Enter') finishAlert();
  });
}

/**
 * @param {{ title?: string, label?: string, defaultValue?: string, okText?: string }} opts
 * @returns {Promise<string|null>}
 */
export function showPrompt(opts = {}) {
  _wireOnce();
  const modal = $('app-prompt-modal');
  const input = $('app-prompt-input');
  if (!modal || !input) return Promise.resolve(null);

  $('app-prompt-title').textContent = opts.title || '';
  $('app-prompt-label').textContent = opts.label || '';
  $('app-prompt-ok').textContent = opts.okText || 'OK';
  input.value = opts.defaultValue ?? '';

  return new Promise((resolve) => {
    _promptResolve = resolve;
    modal.hidden = false;
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  });
}

/**
 * @param {{ title?: string, message?: string, okText?: string, cancelText?: string, danger?: boolean }} opts
 * @returns {Promise<boolean>}
 */
export function showConfirm(opts = {}) {
  _wireOnce();
  const modal = $('app-confirm-modal');
  if (!modal) return Promise.resolve(false);

  $('app-confirm-title').textContent = opts.title || '確認';
  $('app-confirm-message').textContent = opts.message || '';
  $('app-confirm-ok').textContent = opts.okText || 'OK';
  $('app-confirm-cancel').textContent = opts.cancelText || 'キャンセル';
  $('app-confirm-ok').classList.toggle('danger', !!opts.danger);

  return new Promise((resolve) => {
    _confirmResolve = resolve;
    modal.hidden = false;
    $('app-confirm-ok')?.focus();
  });
}

/**
 * @param {{ title?: string, message?: string, okText?: string }} opts
 * @returns {Promise<void>}
 */
export function showAlert(opts = {}) {
  _wireOnce();
  const modal = $('app-alert-modal');
  if (!modal) return Promise.resolve();

  $('app-alert-title').textContent = opts.title || '';
  $('app-alert-message').textContent = opts.message || '';
  $('app-alert-ok').textContent = opts.okText || 'OK';

  return new Promise((resolve) => {
    _alertResolve = resolve;
    modal.hidden = false;
    $('app-alert-ok')?.focus();
  });
}
