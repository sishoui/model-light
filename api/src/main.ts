import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import express from 'express';
import { AppModule } from './app.module';
import { RequestIdMiddleware } from './common/request-id.middleware';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });
  app.use(express.json({ limit: '1mb' }));
  const requestId = new RequestIdMiddleware();
  app.use(requestId.use.bind(requestId));
  if (process.env.BOOTSTRAP_ONLY === '1') {
    // DI smoke mode: full Nest container assembled, no listen, exit 0.
    await app.close();
    return;
  }
  await app.listen(process.env.PORT ? Number(process.env.PORT) : 8080);
}

void bootstrap();
