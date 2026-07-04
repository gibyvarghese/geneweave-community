import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuthContext } from '../../auth.js';

export type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  auth: AuthContext | null,
) => Promise<void>;

export interface RouterLike {
  get(path: string, handler: Handler, opts?: { auth?: boolean; csrf?: boolean }): void;
  post(path: string, handler: Handler, opts?: { auth?: boolean; csrf?: boolean }): void;
  put(path: string, handler: Handler, opts?: { auth?: boolean; csrf?: boolean }): void;
  patch(path: string, handler: Handler, opts?: { auth?: boolean; csrf?: boolean }): void;
  del(path: string, handler: Handler, opts?: { auth?: boolean; csrf?: boolean }): void;
}

export interface AdminHelpers {
  json: (res: ServerResponse, status: number, data: unknown) => void;
  readBody: (req: IncomingMessage) => Promise<string>;
  requireDetailedDescription: (description: unknown, kind: 'prompt' | 'tool' | 'skill' | 'agent', res: ServerResponse) => string | null;
  providers?: Record<string, { apiKey?: string }>;
}
