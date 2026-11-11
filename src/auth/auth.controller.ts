import { Body, Controller, Get, HttpCode, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';

@Controller('v1/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @HttpCode(200)
  async login(@Body() body: { code?: string }) {
    const { tokens, user } = await this.auth.login(requireCode(body));
    return { ...tokens, user };
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(@Body() body: { refreshToken?: string }) {
    return this.auth.refresh(requireRefreshToken(body));
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Body() body: { refreshToken?: string }) {
    await this.auth.logout(requireRefreshToken(body));
  }
}

@Controller('v1/me')
@UseGuards(JwtAuthGuard)
export class MeController {
  constructor(private readonly auth: AuthService) {}

  @Get()
  async me(@Req() req: Request) {
    const user = await this.auth.getUser(req.user!.userId);
    return toUserDto(user);
  }

  @Patch()
  async updateMe(@Req() req: Request, @Body() body: { nickname?: string; avatarUrl?: string }) {
    const user = await this.auth.updateProfile(req.user!.userId, body.nickname, body.avatarUrl);
    return toUserDto(user);
  }
}

function toUserDto(user: { id: bigint; nickname: string | null; avatarUrl: string | null }) {
  return { id: user.id.toString(), nickname: user.nickname, avatarUrl: user.avatarUrl };
}

function requireCode(body: unknown): string {
  const code = (body as { code?: string } | undefined)?.code;
  if (!code) throw new Error('code required');
  return code;
}

function requireRefreshToken(body: unknown): string {
  const token = (body as { refreshToken?: string } | undefined)?.refreshToken;
  if (!token) throw new Error('refreshToken required');
  return token;
}
