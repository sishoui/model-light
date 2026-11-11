import { CanActivate, ExecutionContext, Inject, SetMetadata, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { RateLimitedError, RateLimiter } from '../devices/devices.service';

/** Rate-limit tiers (spec-backend §7). */
export const RATE_LIMIT_LOGIN = 10; // per IP / minute
export const RATE_LIMIT_REFRESH = 20; // per token / minute
export const RATE_LIMIT_DEFAULT = 120; // per user / minute

export type RateTier = 'login' | 'refresh' | 'default';

export const RATE_LIMIT_TIER = 'rateLimitTier';
/** Decorator: @RateLimit('login') etc. Absent metadata → 'default' tier. */
export const RateLimit = (tier: RateTier) => SetMetadata(RATE_LIMIT_TIER, tier);

function clientIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim();
  return req.ip ?? 'unknown';
}

/** Fixed-window per-process limiter over the shared RateLimiter seam (§7).
 * Tier comes from the @RateLimit decorator; no per-endpoint guard instances. */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject('RateLimiter') private readonly rateLimiter: RateLimiter,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const tier =
      this.reflector.getAllAndOverride<RateTier>(RATE_LIMIT_TIER, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'default';

    let key: string;
    let limit: number;
    switch (tier) {
      case 'login':
        key = `login:${clientIp(req)}`;
        limit = RATE_LIMIT_LOGIN;
        break;
      case 'refresh':
        // Per token family (§7): rotation changes the token each call, so the
        // bucket keys on the caller's IP — one client hammering refresh is
        // capped regardless of which rotated token it presents.
        key = `refresh:${clientIp(req)}`;
        limit = RATE_LIMIT_REFRESH;
        break;
      default: {
        const userId = req.user?.userId?.toString() ?? clientIp(req);
        key = `default:${userId}`;
        limit = RATE_LIMIT_DEFAULT;
      }
    }
    const verdict = this.rateLimiter.consume(key, limit, 60_000);
    if (!verdict.allowed) throw new RateLimitedError(verdict.retryAfterSeconds);
    return true;
  }
}
