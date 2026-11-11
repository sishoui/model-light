import { Controller, Get } from '@nestjs/common';

/** Liveness for deploy/rollback.sh health checks. No auth, no deps. */
@Controller('v1/health')
export class HealthController {
  @Get()
  check() {
    return { ok: true };
  }
}
