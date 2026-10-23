import type { Clock, IdGenerator } from '../application/ports.js';

/** UUID v7 (ordenável no tempo) — exige Bun. */
export const uuidV7Generator: IdGenerator = { next: () => Bun.randomUUIDv7() };
export const systemClock: Clock = { now: () => new Date() };
