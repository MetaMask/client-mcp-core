import { redactUrlsInText, truncateText } from './redact.js';
import type { RpcError } from '../tools/types/events.js';

/** Request bodies larger than this are not parsed for JSON-RPC methods. */
export const MAX_RPC_REQUEST_BYTES = 64 * 1024;

/** Methods kept from one batch. */
export const MAX_RPC_BATCH_METHODS = 50;

/** Longest JSON-RPC method name kept. */
export const MAX_RPC_METHOD_NAME_LENGTH = 128;

const MAX_RPC_ERROR_MESSAGE_LENGTH = 300;

/**
 * Returns the method of a JSON-RPC call object, cut to
 * {@link MAX_RPC_METHOD_NAME_LENGTH}.
 *
 * @param call - A parsed JSON value.
 * @returns The method, or undefined when the value is not a JSON-RPC call.
 */
function getRpcCallMethod(call: unknown): string | undefined {
  if (typeof call !== 'object' || call === null) {
    return undefined;
  }
  const { method } = call as { method?: unknown };
  if (
    typeof method !== 'string' ||
    !('jsonrpc' in call || 'id' in call || 'params' in call)
  ) {
    return undefined;
  }
  return method.length > MAX_RPC_METHOD_NAME_LENGTH
    ? method.slice(0, MAX_RPC_METHOD_NAME_LENGTH)
    : method;
}

/**
 * Reads the JSON-RPC methods of a request body: one for a single call, the
 * methods in order for a batch (at most {@link MAX_RPC_BATCH_METHODS}).
 *
 * @param body - The request body text.
 * @returns The methods, or undefined when the body is not JSON-RPC.
 */
export function parseRpcMethods(
  body: string | undefined,
): string[] | undefined {
  if (body === undefined || body.length > MAX_RPC_REQUEST_BYTES) {
    return undefined;
  }
  const text = body.trimStart();
  if (!text.startsWith('{') && !text.startsWith('[')) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const calls = Array.isArray(parsed) ? parsed : [parsed];
  const methods = calls
    .map(getRpcCallMethod)
    .filter((method): method is string => method !== undefined)
    .slice(0, MAX_RPC_BATCH_METHODS);
  return methods.length === 0 ? undefined : methods;
}

/**
 * Returns the JSON-RPC error of a response body: the `error` of a single
 * response, or the first error of a batch.
 *
 * @param body - The response body text.
 * @returns The error with its message redacted, or undefined.
 */
export function parseRpcError(body: string): RpcError | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const responses = Array.isArray(parsed) ? parsed : [parsed];
  for (const response of responses) {
    const error =
      typeof response === 'object' && response !== null
        ? (response as { error?: unknown }).error
        : undefined;
    if (typeof error !== 'object' || error === null) {
      continue;
    }
    const { code, message } = error as { code?: unknown; message?: unknown };
    return {
      ...(typeof code === 'number' ? { code } : {}),
      message: truncateText(
        redactUrlsInText(
          typeof message === 'string' ? message : 'unknown error',
        ),
        MAX_RPC_ERROR_MESSAGE_LENGTH,
      ),
    };
  }
  return undefined;
}
