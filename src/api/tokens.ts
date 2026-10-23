/** Tokens de DI explícitos: não dependem de emitDecoratorMetadata (que o Bun não garante). */
export const TOKENS = {
  ORM: 'ORM',
  PROCESS_WAGER: 'PROCESS_WAGER_TRANSACTION',
  CREATE_WALLET: 'CREATE_WALLET',
  QUERIES: 'WALLET_QUERIES',
  METRICS: 'METRICS',
  PROBES: 'HEALTH_PROBES',
} as const;
