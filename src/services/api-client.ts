/**
 * Anthropic API Client for Claude Managed Agents
 *
 * HTTP client for making authenticated requests to the Anthropic API
 * (https://api.anthropic.com) on behalf of users. The API key is passed
 * as the `x-api-key` header and the required beta headers
 * (`anthropic-version`, `anthropic-beta`) are attached automatically.
 *
 * Two timeouts are available:
 *   - apiGet/apiPost/apiPut/apiPatch/apiDelete: fast timeout (~30s) for
 *     quick CRUD operations
 *   - apiStream: long timeout (~30min) for SSE streams (session events)
 */

import { config } from "../config.js";
import { logger } from "../utils/logger.js";

// =============================================================================
// Types
// =============================================================================

export interface ApiRequestOptions {
  /** HTTP method */
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Request body (will be JSON stringified) */
  body?: unknown;
  /** Additional headers */
  headers?: Record<string, string>;
  /** Request timeout in milliseconds. Defaults to fastTimeoutMs for non-streaming requests. */
  timeout?: number;
  /** Query parameters */
  params?: Record<string, string | number | boolean | undefined>;
  /** If true, skip JSON parsing and return the raw Response. Used by apiStream. */
  rawResponse?: boolean;
}

export interface ApiResponse<T = unknown> {
  /** Response data */
  data: T;
  /** HTTP status code */
  status: number;
  /** Response headers */
  headers: Headers;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly response?: unknown
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Specific error for expired/invalid OAuth tokens (HTTP 401 from upstream API).
 * This is thrown instead of caught so the HTTP transport layer can return
 * a proper HTTP 401 to the MCP client, triggering automatic token refresh.
 */
export class AuthExpiredError extends ApiError {
  constructor(message: string, response?: unknown) {
    super(message, 401, response);
    this.name = "AuthExpiredError";
  }
}

// =============================================================================
// API Client
// =============================================================================

/**
 * Make an authenticated request to the SaaS API
 *
 * @param accessToken OAuth access token for the SaaS API
 * @param endpoint API endpoint (relative to SAAS_API_BASE_URL)
 * @param options Request options
 * @returns Promise resolving to API response
 *
 * @example
 * // GET request
 * const messages = await apiRequest(token, '/gmail/v1/users/me/messages');
 *
 * // POST request with body
 * const result = await apiRequest(token, '/gmail/v1/users/me/messages/send', {
 *   method: 'POST',
 *   body: { raw: base64EncodedEmail }
 * });
 */
export async function apiRequest<T = unknown>(
  accessToken: string,
  endpoint: string,
  options: ApiRequestOptions = {}
): Promise<ApiResponse<T>> {
  const {
    method = "GET",
    body,
    headers = {},
    timeout = config.saasApi.fastTimeoutMs,
    params,
    rawResponse = false,
  } = options;

  // Validate base URL is configured for relative endpoints
  if (!endpoint.startsWith("http") && !config.saasApi.baseUrl) {
    throw new ApiError(
      "SAAS_API_BASE_URL not configured. Set this environment variable to use relative API endpoints.",
      500
    );
  }

  // Build URL with query parameters
  let url = endpoint.startsWith("http")
    ? endpoint
    : `${config.saasApi.baseUrl}${endpoint}`;

  if (params) {
    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined) {
        searchParams.append(key, String(value));
      }
    });
    const queryString = searchParams.toString();
    if (queryString) {
      url += (url.includes("?") ? "&" : "?") + queryString;
    }
  }

  // Build Anthropic-specific headers
  const requestHeaders: Record<string, string> = {
    "x-api-key": accessToken,
    "anthropic-version": config.saasApi.anthropicVersion,
    "anthropic-beta": config.saasApi.anthropicBeta,
    Accept: "application/json",
    ...headers,
  };

  if (body) {
    requestHeaders["Content-Type"] = "application/json";
  }

  // Create abort controller for timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    logger.debug(`API request: ${method} ${url}`);

    const response = await fetch(url, {
      method,
      headers: requestHeaders,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    // For raw responses (streaming), return the Response object without parsing.
    // Caller is responsible for handling the body stream and must handle errors themselves.
    if (rawResponse) {
      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        logger.error(`API error ${response.status}`, { url, status: response.status });
        if (response.status === 401) {
          throw new AuthExpiredError(
            `API request failed: 401 Unauthorized — access token may be expired`,
            errorText
          );
        }
        throw new ApiError(
          `API request failed: ${response.status} ${response.statusText}: ${errorText.slice(0, 500)}`,
          response.status,
          errorText
        );
      }
      // Return a special marker — the caller will read response.body directly via a separate helper.
      return {
        data: response as unknown as T,
        status: response.status,
        headers: response.headers,
      };
    }

    // Parse response
    let data: T;
    const contentType = response.headers.get("content-type");

    if (contentType?.includes("application/json")) {
      data = (await response.json()) as T;
    } else {
      data = (await response.text()) as T;
    }

    // Handle errors
    if (!response.ok) {
      logger.error(`API error ${response.status}`, { url, status: response.status });
      if (response.status === 401) {
        throw new AuthExpiredError(
          `API request failed: 401 Unauthorized — access token may be expired`,
          data
        );
      }
      throw new ApiError(
        `API request failed: ${response.status} ${response.statusText}`,
        response.status,
        data
      );
    }

    logger.debug(`API success ${response.status}`, { url });

    return {
      data,
      status: response.status,
      headers: response.headers,
    };
  } catch (error) {
    clearTimeout(timeoutId);

    if (error instanceof ApiError) {
      throw error;
    }

    if (error instanceof Error) {
      if (error.name === "AbortError") {
        throw new ApiError(`Request timeout after ${timeout}ms`, 408);
      }
      throw new ApiError(error.message, 500);
    }

    throw new ApiError("Unknown error", 500);
  }
}

// =============================================================================
// Convenience Methods
// =============================================================================

/**
 * GET request to SaaS API
 */
export async function apiGet<T = unknown>(
  accessToken: string,
  endpoint: string,
  params?: Record<string, string | number | boolean | undefined>
): Promise<T> {
  const response = await apiRequest<T>(accessToken, endpoint, {
    method: "GET",
    params,
  });
  return response.data;
}

/**
 * POST request to SaaS API
 */
export async function apiPost<T = unknown>(
  accessToken: string,
  endpoint: string,
  body?: unknown
): Promise<T> {
  const response = await apiRequest<T>(accessToken, endpoint, {
    method: "POST",
    body,
  });
  return response.data;
}

/**
 * PUT request to SaaS API
 */
export async function apiPut<T = unknown>(
  accessToken: string,
  endpoint: string,
  body?: unknown
): Promise<T> {
  const response = await apiRequest<T>(accessToken, endpoint, {
    method: "PUT",
    body,
  });
  return response.data;
}

/**
 * PATCH request to SaaS API
 */
export async function apiPatch<T = unknown>(
  accessToken: string,
  endpoint: string,
  body?: unknown
): Promise<T> {
  const response = await apiRequest<T>(accessToken, endpoint, {
    method: "PATCH",
    body,
  });
  return response.data;
}

/**
 * DELETE request to SaaS API
 */
export async function apiDelete<T = unknown>(
  accessToken: string,
  endpoint: string
): Promise<T> {
  const response = await apiRequest<T>(accessToken, endpoint, {
    method: "DELETE",
  });
  return response.data;
}

// =============================================================================
// SSE Streaming (for session event streams)
// =============================================================================

/**
 * A single event parsed from an SSE stream.
 *
 * The Anthropic Managed Agents API emits events in the form:
 *   event: session.status_running
 *   data: {"type":"session.status_running","id":"...","processed_at":"..."}
 *
 *   event: agent.tool_use
 *   data: {"type":"agent.tool_use","name":"web_search","tool_use_id":"..."}
 *
 * We parse these into a simple object.
 */
export interface SseEvent {
  event?: string;
  data: unknown;
  id?: string;
  raw: string;
}

/**
 * Open an SSE stream on the Anthropic API.
 *
 * Opens a GET request to the given endpoint with the long-running timeout
 * (default 30 minutes via config.saasApi.timeoutMs) and yields parsed SSE
 * events as they arrive. The generator completes when the upstream closes
 * the stream, or throws on network/auth errors.
 *
 * Example:
 *   for await (const event of apiStream(token, `/v1/sessions/${id}/events/stream`)) {
 *     if (event.event === 'session.status_idle') break;
 *     console.log(event.event, event.data);
 *   }
 *
 * @param accessToken Anthropic API key
 * @param endpoint Stream endpoint, e.g., `/v1/sessions/{id}/events/stream`
 * @param options Optional extra headers, timeout override, abort signal
 */
export async function* apiStream(
  accessToken: string,
  endpoint: string,
  options: {
    headers?: Record<string, string>;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {}
): AsyncGenerator<SseEvent, void, undefined> {
  const timeoutMs = options.timeoutMs ?? config.saasApi.timeoutMs;

  // Build URL
  const url = endpoint.startsWith("http")
    ? endpoint
    : `${config.saasApi.baseUrl}${endpoint}`;

  // Internal abort controller for timeout, chained with any caller signal
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  if (options.signal) {
    if (options.signal.aborted) {
      controller.abort();
    } else {
      options.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
  }

  const headers: Record<string, string> = {
    "x-api-key": accessToken,
    "anthropic-version": config.saasApi.anthropicVersion,
    "anthropic-beta": config.saasApi.anthropicBeta,
    Accept: "text/event-stream",
    ...(options.headers ?? {}),
  };

  let response: Response;
  try {
    logger.debug(`SSE stream: GET ${url}`);
    response = await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === "AbortError") {
      throw new ApiError(`SSE stream aborted or timed out after ${timeoutMs}ms`, 408);
    }
    throw new ApiError(
      `SSE stream failed to open: ${error instanceof Error ? error.message : String(error)}`,
      500
    );
  }

  if (!response.ok) {
    clearTimeout(timeoutId);
    const errorText = await response.text().catch(() => "");
    logger.error(`SSE stream error ${response.status}`, { url, status: response.status });
    if (response.status === 401) {
      throw new AuthExpiredError(
        `SSE stream failed: 401 Unauthorized — API key may be expired`,
        errorText
      );
    }
    throw new ApiError(
      `SSE stream failed: ${response.status} ${response.statusText}: ${errorText.slice(0, 500)}`,
      response.status,
      errorText
    );
  }

  if (!response.body) {
    clearTimeout(timeoutId);
    throw new ApiError("SSE stream response has no body", 500);
  }

  // Parse the SSE stream
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  try {
    while (true) {
      let readResult: { done: boolean; value: Uint8Array | undefined };
      try {
        readResult = await reader.read();
      } catch (readError) {
        // When the consumer aborts the controller (e.g., session hit idle
        // and the streaming loop broke out), the pending reader.read() throws
        // an AbortError. This is expected and not a real error — just exit
        // the loop cleanly.
        if (readError instanceof Error && readError.name === "AbortError") {
          break;
        }
        throw readError;
      }

      const { done, value } = readResult;
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by double newlines
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        const parsed = parseSseEvent(rawEvent);
        if (parsed) {
          yield parsed;
        }
      }
    }

    // Flush any remaining buffered event
    if (buffer.trim().length > 0) {
      const parsed = parseSseEvent(buffer);
      if (parsed) {
        yield parsed;
      }
    }
  } finally {
    clearTimeout(timeoutId);
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}

/**
 * Parse a single SSE event block into an SseEvent.
 *
 * A block looks like:
 *   event: agent.message
 *   data: {"type":"agent.message","content":[...]}
 *   id: evt_abc123
 *
 * Returns null if the block is empty or contains only comments.
 */
function parseSseEvent(block: string): SseEvent | null {
  const lines = block.split("\n");
  let eventType: string | undefined;
  let dataStr = "";
  let id: string | undefined;
  let hasData = false;

  for (const line of lines) {
    if (!line || line.startsWith(":")) {
      // Comment line or blank — skip
      continue;
    }
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const field = line.slice(0, colonIdx);
    // SSE spec: if there's a space after the colon, strip it
    const value = line.slice(colonIdx + 1).replace(/^ /, "");

    switch (field) {
      case "event":
        eventType = value;
        break;
      case "data":
        if (hasData) dataStr += "\n";
        dataStr += value;
        hasData = true;
        break;
      case "id":
        id = value;
        break;
    }
  }

  if (!hasData) return null;

  // Try to parse data as JSON; fall back to raw string
  let data: unknown;
  try {
    data = JSON.parse(dataStr);
  } catch {
    data = dataStr;
  }

  return {
    event: eventType,
    data,
    id,
    raw: block,
  };
}

// =============================================================================
// Error Handling Helpers
// =============================================================================

/**
 * Format API error for tool response
 *
 * @param error The caught error
 * @param operation Description of the operation that failed
 * @returns Formatted error message
 */
export function formatApiError(error: unknown, operation: string): string {
  if (error instanceof ApiError) {
    switch (error.statusCode) {
      case 401:
        return `Authentication failed: Your access token may be expired. Please re-authenticate.`;
      case 403:
        return `Permission denied: You don't have access to ${operation}.`;
      case 404:
        return `Not found: The requested resource does not exist.`;
      case 429:
        return `Rate limit exceeded: Please wait before making more requests.`;
      default:
        return `API error (${error.statusCode}): ${error.message}`;
    }
  }

  if (error instanceof Error) {
    return `Error: ${error.message}`;
  }

  return `Unknown error during ${operation}`;
}
