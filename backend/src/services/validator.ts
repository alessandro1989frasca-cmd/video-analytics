/**
 * Schema validator — wraps Ajv with the event batch schema.
 * The outer batch envelope is validated first, then each event's payload
 * is validated individually against the per-event payload schema map.
 *
 * A single invalid event does NOT reject the whole batch.
 * Invalid events are quarantined to a separate ClickHouse table for debugging.
 */

import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { EVENT_BATCH_SCHEMA, PAYLOAD_SCHEMAS } from '../../../schema/event-batch-schema';
import type { EventBatch, AnalyticsEvent } from '../../../schema/events';

const ajv = new Ajv({ allErrors: true, coerceTypes: false });
addFormats(ajv);

const validateBatch  = ajv.compile(EVENT_BATCH_SCHEMA);
const payloadValidators = Object.fromEntries(
  Object.entries(PAYLOAD_SCHEMAS).map(([type, schema]) => [type, ajv.compile(schema)])
);

export interface ValidationResult {
  valid: AnalyticsEvent[];
  invalid: Array<{ event: unknown; errors: string }>;
}

/**
 * Validates a parsed JSON body as an EventBatch.
 * Returns { valid, invalid } splitting events by per-payload validity.
 */
export function validateBatchPayload(body: unknown): {
  ok: true;
  result: ValidationResult;
} | {
  ok: false;
  errors: string;
} {
  // 1. Outer envelope validation
  if (!validateBatch(body)) {
    return {
      ok: false,
      errors: ajv.errorsText(validateBatch.errors)
    };
  }

  const batch = body as EventBatch;
  const valid: AnalyticsEvent[] = [];
  const invalid: ValidationResult['invalid'] = [];

  // 2. Per-event payload validation
  for (const event of batch.events) {
    const payloadValidator = payloadValidators[event.event_type];
    if (!payloadValidator) {
      // Unknown event type — the outer schema enum should have caught this,
      // but treat it as invalid if it somehow slips through.
      invalid.push({ event, errors: `Unknown event_type: ${event.event_type}` });
      continue;
    }

    if (!payloadValidator(event.payload)) {
      invalid.push({
        event,
        errors: ajv.errorsText(payloadValidator.errors)
      });
    } else {
      valid.push(event);
    }
  }

  return { ok: true, result: { valid, invalid } };
}
