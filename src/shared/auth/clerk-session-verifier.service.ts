import { Injectable, UnauthorizedException } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';

interface ClerkTokenClaims {
  sub: string;
  sid?: string;
  org_id?: string;
  exp?: number;
}

export interface VerifiedClerkSession {
  subject: string;
  orgId: string | null;
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '==='.slice((normalized.length + 3) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

function parseJwtClaims(token: string): ClerkTokenClaims {
  const segments = token.split('.');
  const payloadSegment = segments[1];

  if (segments.length !== 3 || payloadSegment === undefined) {
    throw new UnauthorizedException('invalid_clerk_token');
  }

  let payload: ClerkTokenClaims;
  try {
    payload = JSON.parse(decodeBase64Url(payloadSegment)) as ClerkTokenClaims;
  } catch {
    throw new UnauthorizedException('invalid_clerk_token_payload');
  }

  // Checked outside the try/catch: swallowing our own rejection would report every malformed
  // subject as a payload decoding failure and make `invalid_clerk_token_subject` unreachable.
  if (!payload || typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw new UnauthorizedException('invalid_clerk_token_subject');
  }

  return payload;
}

@Injectable()
export class ClerkSessionVerifierService {
  constructor(private readonly appConfigService: AppConfigService) {}

  /**
   * DESIGN NOTE — the JWT signature is deliberately NOT verified here.
   *
   * The token is treated as an untrusted claims envelope: the only thing taken from it is the
   * session id (`sid`) and the subject (`sub`). Authority comes from the server-to-server lookup
   * of that session against the Clerk API using CLERK_SECRET_KEY. A forged, unsigned token
   * therefore cannot authenticate, because an attacker cannot invent a session id that Clerk
   * reports as `active`. The `user_id !== sub` check closes the remaining hole: replaying a valid
   * session id belonging to another user (token substitution) is rejected.
   *
   * The trade-off is one network round trip per request instead of local signature verification.
   * Do not "optimise" this by trusting the claims without the lookup.
   */
  async verify(token: string): Promise<VerifiedClerkSession> {
    const claims = parseJwtClaims(token);
    const now = Math.floor(Date.now() / 1000);

    if (typeof claims.exp === 'number' && claims.exp < now) {
      throw new UnauthorizedException('clerk_token_expired');
    }

    if (!claims.sid) {
      throw new UnauthorizedException('clerk_session_missing_sid');
    }

    const secretKey = this.appConfigService.clerkSecretKey;
    if (!secretKey) {
      throw new UnauthorizedException('clerk_secret_key_missing');
    }

    const response = await fetch(`${this.appConfigService.clerkApiUrl}/v1/sessions/${claims.sid}`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${secretKey}`,
        'content-type': 'application/json',
      },
      signal: AbortSignal.timeout(this.appConfigService.webhookNotifierTimeoutMs),
    });

    if (!response.ok) {
      throw new UnauthorizedException('clerk_session_invalid');
    }

    const body = (await response.json()) as { status?: string; user_id?: string };
    if (body.status !== 'active' || body.user_id !== claims.sub) {
      throw new UnauthorizedException('clerk_session_not_active');
    }

    return {
      subject: claims.sub,
      orgId: typeof claims.org_id === 'string' && claims.org_id.length > 0 ? claims.org_id : null,
    };
  }
}
