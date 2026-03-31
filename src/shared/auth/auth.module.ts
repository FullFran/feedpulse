import { Global, Module } from '@nestjs/common';

import { ClerkSessionVerifierService } from './clerk-session-verifier.service';
import { HttpAuthService } from './http-auth.service';

@Global()
@Module({
  providers: [ClerkSessionVerifierService, HttpAuthService],
  exports: [ClerkSessionVerifierService, HttpAuthService],
})
export class AuthModule {}
