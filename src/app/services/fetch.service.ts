import { Injectable, inject } from '@angular/core';
import { MessageService } from 'primeng/api';
import { ConfigService } from './config.service';

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
    } catch {
      console.error('Network error: server unreachable');
      this.showNotification(
        errorMessage || 'Server unreachable. Check your connection.',
        'error'
      );
      return undefined;
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

      this.showNotification(
        errorMessage ||
          `Request failed: ${response.statusText}\n\n${errorDetail}`,
        'error'
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
