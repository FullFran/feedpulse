import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayNotEmpty, IsArray, ValidateNested } from 'class-validator';
import { RuleModel } from '../../../shared/http/swagger.models';
import { CreateRuleDto } from './create-rule.dto';

/**
 * Upper bound on one batch.
 *
 * Sized against the workflow it exists for: an operator who has just imported an
 * OPML file with a few dozen feeds and now wants the matching rule set in one
 * call, instead of one POST per rule. Fifty rules is comfortably past that and
 * still small enough that the single multi-row INSERT stays a cheap statement
 * and the request body stays inside the global body limit.
 */
export const BATCH_CREATE_RULES_MAX_ITEMS = 50;

/**
 * Payload for `POST /api/v1/rules/batch`.
 *
 * `@ValidateNested` + `@Type` make class-validator apply every `CreateRuleDto`
 * constraint to each item, so per-rule limits (name length, keyword count,
 * keyword length) are enforced identically whether a rule arrives one at a time
 * or fifty at a time.
 */
export class BatchCreateRulesDto {
  @ApiProperty({
    type: [CreateRuleDto],
    minItems: 1,
    maxItems: BATCH_CREATE_RULES_MAX_ITEMS,
    description:
      'Rules to create. Create-only: a name the tenant already uses is reported back untouched, never overwritten.',
  })
  @IsArray()
  @ArrayNotEmpty({ message: 'batch_rules_empty' })
  @ArrayMaxSize(BATCH_CREATE_RULES_MAX_ITEMS, { message: 'batch_rules_exceeds_max' })
  @ValidateNested({ each: true })
  @Type(() => CreateRuleDto)
  rules!: CreateRuleDto[];
}

/**
 * Response body of `POST /api/v1/rules/batch`.
 *
 * The three name sets are disjoint, so an operator reading the response never
 * has to reconcile them: whatever is not in `created` is accounted for by
 * exactly one of the other two lists, with the reason implied by which.
 */
export class BatchCreateRulesResultModel {
  @ApiProperty({ type: [RuleModel], description: 'Rules that were newly created by this request.' })
  created!: RuleModel[];

  @ApiProperty({
    type: [String],
    example: ['AI updates'],
    description: 'Names left untouched because the tenant already had a rule with that name.',
  })
  skippedNames!: string[];

  @ApiProperty({
    type: [String],
    example: ['Evictions'],
    description: 'Names the request listed more than once. Only the first occurrence was used.',
  })
  duplicateNames!: string[];
}
