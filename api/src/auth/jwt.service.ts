import { Inject, Injectable } from '@nestjs/common';
import { sign, verify } from 'jsonwebtoken';
import { ACCESS_TOKEN_TTL_SECONDS } from './auth.service';

@Injectable()
export class JwtService {
  constructor(@Inject('JWT_SECRET') private readonly secret: string) {}

  signAccessToken(userId: bigint): string {
    return sign({ sub: userId.toString() }, this.secret, {
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    });
  }

  /** Returns userId string, or throws on invalid/expired token. */
  verifyAccessToken(token: string): string {
    const payload = verify(token, this.secret) as { sub?: string };
    if (!payload.sub) throw new Error('missing sub');
    return payload.sub;
  }
}
