import { InvalidRequestError } from './errors.js';

export interface LedgerCursor {
  createdAt: Date;
  id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Cursor opaco e estável: base64url de (created_at, id) do último item entregue.
 * A paginação usa `(created_at, id) > cursor`, então inserções novas nunca
 * deslocam páginas já lidas (diferente de OFFSET).
 */
export function encodeCursor(cursor: LedgerCursor): string {
  return Buffer.from(JSON.stringify({ c: cursor.createdAt.toISOString(), i: cursor.id })).toString('base64url');
}

export function decodeCursor(raw: string): LedgerCursor {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { c?: unknown; i?: unknown };
    if (typeof parsed.c !== 'string' || typeof parsed.i !== 'string' || !UUID.test(parsed.i)) throw new Error();
    const createdAt = new Date(parsed.c);
    if (Number.isNaN(createdAt.getTime())) throw new Error();
    return { createdAt, id: parsed.i };
  } catch {
    throw new InvalidRequestError('cursor is invalid');
  }
}
