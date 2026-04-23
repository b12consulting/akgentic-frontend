import { TestBed } from '@angular/core/testing';
import { MessageService } from 'primeng/api';

import { ConfigService } from './config.service';
import { FetchService } from './fetch.service';

/** Build a minimal `Response`-like object usable by `FetchService.fetch`. */
function makeResponse({
  ok = true,
  status = 200,
  statusText = 'OK',
  contentLength = null,
  jsonValue,
  textValue,
  throwOnJson = false,
}: {
  ok?: boolean;
  status?: number;
  statusText?: string;
  contentLength?: string | null;
  jsonValue?: unknown;
  textValue?: string;
  throwOnJson?: boolean;
}): Response {
  const headers = new Headers();
  if (contentLength !== null) {
    headers.set('content-length', contentLength);
  }
  const resp: Partial<Response> = {
    ok,
    status,
    statusText,
    headers,
    clone: function clone(): Response {
      return makeResponse({
        ok,
        status,
        statusText,
        contentLength,
        jsonValue,
        textValue,
        throwOnJson,
      });
    } as Response['clone'],
    json: async (): Promise<unknown> => {
      if (throwOnJson) {
        throw new SyntaxError('not JSON');
      }
      return jsonValue;
    },
    text: async (): Promise<string> => textValue ?? '',
  };
  return resp as Response;
}

describe('FetchService', () => {
  let service: FetchService;
  let messageServiceSpy: jasmine.SpyObj<MessageService>;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    messageServiceSpy = jasmine.createSpyObj('MessageService', ['add']);

    TestBed.configureTestingModule({
      providers: [
        FetchService,
        { provide: MessageService, useValue: messageServiceSpy },
        {
          provide: ConfigService,
          useValue: { hideLogin: false } as Partial<ConfigService>,
        },
      ],
    });

    service = TestBed.inject(FetchService);
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('responseType: default JSON behaviour (existing callers unaffected)', () => {
    it('calls response.json() when responseType is omitted', async () => {
      const payload = { foo: 'bar' };
      globalThis.fetch = jasmine
        .createSpy('fetch')
        .and.resolveTo(makeResponse({ jsonValue: payload }));

      const result = await service.fetch({ url: 'https://x/api' });

      expect(result).toEqual(payload);
    });

    it('calls response.json() when responseType is explicitly "json"', async () => {
      const payload = { a: 1 };
      globalThis.fetch = jasmine
        .createSpy('fetch')
        .and.resolveTo(makeResponse({ jsonValue: payload }));

      const result = await service.fetch({
        url: 'https://x/api',
        responseType: 'json',
      });

      expect(result).toEqual(payload);
    });
  });

  describe('responseType: "text"', () => {
    it('calls response.text() and returns the raw string, not JSON', async () => {
      const yamlText = 'namespace: foo\nname: My NS\n';
      // Response body would NOT parse as JSON — confirms we never call .json()
      globalThis.fetch = jasmine.createSpy('fetch').and.resolveTo(
        makeResponse({
          textValue: yamlText,
          throwOnJson: true,
        })
      );

      const result = await service.fetch({
        url: 'https://x/admin/catalog/namespace/foo/export',
        responseType: 'text',
      });

      expect(result).toBe(yamlText);
    });

    it('preserves the non-OK error path (notification fired) even with text body', async () => {
      globalThis.fetch = jasmine.createSpy('fetch').and.resolveTo(
        makeResponse({
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
          textValue: 'boom',
          throwOnJson: true,
        })
      );

      await service.fetch({
        url: 'https://x/admin/catalog/namespace/foo/export',
        responseType: 'text',
      });

      expect(messageServiceSpy.add).toHaveBeenCalledTimes(1);
      const call = messageServiceSpy.add.calls.first().args[0];
      expect(call.severity).toBe('error');
    });

    it('returns undefined on 204 No Content even in text mode', async () => {
      globalThis.fetch = jasmine.createSpy('fetch').and.resolveTo(
        makeResponse({
          status: 204,
          statusText: 'No Content',
          contentLength: '0',
          textValue: '',
        })
      );

      const result = await service.fetch({
        url: 'https://x/admin/catalog/namespace/foo/export',
        responseType: 'text',
      });

      expect(result).toBeUndefined();
    });
  });

  describe('credentials: include injection', () => {
    it('injects credentials: "include" when hideLogin is false (default behaviour preserved)', async () => {
      const fetchSpy = jasmine
        .createSpy('fetch')
        .and.resolveTo(makeResponse({ jsonValue: {} }));
      globalThis.fetch = fetchSpy;

      await service.fetch({ url: 'https://x/api' });

      const opts = fetchSpy.calls.first().args[1] as RequestInit;
      expect(opts.credentials).toBe('include');
    });
  });
});
