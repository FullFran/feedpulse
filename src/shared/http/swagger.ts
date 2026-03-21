import { Type, applyDecorators } from '@nestjs/common';
import { ApiExtraModels, ApiResponse, getSchemaPath } from '@nestjs/swagger';

import { ApiMetaModel, ErrorEnvelopeModel, PaginatedMetaModel } from './swagger.models';

function buildEnvelopeSchema(model: Type<unknown>, isArray: boolean, paginated: boolean) {
  return {
    type: 'object',
    required: ['data', 'meta'],
    properties: {
      data: isArray
        ? {
            type: 'array',
            items: { $ref: getSchemaPath(model) },
          }
        : { $ref: getSchemaPath(model) },
      meta: { $ref: getSchemaPath(paginated ? PaginatedMetaModel : ApiMetaModel) },
    },
  };
}

export function ApiEnvelopeResponse(
  model: Type<unknown>,
  options: {
    status: number;
    description: string;
    isArray?: boolean;
    paginated?: boolean;
  },
) {
  return applyDecorators(
    ApiExtraModels(model, ApiMetaModel, PaginatedMetaModel),
    ApiResponse({
      status: options.status,
      description: options.description,
      schema: buildEnvelopeSchema(model, options.isArray ?? false, options.paginated ?? false),
    }),
  );
}

export function ApiStandardErrorResponses() {
  return applyDecorators(
    ApiExtraModels(ErrorEnvelopeModel),
    ApiResponse({
      status: 400,
      description: 'Invalid request payload or query parameters.',
      schema: { $ref: getSchemaPath(ErrorEnvelopeModel) },
    }),
    ApiResponse({
      status: 404,
      description: 'Requested resource was not found.',
      schema: { $ref: getSchemaPath(ErrorEnvelopeModel) },
    }),
    ApiResponse({
      status: 409,
      description: 'Request conflicts with existing state.',
      schema: { $ref: getSchemaPath(ErrorEnvelopeModel) },
    }),
    ApiResponse({
      status: 503,
      description: 'Dependency readiness checks failed.',
      schema: { $ref: getSchemaPath(ErrorEnvelopeModel) },
    }),
  );
}
