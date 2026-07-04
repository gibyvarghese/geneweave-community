import { execFileSync, execSync } from 'node:child_process';
/**
 * @weaveintel/geneweave — External password manager providers
 *
 * Enables importing credentials from popular password managers into
 * the weaveintel credential vault.  Each provider implements the
 * PasswordManagerProvider interface.
 *
 * Supported providers:
 *   • 1Password      — via `op` CLI (Service Account or signed-in session)
 *   • Bitwarden      — via `bw` CLI (API key or master-password session)
 *   • Apple Keychain  — via macOS `security` CLI
 *   • Chrome          — via local Login Data SQLite (macOS only, requires Keychain access)
 *   • KeePass/XC     — via `kdbxweb` (pure-JS KDBX reader) or `keepassxc-cli`
 *   • CSV Import     — universal fallback (Chrome, Firefox, LastPass CSV exports)
 */

import { existsSync, readFileSync, copyFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* ------------------------------------------------------------------ */
/*  Shared types                                                       */
/* ------------------------------------------------------------------ */

export interface ExternalCredential {
  title: string;
  url: string;
  username: string;
  password: string;
  notes?: string;
  totp?: string;
  provider: string;
}

export interface ProviderStatus {
  provider: string;
  available: boolean;
  reason?: string;
  version?: string;
}

export interface PasswordManagerProvider {
  readonly name: string;
  readonly displayName: string;
  readonly icon: string;

  /** Check if this provider's CLI/dependencies are available */
  checkAvailability(): Promise<ProviderStatus>;

  /**
   * List / search credentials from the external password manager.
   * @param config  Provider-specific auth config (token, password, etc.)
   * @param search  Optional search query to filter results
   */
  listCredentials(config: Record<string, string>, search?: string): Promise<ExternalCredential[]>;
}

/* ------------------------------------------------------------------ */
/*  Helper: safe shell exec                                            */
/* ------------------------------------------------------------------ */

function exec(cmd: string, env?: Record<string, string>): string {
  try {
    return execSync(cmd, {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}

/**
 * Argument-array exec — preferred for any call that includes user-controlled
 * values. Never invokes a shell, so values cannot inject metacharacters,
 * command substitution, or pipe into a second command.
 */
function execFile(cmd: string, args: readonly string[], env?: Record<string, string>): string {
  try {
    return execFileSync(cmd, args as string[], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    }).trim();
  } catch {
    return '';
  }
}

function commandExists(cmd: string): string | null {
  // `cmd` is always a hardcoded literal at call sites; still avoid shell.
  const out = execFile('/usr/bin/env', ['which', cmd]);
  return out || null;
}

/* ================================================================== */
/*  1. 1Password Provider (via `op` CLI)                               */
/* ================================================================== */

export class OnePasswordProvider implements PasswordManagerProvider {
  readonly name = '1password';
  readonly displayName = '1Password';
  readonly icon = '\u{1F511}';

  async checkAvailability(): Promise<ProviderStatus> {
    const path = commandExists('op');
    if (!path) return { provider: this.name, available: false, reason: '`op` CLI not installed. Install from https://1password.com/downloads/command-line/' };
    const ver = exec('op --version');
    return { provider: this.name, available: true, version: ver };
  }

  async listCredentials(config: Record<string, string>, search?: string): Promise<ExternalCredential[]> {
    const env: Record<string, string> = {};
    if (config['serviceAccountToken']) {
      env['OP_SERVICE_ACCOUNT_TOKEN'] = config['serviceAccountToken'];
    }

    const listArgs = ['item', 'list', '--categories', 'Login', '--format', 'json'];
    if (search) {
      // 1Password tags are alnum/dash/underscore only; strip everything else.
      const safeTag = search.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
      if (safeTag) listArgs.push('--tags', safeTag);
    }

    const itemsJson = execFile('op', listArgs, env);
    if (!itemsJson) return [];

    let items: Array<{ id: string; title: string; urls?: Array<{ href: string }> }>;
    try { items = JSON.parse(itemsJson); } catch { return []; }

    const results: ExternalCredential[] = [];
    for (const item of items.slice(0, 100)) {
      // 1Password item ids are 26-char alnum; reject anything else defensively.
      if (!/^[A-Za-z0-9]{6,64}$/.test(item.id)) continue;
      const detailJson = execFile('op', ['item', 'get', item.id, '--format', 'json'], env);
      if (!detailJson) continue;
      try {
        const detail = JSON.parse(detailJson);
        const fields: Array<{ id?: string; label?: string; value?: string; type?: string }> = detail.fields ?? [];
        const username = fields.find((f: { id?: string }) => f.id === 'username')?.value ?? '';
        const password = fields.find((f: { id?: string }) => f.id === 'password')?.value ?? '';
        const totp = fields.find((f: { type?: string }) => f.type === 'OTP')?.value;
        const notes = fields.find((f: { id?: string }) => f.id === 'notesPlain')?.value;
        const url = detail.urls?.[0]?.href ?? item.urls?.[0]?.href ?? '';

        if (username || password) {
          results.push({
            title: item.title,
            url,
            username,
            password,
            notes,
            totp,
            provider: this.name,
          });
        }
      } catch { /* skip malformed items */ }
    }
    return results;
  }
}

/* ================================================================== */
/*  2. Bitwarden Provider (via `bw` CLI)                               */
/* ================================================================== */

export class BitwardenProvider implements PasswordManagerProvider {
  readonly name = 'bitwarden';
  readonly displayName = 'Bitwarden';
  readonly icon = '\u{1F6E1}';

  async checkAvailability(): Promise<ProviderStatus> {
    const path = commandExists('bw');
    if (!path) return { provider: this.name, available: false, reason: '`bw` CLI not installed. Install via `npm install -g @bitwarden/cli`' };
    const ver = exec('bw --version');
    return { provider: this.name, available: true, version: ver };
  }

  async listCredentials(config: Record<string, string>, search?: string): Promise<ExternalCredential[]> {
    const env: Record<string, string> = {};

    // Authenticate if session not provided
    let session = config['session'] ?? '';
    if (!session && config['clientId'] && config['clientSecret']) {
      env['BW_CLIENTID'] = config['clientId'];
      env['BW_CLIENTSECRET'] = config['clientSecret'];
      execFile('bw', ['login', '--apikey'], env);
      if (config['password']) {
        session = execFile('bw', ['unlock', config['password'], '--raw'], env);
      }
    } else if (!session && config['password']) {
      session = execFile('bw', ['unlock', config['password'], '--raw'], env);
    }

    if (session) env['BW_SESSION'] = session;

    // Sync first
    execFile('bw', ['sync'], env);

    const listArgs = ['list', 'items', '--type', '1']; // type 1 = login
    if (search) {
      // Bitwarden's --search accepts arbitrary text but we cap length and
      // strip control characters defensively.
      const safeSearch = search.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 128);
      if (safeSearch) listArgs.push('--search', safeSearch);
    }

    const itemsJson = execFile('bw', listArgs, env);
    if (!itemsJson) return [];

    let items: Array<{ name: string; login?: { username?: string; password?: string; uris?: Array<{ uri: string }>; totp?: string }; notes?: string }>;
    try { items = JSON.parse(itemsJson); } catch { return []; }

    return items
      .filter((item) => item.login?.username || item.login?.password)
      .slice(0, 200)
      .map((item) => ({
        title: item.name,
        url: item.login?.uris?.[0]?.uri ?? '',
        username: item.login?.username ?? '',
        password: item.login?.password ?? '',
        notes: item.notes ?? undefined,
        totp: item.login?.totp ?? undefined,
        provider: this.name,
      }));
  }
}

/* ================================================================== */
/*  3. Apple Keychain Provider (macOS `security` CLI)                   */
/* ================================================================== */

export class AppleKeychainProvider implements PasswordManagerProvider {
  readonly name = 'apple_keychain';
  readonly displayName = 'Apple Keychain';
  readonly icon = '\u{1F34E}';

  async checkAvailability(): Promise<ProviderStatus> {
    if (process.platform !== 'darwin') {
      return { provider: this.name, available: false, reason: 'Apple Keychain is only available on macOS' };
    }
    const path = commandExists('security');
    if (!path) return { provider: this.name, available: false, reason: '`security` CLI not found' };
    return { provider: this.name, available: true, version: 'macOS built-in' };
  }

  async listCredentials(_config: Record<string, string>, search?: string): Promise<ExternalCredential[]> {
    if (process.platform !== 'darwin') return [];

    // dump-keychain lists items but does NOT output passwords
    // So we use: security dump-keychain to get metadata, then
    // security find-internet-password -s <server> -w for each password
    const dump = exec('security dump-keychain -d login.keychain 2>/dev/null');
    if (!dump) return [];

    // Parse the dump output for internet password entries
    const entries: Array<{ server: string; account: string; protocol: string; port: string }> = [];
    const blocks = dump.split('keychain:');

    for (const block of blocks) {
      if (!block.includes('"inet"') && !block.includes('class: "inet"')) continue;

      const serverMatch = block.match(/"svce"<blob>="([^"]+)"|"srvr"<blob>="([^"]+)"/);
      const accountMatch = block.match(/"acct"<blob>="([^"]+)"/);
      const protocolMatch = block.match(/"ptcl"<uint32>="([^"]+)"/);
      const portMatch = block.match(/"port"<uint32>=(?:0x([0-9A-Fa-f]+)|(\d+))/);

      const server = serverMatch?.[1] ?? serverMatch?.[2] ?? '';
      const account = accountMatch?.[1] ?? '';
      if (!server || !account) continue;
      if (search && !server.toLowerCase().includes(search.toLowerCase()) && !account.toLowerCase().includes(search.toLowerCase())) continue;

      entries.push({
        server,
        account,
        protocol: protocolMatch?.[1] ?? 'https',
        port: portMatch?.[1] ? String(parseInt(portMatch[1], 16)) : portMatch?.[2] ?? '',
      });
    }

    // Deduplicate (same server+account)
    const unique = new Map<string, typeof entries[0]>();
    for (const e of entries) unique.set(`${e.server}|${e.account}`, e);

    const results: ExternalCredential[] = [];
    for (const entry of Array.from(unique.values()).slice(0, 100)) {
      // This triggers a macOS Keychain access dialog per-item.
      // Use execFile so server/account values cannot inject shell metachars.
      const password = execFile('security', [
        'find-internet-password',
        '-s', entry.server,
        '-a', entry.account,
        '-w',
      ]);
      if (!password) continue;

      results.push({
        title: entry.server,
        url: `https://${entry.server}`,
        username: entry.account,
        password,
        provider: this.name,
      });
    }
    return results;
  }
}

/* ================================================================== */
/*  4. Chrome Password Provider (macOS — Login Data SQLite)            */
/* ================================================================== */

export class ChromeProvider implements PasswordManagerProvider {
  readonly name = 'chrome';
  readonly displayName = 'Chrome Passwords';
  readonly icon = '\u{1F310}';

  private static readonly PROFILE_PATHS: Record<string, string> = {
    darwin: `${process.env['HOME'] ?? ''}/Library/Application Support/Google/Chrome/Default/Login Data`,
    linux: `${process.env['HOME'] ?? ''}/.config/google-chrome/Default/Login Data`,
  };

  async checkAvailability(): Promise<ProviderStatus> {
    const dbPath = ChromeProvider.PROFILE_PATHS[process.platform];
    if (!dbPath || !existsSync(dbPath)) {
      return { provider: this.name, available: false, reason: 'Chrome Login Data not found at expected path' };
    }
    if (process.platform === 'darwin') {
      // Check if we can read the Chrome Safe Storage key
      const key = execFile('security', ['find-generic-password', '-wa', 'Chrome']);
      if (!key) return { provider: this.name, available: false, reason: 'Cannot access Chrome Safe Storage key from macOS Keychain (access denied or Chrome not installed)' };
    }
    return { provider: this.name, available: true, version: 'local profile' };
  }

  async listCredentials(_config: Record<string, string>, search?: string): Promise<ExternalCredential[]> {
    // Chrome locks its DB while running, so copy to temp file
    const dbPath = ChromeProvider.PROFILE_PATHS[process.platform];
    if (!dbPath || !existsSync(dbPath)) return [];

    const tmpPath = join(tmpdir(), `chrome-login-data-${Date.now()}.sqlite`);
    try {
      copyFileSync(dbPath, tmpPath);
    } catch {
      return [];  // Chrome is likely locking the file
    }

    try {
      // Read URLs and usernames (passwords are encrypted — we extract raw entries)
      let query = "SELECT origin_url, username_value, date_created FROM logins WHERE blacklisted_by_user = 0";
      if (search) {
        // H-1: Escape SQL string delimiters AND LIKE special characters before
        // interpolating into the query. Escaping single-quotes alone is not
        // enough — LIKE treats `%` and `_` as wildcards, so an unescaped
        // search term like `%` would match every row and `%_` would enable
        // wildcard abuse. We also escape `\` because we use `\` as the ESCAPE
        // character in the LIKE clause below.
        //
        // Escape order matters: backslash must be escaped first so we do not
        // double-escape the backslashes we are about to introduce.
        const escapedSearch = search
          .slice(0, 128)          // hard length cap first
          .replace(/'/g, "''")    // SQL string delimiter
          .replace(/\\/g, '\\\\') // LIKE escape char (must come before % and _)
          .replace(/%/g, '\\%')   // LIKE wildcard: any sequence
          .replace(/_/g, '\\_');  // LIKE wildcard: any single character
        query += ` AND (origin_url LIKE '%${escapedSearch}%' ESCAPE '\\' OR username_value LIKE '%${escapedSearch}%' ESCAPE '\\')`;
      }
      query += ' ORDER BY date_last_used DESC LIMIT 200';

      let rows = '';
      try {
        rows = execFileSync('sqlite3', ['-json', tmpPath, query], {
          encoding: 'utf8',
          timeout: 30_000,
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
      } catch {
        rows = '';
      }
      if (!rows) return [];

      let entries: Array<{ origin_url: string; username_value: string }>;
      try { entries = JSON.parse(rows); } catch { return []; }

      // On macOS, we could potentially decrypt using the Chrome Safe Storage key,
      // but this requires native crypto (PBKDF2 + AES-CBC with the Keychain key).
      // For now, we return entries with a placeholder — user must re-enter password.
      return entries
        .filter((e) => e.username_value)
        .map((e) => ({
          title: new URL(e.origin_url).hostname,
          url: e.origin_url,
          username: e.username_value,
          password: '',  // Encrypted — user must re-enter or use Chrome's CSV export
          notes: 'Imported from Chrome (password must be re-entered — Chrome encrypts locally)',
          provider: this.name,
        }));
    } finally {
      try { unlinkSync(tmpPath); } catch { /* cleanup best-effort */ }
    }
  }
}

/* ================================================================== */
/*  5. CSV Import Provider (universal fallback)                        */
/* ================================================================== */

export class CsvImportProvider implements PasswordManagerProvider {
  readonly name = 'csv';
  readonly displayName = 'CSV Import';
  readonly icon = '\u{1F4C4}';

  async checkAvailability(): Promise<ProviderStatus> {
    return { provider: this.name, available: true, version: 'built-in' };
  }

  /**
   * Parse CSV content passed as config.csvContent.
   * Supports Chrome, Firefox, LastPass, Bitwarden, 1Password CSV export formats.
   */
  async listCredentials(config: Record<string, string>, _search?: string): Promise<ExternalCredential[]> {
    const csv = config['csvContent'];
    if (!csv) return [];

    const lines = csv.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) return [];

    // Parse header to detect format
    const header = this.parseCsvLine(lines[0]!).map((h) => h.toLowerCase().trim());

    // Common column mappings across export formats
    const colMap = {
      name:     header.findIndex((h) => ['name', 'title', 'entry'].includes(h)),
      url:      header.findIndex((h) => ['url', 'login_uri', 'login uri', 'web site', 'website'].includes(h)),
      username: header.findIndex((h) => ['username', 'login_username', 'login username', 'user name', 'email'].includes(h)),
      password: header.findIndex((h) => ['password', 'login_password', 'login password'].includes(h)),
      notes:    header.findIndex((h) => ['note', 'notes', 'extra', 'comments'].includes(h)),
      totp:     header.findIndex((h) => ['login_totp', 'totp', 'otp'].includes(h)),
    };

    if (colMap.username < 0 && colMap.password < 0) return [];

    const results: ExternalCredential[] = [];
    for (let i = 1; i < lines.length && results.length < 500; i++) {
      const cols = this.parseCsvLine(lines[i]!);
      const url = colMap.url >= 0 ? (cols[colMap.url] ?? '') : '';
      const username = colMap.username >= 0 ? (cols[colMap.username] ?? '') : '';
      const password = colMap.password >= 0 ? (cols[colMap.password] ?? '') : '';

      if (!username && !password) continue;

      let title = colMap.name >= 0 ? (cols[colMap.name] ?? '') : '';
      if (!title && url) {
        try { title = new URL(url).hostname; } catch { title = url; }
      }

      results.push({
        title,
        url,
        username,
        password,
        notes: colMap.notes >= 0 ? cols[colMap.notes] : undefined,
        totp: colMap.totp >= 0 ? cols[colMap.totp] : undefined,
        provider: `csv_import`,
      });
    }
    return results;
  }

  /** Minimal RFC 4180 CSV line parser */
  private parseCsvLine(line: string): string[] {
    const cols: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
        else if (ch === '"') { inQuotes = false; }
        else { current += ch; }
      } else {
        if (ch === '"') { inQuotes = true; }
        else if (ch === ',') { cols.push(current); current = ''; }
        else { current += ch; }
      }
    }
    cols.push(current);
    return cols;
  }
}

/* ================================================================== */
/*  Provider registry                                                  */
/* ================================================================== */

const ALL_PROVIDERS: PasswordManagerProvider[] = [
  new OnePasswordProvider(),
  new BitwardenProvider(),
  new AppleKeychainProvider(),
  new ChromeProvider(),
  new CsvImportProvider(),
];

export function getProvider(name: string): PasswordManagerProvider | undefined {
  return ALL_PROVIDERS.find((p) => p.name === name);
}

export function getAllProviders(): PasswordManagerProvider[] {
  return ALL_PROVIDERS;
}

export async function checkAllProviders(): Promise<ProviderStatus[]> {
  return Promise.all(ALL_PROVIDERS.map((p) => p.checkAvailability()));
}
