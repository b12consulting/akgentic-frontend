import { inject, Injectable } from '@angular/core';

import { Observable, Subject, Subscription } from 'rxjs';
import { webSocket, WebSocketSubject } from 'rxjs/webSocket';

import { ConfigService } from '../../../platform/config/config.service';
import { AkgenticMessage } from '../../../protocol/message.types';

/**
 * The two ways a socket can end. Kept as separate members rather than one
 * "disconnected" signal because the orchestrator treats them DIFFERENTLY:
 * `error` flips the spinner off as well as raising the toast (a failure before
 * any frame landed must not leave the UI spinning), while `complete` raises the
 * toast only (a clean completion has already had its first frame). Collapsing
 * the two loses that asymmetry with nothing failing except the spec that pins it.
 */
export type TeamSocketStatus = 'error' | 'complete';

/**
 * `TeamSocket` — the WebSocket transport SOURCE (Epic 34 / ADR-025 §1). It owns
 * the URL build, the `createWebSocket` seam, the socket subject and its
 * subscribe/teardown, and NOTHING else: it imports no log, no store, no spinner
 * and neither toast unit. Everything it learns leaves through the three streams
 * below, so the frame handler carries no policy — only the `__model__` split
 * that decides which of two streams a frame belongs to.
 *
 * Nothing is self-wired: the constructor opens no socket and subscribes to
 * nothing (ADR-025 §2, restating ADR-005 §Decision 6). `start()` / `stop()` /
 * `destroy()` are the explicit invocation points, all driven by
 * `IngestionService`: `start()` / `stop()` by `init()` and `close()`, and
 * `destroy()` by `ngOnDestroy()` — which runs only at app teardown, never on
 * navigation, because the router never destroys the route's injector.
 *
 * This is the unit where self-wiring would be most tempting and most damaging:
 * a constructor that opened the socket would put the transport ahead of
 * `log.reset()` and the REST replay, and the resulting team-switch race is
 * invisible in single-team testing — every order works when there is only ever
 * one `init()`.
 *
 * Component-scoped (`@Injectable()` with no `providedIn`), provided on
 * the `process/:id` route before `IngestionService`, which injects it. Root scope
 * would share ONE socket across every team switch.
 */
@Injectable()
export class TeamSocket {
  private config: ConfigService = inject(ConfigService);

  /**
   * The live socket. Starts as an unopened placeholder so `stop()` is safe
   * before the first `start()`; a never-opened `WebSocketSubject` throws on
   * `unsubscribe()`, which is why that half of the teardown is wrapped rather
   * than guarded.
   *
   * Not part of `IngestionService`'s per-cycle `Subscription` bag
   * (ADR-025 §3): the subscription to it is kept HERE, in `socketSub`, and
   * `stop()` releases it.
   */
  private webSocket: WebSocketSubject<any> = new WebSocketSubject({ url: '' });

  /**
   * This unit's own subscription to the live socket, kept so `stop()` can
   * DETACH the observer before closing. Closing alone is not enough: a
   * `WebSocketSubject` delivers its close on a later task, to the observer it
   * captured at connect time, so a socket that was stopped would still report
   * `complete` / `error` on `status$` — to whichever team cycle is subscribed by
   * then (#405). Detached, a stopped socket can reach none of the three streams.
   */
  private socketSub: Subscription | null = null;

  /**
   * Story 6.1 (ADR-005 §Decision 3): the raw protocol-frame stream — every WS
   * frame carrying a `__model__`, pushed at the same synchronous instant the
   * socket delivers it. ONE hot subject with several subscribers, never one
   * stream per consumer: the frame-batched log feed, the spinner's `take(1)`
   * side-channel and `NotificationToasts` all attach here, and the leak probe in
   * `ingestion.service.spec.ts` reads this subject's observer list to prove a
   * cycle's subscriptions are disposed rather than accumulated.
   *
   * `inbound$` is its observable view; subscribers still land on this subject's
   * observer array, which is what keeps that probe working.
   */
  private readonly _inbound$ = new Subject<AkgenticMessage>();
  readonly inbound$: Observable<AkgenticMessage> = this._inbound$.asObservable();

  /**
   * "Bytes arrived" — one emission per frame, BEFORE the `__model__` filter, so
   * it fires for frames the protocol stream drops. The spinner floor rides on
   * this and not on `inbound$` (Story 4-10 AC1): receiving anything at all is
   * proof the replay stream has started, so a frame with no discriminator must
   * still end the loading window.
   *
   * A separate subject rather than an unfiltered `inbound$` because the two
   * populations differ, and separate from the spinner's own `take(1)` on
   * `inbound$` because both paths exist today and the idempotency guard in
   * `scheduleSpinnerFlipFalse` is what makes the double-fire harmless.
   */
  private readonly _frames$ = new Subject<void>();
  readonly frames$: Observable<void> = this._frames$.asObservable();

  /**
   * Connection status, consumed by the orchestrator, which drives
   * `ConnectionToast` from it. A stream rather than the two direct `show()`
   * call sites story 34-4 left behind, because the callbacks now live in this
   * file while the toast does not — and because `error` needs the spinner flip
   * that only the orchestrator can sequence.
   */
  private readonly _status$ = new Subject<TeamSocketStatus>();
  readonly status$: Observable<TeamSocketStatus> = this._status$.asObservable();

  /**
   * Open the socket for one team cycle and start delivering frames.
   *
   * A synchronous construction failure PROPAGATES — this method has no
   * try/catch of its own on purpose. `IngestionService` catches it, flips the
   * spinner off and rethrows (Story 4-10 AC3): swallowing it here would leave
   * the UI spinning for ever with the socket that would end the wait never
   * having existed.
   *
   * Called LAST in `init()`'s sequence, after the log reset, the REST replay and
   * every consumer subscription. That is the whole ordering guarantee
   * (ADR-005 §Decision 6) and it is the caller's to keep — this unit only makes
   * it possible by doing nothing until asked.
   */
  start(processId: string): void {
    const wsProtocol =
      this.pageProtocol() === 'https:' ? 'wss://' : 'ws://';
    const api = this.config.api.replace(/(^\w+:|^)\/\//, '');

    this.webSocket = this.createWebSocket(
      `${wsProtocol}${api}/ws/${processId}`,
    );

    this.socketSub = this.webSocket.subscribe({
      next: (data: any) => {
        // Story 4-10 (AC1): announce the frame BEFORE the `__model__` guard.
        // Runs for EVERY event shape, including the ones dropped below —
        // receiving bytes is proof the replay stream has started, so this stays
        // the FIRST statement here.
        this._frames$.next();

        // V2: data is a raw Message with __model__ discriminator.
        const event = data;
        if (!event || !event.__model__) return;

        // Story 6.1 (AC8): the single protocol-frame fan-out. The frame-batched
        // log feed, the spinner side-channel and the notification reactor all
        // hang off this one `next(...)`, in subscription order, synchronously.
        this._inbound$.next(event as AkgenticMessage);
      },
      error: (err: any) => {
        console.error('WebSocket error:', err);
        this._status$.next('error');
      },
      complete: () => {
        console.log('webSocket - complete');
        this._status$.next('complete');
      },
    });
  }

  /**
   * Story 4-10: indirection point for WebSocket construction so tests can
   * inject a fake Subject without trying to rewrite the rxjs module
   * namespace (which is frozen under ES modules).
   *
   * Stays `protected`: both `spyOn<any>(socket, 'createWebSocket')` and
   * `(socket as any).createWebSocket = ...` are used across the suite, and both
   * must keep working.
   */
  protected createWebSocket(url: string): WebSocketSubject<any> {
    return webSocket(url);
  }

  /**
   * The page's protocol, behind a seam for one reason only: `window.location` is
   * a non-configurable own property in Chrome, so a spec cannot stub it and the
   * `wss://` half of the ternary above would otherwise be unreachable — the
   * Karma runner always serves over `http:`. The ternary itself is unchanged.
   *
   * Not a configuration point: nothing in the app overrides this, and nothing
   * should. If a story ever needs the scheme configured, it belongs in
   * `ConfigService` next to `api`, not here.
   */
  protected pageProtocol(): string {
    return window.location.protocol;
  }

  /**
   * Close the socket for this cycle, and stop listening to it.
   *
   * The detach comes FIRST and is the mechanism: once `socketSub` is
   * unsubscribed, nothing the stopped socket does later — a frame, an error,
   * the close itself — can reach `inbound$`, `frames$` or `status$`. So
   * `status$` only ever carries the CURRENT socket's transitions, and a team
   * that was left cannot raise a "Connection Lost" toast on the next one.
   *
   * The subject-level `unsubscribe()` stays as the second step. It marks a real
   * `WebSocketSubject` closed, and its try/catch is what keeps this safe before
   * any `start()` (a never-opened `WebSocketSubject` throws) and safe twice —
   * it is called from `init()`'s dispose step, from `close()`, and again if the
   * injector is ever destroyed.
   *
   * The three subjects are deliberately NOT completed here: they outlive a
   * cycle and carry the next one's frames. Completing them per cycle would
   * leave every consumer attached to a dead stream after the first team switch,
   * with no error anywhere.
   */
  stop(): void {
    this.socketSub?.unsubscribe();
    this.socketSub = null;
    try {
      this.webSocket.unsubscribe();
    } catch {
      /* never-opened WS — ignore */
    }
  }

  /**
   * Teardown for good: close the socket, then complete the three streams.
   *
   * `stop()` detaches the observer, so the close it causes emits NOTHING on
   * `status$`: a deliberate teardown is not a lost connection. The order is
   * kept — `stop()` first — so a real `WebSocketSubject` is closed before the
   * streams its frames would land on are completed.
   */
  destroy(): void {
    this.stop();
    this._inbound$.complete();
    this._frames$.complete();
    this._status$.complete();
  }
}
