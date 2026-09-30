import { ComponentFixture, TestBed } from '@angular/core/testing';
import { BehaviorSubject } from 'rxjs';

import en from '../../../platform/i18n/locales/en.json';
import {
  provideTranslateTesting,
  setTestTranslations,
} from '../../../../../testing/i18n-testing';
import {
  ASSISTANT,
  EXPERT,
  MANAGER,
  received,
  SUPPORT,
} from '../../../../../testing/run-log-builders';
import {
  CASE_2,
  CASE_4,
  CASE_5,
  CASE_5_ANSWER,
  CASE_5_PREFIX,
} from '../../../../../testing/run-log-cases';
import { MessageLogService } from '../../../services/process/event/message-log.service';
import { NodeInterface } from '../../../services/process/models/types';
import { GraphDataService } from '../../../services/process/selectors/graph.selector';
import {
  RunGraph,
  RunGraphService,
  runGraphFold,
  runKey,
} from '../../../services/process/selectors/run-graph.selector';
import {
  RunSelection,
  RunSelectionState,
} from '../../../services/process/ui-state/run-selection';
import { TraceFoldState } from '../../../services/process/ui-state/trace-fold-state';
import { RunInspectorComponent } from './run-inspector.component';

const M = MANAGER.agent_id;
const E = EXPERT.agent_id;
const A = ASSISTANT.agent_id;
const S = SUPPORT.agent_id;

describe('RunInspectorComponent', () => {
  let log: MessageLogService;
  let selection: RunSelectionState;
  let fixture: ComponentFixture<RunInspectorComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [RunInspectorComponent],
      providers: [
        provideTranslateTesting(),
        MessageLogService,
        RunGraphService,
        TraceFoldState,
        RunSelectionState,
        { provide: GraphDataService, useValue: { nodes$: new BehaviorSubject<NodeInterface[]>([]) } },
      ],
    }).compileComponents();
    setTestTranslations(en);
    log = TestBed.inject(MessageLogService);
    selection = TestBed.inject(RunSelectionState);
  });

  function mount(): HTMLElement {
    fixture = TestBed.createComponent(RunInspectorComponent);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  function graph(): RunGraph {
    return runGraphFold(log.snapshot());
  }

  function select(key: string): void {
    selection.select(graph(), key, 'tree');
    fixture.detectChanges();
  }

  function host(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function text(node: Element | null): string {
    return (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
  }

  function texts(selector: string): string[] {
    return [...host().querySelectorAll(selector)].map((n) => text(n));
  }

  function miniNode(key: string): HTMLElement {
    const el = host().querySelector<HTMLElement>(`[data-mini-run-key="${key}"]`);
    if (el === null) throw new Error('no mini node ' + key);
    return el;
  }

  function miniKeys(): (string | null)[] {
    return [...host().querySelectorAll('.mini-node')].map((n) =>
      n.getAttribute('data-mini-run-key'),
    );
  }

  it('shows an empty state and no section while there is no run', () => {
    mount();
    expect(host().querySelector('app-empty-state')).not.toBeNull();
    expect(text(host().querySelector('.empty-title'))).toBe('No run yet');
    expect(host().querySelector('.ri-section')).toBeNull();
  });

  it('with nothing selected, shows the latest running run and selects nothing', () => {
    log.appendAll(CASE_2.slice(0, 7));
    mount();
    expect(text(host().querySelector('.ri-agent'))).toBe('@Assistant');
    expect(text(host().querySelector('.ri-pill'))).toBe('running');
    expect(selection.selected()).toBeNull();

    log.appendAll(CASE_2.slice(7));
    fixture.detectChanges();
    // Done: the latest run, @Manager's on @Assistant's reply.
    expect(text(host().querySelector('.ri-agent'))).toBe('@Manager');
    expect(selection.selected()).toBeNull();
  });

  it('case 5: the four sections of @Assistant\'s run', () => {
    log.appendAll(CASE_5);
    mount();
    select(runKey('D2', A));

    expect(text(host().querySelector('.ri-agent'))).toBe('@Assistant');
    expect(text(host().querySelector('.ri-pill'))).toBe('done');
    expect(texts('.ri-section-title')).toEqual([
      'Where this run sits',
      'Handling',
      'Steps',
      'Event log',
    ]);
    expect(text(host().querySelector('.ri-route'))).toBe('@Expert → @Assistant');
    expect(texts('.ri-fields dd').slice(0, 2)).toEqual(['D2', 'D1']);
    expect(text(host().querySelector('.ri-text'))).toBe('content of D2');
    expect(texts('.ri-offset')).toEqual(['+0s', '+1s', '+3s', '+5s', '+7s', '+8s']);
    expect(texts('.ri-step-label')).toEqual([
      'received',
      'workspace_read · failed',
      'workspace_list',
      'workspace_read',
      'sent to @Expert',
      'processed',
    ]);
    expect(host().querySelectorAll('.ri-step--failed').length).toBe(1);
  });

  it('a seat reads "waiting for a person", then "answered"', () => {
    log.appendAll(CASE_5_PREFIX);
    mount();
    select(runKey('S', S));
    expect(text(host().querySelector('.ri-pill'))).toBe('waiting for a person');
    log.appendAll(CASE_5_ANSWER);
    fixture.detectChanges();
    expect(text(host().querySelector('.ri-pill'))).toBe('answered');
  });

  it('an unknown trigger replaces Handling\'s fields with one note', () => {
    // A replay that starts at the ReceivedMessage: the send was never loaded.
    log.appendAll([received('D2', ASSISTANT, 11)]);
    mount();
    expect(text(host().querySelector('.ri-agent'))).toBe('@Assistant');
    expect(host().querySelector('.ri-fields')).toBeNull();
    expect(texts('.ri-note')).toContain(
      'The message that started this run is not in the loaded log.',
    );
  });

  describe('where this run sits', () => {
    beforeEach(() => {
      log.appendAll(CASE_5);
      mount();
      select(runKey('B', M));
    });

    it('bolds the path, inverts the displayed node, folds the branch off it', () => {
      expect(miniKeys()).toEqual([
        runKey('U1', M),
        runKey('S', S),
        runKey('D1', E),
        runKey('D2', A),
        runKey('C', E),
        runKey('B', M),
      ]);
      const path = [...host().querySelectorAll('.mini-node--path')].map((n) =>
        n.getAttribute('data-mini-run-key'),
      );
      expect(path).toEqual([
        runKey('U1', M),
        runKey('D1', E),
        runKey('D2', A),
        runKey('C', E),
        runKey('B', M),
      ]);
      const displayed = host().querySelectorAll('.mini-node--displayed');
      expect(displayed.length).toBe(1);
      expect(displayed[0].querySelector('.mini-main')!.getAttribute('aria-current')).toBe('true');
      expect(host().querySelectorAll('[aria-current]').length).toBe(1);
      // The seat, off the path, folds to what it hides.
      expect(text(miniNode(runKey('S', S)).querySelector('.mini-folded'))).toBe('1 run · @Manager');
    });

    it('a seat is a button; a click selects from the mini-tree and scrolls nothing', () => {
      const scroll = spyOn(HTMLElement.prototype, 'scrollIntoView');
      const events: RunSelection[] = [];
      selection.selections$.subscribe((e) => events.push(e));
      const seat = miniNode(runKey('S', S)).querySelector<HTMLElement>('.mini-main')!;
      expect(seat.tagName).toBe('BUTTON');
      expect(text(seat.querySelector('.mini-name'))).toBe('@Support');
      expect(text(seat.querySelector('.mini-hint'))).toBe('human seat');

      seat.click();
      fixture.detectChanges();
      expect(events).toEqual([{ key: runKey('S', S), origin: 'mini-tree' }]);
      expect(selection.selected()).toBe(runKey('S', S));
      expect(text(host().querySelector('.ri-agent'))).toBe('@Support');
      expect(scroll).not.toHaveBeenCalled();
    });

    it('its folds are its own: toggling one leaves the transcript\'s, and the other way round', () => {
      const folds = TestBed.inject(TraceFoldState);
      const root = runKey('U1', M);
      const before = [...folds.openKeys()];
      const beforeNode = folds.isNodeExpanded(runKey('S', S), root);

      const chevron = miniNode(runKey('S', S)).querySelector<HTMLButtonElement>('.mini-chevron')!;
      expect(chevron.getAttribute('aria-expanded')).toBe('false');
      expect(chevron.getAttribute('aria-label')).toBe('Show the runs under this one');
      chevron.click();
      fixture.detectChanges();
      expect(miniKeys()).toContain(runKey('Sa', M));
      expect(miniNode(runKey('S', S)).querySelector('.mini-folded')).toBeNull();
      expect([...folds.openKeys()]).toEqual(before);
      expect(folds.isNodeExpanded(runKey('S', S), root)).toBe(beforeNode);

      folds.toggleNode(runKey('D1', E), root);
      fixture.detectChanges();
      expect(miniKeys()).toContain(runKey('B', M));
    });

    it('a path node can be folded, and opens again when a run under it is displayed', () => {
      miniNode(runKey('D1', E)).querySelector<HTMLButtonElement>('.mini-chevron')!.click();
      fixture.detectChanges();
      expect(miniKeys()).not.toContain(runKey('B', M));

      select(runKey('C', E));
      expect(miniKeys()).toContain(runKey('C', E));
    });
  });

  it('case 4: the entry point receiving a message is drawn, never a button', () => {
    log.appendAll(CASE_4);
    mount();
    select(runKey('U2', M));
    const entry = miniNode(runKey('Q', 'human-id'));
    expect(entry.querySelector('button')).not.toBeNull(); // its chevron only
    expect(entry.querySelector('button.mini-main')).toBeNull();
    expect(text(entry.querySelector('.mini-name'))).toBe('@Human');
    expect(text(entry.querySelector('.mini-hint'))).toBe('you answered');
    // Below your reply's run: the answer you received, still not a button.
    const answer = miniNode(runKey('A', 'human-id'));
    expect(answer.querySelector('button')).toBeNull();
    expect(text(answer.querySelector('.mini-hint'))).toBe('to you');
  });

  describe('the event log', () => {
    beforeEach(() => {
      log.appendAll(CASE_5);
      mount();
      select(runKey('D2', A));
    });

    function indices(): number[] {
      return [...host().querySelectorAll('.ri-line')].map((n) =>
        Number(n.getAttribute('data-log-index')),
      );
    }

    function pressed(): (string | null)[] {
      return [...host().querySelectorAll('.ri-scope-button')].map((b) =>
        b.getAttribute('aria-pressed'),
      );
    }

    it('This run: only the run\'s own lines, none dimmed', () => {
      expect(pressed()).toEqual(['true', 'false']);
      expect(indices()).toEqual([8, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
      expect(host().querySelector('.ri-line--dimmed')).toBeNull();
      expect(texts('.ri-line-kind').slice(0, 3)).toEqual([
        'SentMessage',
        'ReceivedMessage',
        'ToolCallEvent',
      ]);
    });

    it('Whole team: every line, the run\'s own highlighted and the rest dimmed', () => {
      host().querySelectorAll<HTMLButtonElement>('.ri-scope-button')[1].click();
      fixture.detectChanges();
      expect(pressed()).toEqual(['false', 'true']);
      expect(indices().length).toBe(CASE_5.length);
      expect(host().querySelectorAll('.ri-line--own').length).toBe(10);
      expect(host().querySelectorAll('.ri-line--dimmed').length).toBe(CASE_5.length - 10);
    });
  });
});
