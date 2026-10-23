import type { NextFunction, Request, Response } from 'express';
import { extractCorrelationId } from './correlation.js';
import type { Metrics } from './metrics.js';

/** Log estruturado (JSON, uma linha) + métrica por rota/status + eco do correlationId. Sem payload financeiro nos logs. */
export function requestLogging(metrics: Metrics, generateId: () => string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const started = performance.now();
    const correlationId = extractCorrelationId(req.headers, generateId);
    (req as Request & { correlationId?: string }).correlationId = correlationId;
    res.setHeader('x-correlation-id', correlationId);

    res.on('finish', () => {
      const route = (req.route as { path?: string } | undefined)?.path ?? 'unmatched';
      metrics.increment('http_requests_total', { method: req.method, route, status: String(res.statusCode) });
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: res.statusCode >= 500 ? 'error' : 'info',
          msg: 'http_request',
          method: req.method,
          route,
          status: res.statusCode,
          durationMs: Math.round(performance.now() - started),
          correlationId,
        }),
      );
    });
    next();
  };
}
