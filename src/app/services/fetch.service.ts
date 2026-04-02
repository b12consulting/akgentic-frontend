import { Injectable, inject } from '@angular/core';
import { MessageService } from 'primeng/api';
import { environment } from '../../environments/environment';

@Injectable({
  providedIn: 'root',
})
export class FetchService {
  messageService: MessageService = inject(MessageService);

  async fetch({
    url,
    options,
    successMessage,
    errorMessage,
  }: {
    url: string;
    options?: RequestInit;
    successMessage?: string;
    errorMessage?: string;
  }): Promise<any> {
    options = environment.hideLogin
      ? options
      : { ...options, credentials: 'include' };
    const response = await fetch(url, options);

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

    return response.json();
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
