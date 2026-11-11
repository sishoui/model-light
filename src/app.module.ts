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
import { PrismaService } from './prisma/prisma.service';
import { WxHttpGateway } from './wx/wx-http.gateway';

@Module({
  controllers: [AuthController, MeController, DevicesController],
  providers: [
    AuthService,
    DevicesService,
    JwtService,
    JwtAuthGuard,
    { provide: 'AuthStore', useClass: PrismaAuthStore },
    { provide: 'DeviceStore', useClass: PrismaDeviceStore },
    { provide: 'WxGateway', useClass: WxHttpGateway },
    { provide: 'JWT_SECRET', useValue: process.env.JWT_SECRET ?? 'dev-secret' },
    { provide: 'WX_APPID', useValue: process.env.WX_APPID ?? '' },
    { provide: 'WX_SECRET', useValue: process.env.WX_SECRET ?? '' },
    PrismaService,
    { provide: APP_FILTER, useClass: ErrorFormatFilter },
  ],
})
export class AppModule {}

