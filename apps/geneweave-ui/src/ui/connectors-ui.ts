import { api, loadConnectors, loadCredentials, loadSSOProviders, loadOAuthAccounts, loadPasswordProviders } from './api.js';
import { noticeDialog, confirmDialog, promptDialog } from "./dialog.js";
import { h } from './dom.js';
import { state } from './state.js';

const CONNECTOR_DEFS = [
  { id: 'jira', label: 'Jira', category: 'enterprise', desc: 'Project tracking and issue management', color: '#0052CC' },
  { id: 'servicenow', label: 'ServiceNow', category: 'enterprise', desc: 'IT service management and workflows', color: '#62D84E', needsDomain: true },
  { id: 'canva', label: 'Canva', category: 'enterprise', desc: 'Design assets and creative workflows', color: '#00C4CC' },
  { id: 'facebook', label: 'Facebook', category: 'social', desc: 'Pages, posts, and audience engagement', color: '#1877F2' },
  { id: 'instagram', label: 'Instagram', category: 'social', desc: 'Business content and media publishing', color: '#E4405F' },
];

function getConnectorStatus(def: any) {
  const list = def.category === 'social' ? (state.connectors?.social || []) : (state.connectors?.enterprise || []);
  const key = def.category === 'social' ? 'platform' : 'connector_type';
  return list.find((connector: any) => connector?.[key] === def.id || String(connector?.name || '').toLowerCase() === def.id);
}

async function startOAuthFlow(def: any, connectorId: string, onComplete: () => void) {
  const qs = new URLSearchParams({ connector_id: connectorId || '' });
  if (def.needsDomain) {
    const domain = await promptDialog({ title: 'ServiceNow domain', message: 'Enter your ServiceNow domain (without .service-now.com).', placeholder: 'mycompany', required: true, confirmLabel: 'Continue' });
    if (!domain) return;
    qs.set('domain', domain);
  }

  const response = await api.get(`/connectors/${def.id}/authorize?${qs.toString()}`);
  const data = await response.json();
  if (!response.ok || !data.url) {
    void noticeDialog({ message: data?.error || 'Could not get authorization URL' });
    return;
  }

  const popup = window.open(data.url, `oauth-${def.id}`, 'width=600,height=700,scrollbars=yes');
  if (!popup) {
    void noticeDialog({ message: 'Popup blocked. Please allow popups for this site.' });
    return;
  }

  function onMessage(event: MessageEvent) {
    if (event.origin !== window.location.origin) return;
    if (!event.data || (event.data.type !== 'oauth-success' && event.data.type !== 'oauth-error')) return;
    window.removeEventListener('message', onMessage);
    if (event.data.type === 'oauth-error') {
      void noticeDialog({ message: `OAuth error: ${event.data.error || 'Unknown error'}` });
    }
    onComplete();
  }

  window.addEventListener('message', onMessage);
}

async function connectorConnect(def: any, render: () => void) {
  let existing = getConnectorStatus(def);
  let connectorId = existing?.id as string | undefined;
  if (!connectorId) {
    const table = def.category === 'social' ? 'social-accounts' : 'enterprise-connectors';
    const body = def.category === 'social'
      ? { name: def.label, platform: def.id, description: def.desc }
      : { name: def.label, connector_type: def.id, description: def.desc, auth_type: 'oauth2' };
    const response = await api.post(`/admin/${table}`, body);
    const data = await response.json();
    connectorId = data?.['social-account']?.id || data?.['enterprise-connector']?.id;
    existing = getConnectorStatus(def);
  }
  if (!connectorId && existing?.id) connectorId = existing.id;
  if (connectorId) {
    await startOAuthFlow(def, connectorId, () => { void openConnectorsView(render); });
  }
}

async function connectorDisconnect(def: any, render: () => void) {
  const existing = getConnectorStatus(def);
  if (!existing?.id) return;
  await api.post(`/connectors/${existing.id}/disconnect`, { table: def.category === 'social' ? 'social' : 'enterprise' });
  await openConnectorsView(render);
}

async function connectorTest(def: any) {
  const existing = getConnectorStatus(def);
  if (!existing?.id) return;
  const response = await api.post(`/connectors/${existing.id}/test`, { table: def.category === 'social' ? 'social' : 'enterprise' });
  const data = await response.json();
  void noticeDialog({ message: data?.ok ? `Connection verified: ${data.message || 'OK'}` : `Connection test failed: ${data?.message || data?.error || 'Unknown error'}` });
}

function startAddCredential(render: () => void) {
  state.credentialEditing = null;
  state.credentialForm = { siteName: '', siteUrlPattern: '', authMethod: 'form_fill', username: '', password: '' };
  render();
}

function startEditCredential(credential: any, render: () => void) {
  state.credentialEditing = credential.id;
  state.credentialForm = {
    siteName: credential.siteName,
    siteUrlPattern: credential.siteUrlPattern,
    authMethod: credential.authMethod,
    username: '',
    password: '',
    headerValue: '',
    cookiesJson: '[]',
  };
  render();
}

async function saveCredential(render: () => void) {
  const form = state.credentialForm || {};
  if (!form.siteName || !form.siteUrlPattern || !form.authMethod) {
    void noticeDialog({ message: 'Site Name, URL Pattern, and Auth Method are required.' });
    return;
  }

  const config: Record<string, unknown> = { method: form.authMethod };
  if (form.authMethod === 'form_fill') {
    config['username'] = form.username || '';
    config['password'] = form.password || '';
  } else if (form.authMethod === 'header') {
    config['headerValue'] = form.headerValue || '';
  } else if (form.authMethod === 'cookie') {
    try {
      config['cookies'] = JSON.parse(form.cookiesJson || '[]');
    } catch {
      void noticeDialog({ message: 'Invalid cookies JSON.' });
      return;
    }
  }

  if (state.credentialEditing) {
    await api.put(`/credentials/${state.credentialEditing}`, {
      siteName: form.siteName,
      siteUrlPattern: form.siteUrlPattern,
      authMethod: form.authMethod,
      config,
    });
  } else {
    await api.post('/credentials', {
      siteName: form.siteName,
      siteUrlPattern: form.siteUrlPattern,
      authMethod: form.authMethod,
      config,
    });
  }

  state.credentialEditing = null;
  state.credentialForm = null;
  await loadCredentials();
  render();
}

async function deleteCredential(id: string, render: () => void) {
  if (!(await confirmDialog({ message: 'Delete this credential?', danger: true }))) return;
  await api.del(`/credentials/${id}`);
  await loadCredentials();
  render();
}

function renderImportField(label: string, key: string, placeholder: string, isSecret = false): HTMLElement {
  return h('div', null,
    h('label', { style: 'display:block;font-size:12px;font-weight:600;color:var(--fg2);margin-bottom:4px;' }, label),
    h('input', {
      type: isSecret ? 'password' : 'text',
      value: state.importConfig?.[key] || '',
      placeholder,
      style: 'width:100%;padding:8px 10px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg2);color:var(--fg);',
      onInput: (e: Event) => {
        state.importConfig = { ...(state.importConfig || {}), [key]: (e.target as HTMLInputElement).value };
      },
    })
  );
}

async function runPasswordImport(render: () => void) {
  if (!state.importProvider) return;
  state.importLoading = true;
  state.importResult = null;
  render();
  try {
    const body = {
      provider: state.importProvider,
      config: state.importConfig || {},
      search: state.importConfig?.search || undefined,
    };
    const response = await api.post('/password-providers/import', body);
    const data = await response.json();
    if (!response.ok) {
      state.importResult = { error: data?.error || 'Import failed' };
    } else {
      state.importResult = data;
      await loadCredentials();
    }
  } catch (e) {
    state.importResult = { error: (e as Error)?.message || 'Import failed' };
  } finally {
    state.importLoading = false;
    render();
  }
}

function renderImportPanel(render: () => void): HTMLElement {
  const labels: Record<string, string> = {
    '1password': '1Password',
    bitwarden: 'Bitwarden',
    apple_keychain: 'Apple Keychain',
    chrome: 'Chrome Passwords',
    csv: 'CSV Import',
  };
  const icons: Record<string, string> = {
    '1password': '🔑',
    bitwarden: '🛡',
    apple_keychain: '🍎',
    chrome: '🌐',
    csv: '📄',
  };

  const panel = h('div', { className: 'chart-box', style: 'margin-bottom:16px;border-color:#bfdbfe;background:linear-gradient(180deg,#f0f9ff,#ecfeff);' },
    h('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;' },
      h('h3', { style: 'margin:0;' }, '📥 Import From Password Manager'),
      h('button', {
        className: 'row-btn',
        onClick: () => {
          state.importShow = false;
          state.importProvider = null;
          state.importConfig = {};
          state.importResult = null;
          render();
        },
      }, 'Close')
    )
  );

  if (!state.importProvider) {
    const providers = state.importProviders || [];
    panel.appendChild(h('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;' },
      ...providers.map((provider: any) => {
        const available = !!provider?.available;
        return h('button', {
          style: `text-align:left;padding:10px;border-radius:10px;border:1px solid ${available ? '#bfdbfe' : '#e5e7eb'};background:${available ? '#ffffff' : '#f8fafc'};opacity:${available ? '1' : '.7'};cursor:${available ? 'pointer' : 'not-allowed'};`,
          title: provider?.reason || '',
          onClick: available
            ? () => {
                state.importProvider = provider.provider;
                state.importConfig = {};
                state.importResult = null;
                render();
              }
            : undefined,
        },
          h('div', { style: 'font-size:22px;margin-bottom:4px;' }, icons[provider.provider] || '🔐'),
          h('div', { style: 'font-size:12px;font-weight:700;color:#0f172a;' }, labels[provider.provider] || provider.provider),
          h('div', { style: `font-size:11px;color:${available ? '#15803d' : '#b91c1c'};` }, available ? (provider.version || 'Available') : 'Unavailable')
        );
      })
    ));
    return panel;
  }

  const selected = state.importProvider as string;
  panel.appendChild(h('div', { style: 'display:flex;align-items:center;gap:8px;margin-bottom:10px;' },
    h('button', {
      className: 'row-btn',
      onClick: () => {
        state.importProvider = null;
        state.importConfig = {};
        state.importResult = null;
        render();
      },
    }, 'Back'),
    h('div', { style: 'font-size:13px;font-weight:700;color:#0f172a;' }, labels[selected] || selected)
  ));

  const configWrap = h('div', { style: 'display:grid;gap:10px;margin-bottom:12px;' });
  if (selected === '1password') {
    configWrap.appendChild(renderImportField('Service Account Token', 'serviceAccountToken', 'OP_SERVICE_ACCOUNT_TOKEN', true));
  } else if (selected === 'bitwarden') {
    configWrap.appendChild(renderImportField('Master Password', 'password', 'Bitwarden master password', true));
    configWrap.appendChild(renderImportField('Client ID (optional)', 'clientId', 'BW_CLIENTID'));
    configWrap.appendChild(renderImportField('Client Secret (optional)', 'clientSecret', 'BW_CLIENTSECRET', true));
  } else if (selected === 'csv') {
    configWrap.appendChild(h('div', null,
      h('label', { style: 'display:block;font-size:12px;font-weight:600;color:var(--fg2);margin-bottom:4px;' }, 'CSV Content'),
      h('textarea', {
        rows: '6',
        placeholder: 'Paste CSV export content here...',
        value: state.importConfig?.csvContent || '',
        style: 'width:100%;padding:8px 10px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg2);color:var(--fg);font-family:var(--mono);',
        onInput: (e: Event) => {
          state.importConfig = { ...(state.importConfig || {}), csvContent: (e.target as HTMLTextAreaElement).value };
        },
      })
    ));
  }
  configWrap.appendChild(renderImportField('Search Filter (optional)', 'search', 'Import only matching entries'));
  panel.appendChild(configWrap);

  panel.appendChild(h('div', { style: 'display:flex;align-items:center;gap:10px;' },
    h('button', {
      className: 'nav-btn active',
      onClick: () => { void runPasswordImport(render); },
      disabled: state.importLoading ? 'true' : undefined,
    }, state.importLoading ? 'Importing...' : 'Import Credentials'),
    state.importResult?.error
      ? h('span', { style: 'font-size:12px;color:#b91c1c;' }, `Error: ${state.importResult.error}`)
      : state.importResult
        ? h('span', { style: 'font-size:12px;color:#15803d;' }, `Imported ${state.importResult.imported || 0} of ${state.importResult.total || 0}`)
        : null
  ));

  return panel;
}

function renderCredentialForm(render: () => void): HTMLElement {
  const form = state.credentialForm || {};
  const isEdit = !!state.credentialEditing;
  return h('div', { className: 'chart-box', style: 'margin-bottom:16px;' },
    h('h3', null, isEdit ? 'Edit Browser Credential' : 'New Browser Credential'),
    h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:10px;' },
      h('div', null,
        h('label', { style: 'display:block;font-size:12px;font-weight:600;color:var(--fg2);margin-bottom:4px;' }, 'Site Name'),
        h('input', {
          value: form.siteName || '',
          onInput: (e: Event) => {
            state.credentialForm = { ...form, siteName: (e.target as HTMLInputElement).value };
          },
          style: 'width:100%;padding:8px 10px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg2);color:var(--fg);',
        })
      ),
      h('div', null,
        h('label', { style: 'display:block;font-size:12px;font-weight:600;color:var(--fg2);margin-bottom:4px;' }, 'URL Pattern'),
        h('input', {
          value: form.siteUrlPattern || '',
          onInput: (e: Event) => {
            state.credentialForm = { ...form, siteUrlPattern: (e.target as HTMLInputElement).value };
          },
          style: 'width:100%;padding:8px 10px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg2);color:var(--fg);',
        })
      ),
      h('div', { style: 'grid-column:1/-1;' },
        h('label', { style: 'display:block;font-size:12px;font-weight:600;color:var(--fg2);margin-bottom:4px;' }, 'Auth Method'),
        h('select', {
          value: form.authMethod || 'form_fill',
          onChange: (e: Event) => {
            state.credentialForm = { ...form, authMethod: (e.target as HTMLSelectElement).value };
            render();
          },
          style: 'width:100%;padding:8px 10px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg2);color:var(--fg);',
        },
          h('option', { value: 'form_fill' }, 'Form Fill (username/password)'),
          h('option', { value: 'header' }, 'Header Auth'),
          h('option', { value: 'cookie' }, 'Cookie Injection')
        )
      ),
      (form.authMethod || 'form_fill') === 'form_fill'
        ? h('div', { style: 'grid-column:1/-1;display:grid;grid-template-columns:1fr 1fr;gap:10px;' },
            h('input', {
              type: 'text',
              placeholder: 'Username',
              value: form.username || '',
              onInput: (e: Event) => {
                state.credentialForm = { ...form, username: (e.target as HTMLInputElement).value };
              },
              style: 'padding:8px 10px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg2);color:var(--fg);',
            }),
            h('input', {
              type: 'password',
              placeholder: 'Password',
              value: form.password || '',
              onInput: (e: Event) => {
                state.credentialForm = { ...form, password: (e.target as HTMLInputElement).value };
              },
              style: 'padding:8px 10px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg2);color:var(--fg);',
            })
          )
        : null,
      (form.authMethod || 'form_fill') === 'header'
        ? h('div', { style: 'grid-column:1/-1;' },
            h('input', {
              type: 'password',
              placeholder: 'Authorization header value',
              value: form.headerValue || '',
              onInput: (e: Event) => {
                state.credentialForm = { ...form, headerValue: (e.target as HTMLInputElement).value };
              },
              style: 'width:100%;padding:8px 10px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg2);color:var(--fg);',
            })
          )
        : null,
      (form.authMethod || 'form_fill') === 'cookie'
        ? h('div', { style: 'grid-column:1/-1;' },
            h('textarea', {
              rows: '4',
              placeholder: '[{"name":"session","value":"...","domain":".example.com"}]',
              value: form.cookiesJson || '[]',
              onInput: (e: Event) => {
                state.credentialForm = { ...form, cookiesJson: (e.target as HTMLTextAreaElement).value };
              },
              style: 'width:100%;padding:8px 10px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg2);color:var(--fg);font-family:var(--mono);',
            })
          )
        : null
    ),
    h('div', { style: 'display:flex;gap:8px;margin-top:12px;' },
      h('button', { className: 'nav-btn active', onClick: () => { void saveCredential(render); } }, isEdit ? 'Update' : 'Save'),
      h('button', {
        className: 'nav-btn',
        onClick: () => {
          state.credentialForm = null;
          state.credentialEditing = null;
          render();
        },
      }, 'Cancel')
    )
  );
}

function renderCredentialsSection(render: () => void): HTMLElement {
  const wrap = h('div', { style: 'margin-top:28px;' },
    h('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;' },
      h('div', null,
        h('h3', { style: 'margin:0 0 2px;font-size:15px;color:var(--fg);' }, '🔒 Browser Passwords'),
        h('p', { style: 'margin:0;font-size:12px;color:var(--fg2);' }, 'Credentials used by browser tools for auto-login')
      ),
      h('div', { style: 'display:flex;gap:8px;' },
        h('button', {
          className: 'nav-btn',
          onClick: () => {
            state.importShow = !state.importShow;
            state.importProvider = null;
            state.importConfig = {};
            state.importResult = null;
            if (state.importShow) {
              void loadPasswordProviders();
            }
            render();
          },
        }, 'Import'),
        h('button', { className: 'nav-btn active', onClick: () => startAddCredential(render) }, '+ Add Credential')
      )
    )
  );

  if (state.importShow) {
    wrap.appendChild(renderImportPanel(render));
  }

  if (state.credentialForm) {
    wrap.appendChild(renderCredentialForm(render));
  }

  const credentials = state.credentials || [];
  if (!credentials.length && !state.credentialForm) {
    wrap.appendChild(h('div', { className: 'chart-box' }, h('div', { style: 'font-size:13px;color:var(--fg2);' }, 'No browser credentials saved yet.')));
    return wrap;
  }

  const grid = h('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px;' });
  credentials.forEach((credential: any) => {
    grid.appendChild(h('div', { className: 'card', style: 'padding:16px;' },
      h('div', { style: 'font-weight:700;color:var(--fg);font-size:14px;margin-bottom:4px;' }, credential.siteName || 'Site'),
      h('div', { style: 'font-family:var(--mono);font-size:11px;color:var(--fg3);margin-bottom:8px;word-break:break-all;' }, credential.siteUrlPattern || ''),
      h('div', { style: 'font-size:12px;color:var(--fg2);margin-bottom:10px;' }, `Method: ${credential.authMethod || 'unknown'}`),
      h('div', { className: 'row-actions' },
        h('button', { className: 'row-btn row-btn-edit', onClick: () => startEditCredential(credential, render) }, 'Edit'),
        h('button', { className: 'row-btn row-btn-del', onClick: () => { void deleteCredential(credential.id, render); } }, 'Delete')
      )
    ));
  });
  wrap.appendChild(grid);
  return wrap;
}

function renderLinkedAccountsSection(): HTMLElement {
  const panel = h('div', { style: 'margin-top:20px;display:grid;grid-template-columns:1fr 1fr;gap:14px;' });

  const ssoProviders = state.ssoProviders || [];
  panel.appendChild(h('div', { className: 'chart-box' },
    h('h3', null, '🔐 Linked SSO Providers'),
    ssoProviders.length
      ? h('div', { style: 'display:flex;flex-direction:column;gap:8px;' },
          ...ssoProviders.map((provider: any) =>
            h('div', { style: 'padding:8px 10px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg3);font-size:12px;color:var(--fg2);' },
              `${provider.providerName || provider.name || 'Provider'} • ${provider.status || 'active'}`
            )
          )
        )
      : h('div', { style: 'font-size:12px;color:var(--fg3);' }, 'No linked SSO providers')
  ));

  const oauthAccounts = state.oauthAccounts || [];
  panel.appendChild(h('div', { className: 'chart-box' },
    h('h3', null, '🔗 Linked OAuth Accounts'),
    oauthAccounts.length
      ? h('div', { style: 'display:flex;flex-direction:column;gap:8px;' },
          ...oauthAccounts.map((account: any) =>
            h('div', { style: 'padding:8px 10px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg3);font-size:12px;color:var(--fg2);' },
              `${account.provider || 'Provider'} • ${account.account_email || account.account_id || 'Connected'}`
            )
          )
        )
      : h('div', { style: 'font-size:12px;color:var(--fg3);' }, 'No linked OAuth accounts')
  ));

  return panel;
}

export async function openConnectorsView(render: () => void) {
  await loadConnectors();
  await Promise.all([loadCredentials(), loadSSOProviders(), loadOAuthAccounts(), loadPasswordProviders()]);
  render();
}

export function renderConnectorsView(render: () => void): HTMLElement {
  const view = h('div', { className: 'dash-view' });
  view.appendChild(h('h2', null, '⚡ Connectors'));

  if (state.connectorsLoading) {
    view.appendChild(h('div', { className: 'empty-chat' }, 'Loading connectors...'));
    return view;
  }

  view.appendChild(h('div', { style: 'margin-bottom:24px' },
    h('h3', { style: 'font-size:16px;font-weight:700;margin-bottom:12px;color:var(--fg);' }, '🏢 Enterprise'),
    h('p', { style: 'font-size:13px;color:var(--fg2);margin-bottom:16px;' }, 'Connect business tools and integrations'),
    h('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px;' },
      ...CONNECTOR_DEFS.filter((definition) => definition.category === 'enterprise').map((definition: any) => {
        const existing = getConnectorStatus(definition);
        const connected = existing && existing.status === 'connected';
        return h('div', { className: 'card', style: 'padding:20px;' },
          h('div', { className: 'label' }, definition.label),
          h('div', { style: 'font-size:14px;color:var(--fg);margin-bottom:8px;font-weight:600;' }, connected ? 'Connected' : 'Not connected'),
          h('div', { style: 'font-size:12px;color:var(--fg2);margin-bottom:16px;line-height:1.5;' }, definition.desc),
          connected
            ? h('div', { style: 'display:flex;gap:8px;' },
                h('button', { className: 'row-btn row-btn-edit', style: 'flex:1;', onClick: () => { void connectorTest(definition); } }, 'Test'),
                h('button', { className: 'row-btn row-btn-del', style: 'flex:1;', onClick: () => { void connectorDisconnect(definition, render); } }, 'Disconnect')
              )
            : h('button', { className: 'nav-btn active', style: `width:100%;background:${definition.color};border-color:${definition.color};`, onClick: () => { void connectorConnect(definition, render); } }, 'Connect')
        );
      })
    )
  ));

  view.appendChild(h('div', { style: 'margin-bottom:24px' },
    h('h3', { style: 'font-size:16px;font-weight:700;margin-bottom:12px;color:var(--fg);' }, '📱 Social Media'),
    h('p', { style: 'font-size:13px;color:var(--fg2);margin-bottom:16px;' }, 'Connect social platforms and messaging services'),
    h('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px;' },
      ...CONNECTOR_DEFS.filter((definition) => definition.category === 'social').map((definition: any) => {
        const existing = getConnectorStatus(definition);
        const connected = existing && existing.status === 'connected';
        return h('div', { className: 'card', style: 'padding:20px;' },
          h('div', { className: 'label' }, definition.label),
          h('div', { style: 'font-size:14px;color:var(--fg);margin-bottom:8px;font-weight:600;' }, connected ? 'Connected' : 'Not connected'),
          h('div', { style: 'font-size:12px;color:var(--fg2);margin-bottom:16px;line-height:1.5;' }, definition.desc),
          connected
            ? h('div', { style: 'display:flex;gap:8px;' },
                h('button', { className: 'row-btn row-btn-edit', style: 'flex:1;', onClick: () => { void connectorTest(definition); } }, 'Test'),
                h('button', { className: 'row-btn row-btn-del', style: 'flex:1;', onClick: () => { void connectorDisconnect(definition, render); } }, 'Disconnect')
              )
            : h('button', { className: 'nav-btn active', style: `width:100%;background:${definition.color};border-color:${definition.color};`, onClick: () => { void connectorConnect(definition, render); } }, 'Connect')
        );
      })
    )
  ));

  view.appendChild(renderCredentialsSection(render));
  view.appendChild(renderLinkedAccountsSection());
  return view;
}