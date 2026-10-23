/**
 * Política de espera por referência ausente (regra 8).
 * delay(n) = min(2s * 2^n, 60s), n = nº de tentativas já feitas.
 * 10 tentativas somam ~6 min (2+4+8+16+32+5*60 s). Esgotado: REJECTED com
 * REFERENCE_NOT_FOUND. Provedores reordenam em ms/segundos, então o teto cobre
 * o caso real sem deixar transações penduradas.
 */
export const MAX_REFERENCE_ATTEMPTS = 10;

const BASE_DELAY_MS = 2_000;
const MAX_DELAY_MS = 60_000;

export function referenceRetryDelayMs(attempt: number): number {
  return Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
}

export function nextReferenceAttemptAt(attempt: number, now: Date): Date {
  return new Date(now.getTime() + referenceRetryDelayMs(attempt));
}
