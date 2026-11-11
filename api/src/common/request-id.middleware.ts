import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';

const HEADER = 'x-request-id';

/** Assigns a requestId per request, logs one line per request. Never logs bodies. */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  private readonly logger = new Logger('http');

  use(req: Request, res: Response, next: NextFunction) {
    const requestId = (req.headers[HEADER] as string) || randomUUID();
    (req as Request & { requestId: string }).requestId = requestId;
    res.setHeader(HEADER, requestId);
    const start = Date.now();
    res.on('finish', () => {
      this.logger.log(
        `${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms requestId=${requestId}`,
      );
    });
    next();
  }
}

export function getRequestId(req: Request): string {
  return (req as Request & { requestId?: string }).requestId ?? randomUUID();
}
