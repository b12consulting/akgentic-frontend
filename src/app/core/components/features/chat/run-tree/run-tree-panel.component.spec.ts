import { ApplicationRef } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { provideMarkdown } from 'ngx-markdown';
import { MessageService } from 'primeng/api';
import { BehaviorSubject } from 'rxjs';

import { PrimeNgNotificationAdapter } from '../../../../../ui/console/notification.adapter';
import { ApiService } from '../../../../platform/http/api.service';
import { NOTIFICATION_PORT } from '../../../../platform/notification/notification.port';
import { ActorAddress, AkgenticMessage } from '../../../../protocol/message.types';
import { IngestionService } from '../../../../services/process/event/ingestion.service';
import { MessageLogService } from '../../../../services/process/event/message-log.service';
import { NodeInterface } from '../../../../services/process/models/types';
import { ChatService } from '../../../../services/process/selectors/chat.selector';
import { GraphDataService } from '../../../../services/process/selectors/graph.selector';
import { RunGraphService, runKey } from '../../../../services/process/selectors/run-graph.selector';
import { RunTreeService } from '../../../../services/process/selectors/run-tree-items';
import { Feedback, FeedbackService } from '../../../../services/process/ui-state/feedback.service';
import {
  RunSelection,
  RunSelectionState,
} from '../../../../services/process/ui-state/run-selection';
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
  CASE_5,
  CASE_5_ANSWER,
  CASE_5_PREFIX,
  CASE_5_VARIANT,
} from '../../../../../../testing/run-log-cases';
import { RunInspectorComponent } from '../../run-inspector/run-inspector.component';
import { RunTreePanelComponent } from './run-tree-panel.component';
import { TranscriptScroll } from './transcript-scroll';

const M = MANAGER.agent_id;

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
      imports: [RunTreePanelComponent, NoopAnimationsModule],
      providers: [
        provideTranslateTesting(),
        provideMarkdown(),
        MessageLogService,
        ChatService,
        RunGraphService,
        RunTreeService,
        TraceFoldState,
        RunSelectionState,
        {
          provide: FeedbackService,
          useValue: {
            feedbacks$: new BehaviorSubject<Feedback[]>([]),
            loadFeedback: () => Promise.resolve(),
            setFeedback: () => Promise.resolve(),
          },
        },
        { provide: ApiService, useValue: api },
        { provide: GraphDataService, useValue: { nodes$: new BehaviorSubject<NodeInterface[]>([]) } },
        { provide: IngestionService, useValue: ingestion },
        MessageService,
        { provide: NOTIFICATION_PORT, useClass: PrimeNgNotificationAdapter },
      ],
    }).compileComponents();
    log = TestBed.inject(MessageLogService);
  });

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
      // An answer: its bubble, then its action row as a note when it carries
      // the provenance link.
      if (child.classList.contains('run-answer')) {
        const bubble = child.querySelector('[data-message-id]')!.getAttribute('data-message-id');
        return ['msg:' + bubble, ...(child.querySelector('.run-link--provenance') ? ['note'] : [])];
      }
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

  it('shows the empty state with its keys', () => {
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

  it('the provenance link selects the run that produced the answer and opens its card', () => {
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
    expect(TestBed.inject(RunSelectionState).selected()).toBe(runKey('U1', M));
    expect(el(fixture).querySelector('.trace-body')).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // Selection (55-4)
  // -------------------------------------------------------------------------

  /** Render, then run the after-render hooks a real tick would run. */
  function settleRender(fixture: ComponentFixture<unknown>): void {
    fixture.detectChanges();
    TestBed.inject(ApplicationRef).tick();
    fixture.detectChanges();
  }

  function selectedKeys(fixture: ComponentFixture<unknown>): (string | null)[] {
    return [...el(fixture).querySelectorAll('.tree-node--selected')].map((n) =>
      n.getAttribute('data-run-key'),
    );
  }

  it('case 5: the provenance link selects @Manager\'s report run, reveals, highlights, scrolls and flashes it', () => {
    const scroll = spyOn(HTMLElement.prototype, 'scrollIntoView');
    log.appendAll(CASE_5);
    const fixture = mount();
    expect(selectedKeys(fixture)).toEqual([]);
    const report = runKey('Sa', M);

    el(fixture).querySelector<HTMLButtonElement>('.run-link--provenance')!.click();
    settleRender(fixture);

    // The card is open with the path down to the run expanded; @Expert's
    // branch, off the path, keeps its default fold.
    const keys = [...el(fixture).querySelectorAll('.tree-node')].map((n) =>
      n.getAttribute('data-run-key'),
    );
    expect(keys).toEqual([
      runKey('U1', M),
      runKey('D1', EXPERT.agent_id),
      runKey('S', SUPPORT.agent_id),
      report,
    ]);
    expect(TestBed.inject(TraceFoldState).isNodeExpanded(runKey('D1', EXPERT.agent_id), runKey('U1', M)))
      .toBeFalse();
    expect(selectedKeys(fixture)).toEqual([report]);
    const reportNode = el(fixture).querySelector(`.tree-node[data-run-key="${report}"]`)!;
    expect(reportNode.querySelector('.node-main')!.getAttribute('aria-current')).toBe('true');
    expect(reportNode.classList).toContain('tree-node--flash');
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.calls.mostRecent().object).toBe(reportNode);
  });

  it('the flash ends after its time; a re-flash restarts it', () => {
    jasmine.clock().install();
    try {
      spyOn(HTMLElement.prototype, 'scrollIntoView');
      log.appendAll(CASE_5);
      const fixture = mount();
      const link = el(fixture).querySelector<HTMLButtonElement>('.run-link--provenance')!;
      link.click();
      settleRender(fixture);
      expect(fixture.componentInstance.flashingRun()).toBe(runKey('Sa', M));
      jasmine.clock().tick(1000);
      link.click();
      settleRender(fixture);
      jasmine.clock().tick(1000);
      expect(fixture.componentInstance.flashingRun()).toBe(runKey('Sa', M));
      jasmine.clock().tick(300);
      expect(fixture.componentInstance.flashingRun()).toBeNull();
    } finally {
      jasmine.clock().uninstall();
    }
  });

  it('a tree-node click selects without scrolling; a user-folded sibling stays folded', () => {
    const scroll = spyOn(HTMLElement.prototype, 'scrollIntoView');
    log.appendAll(CASE_5_VARIANT);
    const fixture = mount();
    const root = runKey('U1', M);
    openCard(fixture, root);
    // The person reading folds @Expert's branch (the reveal had opened it for the seat).
    const expert = runKey('D1', EXPERT.agent_id);
    el(fixture)
      .querySelector<HTMLButtonElement>(`.tree-node[data-run-key="${expert}"] .node-chevron`)!
      .click();
    fixture.detectChanges();

    const assistant = runKey('D2', ASSISTANT.agent_id);
    el(fixture)
      .querySelector<HTMLButtonElement>(`.tree-node[data-run-key="${assistant}"] .node-main`)!
      .click();
    settleRender(fixture);

    expect(TestBed.inject(RunSelectionState).selected()).toBe(assistant);
    expect(selectedKeys(fixture)).toEqual([assistant]);
    expect(TestBed.inject(TraceFoldState).isNodeExpanded(expert, root)).toBeFalse();
    expect(scroll).not.toHaveBeenCalled();
  });

  it('nothing is highlighted before a click, even with the Run tab showing a run', () => {
    log.appendAll(CASE_5);
    const fixture = mount();
    // The inspector's Run tab, mounted beside the transcript as in the console:
    // it DISPLAYS a fallback run, and must not select it.
    const inspector = TestBed.createComponent(RunInspectorComponent);
    inspector.detectChanges();
    expect(el(inspector).querySelector('.ri-agent')).not.toBeNull();
    openCard(fixture, runKey('U1', M));
    fixture.detectChanges();
    expect(el(fixture).querySelectorAll('.tree-node').length).toBeGreaterThan(0);
    expect(selectedKeys(fixture)).toEqual([]);
    expect(TestBed.inject(RunSelectionState).selected()).toBeNull();
  });

  it('folding a card away under a hovered @Human row clears the bubble highlight', () => {
    log.appendAll([
      sent('U1', HUMAN, MANAGER, null, 1),
      received('U1', MANAGER, 2),
      sent('A1', MANAGER, HUMAN, 'U1', 3),
      processed('U1', MANAGER, 4),
    ]);
    const fixture = mount();
    const card = openCard(fixture, runKey('U1', M));
    el(fixture).querySelector<HTMLElement>('.tree-human')!.dispatchEvent(new MouseEvent('mouseenter'));
    fixture.detectChanges();
    expect(fixture.componentInstance.highlightedBubble).toBe(envId('A1', HUMAN));

    card.querySelector<HTMLButtonElement>('.trace-toggle')!.click();
    fixture.detectChanges();
    expect(el(fixture).querySelector('.tree-human')).toBeNull();
    expect(fixture.componentInstance.highlightedBubble).toBeNull();
    expect(el(fixture).querySelector('.run-bubble--highlight')).toBeNull();
  });

  it('an answer\'s copy, thumbs and provenance pill share one row and one reveal, which holds its space', () => {
    log.appendAll([
      sent('U1', HUMAN, MANAGER, null, 1),
      received('U1', MANAGER, 2),
      sent('A1', MANAGER, HUMAN, 'U1', 3),
      processed('U1', MANAGER, 4),
    ]);
    const fixture = mount();
    const answer = el(fixture).querySelector(`[data-message-id="${envId('A1', HUMAN)}"]`)!;
    // The bubble's own hover-revealed row is off in this view; the panel's
    // row replaces it.
    expect(answer.querySelector('.turn-feedback')).toBeNull();
    const row = answer.nextElementSibling!;
    expect(row.classList).toContain('run-actions');
    expect(
      [...row.querySelectorAll('.action-copy, .action-thumb-up, .action-thumb-down, .run-link--provenance')]
        .map((e) => e.classList[0]),
    ).toEqual(['action-copy', 'action-thumb-up', 'action-thumb-down', 'run-link']);
    // ONE reveal: the row is hidden at rest and the buttons carry no reveal of
    // their own; hidden, the row still holds its space.
    const rowEl = row as HTMLElement;
    rowEl.style.transition = 'none';
    expect(getComputedStyle(rowEl).opacity).toBe('0');
    expect(getComputedStyle(row.querySelector('.action-row')!).opacity).toBe('1');
    expect(rowEl.getBoundingClientRect().height).toBeGreaterThan(0);
    // Focus anywhere in the answer reveals the whole row at once.
    expect(row.parentElement!.classList).toContain('run-answer');
    row.querySelector<HTMLButtonElement>('.run-link--provenance')!.focus();
    expect(getComputedStyle(rowEl).opacity).toBe('1');
  });

  it('only an answer your message follows takes the end-of-turn space', () => {
    log.appendAll([
      sent('U1', HUMAN, MANAGER, null, 1),
      received('U1', MANAGER, 2),
      sent('A1', MANAGER, HUMAN, 'U1', 3),
      sent('A2', MANAGER, HUMAN, 'U1', 4),
      processed('U1', MANAGER, 5),
      sent('U2', HUMAN, MANAGER, null, 6),
      received('U2', MANAGER, 7),
    ]);
    const fixture = mount();
    const answerOf = (id: string): HTMLElement =>
      el(fixture).querySelector(`[data-message-id="${envId(id, HUMAN)}"]`)!.parentElement!;
    const first = answerOf('A1');
    const last = answerOf('A2');
    expect(first.nextElementSibling).toBe(last);

    // Answer → answer: the reserved row is the gap; the next answer takes only
    // the space that centres the row, not a turn gap.
    expect(first.classList).not.toContain('run-answer--before-yours');
    expect(getComputedStyle(first).marginBottom).toBe('0px');
    expect(getComputedStyle(last).marginTop).toBe('12px');
    // Answer → your message: the turn gap, plus the end-of-turn space.
    expect(last.classList).toContain('run-answer--before-yours');
    expect(getComputedStyle(last).marginBottom).toBe('24px');
    expect(getComputedStyle(last.nextElementSibling!).marginTop).toBe('18px');
  });

  it('an agent reply with no known run renders without a link (fail-open)', () => {
    log.appendAll([sent('A', MANAGER, HUMAN, 'unknown', 1)]);
    const fixture = mount();
    expect(rows(fixture)).toEqual(['msg:' + envId('A', HUMAN)]);
    expect(el(fixture).querySelector('.run-link--provenance')).toBeNull();
  });

  it('case 6: the absorbed note has no card of its own and selects the absorbing run, without scrolling', () => {
    const scroll = spyOn(HTMLElement.prototype, 'scrollIntoView');
    log.appendAll([
      sent('U1', HUMAN, MANAGER, null, 1),
      received('U1', MANAGER, 2),
      sent('U2', HUMAN, MANAGER, null, 4),
      handled('U2', MANAGER, 'U1', 5),
    ]);
    const fixture = mount();
    const events: RunSelection[] = [];
    TestBed.inject(RunSelectionState).selections$.subscribe((e) => events.push(e));
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
    TestBed.inject(ApplicationRef).tick();
    expect(TestBed.inject(TraceFoldState).isOpen(runKey('U1', M))).toBeTrue();
    expect(events).toEqual([{ key: runKey('U1', M), origin: 'absorbed' }]);
    expect(scroll).not.toHaveBeenCalled();
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

  it('an answer that lands from elsewhere closes the open dialog; an answered seat never opens it', () => {
    log.appendAll(CASE_5_PREFIX);
    const fixture = mount();
    const seat = runKey('S', SUPPORT.agent_id);
    fixture.componentInstance.onAnswer(seat);
    expect(fixture.componentInstance.answerVisible).toBeTrue();

    log.appendAll(CASE_5_ANSWER);
    fixture.detectChanges();
    expect(fixture.componentInstance.answerVisible).toBeFalse();

    fixture.componentInstance.onAnswer(seat);
    expect(fixture.componentInstance.answerVisible).toBeFalse();
    expect(api.processHumanInput).not.toHaveBeenCalled();
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

  it('answers a waiting seat whose question is not in the loaded log, keyed by the seat run', async () => {
    // A replay that starts after @Manager asked: the seat's run is there, the
    // question is not. The seat run's `message_id` is the question's inner id.
    log.appendAll([received('S', SUPPORT, 6), processed('S', SUPPORT, 7)]);
    const fixture = mount();
    const seat = runKey('S', SUPPORT.agent_id);
    fixture.componentInstance.onAnswer(seat);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.componentInstance.answerVisible).toBeTrue();
    expect(fixture.componentInstance.answerQuestion).toBeNull();
    expect(text(document.querySelector('app-seat-answer-dialog .seat-unknown-question'))).toBe(
      'chat.runTree.answerDialog.unknownQuestion',
    );

    const area = document.querySelector<HTMLTextAreaElement>('app-seat-answer-dialog textarea')!;
    area.value = 'yes';
    area.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    document.querySelector<HTMLButtonElement>('app-seat-answer-dialog .seat-send')!.click();
    fixture.detectChanges();

    expect(api.processHumanInput).toHaveBeenCalledOnceWith('team-1', 'yes', 'S');
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
    spyOn(HTMLElement.prototype, 'scrollIntoView');
    log.appendAll([...CASE_5_VARIANT, sent('A', MANAGER, HUMAN, 'U1', 16)]);
    const fixture = mount();
    el(fixture).querySelector<HTMLButtonElement>('.run-link--provenance')!.click();
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
      .chat$.subscribe((s) => (shared = s.messages.find((m) => m.rule === 6)!.collapsed))
      .unsubscribe();
    expect(shared).toBeTrue();
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

    for (const width of [900, 420]) {
      // A long line of command output in a code block used to widen the whole
      // stream; so could any nowrap row of the tree.
      it(`never scrolls sideways at ${width}px, with a card open, a row selected and a bubble highlighted`, async () => {
        host.style.width = `${width}px`;
        const long = (
          id: string,
          from: ActorAddress,
          to: ActorAddress,
          parent: string | null,
          t: number,
        ): AkgenticMessage => {
          const m = sent(id, from, to, parent, t);
          m.message.content =
            'search the rag for the hugging face report '.repeat(6) +
            '\n\n```\n' +
            '-rw-r--r--  1 agent  staff  2048 hugging-face-incident-report-aug-2026.pdf '.repeat(4) +
            '\n```\n';
          return m;
        };
        log.appendAll([
          long('U1', HUMAN, MANAGER, null, 1),
          received('U1', MANAGER, 2),
          toolCall('t1', 'workspace_rag_search', MANAGER, 'U1', 3),
          toolReturn('t1', 'workspace_rag_search', MANAGER, 'U1', 4),
          toolCall('t2', 'workspace_read', MANAGER, 'U1', 5),
          toolReturn('t2', 'workspace_read', MANAGER, 'U1', 6),
          long('A1', MANAGER, HUMAN, 'U1', 7),
          processed('U1', MANAGER, 8),
        ]);
        settle();
        host.querySelector<HTMLButtonElement>('.trace-toggle')!.click();
        settle();
        host.querySelector<HTMLButtonElement>('.node-main')!.click();
        host.querySelector<HTMLElement>('.tree-human')!.dispatchEvent(new MouseEvent('mouseenter'));
        settle();
        // The answer's markdown renders asynchronously.
        await fixture.whenStable();
        await new Promise((resolve) => setTimeout(resolve));
        settle();
        expect(host.querySelector('.markdown-content pre')).withContext('code block').not.toBeNull();

        const list = host.querySelector('.message-list') as HTMLElement;
        const right = list.getBoundingClientRect().right;
        // Content inside its own sideways scroller (the code block) is clipped
        // there and cannot widen the stream.
        const clipped = (e: HTMLElement): boolean => {
          for (let a = e.parentElement; a && a !== list; a = a.parentElement) {
            if (getComputedStyle(a).overflowX !== 'visible') return true;
          }
          return false;
        };
        const offenders = [...list.querySelectorAll<HTMLElement>('*')]
          .filter((e) => e.getBoundingClientRect().right > right + 0.5 && !clipped(e))
          .map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')}`);
        expect(offenders).withContext('elements past the list edge').toEqual([]);
        expect(list.scrollWidth).toBeLessThanOrEqual(list.clientWidth);


        // The run row is one block: its box holds line 1, the status and the
        // chips, and a click anywhere on it — a chip included — hits the run.
        const runBox = host.querySelector('.tree-node--selected .rn-body')!.getBoundingClientRect();
        for (const part of ['.node-status', '.node-chips']) {
          const r = host.querySelector(`.tree-node--selected ${part}`)!.getBoundingClientRect();
          expect(r.top >= runBox.top && r.bottom <= runBox.bottom && r.right <= runBox.right)
            .withContext(`${part} inside the run box`)
            .toBeTrue();
        }
        const chipEl = host.querySelector<HTMLElement>('.tree-node--selected .chip')!;
        chipEl.scrollIntoView({ block: 'center' });
        const chip = chipEl.getBoundingClientRect();
        const hit = document.elementFromPoint(chip.left + chip.width / 2, chip.top + chip.height / 2);
        expect(hit).withContext('the chip is on screen').not.toBeNull();
        expect(hit!.closest('.node-main')).withContext('a chip hits the run').not.toBeNull();
      });
    }

    it('centres an answer\'s action row between its text and the next row', async () => {
      host.style.width = '900px';
      log.appendAll([
        sent('U1', HUMAN, MANAGER, null, 1),
        received('U1', MANAGER, 2),
        sent('A1', MANAGER, HUMAN, 'U1', 3),
        sent('A2', MANAGER, HUMAN, 'U1', 4),
        processed('U1', MANAGER, 5),
        sent('U2', HUMAN, MANAGER, null, 6),
        received('U2', MANAGER, 7),
      ]);
      settle();
      // The answers' markdown renders asynchronously.
      await fixture.whenStable();
      await new Promise((resolve) => setTimeout(resolve));
      settle();

      /** Text bottom → row top, and row bottom → the next row's top. */
      const gaps = (id: string): { above: number; below: number } => {
        const bubble = host.querySelector(`[data-message-id="${envId(id, HUMAN)}"]`)!;
        const text = bubble.querySelector('.markdown-content markdown > :last-child')!;
        const answer = bubble.parentElement!;
        const row = answer.querySelector('.run-actions')!.getBoundingClientRect();
        const next = answer.nextElementSibling!.getBoundingClientRect();
        return {
          above: row.top - text.getBoundingClientRect().bottom,
          below: next.top - row.bottom,
        };
      };

      // Answer → answer: the row sits halfway.
      const between = gaps('A1');
      expect(Math.abs(between.above - between.below))
        .withContext(`above ${between.above}px, below ${between.below}px`)
        .toBeLessThanOrEqual(2);
      // Answer → your message: the same space above, visibly more below.
      const beforeYours = gaps('A2');
      expect(Math.abs(beforeYours.above - between.above)).toBeLessThanOrEqual(1);
      expect(beforeYours.below).toBeGreaterThan(between.below + 16);
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

    /** Settle, then let the pill's queued update land. */
    async function pill(): Promise<string | null> {
      settle();
      await Promise.resolve();
      return fixture.componentInstance.scroll.indicatorLabel;
    }

    it('a pick-up raises no "New messages"; a new answer below the fold does', async () => {
      const turns: AkgenticMessage[] = [];
      for (let i = 1; i <= 6; i++) {
        const t = i * 10;
        turns.push(
          sent('U' + i, HUMAN, MANAGER, null, t),
          received('U' + i, MANAGER, t + 1),
          sent('A' + i, MANAGER, HUMAN, 'U' + i, t + 2),
          processed('U' + i, MANAGER, t + 3),
        );
      }
      log.appendAll([...turns, sent('U7', HUMAN, MANAGER, null, 70)]);
      settle();
      const container = host.querySelector('.message-list') as HTMLElement;
      container.scrollTop = 0;
      fixture.componentInstance.scroll.onScroll();
      expect(await pill()).toBe('chat.messages');

      // The pick-up: U7 leaves the tail for the timeline and gains a trace
      // card. Nothing new to read.
      log.append(received('U7', MANAGER, 71));
      expect(await pill()).toBe('chat.messages');
      expect(inTail(envId('U7', MANAGER))).toBeFalse();

      // An agent → you answer below the fold is.
      log.append(sent('A7', MANAGER, HUMAN, 'U7', 72));
      expect(await pill()).toBe('chat.newMessages');
    });
  });
});
