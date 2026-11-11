import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { Request, Response } from 'express';
import { getRequestId } from './request-id.middleware';

const HTTP_BY_CODE: Record<string, number> = {
  AUTH_INVALID: HttpStatus.UNAUTHORIZED,
  AUTH_FORBIDDEN: HttpStatus.FORBIDDEN,
  DEVICE_ID_INVALID: 422,
  BACKUP_CRC_MISMATCH: 422,
  PAYLOAD_TOO_LARGE: 413,
  SCHEMA_VERSION_UNSUPPORTED: 422,
  NOT_FOUND: HttpStatus.NOT_FOUND,
  RATE_LIMITED: 429,
  INTERNAL: HttpStatus.INTERNAL_SERVER_ERROR,
};

/** All errors leave as { error: { code, message }, requestId }. Internal details never leak. */
@Catch()
export class ErrorFormatFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const requestId = getRequestId(req);

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL';
    let message = 'internal error';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      if (status === HttpStatus.UNAUTHORIZED) {
        code = 'AUTH_INVALID';
        message = 'invalid or expired token';
      } else {
        code = 'INTERNAL';
        message = 'internal error';
      }
      const body = exception.getResponse();
      if (typeof body === 'object' && body !== null && 'code' in body) {
        code = (body as { code: string }).code;
        message = (body as { message?: string }).message ?? message;
      }
    } else if (exception instanceof Error && /^\w+$/.test(exception.message)) {
      // Domain errors thrown as AuthError with a spec code.
      const mapped = HTTP_BY_CODE[exception.message];
      if (mapped) {
        const domainStatus = (exception as { status?: number }).status;
        status = domainStatus && domainStatus !== mapped ? domainStatus : mapped;
        code = exception.message;
        message = code === 'AUTH_INVALID' ? 'invalid or expired token' : code;
      }
      const retryAfter = (exception as { retryAfterSeconds?: number }).retryAfterSeconds;
      if (code === 'RATE_LIMITED' && typeof retryAfter === 'number' && retryAfter > 0) {
        res.header('Retry-After', String(Math.max(1, Math.ceil(retryAfter))));
      }
    }

    res.status(status).json({ error: { code, message }, requestId });
  }
}
