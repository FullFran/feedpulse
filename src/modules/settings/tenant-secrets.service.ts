import { BadRequestException, Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { AppConfigService } from '../../shared/config/app-config.service';

import { TenantEncryptedSecret } from './settings.repository';

const CIPHER_ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12;

@Injectable()
export class TenantSecretsService {
  constructor(private readonly appConfigService: AppConfigService) {}

  encryptTelegramBotToken(token: string): TenantEncryptedSecret {
    const key = this.getDerivedMasterKeyOrThrow();
    const iv = randomBytes(IV_LENGTH_BYTES);
    const cipher = createCipheriv(CIPHER_ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return {
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
    };
  }

  decryptTelegramBotToken(secret: TenantEncryptedSecret): string {
    const key = this.getDerivedMasterKeyOrThrow();
    const iv = Buffer.from(secret.iv, 'base64');
    const ciphertext = Buffer.from(secret.ciphertext, 'base64');
    const tag = Buffer.from(secret.tag, 'base64');

    const decipher = createDecipheriv(CIPHER_ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    if (!plaintext) {
      throw new Error('tenant_telegram_token_empty_after_decrypt');
    }

    return plaintext;
  }

  canUseTenantSecrets(): boolean {
    return Boolean(this.appConfigService.tenantSecretsMasterKey);
  }

  private getDerivedMasterKeyOrThrow(): Buffer {
    const masterKey = this.appConfigService.tenantSecretsMasterKey;
    if (!masterKey) {
      throw new BadRequestException('tenant_secrets_master_key_missing');
    }

    return createHash('sha256').update(masterKey, 'utf8').digest();
  }
}
