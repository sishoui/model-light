import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { BackupBody, DevicesService, DeviceMetaBody } from './devices.service';

@Controller('v1/devices')
@UseGuards(JwtAuthGuard)
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Get()
  async list(@Req() req: Request, @Query('cursor') cursor?: string) {
    return this.devices.list(req.user!.userId, cursor);
  }

  @Get(':mlId')
  async getOne(@Param('mlId') mlId: string) {
    return this.devices.getOne(mlId);
  }

  @Get(':mlId/backup')
  async getBackup(@Param('mlId') mlId: string, @Query('fwVersion') fwVersion?: string) {
    return this.devices.getBackup(mlId, fwVersion);
  }

  @Put(':mlId/backup')
  async putBackup(@Param('mlId') mlId: string, @Req() req: Request, @Body() body: BackupBody) {
    const contentLength = Number(req.headers['content-length'] ?? NaN);
    return this.devices.putBackup(mlId, req.user!.userId, body ?? {}, Number.isNaN(contentLength) ? undefined : contentLength);
  }

  @Post(':mlId/backup/restore-last-good')
  @HttpCode(200)
  async restoreLastGood(@Param('mlId') mlId: string) {
    return this.devices.restoreLastGood(mlId);
  }

  @Put(':mlId')
  async putMeta(@Param('mlId') mlId: string, @Req() req: Request, @Body() body: DeviceMetaBody) {
    void req;
    return this.devices.putMeta(mlId, body ?? {});
  }

  @Delete(':mlId')
  @HttpCode(204)
  async remove(@Param('mlId') mlId: string) {
    await this.devices.remove(mlId);
  }
}
