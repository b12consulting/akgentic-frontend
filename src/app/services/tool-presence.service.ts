import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

import {
  AkgenticMessage,
  isStartMessage,
  isStopMessage,
} from '../models/message.types';

/**
 * Canonical name for the Knowledge Graph tool actor (ADR-004 §Decision 4).
 * Mirrors `KG_ACTOR_NAME` from backend `kg_actor.py`.
 */
export const KG_ACTOR_NAME = '#KnowledgeGraphTool';

/**
 * Minimal interface the presence service needs from the message producer.
 * Kept narrow (two streams) so the presence service does NOT depend on
 * `ActorMessageService` directly — that would create a circular DI loop
 * since `ActorMessageService` also wires the presence service up.
 */
export interface KGPresenceMessageSource {
  createAgentGraph$: BehaviorSubject<AkgenticMessage[] | null>;
  message$: BehaviorSubject<AkgenticMessage | null>;
}

/**
 * ToolPresenceService — publishes `hasKnowledgeGraph$` derived from the
 * `StartMessage` / `StopMessage` stream.
 *
 * Subscribes to both channels `GraphDataService` uses so presence detection
 * works during replay (batch on `createAgentGraph$`) AND live
 * (one-by-one on `message$`). ADR-004 §Decision 4.
 *
 * Wiring note: call `bindTo(messageService)` once from the message service's
 * constructor to establish the subscriptions. The presence service does NOT
 * `inject(ActorMessageService)` — doing so would create a circular DI graph.
 *
 * Story 5-2 ships this observable "dark" — no UI consumer yet. Story 5-3
 * wires it into `ProcessComponent` to activate the KG tab reactively.
 */
@Injectable({ providedIn: 'root' })
export class ToolPresenceService {
  readonly hasKnowledgeGraph$: BehaviorSubject<boolean> =
    new BehaviorSubject<boolean>(false);

  private bound = false;

  /**
   * Establish subscriptions against the message source's replay + live
   * streams. Idempotent — second+ calls are a no-op so `ActorMessageService`
   * construction remains safe under HMR / test re-instantiation.
   */
  bindTo(source: KGPresenceMessageSource): void {
    if (this.bound) return;
    this.bound = true;

    source.createAgentGraph$.subscribe((messages) => {
      if (!messages) return;
      for (const msg of messages) {
        this.observe(msg);
      }
    });

    source.message$.subscribe((message) => {
      if (!message) return;
      this.observe(message);
    });
  }

  /**
   * Reset presence to `false`. Called from `ActorMessageService.init()` on
   * team switch (alongside `KGStateReducer.resetForTeam()`).
   */
  resetForTeam(): void {
    this.setPresence(false);
  }

  /**
   * Single-message observer. Exposed for tests that feed messages directly
   * without binding to a full `ActorMessageService`. Production code uses
   * `bindTo()` + the streams; test code may use either.
   */
  observe(msg: AkgenticMessage): void {
    if (isStartMessage(msg) && msg.sender?.name === KG_ACTOR_NAME) {
      this.setPresence(true);
      return;
    }
    if (isStopMessage(msg) && msg.sender?.name === KG_ACTOR_NAME) {
      this.setPresence(false);
    }
  }

  /**
   * `BehaviorSubject.next()` wrapped with an explicit value check so we
   * never emit the same boolean twice in a row (AC8.7 — avoid redundant
   * downstream work; cheaper than piping through `distinctUntilChanged`).
   */
  private setPresence(value: boolean): void {
    if (this.hasKnowledgeGraph$.getValue() === value) return;
    this.hasKnowledgeGraph$.next(value);
  }
}
