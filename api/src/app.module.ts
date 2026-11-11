import { Inject, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuthController, MeController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { JwtService } from './auth/jwt.service';
import { DevicesController } from './devices/devices.controller';
import { DevicesService } from './devices/devices.service';
import { ErrorFormatFilter } from './common/error-format.filter';
import { PrismaAuthStore } from './prisma/prisma-auth.store';
import { PrismaDeviceStore } from './prisma/prisma-device.store';
import { PrismaBackupStore } from './prisma/prisma-backup.store';
import { PrismaService } from './prisma/prisma.service';
import { HealthController } from './health/health.controller';
import { WxHttpGateway } from './wx/wx-http.gateway';

/** In-memory fixed-window rate limiter (per process; single-node deployment per spec §10). */
class MemoryRateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  consume(key: string, limit: number, windowMs: number): { allowed: boolean; retryAfterSeconds: number } {
    const now = Date.now();
    const hit = this.hits.get(key);
    if (!hit || hit.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    if (hit.count < limit) {
      hit.count += 1;
      return { allowed: true, retryAfterSeconds: 0 };
    }
    return { allowed: false, retryAfterSeconds: Math.ceil((hit.resetAt - now) / 1000) };
  }
}

@Module({
  controllers: [AuthController, MeController, DevicesController, HealthController],
  providers: [
    AuthService,
    DevicesService,
    JwtService,
    JwtAuthGuard,
    { provide: 'AuthStore', useClass: PrismaAuthStore },
    { provide: 'DeviceStore', useClass: PrismaDeviceStore },
    { provide: 'BackupStore', useClass: PrismaBackupStore },
    { provide: 'RateLimiter', useClass: MemoryRateLimiter },
    { provide: 'WxGateway', useClass: WxHttpGateway },
    { provide: 'JWT_SECRET', useValue: process.env.JWT_SECRET ?? 'dev-secret' },
    { provide: 'WX_APPID', useValue: process.env.WX_APPID ?? '' },
    { provide: 'WX_SECRET', useValue: process.env.WX_SECRET ?? '' },
    PrismaService,
    { provide: APP_FILTER, useClass: ErrorFormatFilter },
  ],
})
export class AppModule {}

