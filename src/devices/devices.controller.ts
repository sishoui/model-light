import { Body, Controller, Delete, Get, HttpCode, Param, Put, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DevicesService, DeviceMetaBody } from './devices.service';

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
