import { Global, Module } from '@nestjs/common';
import { ApiKeysRepository } from '../../modules/auth/api-keys.repository';
import { ClerkSessionVerifierService } from './clerk-session-verifier.service';
import { HttpAuthService } from './http-auth.service';

/**
 * Global because HttpAuthService is installed as express middleware in create-api-app.ts, before
 * any module scope exists. DatabaseModule is itself global, so ApiKeysRepository resolves its
 * DatabaseService here without an explicit import.
 */
@Global()
@Module({
  providers: [ApiKeysRepository, ClerkSessionVerifierService, HttpAuthService],
  exports: [ApiKeysRepository, ClerkSessionVerifierService, HttpAuthService],
})
export class AuthModule {}
