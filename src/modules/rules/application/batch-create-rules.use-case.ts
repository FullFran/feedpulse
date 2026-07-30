import { Injectable } from '@nestjs/common';
import { BatchInsertRulesResult, RuleDraft, RulesRepository } from '../rules.repository';

/**
 * Batch rule creation.
 *
 * `tenantId` MUST come from the authenticated request context, never from the payload: it is the
 * only thing keeping one tenant's batch out of another tenant's rule set.
 *
 * CREATE-ONLY by contract. A name the tenant already uses is reported back, not overwritten, so
 * re-sending a batch is safe and a caller can never destroy an existing rule's keywords by
 * accident. Replacement is a different intent and has a different door (`upsertByName`, used by
 * the OPML import path).
 *
 * The use case owns the defaults an omitted field implies; the repository owns the SQL. Neither
 * knows about HTTP.
 */
export interface BatchCreateRulesInput {
  tenantId: string;
  rules: RuleDraft[];
}

@Injectable()
export class BatchCreateRulesUseCase {
  constructor(private readonly rulesRepository: RulesRepository) {}

  execute(input: BatchCreateRulesInput): Promise<BatchInsertRulesResult> {
    return this.rulesRepository.insertIgnoreOnConflict(input.rules, input.tenantId);
  }
}
