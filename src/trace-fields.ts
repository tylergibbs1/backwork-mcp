import type { OperationId } from "./api-operations.js";

/**
 * Fields that only trace a request, not answer it. Tool results leave them
 * out (response minimization in https://developers.openai.com/plugins/plugin-guidelines#tool-data-handling);
 * the request ID of a failed call goes to the server log instead.
 */
const TRACE_FIELDS: ReadonlySet<string> = new Set(["request_id", "timestamp"]);

/** Operations whose `data`, not just `meta`, carries a trace field: the health check stamps its response time. */
const TRACE_FIELDS_IN_DATA: ReadonlySet<OperationId> = new Set(["getHealth"]);

function withoutTraceFields(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !TRACE_FIELDS.has(key)));
}

/** A successful API envelope with trace fields removed from `meta` (and from `data` where the operation puts them there). */
export function minimizeEnvelope<T extends { data?: unknown; meta?: unknown }>(operationId: OperationId, envelope: T): T {
  return {
    ...envelope,
    ...("meta" in envelope ? { meta: withoutTraceFields(envelope.meta) } : {}),
    ...("data" in envelope && TRACE_FIELDS_IN_DATA.has(operationId) ? { data: withoutTraceFields(envelope.data) } : {}),
  };
}
