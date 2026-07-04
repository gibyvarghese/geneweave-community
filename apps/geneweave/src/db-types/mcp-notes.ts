// SPDX-License-Identifier: MIT
/** A per-user MCP personal access token (m130). The plaintext is never stored — only token_hash. */
export interface UserMcpTokenRow {
  id: string;
  user_id: string;
  tenant_id: string | null;
  name: string;
  token_hash: string;
  token_prefix: string;
  scope: string; // 'read' | 'readwrite'
  enabled: number;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
}
