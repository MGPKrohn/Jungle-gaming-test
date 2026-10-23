import { Catch, HttpException, Logger, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { toHttpError } from './http-mapping.js';

/** Corpo de erro único em todos os endpoints: { error: { code, message } }. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      response.status(status).json({ error: { code: status === 404 ? 'NOT_FOUND' : 'HTTP_ERROR', message: exception.message } });
      return;
    }

    const described = toHttpError(exception);
    if (described.status >= 500) {
      this.logger.error(
        JSON.stringify({ msg: 'request_failed', code: described.code, error: String(exception), stack: (exception as Error)?.stack }),
      );
    }
    if (described.retryAfterSeconds !== undefined) response.setHeader('Retry-After', String(described.retryAfterSeconds));
    response.status(described.status).json({ error: { code: described.code, message: described.message } });
  }
}
