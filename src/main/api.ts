import { Logger as NestLogger } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import { AppConfigService } from '../shared/config/app-config.service';
import { handleBootstrapFailure, installProcessGuards, resolveShutdownTimeoutMs } from './bootstrap-guards';
import { createApiApplication } from './create-api-app';

const BOOTSTRAP_CONTEXT = 'ApiBootstrap';

async function bootstrap(): Promise<void> {
  const app = await createApiApplication();
  // Routes every `@nestjs/common` Logger call through pino so framework logs and
  // application logs land in the same structured stream.
  app.useLogger(app.get(Logger));

  const configService = app.get(AppConfigService);
  installProcessGuards(app, {
    context: BOOTSTRAP_CONTEXT,
    shutdownTimeoutMs: resolveShutdownTimeoutMs(configService),
  });

  await app.listen(configService.port);
  new NestLogger(BOOTSTRAP_CONTEXT).log(`API listening on port ${configService.port}`);
}

void bootstrap().catch((error: unknown) => {
  handleBootstrapFailure(error, BOOTSTRAP_CONTEXT);
});
