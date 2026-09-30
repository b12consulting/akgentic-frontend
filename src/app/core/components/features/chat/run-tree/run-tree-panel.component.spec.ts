import { Component, inject } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { provideMarkdown } from 'ngx-markdown';
import { MessageService } from 'primeng/api';
import { BehaviorSubject } from 'rxjs';

import { PrimeNgNotificationAdapter } from '../../../../../ui/console/notification.adapter';
import { CHAT_VIEW_STORAGE_KEY, ChatViewService } from '../../../../../ui/console/chat-view.service';
import { ApiService } from '../../../../platform/http/api.service';
import { NOTIFICATION_PORT } from '../../../../platform/notification/notification.port';
import { AkgenticMessage } from '../../../../protocol/message.types';
import { AkgentService } from '../../../../services/akgent.service';
import { IngestionService } from '../../../../services/process/event/ingestion.service';
import { MessageLogService } from '../../../../services/process/event/message-log.service';
import { NodeInterface } from '../../../../services/process/models/types';
import { ChatService } from '../../../../services/process/selectors/chat.selector';
import { GraphDataService } from '../../../../services/process/selectors/graph.selector';
import { RunGraphService, runKey } from '../../../../services/process/selectors/run-graph.selector';
import { RunTreeService } from '../../../../services/process/selectors/run-tree-items';
import { Feedback, FeedbackService } from '../../../../services/process/ui-state/feedback.service';
import { SelectionService } from '../../../../services/process/ui-state/selection.service';
import { TraceFoldState } from '../../../../services/process/ui-state/trace-fold-state';
import { provideTranslateTesting } from '../../../../../../testing/i18n-testing';
import {
  ASSISTANT,
  compacted,
  envId,
  EXPERT,
  handled,
  HUMAN,
  MANAGER,
  processed,
  received,
  sent,
  SUPPORT,
  toolCall,
  toolReturn,
  welcome,
} from '../../../../../../testing/run-log-builders';
import {
  CASE_5_ANSWER,
  CASE_5_PREFIX,
  CASE_5_VARIANT,
} from '../../../../../../testing/run-log-cases';
import { ChatPanelComponent } from '../chat-panel.component';
import { RunTreePanelComponent } from './run-tree-panel.component';
import { TranscriptScroll } from './transcript-scroll';

const M = MANAGER.agent_id;

/** A host for the switch round trip: the process view's `@if`, in miniature. */
@Component({
  standalone: true,
  imports: [RunTreePanelComponent, ChatPanelComponent],
  template: `
    @if (chatView.newView()) {
      <app-run-tree-panel processId="team-1"></app-run-tree-panel>
    } @else {
      <app-chat-panel processId="team-1"></app-chat-panel>
    }
  `,
})
class SwitchHostComponent {
  readonly chatView = inject(ChatViewService);
}

function apiSpy(): jasmine.SpyObj<ApiService> {
  const methods = Object.getOwnPropertyNames(ApiService.prototype).filter(
    (name) => name !== 'constructor',
  ) as (keyof ApiService)[];
  const spy = jasmine.createSpyObj<ApiService>('ApiService', methods);
  for (const name of methods) {
    (spy[name as keyof ApiService] as jasmine.Spy).and.returnValue(Promise.resolve());
  }
  return spy;
}

describe('RunTreePanelComponent', () => {
  let log: MessageLogService;
  let api: jasmine.SpyObj<ApiService>;
  let ingestion: { commands: { snapshot: () => [] }; loadingProcess$: BehaviorSubject<boolean>; init: jasmine.Spy };

  beforeEach(async () => {
    api = apiSpy();
    ingestion = {
      commands: { snapshot: () => [] },
      loadingProcess$: new BehaviorSubject<boolean>(false),
      init: jasmine.createSpy('init'),
    };
    await TestBed.configureTestingModule({
      imports: [RunTreePanelComponent, SwitchHostComponent, NoopAnimationsModule],
      providers: [
        provideTranslateTesting(),
        provideMarkdown(),
        MessageLogService,
        ChatService,
        RunGraphService,
        RunTreeService,
        TraceFoldState,
        {
          provide: FeedbackService,
          useValue: {
            feedbacks$: new BehaviorSubject<Feedback[]>([]),
            loadFeedback: () => Promise.resolve(),
            setFeedback: () => Promise.resolve(),
          },
        },
        { provide: SelectionService, useValue: jasmine.createSpyObj('SelectionService', ['handleSelection']) },
        { provide: ApiService, useValue: api },
        { provide: AkgentService, useValue: { selectedAkgent$: new BehaviorSubject(null) } },
        { provide: GraphDataService, useValue: { nodes$: new BehaviorSubject<NodeInterface[]>([]) } },
        { provide: IngestionService, useValue: ingestion },
        MessageService,
        { provide: NOTIFICATION_PORT, useClass: PrimeNgNotificationAdapter },
      ],
    }).compileComponents();
    log = TestBed.inject(MessageLogService);
  });

  afterEach(() => localStorage.removeItem(CHAT_VIEW_STORAGE_KEY));

  function mount(): ComponentFixture<RunTreePanelComponent> {
    const fixture = TestBed.createComponent(RunTreePanelComponent);
    fixture.componentInstance.processId = 'team-1';
    fixture.detectChanges();
    return fixture;
  }

  function el(fixture: ComponentFixture<unknown>): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  /** Every row of the scroll list, as `msg:<envelope>` / `trace:<root>` /
   *  `note` / `divider` / `day`, in DOM order. */
  function rows(fixture: ComponentFixture<unknown>): string[] {
    const list = el(fixture).querySelector('.message-list');
    return [...(list?.children ?? [])].flatMap((child) => {
      const id = child.getAttribute('data-message-id');
      if (id) return ['msg:' + id];
      const card = child.querySelector('[data-trace-root]');
      if (card) return ['trace:' + card.getAttribute('data-trace-root')];
      if (child.classList.contains('tail-divider')) return ['divider'];
      if (child.classList.contains('run-note')) return ['note'];
      if (child.classList.contains('day-separator')) return ['day'];
      return [];
    });
  }

  function text(node: Element | null): string {
    return (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
  }

  // -------------------------------------------------------------------------
  // What renders (AC 3–8, 10)
  // -------------------------------------------------------------------------

  const CASE_7_PREFIX: AkgenticMessage[] = [
    sent('U1', HUMAN, MANAGER, null, 1),
    received('U1', MANAGER, 2),
    sent('D', MANAGER, EXPERT, 'U1', 3),
    processed('U1', MANAGER, 4),
    received('D', EXPERT, 5),
    sent('Re', EXPERT, MANAGER, 'D', 6),
    processed('D', EXPERT, 7),
    received('Re', MANAGER, 8),
    sent('U2', HUMAN, MANAGER, null, 10),
    sent('U3', HUMAN, MANAGER, null, 11),
    sent('A1', MANAGER, HUMAN, 'Re', 13),
    processed('Re', MANAGER, 14),
  ];

  it('shows the empty state with the legacy keys', () => {
    const fixture = mount();
    expect(text(el(fixture).querySelector('.chat-placeholder-title'))).toBe('chat.emptyTitle');
  });

  it('case 7: the queued follow-ups sit in the tail, then move into the timeline', () => {
    log.appendAll(CASE_7_PREFIX);
    const fixture = mount();
    expect(rows(fixture)).toEqual([
      'msg:' + envId('U1', MANAGER),
      'trace:' + runKey('U1', M),
      'msg:' + envId('A1', HUMAN),
      'note',
      'divider',
      'msg:' + envId('U2', MANAGER),
      'note',
      'msg:' + envId('U3', MANAGER),
      'note',
    ]);
    expect(text(el(fixture).querySelector('.tail-divider'))).toBe('chat.runTree.messagesSent');
    expect(text(el(fixture).querySelector('.run-note--tail'))).toBe('chat.runTree.notReceivedYet');

    log.appendAll([
      received('U2', MANAGER, 15),
      sent('A2', MANAGER, HUMAN, 'U2', 16),
      processed('U2', MANAGER, 17),
      received('U3', MANAGER, 18),
    ]);
    fixture.detectChanges();
    expect(rows(fixture)).toEqual([
      'msg:' + envId('U1', MANAGER),
      'trace:' + runKey('U1', M),
      'msg:' + envId('A1', HUMAN),
      'note',
      'msg:' + envId('U2', MANAGER),
      'trace:' + runKey('U2', M),
      'msg:' + envId('A2', HUMAN),
      'note',
      'msg:' + envId('U3', MANAGER),
      'trace:' + runKey('U3', M),
    ]);
  });

  it('a single queued message reads "Message sent"', () => {
    log.appendAll([sent('U1', HUMAN, MANAGER, null, 1)]);
    const fixture = mount();
    expect(text(el(fixture).querySelector('.tail-divider'))).toBe('chat.runTree.messageSent');
  });

  it('renders no row for a rule-3 question to a seat or a rule-4 delegation', () => {
    log.appendAll([
      sent('U1', HUMAN, MANAGER, null, 1),
      received('U1', MANAGER, 2),
      sent('S', MANAGER, SUPPORT, 'U1', 3),
      sent('D1', MANAGER, EXPERT, 'U1', 4),
      processed('U1', MANAGER, 5),
    ]);
    const fixture = mount();
    expect(rows(fixture)).toEqual(['msg:' + envId('U1', MANAGER), 'trace:' + runKey('U1', M)]);
    expect(el(fixture).querySelectorAll('app-chat-message').length).toBe(1);
  });

  it('case 4: "replying to" above your bubble and a continued-trace header', () => {
    log.appendAll([
      sent('U1', HUMAN, MANAGER, null, 1),
      received('U1', MANAGER, 2),
      sent('Q', MANAGER, HUMAN, 'U1', 3),
      processed('U1', MANAGER, 4),
      received('Q', HUMAN, 5),
      processed('Q', HUMAN, 6),
      sent('U2', HUMAN, MANAGER, 'Q', 7),
      received('U2', MANAGER, 8),
    ]);
    const fixture = mount();
    const r = rows(fixture);
    // Q, the question, carries its provenance link; then "replying to" above U2.
    expect(r.slice(2)).toEqual([
      'msg:' + envId('Q', HUMAN),
      'note',
      'note',
      'msg:' + envId('U2', MANAGER),
      'trace:' + runKey('U2', M),
    ]);
    expect(text(el(fixture).querySelector('.run-note--above'))).toBe('chat.runTree.replyingTo');
    expect(text(el(fixture).querySelector('.trace-continues'))).toBe('chat.runTree.continuesTrace');
  });

  it('a Send-as message renders as your bubble with an "as" label and a card', () => {
    log.appendAll([sent('X', SUPPORT, MANAGER, null, 1), received('X', MANAGER, 2)]);
    const fixture = mount();
    expect(rows(fixture)).toEqual(['note', 'msg:' + envId('X', MANAGER), 'trace:' + runKey('X', M)]);
    expect(text(el(fixture).querySelector('.run-note--above'))).toBe('chat.runTree.sendAs');
  });

  it('a queued Send-as message keeps its "as" label above the tail bubble', () => {
    log.appendAll([sent('X', SUPPORT, MANAGER, null, 1)]);
    const fixture = mount();
    expect(rows(fixture)).toEqual(['divider', 'note', 'msg:' + envId('X', MANAGER), 'note']);
    expect(text(el(fixture).querySelector('.run-note--above'))).toBe('chat.runTree.sendAs');
  });

  it('the provenance link opens the trace card that produced the answer', () => {
    log.appendAll([
      sent('U1', HUMAN, MANAGER, null, 1),
      received('U1', MANAGER, 2),
      sent('A1', MANAGER, HUMAN, 'U1', 3),
      processed('U1', MANAGER, 4),
    ]);
    const fixture = mount();
    expect(el(fixture).querySelector('.trace-body')).toBeNull();
    const link = el(fixture).querySelector<HTMLButtonElement>('.run-link--provenance')!;
    expect(text(link)).toBe('chat.runTree.provenance.yourMessage');
    link.click();
    fixture.detectChanges();
    expect(TestBed.inject(TraceFoldState).isOpen(runKey('U1', M))).toBeTrue();
    expect(el(fixture).querySelector('.trace-body')).not.toBeNull();
  });

  it('an agent reply with no known run renders without a link (fail-open)', () => {
    log.appendAll([sent('A', MANAGER, HUMAN, 'unknown', 1)]);
    const fixture = mount();
    expect(rows(fixture)).toEqual(['msg:' + envId('A', HUMAN)]);
    expect(el(fixture).querySelector('.run-link--provenance')).toBeNull();
  });

  it('case 6: the absorbed note has no card of its own and opens the absorbing trace', () => {
    log.appendAll([
      sent('U1', HUMAN, MANAGER, null, 1),
      received('U1', MANAGER, 2),
      sent('U2', HUMAN, MANAGER, null, 4),
      handled('U2', MANAGER, 'U1', 5),
    ]);
    const fixture = mount();
    expect(rows(fixture)).toEqual([
      'msg:' + envId('U1', MANAGER),
      'trace:' + runKey('U1', M),
      'msg:' + envId('U2', MANAGER),
      'note',
    ]);
    const note = el(fixture).querySelector<HTMLButtonElement>('.run-link')!;
    expect(text(note)).toBe('chat.runTree.absorbedNote');
    note.click();
    fixture.detectChanges();
    expect(TestBed.inject(TraceFoldState).isOpen(runKey('U1', M))).toBeTrue();
  });

  it('a card starts collapsed and stays open as its trace grows (Trap 7)', () => {
    log.appendAll([sent('U1', HUMAN, MANAGER, null, 1), received('U1', MANAGER, 2)]);
    const fixture = mount();
    const card = (): HTMLElement => el(fixture).querySelector('app-trace-card') as HTMLElement;
    expect(card().querySelector('.trace-body')).toBeNull();
    card().querySelector<HTMLButtonElement>('.trace-toggle')!.click();
    fixture.detectChanges();
    const before = card();
    expect(before.querySelectorAll('.tree-node').length).toBe(1);

    log.appendAll([
      sent('D', MANAGER, EXPERT, 'U1', 3),
      received('D', EXPERT, 4),
      toolCall('t1', 'search', EXPERT, 'D', 5),
    ]);
    fixture.detectChanges();
    expect(card()).toBe(before);
    expect(card().querySelector('.trace-body')).not.toBeNull();
    expect(card().querySelectorAll('.tree-node').length).toBe(2);
  });

  // -------------------------------------------------------------------------
  // The tree in the panel (55-3)
  // -------------------------------------------------------------------------

  function openCard(fixture: ComponentFixture<unknown>, root: string): HTMLElement {
    const card = el(fixture).querySelector<HTMLElement>(`[data-trace-root="${root}"]`)!;
    card.querySelector<HTMLButtonElement>('.trace-toggle')!.click();
    fixture.detectChanges();
    return card;
  }

  function seatStatus(fixture: ComponentFixture<unknown>): string | null {
    const seat = el(fixture).querySelector(`.tree-node[data-run-key="${runKey('S', SUPPORT.agent_id)}"]`);
    return seat?.querySelector('.node-status')?.getAttribute('data-status') ?? null;
  }

  it('answers a waiting seat from its node, keyed by the question, with no optimistic insert', async () => {
    log.appendAll(CASE_5_PREFIX);
    const fixture = mount();
    openCard(fixture, runKey('U1', M));
    el(fixture).querySelector<HTMLButtonElement>('.node-answer')!.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const area = document.querySelector<HTMLTextAreaElement>('app-seat-answer-dialog textarea')!;
    area.value = 'yes';
    area.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    document.querySelector<HTMLButtonElement>('app-seat-answer-dialog .seat-send')!.click();
    fixture.detectChanges();

    // The question's INNER id: not the run key, not the envelope id.
    expect(api.processHumanInput).toHaveBeenCalledOnceWith('team-1', 'yes', 'S');
    expect(fixture.componentInstance.answerVisible).toBeFalse();
    expect(seatStatus(fixture)).toBe('waiting');
    expect(el(fixture).querySelector('.node-answer')).not.toBeNull();

    log.appendAll(CASE_5_ANSWER);
    fixture.detectChanges();
    expect(seatStatus(fixture)).toBe('answered');
    expect(el(fixture).querySelector('.node-answer')).toBeNull();
  });

  it('logs a failed answer; the dialog is already closed', async () => {
    const error = spyOn(console, 'error');
    api.processHumanInput.and.returnValue(Promise.reject(new Error('down')));
    log.appendAll(CASE_5_PREFIX);
    const fixture = mount();
    fixture.componentInstance.onAnswer(runKey('S', SUPPORT.agent_id));
    fixture.componentInstance.onSeatAnswer({ content: 'yes', messageId: 'S' });
    await fixture.whenStable();
    expect(fixture.componentInstance.answerVisible).toBeFalse();
    expect(error).toHaveBeenCalledWith('Failed to send human input:', jasmine.any(Error));
  });

  it('opening a card reveals a seat two levels down; its sibling branch stays folded', () => {
    log.appendAll(CASE_5_VARIANT);
    const fixture = mount();
    openCard(fixture, runKey('U1', M));
    const keys = [...el(fixture).querySelectorAll('.tree-node')].map((n) =>
      n.getAttribute('data-run-key'),
    );
    expect(keys).toEqual([
      runKey('U1', M),
      runKey('D1', EXPERT.agent_id),
      runKey('S', SUPPORT.agent_id),
      runKey('D2', ASSISTANT.agent_id),
    ]);
    expect(el(fixture).querySelector('.node-answer')).not.toBeNull();
  });

  it('the provenance link reveals the seat path too', () => {
    log.appendAll([...CASE_5_VARIANT, sent('A', MANAGER, HUMAN, 'U1', 16)]);
    const fixture = mount();
    fixture.componentInstance.openTraceOf(runKey('U1', M));
    fixture.detectChanges();
    expect(el(fixture).querySelector('.node-answer')).not.toBeNull();
  });

  it('a @Human row highlights and flashes the matching bubble', () => {
    const scroll = spyOn(HTMLElement.prototype, 'scrollIntoView');
    log.appendAll([
      sent('U1', HUMAN, MANAGER, null, 1),
      received('U1', MANAGER, 2),
      sent('A1', MANAGER, HUMAN, 'U1', 3),
      processed('U1', MANAGER, 4),
    ]);
    const fixture = mount();
    openCard(fixture, runKey('U1', M));
    const bubble = el(fixture).querySelector(`app-chat-message[data-message-id="${envId('A1', HUMAN)}"]`)!;
    const row = el(fixture).querySelector<HTMLElement>('.tree-human')!;

    row.dispatchEvent(new MouseEvent('mouseenter'));
    fixture.detectChanges();
    expect(bubble.classList).toContain('run-bubble--highlight');
    row.dispatchEvent(new MouseEvent('mouseleave'));
    fixture.detectChanges();
    expect(bubble.classList).not.toContain('run-bubble--highlight');

    row.querySelector<HTMLButtonElement>('.node-in-chat')!.click();
    fixture.detectChanges();
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.calls.mostRecent().object).toBe(bubble);
    expect(bubble.classList).toContain('run-bubble--flash');
  });

  it('keeps a compaction marker open across emissions without mutating chat$', () => {
    log.appendAll([welcome('W', 0), compacted('C6', MANAGER, 1)]);
    const fixture = mount();
    const marker = fixture.componentInstance.timeline.find(
      (i) => i.kind === 'message' && i.data.rule === 6,
    );
    expect(marker?.kind === 'message' && marker.data.collapsed).toBeTrue();
    if (marker?.kind !== 'message') return;
    fixture.componentInstance.onToggleCollapse(marker.data);
    log.appendAll([sent('U1', HUMAN, MANAGER, null, 2)]);
    fixture.detectChanges();
    const after = fixture.componentInstance.timeline.find(
      (i) => i.kind === 'message' && i.data.rule === 6,
    );
    expect(after?.kind === 'message' && after.data.collapsed).toBeFalse();
    let shared = true;
    TestBed.inject(ChatService)
      .messages$.subscribe((ms) => (shared = ms.find((m) => m.rule === 6)!.collapsed))
      .unsubscribe();
    expect(shared).toBeTrue();
  });

  // -------------------------------------------------------------------------
  // The switch round trip (AC 2)
  // -------------------------------------------------------------------------

  it('switching back and forth refetches nothing and keeps an open card open', () => {
    log.appendAll([
      sent('U1', HUMAN, MANAGER, null, 1),
      received('U1', MANAGER, 2),
      sent('A1', MANAGER, HUMAN, 'U1', 3),
      processed('U1', MANAGER, 4),
    ]);
    const logLength = log.snapshot().length;
    const chatView = TestBed.inject(ChatViewService);
    const fixture = TestBed.createComponent(SwitchHostComponent);
    fixture.detectChanges();
    expect(el(fixture).querySelector('app-chat-panel')).not.toBeNull();

    chatView.toggle();
    fixture.detectChanges();
    const firstRows = rows(fixture);
    el(fixture).querySelector<HTMLButtonElement>('.trace-toggle')!.click();
    fixture.detectChanges();

    chatView.toggle();
    fixture.detectChanges();
    expect(el(fixture).querySelector('app-run-tree-panel')).toBeNull();
    chatView.toggle();
    fixture.detectChanges();

    expect(rows(fixture)).toEqual(firstRows);
    expect(el(fixture).querySelector('.trace-body')).not.toBeNull();
    expect(log.snapshot().length).toBe(logLength);
    expect(ingestion.init).not.toHaveBeenCalled();
    for (const name of Object.keys(api)) {
      expect((api[name as keyof ApiService] as jasmine.Spy).calls.count())
        .withContext(name)
        .toBe(0);
    }
  });

  // -------------------------------------------------------------------------
  // ADR-016's pin survives the move (AC 11, Trap 5) — REAL layout
  // -------------------------------------------------------------------------

  describe('the pin, in real layout', () => {
    let fixture: ComponentFixture<RunTreePanelComponent>;
    let host: HTMLElement;

    beforeEach(() => {
      // Instant programmatic scrolls, so the end position is synchronous.
      spyOn(window, 'matchMedia').and.returnValue({ matches: true } as MediaQueryList);
      fixture = TestBed.createComponent(RunTreePanelComponent);
      fixture.componentInstance.processId = 'team-1';
      host = el(fixture);
      host.style.display = 'block';
      host.style.height = '400px';
      document.body.appendChild(host);
    });

    afterEach(() => host.remove());

    function settle(): void {
      fixture.detectChanges();
      fixture.detectChanges();
    }

    /** Distance from the scroll viewport's top to the bubble's top. */
    function offsetOf(envelope: string): number {
      const c = host.querySelector('.message-list') as HTMLElement;
      const bubble = host.querySelector(`[data-message-id="${envelope}"]`) as HTMLElement;
      expect(bubble).withContext(envelope).toBeTruthy();
      return bubble.offsetTop - c.offsetTop - c.scrollTop;
    }

    /** The bubble's top sits `TOP_PAD` below the viewport top, ±1px. */
    function expectPinned(envelope: string): void {
      expect(Math.abs(offsetOf(envelope) - TranscriptScroll.TOP_PAD))
        .withContext(`${envelope} at ${offsetOf(envelope)}px`)
        .toBeLessThanOrEqual(1);
    }

    function inTail(envelope: string): boolean {
      const tailIds = fixture.componentInstance.tail.map((m) => m.id);
      return tailIds.includes(envelope);
    }

    it('holds on the tail bubble while work grows above it, and again after the move', () => {
      const U2 = envId('U2', MANAGER);
      log.appendAll([
        sent('U1', HUMAN, MANAGER, null, 1),
        received('U1', MANAGER, 2),
        toolCall('t1', 'search', MANAGER, 'U1', 3),
      ]);
      settle();

      TestBed.inject(ChatService).emitJustSent('k');
      log.append(sent('U2', HUMAN, MANAGER, null, 4));
      settle();
      expect(inTail(U2)).toBeTrue();
      expectPinned(U2);

      // Content grows ABOVE the tail: a tool step and the answer to U1.
      log.appendAll([
        toolReturn('t1', 'search', MANAGER, 'U1', 5),
        sent('A1', MANAGER, HUMAN, 'U1', 6),
      ]);
      settle();
      expect(inTail(U2)).toBeTrue();
      expectPinned(U2);

      // Pick-up: the bubble leaves the tail for the timeline.
      log.appendAll([processed('U1', MANAGER, 7), received('U2', MANAGER, 8)]);
      settle();
      expect(inTail(U2)).toBeFalse();
      expectPinned(U2);
    });

    it('a message picked up in the frame of its echo pins once and never sits in the tail', () => {
      const U1 = envId('U1', MANAGER);
      log.appendAll([welcome('W', 0)]);
      settle();
      const container = host.querySelector('.message-list') as HTMLElement;
      const scrollTo = spyOn(container, 'scrollTo').and.callThrough();

      TestBed.inject(ChatService).emitJustSent('k');
      log.appendAll([sent('U1', HUMAN, MANAGER, null, 1), received('U1', MANAGER, 2)]);
      fixture.detectChanges();
      expect(host.querySelector('.tail-divider')).toBeNull();
      settle();
      settle();
      expect(host.querySelector('.tail-divider')).toBeNull();
      expect(inTail(U1)).toBeFalse();
      expect(scrollTo).toHaveBeenCalledTimes(1);
      expectPinned(U1);
    });
  });
});
