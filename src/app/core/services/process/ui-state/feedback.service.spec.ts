import { TestBed } from '@angular/core/testing';

import { ConfigService } from '../../../platform/config/config.service';
import { FetchService, HttpError } from '../../../platform/http/fetch.service';
import { MessageLogService } from '../event/message-log.service';
import { FeedbackService } from './feedback.service';

/**
 * The feedback service against a backend that DOES NOT SERVE ITS ROUTES.
 *
 * `/get-feedback` and `/set-feedback` are absent from every released server
 * tier — they are not in the community tier's OpenAPI at all. The controls
 * shipped anyway, so the first real conversation produced one request and one
 * "Request failed: Not Found" toast PER RATEABLE TURN, on every mount.
 *
 * Nothing caught it because this service had no spec of its own and is stubbed
 * in all four component specs that touch it. These pin the two properties that
 * were missing: the absence is discovered ONCE and costs ONE request, and the
 * user is never told about it — while a genuine fault still behaves as before.
 */
describe('FeedbackService (backend without feedback routes)', () => {
  let fetchSpy: jasmine.SpyObj<FetchService>;
  let service: FeedbackService;

  /** Two derived turns, so "one request per turn" is distinguishable from one. */
  function twoMessages(): void {
    const logSpy = TestBed.inject(MessageLogService) as jasmine.SpyObj<MessageLogService>;
    logSpy.snapshot.and.returnValue([]);
    // `currentMessages` folds the log; stub the fold's OUTPUT instead of
    // building a log, since what is under test is the request pattern.
    spyOn(service as any, 'currentMessages').and.returnValue([
      { id: 'run-1' },
      { id: 'run-2' },
    ]);
  }

  beforeEach(() => {
    fetchSpy = jasmine.createSpyObj<FetchService>('FetchService', ['fetch']);
    const logSpy = jasmine.createSpyObj<MessageLogService>('MessageLogService', [
      'snapshot',
    ]);
    logSpy.snapshot.and.returnValue([]);

    TestBed.configureTestingModule({
      providers: [
        FeedbackService,
        { provide: FetchService, useValue: fetchSpy },
        { provide: MessageLogService, useValue: logSpy },
        { provide: ConfigService, useValue: { api: 'http://api' } },
      ],
    });
    service = TestBed.inject(FeedbackService);
  });

  it('asks SILENTLY, so a missing route raises no toast', async () => {
    twoMessages();
    fetchSpy.fetch.and.returnValue(
      Promise.reject(new HttpError('Request failed: Not Found', 404, '')),
    );

    await service.loadFeedback();

    // The toast lives in FetchService and is suppressed by this flag — the wall
    // of "Not Found" the user saw is exactly what its absence produced.
    expect(fetchSpy.fetch.calls.first().args[0].silent).toBeTrue();
  });

  it('a 404 costs ONE request, not one per turn', async () => {
    twoMessages();
    fetchSpy.fetch.and.returnValue(
      Promise.reject(new HttpError('Request failed: Not Found', 404, '')),
    );

    await service.loadFeedback();

    // The probe is awaited ALONE before the fan-out. Fanning out first would
    // issue a request per turn and learn nothing extra from any of them.
    expect(fetchSpy.fetch).toHaveBeenCalledTimes(1);
    expect(service.feedbackSupported).toBeFalse();
  });

  it('never asks again once the backend has said no', async () => {
    twoMessages();
    fetchSpy.fetch.and.returnValue(
      Promise.reject(new HttpError('Request failed: Not Found', 404, '')),
    );

    await service.loadFeedback();
    fetchSpy.fetch.calls.reset();
    // A second control mounting is what re-ran the whole storm before: the old
    // catch released the latch unconditionally, so every mount retried.
    await service.loadFeedback();
    await service.loadFeedback();

    expect(fetchSpy.fetch).not.toHaveBeenCalled();
  });

  it('does NOT latch on a 500 — a fault is not an answer', async () => {
    twoMessages();
    fetchSpy.fetch.and.returnValue(
      Promise.reject(new HttpError('Server error', 500, 'boom')),
    );

    await service.loadFeedback();

    // Disabling ratings for the session because one request happened to fail
    // would leave the user no way back short of a reload.
    expect(service.feedbackSupported).toBeTrue();
    fetchSpy.fetch.calls.reset();
    await service.loadFeedback();
    expect(fetchSpy.fetch).toHaveBeenCalled();
  });

  it('when the routes DO exist, every turn is still asked about', async () => {
    twoMessages();
    fetchSpy.fetch.and.returnValue(Promise.resolve({ comment: '', score: 1 }));

    await service.loadFeedback();

    // The probe must not cost the second turn its answer: two turns, two
    // requests, and both ratings surfaced.
    expect(fetchSpy.fetch).toHaveBeenCalledTimes(2);
    expect(service.feedbackSupported).toBeTrue();
    expect(service.feedbacks$.value.length).toBe(2);
  });
});
