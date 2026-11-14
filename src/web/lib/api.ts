import type { SessionInfo } from '../../shared/contracts.ts';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: unknown;
  constructor(status: number, code: string, body: unknown) {
    super(code);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

let csrfToken: string | null = null;
let onUnauthenticated: () => void = () => {};
let onForbidden: () => void = () => {};

export const setCsrfToken = (token: string | null) => (csrfToken = token);
export const setUnauthenticatedHandler = (fn: () => void) => (onUnauthenticated = fn);
export const setForbiddenHandler = (fn: () => void) => (onForbidden = fn);

export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['x-csrf-token'] = csrfToken;
  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal,
    credentials: 'same-origin',
  });
  if (res.status === 204) return undefined as T;
  const body: unknown = res.headers.get('content-type')?.includes('json')
    ? await res.json()
    : await res.text();
  if (!res.ok) {
    const code =
      typeof body === 'object' && body && 'error' in body ? String(body.error) : `http_${res.status}`;
    if (res.status === 401 && path !== '/session') onUnauthenticated();
    if (res.status === 403 && code === 'forbidden') onForbidden();
    throw new ApiError(res.status, code, body);
  }
  return body as T;
}

export const fetchSession = () => api<SessionInfo>('/session');

const messages: Record<string, string> = {
  invalid_credentials: 'Username or password is incorrect.',
  too_many_attempts: 'Too many attempts. Wait 15 minutes and try again.',
  not_found: 'This item is not available. It may have been removed or your access changed.',
  forbidden: 'You do not have permission for this action.',
  csrf: 'Your session expired. Reload the page and try again.',
  username_taken: 'That username is already in use.',
  last_admin: 'Keep at least one active administrator.',
  invalid_current_password: 'Current password is incorrect.',
  admin_password_cli_only: 'Admin passwords are changed on the server with the user:password command.',
  admins_cli_only:
    'Add administrators on the server, or promote a member after setting their password there.',
  cannot_change_own_access: 'You cannot change your own role or disable yourself.',
  promotion_needs_cli_password:
    'Set this member’s password on the server with user:password before making them an admin.',
  unknown_account: 'One of the selected accounts no longer exists. Reload and try again.',
  groups_require_members: 'Only members belong to groups. Administrators already see everything.',
};

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'invalid_request') {
      const issues = (error.body as { issues?: { message: string }[] }).issues;
      return issues?.[0]?.message ?? 'Check the highlighted fields.';
    }
    return messages[error.code] ?? `Request failed (${error.code}).`;
  }
  return 'Network error. Check your connection and try again.';
}
