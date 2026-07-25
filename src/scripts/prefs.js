/**
 * Consent-gated storage for the Ambi4 site — v4 contract
 * (docs/engine-v2-contract.md § "v4 addendum → Consent + storage").
 *
 * All persistence (localStorage under the 'ambi4:' namespace) is gated on an
 * explicit user decision. Before consent is granted, values live only in an
 * in-module memory Map (session-scoped); on the transition to granted the
 * memory layer is flushed into localStorage so nothing chosen pre-consent is
 * lost.
 *
 * The consent decision itself is recorded in a first-party cookie
 * 'ambi4-consent'. Rationale: the record of the user's consent choice is
 * "strictly necessary" — without it we could not honour a refusal, so it is
 * itself exempt from consent (the standard ePrivacy strictly-necessary
 * exemption).
 *
 * Pure module: no imports, import-time safe in bare node (all environment
 * access — document, localStorage, location — is lazy and guarded).
 */

const NAMESPACE = 'ambi4:';
const CONSENT_COOKIE = 'ambi4-consent';
const CONSENT_MAX_AGE = 31536000; // 1 year in seconds

/** Session-scoped fallback layer; also the only layer pre-consent. */
const memory = new Map();

/** container → pending Promise, for consentPrompt idempotency. */
const pendingPrompts = new WeakMap();

function getLocalStorage() {
  try {
    // typeof guard first (bare node); access itself can throw SecurityError
    // in sandboxed browsing contexts — treat both as "no storage".
    if (typeof localStorage === 'undefined' || localStorage === null) return null;
    return localStorage;
  } catch (_) {
    return null;
  }
}

function readConsent() {
  try {
    if (typeof document === 'undefined' || typeof document.cookie !== 'string') {
      return null;
    }
    const parts = document.cookie.split(';');
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed.indexOf(CONSENT_COOKIE + '=') === 0) {
        const value = trimmed.slice(CONSENT_COOKIE.length + 1);
        if (value === 'granted' || value === 'denied') return value;
        return null;
      }
    }
  } catch (_) {
    /* unreadable cookie jar → treated as unasked */
  }
  return null;
}

function writeConsentCookie(value) {
  try {
    if (typeof document === 'undefined') return;
    let cookie =
      CONSENT_COOKIE + '=' + value +
      '; Path=/; Max-Age=' + CONSENT_MAX_AGE + '; SameSite=Lax';
    try {
      if (typeof location !== 'undefined' && location.protocol === 'https:') {
        cookie += '; Secure';
      }
    } catch (_) { /* no location → no Secure flag */ }
    document.cookie = cookie;
  } catch (_) {
    /* cookie write refused → decision lives only for this page view */
  }
}

/** Flush everything chosen pre-consent into localStorage (on grant). */
function flushMemory() {
  const store = getLocalStorage();
  if (!store) return;
  for (const [key, value] of memory) {
    try {
      store.setItem(NAMESPACE + key, JSON.stringify(value));
      memory.delete(key);
    } catch (_) {
      /* quota/security — keep this entry in memory */
    }
  }
}

/** Remove every ambi4:-namespaced key; never touch anything else. */
function wipeNamespace() {
  const store = getLocalStorage();
  if (!store) return;
  try {
    const doomed = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key && key.indexOf(NAMESPACE) === 0) doomed.push(key);
    }
    for (const key of doomed) store.removeItem(key);
  } catch (_) {
    /* storage unavailable mid-wipe — nothing more we can do */
  }
}

export const prefs = {
  /** 'granted' | 'denied' | null (unasked). */
  consent() {
    return readConsent();
  },

  /** Persist the decision; grant flushes memory, denial wipes our namespace. */
  setConsent(granted) {
    writeConsentCookie(granted ? 'granted' : 'denied');
    if (granted) flushMemory();
    else wipeNamespace();
  },

  /** Returns true only when the value was persisted to localStorage. */
  set(key, value) {
    if (readConsent() === 'granted') {
      const store = getLocalStorage();
      if (store) {
        try {
          store.setItem(NAMESPACE + key, JSON.stringify(value));
          memory.delete(key); // memory is read first; don't shadow the store
          return true;
        } catch (_) {
          /* quota/security exceeded — degrade to memory silently */
        }
      }
    }
    memory.set(key, value);
    return false;
  },

  get(key) {
    if (memory.has(key)) return memory.get(key);
    const store = getLocalStorage();
    if (!store) return null;
    let raw = null;
    try {
      raw = store.getItem(NAMESPACE + key);
    } catch (_) {
      return null;
    }
    if (raw === null || raw === undefined) return null;
    try {
      return JSON.parse(raw);
    } catch (_) {
      try { store.removeItem(NAMESPACE + key); } catch (_) { /* ignore */ }
      return null;
    }
  },

  remove(key) {
    memory.delete(key);
    const store = getLocalStorage();
    if (store) {
      try { store.removeItem(NAMESPACE + key); } catch (_) { /* ignore */ }
    }
  },
};

function styleCard(card) {
  if (!card.style) return;
  card.style.background = 'var(--bg)';
  card.style.color = 'var(--text)';
  card.style.border = '1px solid var(--border)';
  card.style.borderRadius = 'var(--radius)';
  card.style.padding = '12px 16px';
  card.style.margin = '8px 0';
  card.style.font = 'inherit';
}

function styleButton(button, primary) {
  if (!button.style) return;
  button.style.font = 'inherit';
  button.style.padding = '6px 14px';
  button.style.borderRadius = 'var(--radius)';
  button.style.cursor = 'pointer';
  if (primary) {
    button.style.background = 'var(--link)';
    button.style.color = 'var(--bg)';
    button.style.border = '1px solid var(--link)';
  } else {
    button.style.background = 'transparent';
    button.style.color = 'var(--secondary)';
    button.style.border = '1px solid var(--border)';
  }
}

/**
 * Render an inline consent ask into `container`. Resolves with the user's
 * choice (true = granted) after calling prefs.setConsent() and removing the
 * card. Idempotent per container; short-circuits if consent is already
 * decided; resolves false without rendering outside a browser.
 */
export function consentPrompt(container, message) {
  const pending = container && typeof container === 'object'
    ? pendingPrompts.get(container)
    : undefined;
  if (pending) return pending;

  const decided = readConsent();
  if (decided !== null) return Promise.resolve(decided === 'granted');

  if (
    typeof document === 'undefined' ||
    typeof document.createElement !== 'function' ||
    !container ||
    typeof container.appendChild !== 'function'
  ) {
    return Promise.resolve(false);
  }

  const card = document.createElement('div');
  card.setAttribute('role', 'group');
  card.setAttribute('aria-label', message);
  card.setAttribute('tabindex', '-1');
  styleCard(card);

  const text = document.createElement('p');
  text.textContent = message;
  if (text.style) {
    text.style.margin = '0 0 10px';
    text.style.color = 'var(--text)';
  }
  card.appendChild(text);

  const row = document.createElement('div');
  if (row.style) {
    row.style.display = 'flex';
    row.style.gap = '8px';
    row.style.flexWrap = 'wrap';
  }

  const accept = document.createElement('button');
  accept.setAttribute('type', 'button');
  accept.textContent = 'Save on this device';
  styleButton(accept, true);

  const decline = document.createElement('button');
  decline.setAttribute('type', 'button');
  decline.textContent = 'No thanks';
  styleButton(decline, false);

  row.appendChild(accept);
  row.appendChild(decline);
  card.appendChild(row);

  const promise = new Promise((resolve) => {
    const finish = (granted) => {
      pendingPrompts.delete(container);
      prefs.setConsent(granted);
      if (typeof card.remove === 'function') card.remove();
      else if (card.parentNode && card.parentNode.removeChild) {
        card.parentNode.removeChild(card);
      }
      resolve(granted);
    };
    accept.addEventListener('click', () => finish(true));
    decline.addEventListener('click', () => finish(false));
  });

  pendingPrompts.set(container, promise);
  container.appendChild(card);
  try {
    if (typeof card.focus === 'function') card.focus({ preventScroll: true });
  } catch (_) { /* focus is best-effort */ }

  return promise;
}
