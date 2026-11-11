import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from './jwt.service';

export interface RequestUser {
  userId: bigint;
}

// Attach userId to the request for downstream handlers.
declare module 'http' {
  interface IncomingMessage {
    user?: RequestUser;
  }
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(@Inject(JwtService) private readonly jwt: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const header: string | undefined = req.headers['authorization'];
    if (!header || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException();
    }
    try {
      const sub = this.jwt.verifyAccessToken(header.slice('Bearer '.length));
      req.user = { userId: BigInt(sub) };
      return true;
    } catch {
      throw new UnauthorizedException();
    }
  }
}
