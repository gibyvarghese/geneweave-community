// Authentication related functions
import { api } from './api.js';
import { state } from './state.js';
import { h } from './dom.js';

function triggerRender() {
  (globalThis as any).render?.();
}

export async function doLogin(email: string, pass: string) {
  if (!email || !pass) {
    state.authError = 'Email and password are required';
    return;
  }

  try {
    const r = await api.post('/auth/login', { email, password: pass });
    if (r.ok) {
      const d = await r.json();
      state.user = d.user;
      state.csrfToken = d.csrfToken;
      await loadChatsAfterAuth();
      triggerRender();
    } else {
      const err = await r.json();
      state.authError = err.error || 'Login failed';
      triggerRender();
    }
  } catch (e: any) {
    state.authError = e.message || 'Login error';
    triggerRender();
  }
}

export async function doRegister(name: string, email: string, pass: string) {
  if (!name || !email || !pass) {
    state.authError = 'All fields are required';
    return;
  }

  try {
    const r = await api.post('/auth/register', { name, email, password: pass });
    if (r.ok) {
      const d = await r.json();
      state.user = d.user;
      state.csrfToken = d.csrfToken;
      await loadChatsAfterAuth();
      triggerRender();
    } else {
      const err = await r.json();
      state.authError = err.error || 'Registration failed';
      triggerRender();
    }
  } catch (e: any) {
    state.authError = e.message || 'Registration error';
    triggerRender();
  }
}

export async function doLogout() {
  try {
    await api.post('/auth/logout', {});
  } catch (e) {
    console.error('Logout error:', e);
  }
  state.user = null;
  state.csrfToken = '';
  state.messages = [];
  state.chats = [];
  state.currentChatId = null;
  state.view = 'chat';
  triggerRender();
}

export async function initiateOAuthFlow(provider: string) {
  try {
    const r = await api.post('/oauth/authorize-url', { provider });
    const data = await r.json();

    if (!r.ok || !data.authUrl) {
      state.authError = data.error || 'Could not get authorization URL';
      (globalThis as any).render?.();
      return;
    }

    const width = 500;
    const height = 700;
    const left = window.screenX + Math.max(0, (window.outerWidth - width) / 2);
    const top = window.screenY + Math.max(0, (window.outerHeight - height) / 2);
    const popup = window.open(
      data.authUrl,
      `${provider}-oauth`,
      `width=${width},height=${height},left=${left},top=${top}`,
    );

    if (!popup) {
      state.authError = 'Popup blocked. Please allow popups and try again.';
      (globalThis as any).render?.();
      return;
    }

    let completed = false;
    let pollTimer: number | undefined;
    let timeoutTimer: number | undefined;

    const cleanup = () => {
      window.removeEventListener('message', onMessage);
      if (pollTimer) window.clearInterval(pollTimer);
      if (timeoutTimer) window.clearTimeout(timeoutTimer);
    };

    const finalizeAuth = async () => {
      if (completed) return;
      try {
        const meR = await api.get('/auth/check');
        if (!meR.ok) return;

        const meD = await meR.json();
        if (!meD.authenticated) return;
        completed = true;
        cleanup();
        state.user = meD.user;
        state.csrfToken = meD.csrfToken;
        state.authError = '';
        try { popup.close(); } catch { /* ignore */ }
        await loadChatsAfterAuth();
        (globalThis as any).render?.();
      } catch {
        // ignore transient polling errors
      }
    };

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (!event.data || event.data.type !== 'oauth-success') return;
      void finalizeAuth();
    };

    window.addEventListener('message', onMessage);
    pollTimer = window.setInterval(() => {
      // COOP can block popup.closed reads in some browsers; rely on auth-check polling instead.
      void finalizeAuth();
    }, 1200);
    timeoutTimer = window.setTimeout(() => {
      if (completed) return;
      cleanup();
      state.authError = 'OAuth timed out. Please try again.';
      (globalThis as any).render?.();
    }, 120000);
  } catch (e: any) {
    state.authError = 'OAuth flow failed: ' + (e.message || 'Unknown error');
    (globalThis as any).render?.();
  }
}

async function loadChatsAfterAuth() {
  // The session cookie is now set. Reload so the SINGLE canonical authenticated-init
  // sequence in ui-client.ts (the `/auth/check` → authenticated branch) runs in full:
  // tenant appearance, AI-transparency, chat-citations, answer-versions, accessibility,
  // workspace-access, i18n message pack, suggested prompts, models, tools, chats, etc.
  //
  // This helper previously RE-IMPLEMENTED only a subset of that list (chats/models/tools/
  // prefs), so logging in via the form silently skipped loadI18n() (and the other post-auth
  // config) — the nav then rendered raw i18n keys (nav.home, action.newChat, …) until a
  // manual reload. Delegating to a reload keeps one source of truth and prevents that drift.
  state.authError = '';
  window.location.reload();
}

export function renderAuth(): HTMLElement {
  const isLogin = state.authMode === 'login';
  const formLabel = isLogin ? 'Sign in' : 'Create account';
  const card = h('div', { className: 'auth-wrap' },
    h('div', { className: 'auth-card' },
      h('h1', null,
        Object.assign(document.createElement('span'), {
          innerHTML:
            '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#8A8A8A" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px;margin-right:6px" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 10h.01"/><path d="M12 10h.01"/><path d="M16 10h.01"/></svg>',
        }),
        ' ',
        h('span', null, 'gene'),
        'Weave'
      ),
      h('p', { className: 'sub' }, isLogin ? 'Sign in to your account' : 'Create a new account'),
      h('form', {
        'aria-label': formLabel,
        onSubmit: (e: Event) => {
          e.preventDefault();
          const email = (document.getElementById('auth-email') as HTMLInputElement)?.value;
          const pass = (document.getElementById('auth-pass') as HTMLInputElement)?.value;
          if (isLogin) {
            doLogin(email, pass);
          } else {
            const name = (document.getElementById('auth-name') as HTMLInputElement)?.value;
            doRegister(name, email, pass);
          }
        },
      },
        !isLogin
          ? h('div', { className: 'field' },
              h('label', { for: 'auth-name' }, 'Name'),
              h('input', { type: 'text', id: 'auth-name', name: 'name', placeholder: 'Your name', 'aria-required': 'true', autocomplete: 'name' })
            )
          : null,
        h('div', { className: 'field' },
          h('label', { for: 'auth-email' }, 'Email'),
          h('input', { type: 'email', id: 'auth-email', name: 'email', placeholder: 'you@example.com', 'aria-required': 'true', autocomplete: isLogin ? 'username' : 'email' })
        ),
        h('div', { className: 'field' },
          h('label', { for: 'auth-pass' }, 'Password'),
          h('input', { type: 'password', id: 'auth-pass', name: 'password', placeholder: '••••••••', 'aria-required': 'true', autocomplete: isLogin ? 'current-password' : 'new-password' })
        ),
        h('button', { type: 'submit', className: 'btn' }, isLogin ? 'Sign In' : 'Create Account'),
      ),
      h('div', { className: 'divider', 'aria-hidden': 'true' },
        h('div', { className: 'line' }),
        h('span', null, 'or'),
        h('div', { className: 'line' })
      ),
      h('div', { className: 'oauth-btns', 'aria-label': 'Sign in with a third-party provider' },
        h('button', { type: 'button', className: 'oauth-btn', onClick: () => initiateOAuthFlow('google'), 'aria-label': 'Sign in with Google' }, h('span', { 'aria-hidden': 'true' }, '🔷'), 'Google'),
        h('button', { type: 'button', className: 'oauth-btn', onClick: () => initiateOAuthFlow('github'), 'aria-label': 'Sign in with GitHub' }, h('span', { 'aria-hidden': 'true' }, '⬛'), 'GitHub'),
        h('button', { type: 'button', className: 'oauth-btn', onClick: () => initiateOAuthFlow('microsoft'), 'aria-label': 'Sign in with Microsoft' }, h('span', { 'aria-hidden': 'true' }, '🟦'), 'Microsoft'),
        h('button', { type: 'button', className: 'oauth-btn', onClick: () => initiateOAuthFlow('apple'), 'aria-label': 'Sign in with Apple' }, h('span', { 'aria-hidden': 'true' }, '🍎'), 'Apple'),
        h('button', { type: 'button', className: 'oauth-btn', onClick: () => initiateOAuthFlow('facebook'), 'aria-label': 'Sign in with Facebook' }, h('span', { 'aria-hidden': 'true' }, '📘'), 'Facebook')
      ),
      h('div', { className: 'err', role: 'alert', 'aria-live': 'polite', 'aria-atomic': 'true' }, state.authError),
      h('div', { className: 'toggle' },
        isLogin ? 'No account? ' : 'Already have an account? ',
        h('a', {
          role: 'button',
          tabindex: '0',
          onClick: () => {
            state.authMode = isLogin ? 'register' : 'login';
            state.authError = '';
            triggerRender();
          },
          onKeydown: (e: KeyboardEvent) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              state.authMode = isLogin ? 'register' : 'login';
              state.authError = '';
              triggerRender();
            }
          },
        }, isLogin ? 'Register' : 'Sign In')
      )
    )
  );
  return card;
}
