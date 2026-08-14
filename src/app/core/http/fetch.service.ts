import { Injectable, inject } from '@angular/core';
import { MessageService } from 'primeng/api';
import { ConfigService } from '../config/config.service';

/**
 * `responseType` controls how the response body is parsed.
 *
 * - `'json'` (default) — preserves the long-standing behaviour of calling
 *   `response.json()`. Every existing caller keeps working unchanged.
 * - `'text'` — calls `response.text()` instead. Needed for endpoints that
 *   return `application/yaml` (e.g. admin namespace export), on which
 *   `response.json()` would raise `SyntaxError`.
 *
 * Option A (single `fetch()` method with a new option) was chosen over a
 * sibling `fetchText()` method to avoid duplicating the error-notification,
 * `credentials: 'include'`, and 204/empty-body branches at two sites.
 */
export type FetchResponseType = 'json' | 'text';

/**
 * Any failure `FetchService` has ALREADY notified the user about (ADR-026 §1).
 *
 * That property — "the toast has been raised" — and NOT HTTP-ness is what
 * callers branch on when deciding whether to raise their own error toast. A
 * caller catching a `FetchFailure` must stay silent or it double-toasts;
 * anything else (an rxjs `TimeoutError`, a programming error) has never been
 * reported and is the caller's to surface.
 *
 * The base type exists so that check keeps working when a fourth failure mode
 * is added, instead of being an enumeration that silently starts double-toasting.
 */
export class FetchFailure extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'FetchFailure';
    // Restore prototype chain (TS target < ES6 / down-levelling safety).
    Object.setPrototypeOf(this, FetchFailure.prototype);
  }
}

/**
 * Error thrown by `FetchService.fetch` on non-OK HTTP responses (Story 11.3).
 *
 * `HttpError` exists so callers can branch on `.status` (e.g. 422 vs 5xx vs
 * 401) without sniffing the message string. The `body` field carries the
 * server response body — parsed as JSON when possible, falls back to the raw
 * text — so callers like the namespace-panel Save handler can consume a
 * `NamespaceValidationReport` on 422 without re-reading the response.
 *
 * The `.message` shape is preserved verbatim from the prior (non-throwing)
 * behaviour so existing notifications remain identical.
 */
export class HttpError extends FetchFailure {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
    // Restore prototype chain (TS target < ES6 / down-levelling safety).
    Object.setPrototypeOf(this, HttpError.prototype);
  }
}

/**
 * The request never reached the server: unreachable host, DNS failure, offline
 * browser, aborted request, or a CORS rejection (ADR-026 §1).
 *
 * There is deliberately **no `status` property**. `HttpError` promises a real
 * HTTP status and there is none here; minting `0` or `503` would mis-route the
 * callers that branch on the value — the namespace-panel Save handler
 * distinguishes 422 / 401 / other on `err.status`.
 *
 * The original rejection reason travels in `cause`, so an abort or a CORS
 * rejection stays debuggable even though the user is shown the generic
 * "Server unreachable" text.
 */
export class NetworkError extends FetchFailure {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'NetworkError';
    // Restore prototype chain (TS target < ES6 / down-levelling safety).
    Object.setPrototypeOf(this, NetworkError.prototype);
  }
}

/**
 * Best-effort JSON parse — returns parsed value on success, `undefined` on
 * failure. Used to populate `HttpError.body` with structured data when the
 * server emits JSON, and fall back to the raw string otherwise.
 */
function tryParseJson(text: string): unknown {
  if (text === '') {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

@Injectable({
  providedIn: 'root',
})
export class FetchService {
  messageService: MessageService = inject(MessageService);
  private config = inject(ConfigService);

  /**
   * Issue a fetch, handle notifications, and parse the body.
   *
   * The error path (non-OK status), `credentials: 'include'` injection, and
   * 204/`content-length: 0` empty-body branch are identical for every
   * `responseType` — only the final body-parse call differs.
   *
   * ONE failure contract (ADR-026): the method either returns a parsed body or
   * throws a `FetchFailure`. It never hands back a sentinel to signal failure,
   * so a falsy return means a genuinely empty body (204 / `content-length: 0`)
   * and nothing else.
   *
   * - non-OK status → `HttpError`, carrying the HTTP status and response body.
   *   Callers that need to branch on the status (e.g. the namespace-panel Save
   *   handler: 422 vs 401 vs other) narrow via `instanceof HttpError` or read
   *   `err.status`. Its `.message` still matches the prior (non-throwing)
   *   notification text, so callers catching on `Error` see the same string.
   * - the request never reached the server → `NetworkError`, with the original
   *   rejection reason in `cause` and deliberately no `status`.
   *
   * Both derive from `FetchFailure`, which is the type a caller checks to ask
   * "has the user already been told?" — the toast is raised here, once, before
   * either throw.
   *
   * @param responseType `'json'` (default) returns `response.json()`;
   *   `'text'` returns `response.text()` as a string.
   */
  async fetch({
    url,
    options,
    successMessage,
    errorMessage,
    responseType = 'json',
  }: {
    url: string;
    options?: RequestInit;
    successMessage?: string;
    errorMessage?: string;
    responseType?: FetchResponseType;
  }): Promise<any> {
    options = this.config.hideLogin
      ? options
      : { ...options, credentials: 'include' };

    let response: Response;
    try {
      response = await fetch(url, options);
    } catch (cause) {
      // Story 33-5 (ADR-026 §2): a network failure throws, like every other
      // failure here. Returning `undefined` made "we never reached the server"
      // indistinguishable from "the server returned an empty body", so callers
      // rendered an empty view — or, on the restore path, read the sentinel as
      // success and blamed a timeout ten seconds later.
      const message =
        errorMessage || 'Server unreachable. Check your connection.';
      console.error('Network error: server unreachable');
      this.showNotification(message, 'error');
      throw new NetworkError(message, { cause });
    }

    if (!response.ok) {
      let errorDetail = '';
      try {
        const errorJson = await response.clone().json();
        errorDetail = errorJson.detail || '';
      } catch {
        // Response body is not valid JSON -- fall back to text
      }
      const errorBody = await response.text();
      console.error(
        `Error: ${response.status} - ${response.statusText}`,
        errorBody
      );

      const resolvedErrorMessage =
        errorMessage ||
        `Request failed: ${response.statusText}\n\n${errorDetail}`;

      this.showNotification(resolvedErrorMessage, 'error');

      // Throw an HttpError carrying the status + parsed body so callers that
      // need to branch (e.g. 422 vs 5xx) can inspect `.status` / `.body`.
      // Backwards compatibility: `.message` remains the same string that was
      // previously shown via the toast — existing Error-catching callers keep
      // receiving the same text.
      throw new HttpError(
        resolvedErrorMessage,
        response.status,
        tryParseJson(errorBody) ?? errorBody,
      );
    } else if (successMessage) {
      this.showNotification(successMessage, 'success');
    }

    // 204 No Content (and other bodyless responses) cannot be parsed as JSON
    if (response.status === 204 || response.headers.get('content-length') === '0') {
      return undefined;
    }

    return responseType === 'text' ? response.text() : response.json();
  }

  showNotification(
    message: string,
    type: 'success' | 'error' = 'success'
  ): void {
    this.messageService.add({
      severity: type,
      summary: message,
    });
  }
}
