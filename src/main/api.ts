import { Logger } from '@nestjs/common';
import { AppConfigService } from '../shared/config/app-config.service';
import { createApiApplication } from './create-api-app';

async function bootstrap(): Promise<void> {
  const app = await createApiApplication();
  const configService = app.get(AppConfigService);
  await app.listen(configService.port);
  Logger.log(`API listening on port ${configService.port}`, 'Bootstrap');
}

void bootstrap();
