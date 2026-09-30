import { ComponentFixture, TestBed } from '@angular/core/testing';

import en from '../../../../platform/i18n/locales/en.json';
import { AkgenticMessage } from '../../../../protocol/message.types';
import {
  addr,
  ASSISTANT,
  at,
  envId,
  EXPERT,
  HUMAN,
  MANAGER,
  processed,
  received,
  sent,
  SUPPORT,
  toolCall,
} from '../../../../../../testing/run-log-builders';
import {
  CASE_2,
  CASE_3,
  CASE_4,
  CASE_5,
  CASE_5_PREFIX,
} from '../../../../../../testing/run-log-cases';
import {
  provideTranslateTesting,
  setTestTranslations,
} from '../../../../../../testing/i18n-testing';
import { runGraphFold, RunKey, runKey } from '../../../../services/process/selectors/run-graph.selector';
import { TraceFoldState } from '../../../../services/process/ui-state/trace-fold-state';
import { TraceTreeComponent } from './trace-tree.component';

const k = (id: string, agent: { agent_id: string }): RunKey => runKey(id, agent.agent_id);
const ROOT = k('U1', MANAGER);

describe('TraceTreeComponent', () => {
  let fixture: ComponentFixture<TraceTreeComponent>;
  let folds: TraceFoldState;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TraceTreeComponent],
      providers: [provideTranslateTesting(), TraceFoldState],
    }).compileComponents();
    setTestTranslations(en);
    folds = TestBed.inject(TraceFoldState);
    fixture = TestBed.createComponent(TraceTreeComponent);
  });

  function host(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function render(log: AkgenticMessage[], root: RunKey = ROOT): HTMLElement {
    fixture.componentRef.setInput('graph', runGraphFold(log));
    fixture.componentRef.setInput('root', root);
    fixture.detectChanges();
    return host();
  }

  function text(node: Element | null): string {
    return (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
  }

  function node(key: RunKey): HTMLElement {
    const el = host().querySelector<HTMLElement>(`.tree-node[data-run-key="${key}"]`);
    if (el === null) throw new Error('no node ' + key);
    return el;
  }

  function visibleKeys(): (string | null)[] {
    return [...host().querySelectorAll('.tree-node')].map((n) => n.getAttribute('data-run-key'));
  }

  function chips(key: RunKey): string[] {
    return [...node(key).querySelectorAll('.chip')].map((c) => text(c));
  }

  function expand(key: RunKey): void {
    node(key).querySelector<HTMLButtonElement>('.node-chevron')!.click();
    fixture.detectChanges();
  }

  it('starts with only the root expanded; the others fold and show message chips', () => {
    render(CASE_2);
    expect(visibleKeys()).toEqual([ROOT, k('De', EXPERT), k('Da', ASSISTANT)]);
    expect(chips(k('De', EXPERT))).toEqual(['💬 @Manager']);
    // The expanded root shows no message chips: its children are on screen.
    expect(chips(ROOT)).toEqual([]);
  });

  it('case 2: three @Manager runs; the one that sent nothing is dimmed', () => {
    render(CASE_2);
    expand(k('De', EXPERT));
    expand(k('Da', ASSISTANT));
    expect(visibleKeys()).toEqual([
      ROOT,
      k('De', EXPERT),
      k('Re', MANAGER),
      k('Da', ASSISTANT),
      k('Ra', MANAGER),
    ]);
    expect(node(k('Re', MANAGER)).classList).toContain('tree-node--silent');
    expect(chips(k('Re', MANAGER))).toEqual(['sent nothing']);
    expect(node(k('Ra', MANAGER)).classList).not.toContain('tree-node--silent');
    expect(node(k('Re', MANAGER)).getAttribute('data-depth')).toBe('2');
  });

  it('two-line node: agent, a ← naming the sender, the trigger excerpt, the status', () => {
    render(CASE_2);
    const expert = node(k('De', EXPERT));
    expect(text(expert.querySelector('.node-agent'))).toBe('@Expert');
    expect(expert.querySelector('.node-from')!.getAttribute('title')).toBe('from @Manager');
    expect(text(expert.querySelector('.node-excerpt'))).toBe('content of De');
    // De: received at 6, processed at 9.
    expect(text(expert.querySelector('.node-status'))).toBe('3s');
    expect(expert.querySelector('.node-status .pi-check')).not.toBeNull();
  });

  it('case 3: the join shows on both sides', () => {
    render(CASE_3);
    expand(k('De', EXPERT));
    expect(text(host().querySelector('.tree-leaf--absorbed'))).toBe(
      '→ @Manager · absorbed by @Manager ⤴',
    );
    expand(k('Da', ASSISTANT));
    expand(k('Ra', MANAGER));
    expect(text(host().querySelector('.tree-join'))).toBe("⤵ took in @Expert's reply");
    expect(chips(k('Ra', MANAGER))).toContain('took in 1 message');
  });

  it('case 5: a red failed-tool chip on an ordinary done node', () => {
    render(CASE_5_PREFIX);
    expand(k('D1', EXPERT));
    const assistant = node(k('D2', ASSISTANT));
    expect(assistant.getAttribute('data-depth')).toBe('2');
    const failed = assistant.querySelectorAll('.chip--failed');
    expect(failed.length).toBe(1);
    expect(text(failed[0])).toBe('workspace_read ✕');
    expect(failed[0].getAttribute('aria-label')).toBe('workspace_read failed');
    expect(chips(k('D2', ASSISTANT)).slice(0, 3)).toEqual([
      'workspace_read ✕',
      'workspace_list',
      'workspace_read',
    ]);
    expect(assistant.querySelector('.node-status')!.getAttribute('data-status')).toBe('done');
    expect(assistant.classList).not.toContain('tree-node--silent');
  });

  it('case 5: the seat node is waiting with an Answer button, then answered', () => {
    jasmine.clock().install();
    try {
      jasmine.clock().mockDate(at(16));
      render(CASE_5_PREFIX);
      const seat = node(k('S', SUPPORT));
      expect(chips(k('S', SUPPORT))).toEqual(['human seat']);
      // Received at 6; the clock reads 16.
      expect(text(seat.querySelector('.node-status'))).toBe('waiting 10s');
      const answered: string[] = [];
      fixture.componentInstance.answer.subscribe((key) => answered.push(key));
      seat.querySelector<HTMLButtonElement>('.node-answer')!.click();
      expect(answered).toEqual([k('S', SUPPORT)]);

      render(CASE_5);
      expect(text(node(k('S', SUPPORT)).querySelector('.node-status'))).toBe('answered after 23s');
      expect(node(k('S', SUPPORT)).querySelector('.node-answer')).toBeNull();
    } finally {
      jasmine.clock().uninstall();
    }
  });

  it('folded message chips group by recipient, with a count only above one', () => {
    render([
      sent('U1', HUMAN, MANAGER, null, 1),
      received('U1', MANAGER, 2),
      sent('D', MANAGER, EXPERT, 'U1', 3),
      sent('A1', MANAGER, HUMAN, 'U1', 4),
      sent('A2', MANAGER, HUMAN, 'U1', 5),
      processed('U1', MANAGER, 6),
    ]);
    node(ROOT).querySelector<HTMLButtonElement>('.node-chevron')!.click();
    fixture.detectChanges();
    expect(chips(ROOT)).toEqual(['💬 @Expert', '💬 @Human ×2']);
  });

  it('a folded node\'s toggle persists across a re-emission, by run key', () => {
    render(CASE_2.slice(0, 9));
    expand(k('De', EXPERT));
    const expert = node(k('De', EXPERT));
    render(CASE_2);
    expect(node(k('De', EXPERT))).toBe(expert);
    expect(visibleKeys()).toEqual([ROOT, k('De', EXPERT), k('Re', MANAGER), k('Da', ASSISTANT)]);
    expect(folds.isNodeExpanded(k('De', EXPERT), ROOT)).toBeTrue();
  });

  it('fold state is keyed by run key: two supervisors of one message fold apart', () => {
    const LEAD = addr('@Lead', 'Manager', 'lead-id');
    const log = [
      sent('M', HUMAN, MANAGER, null, 1),
      sent('M', HUMAN, LEAD, null, 1),
      received('M', MANAGER, 2),
      received('M', LEAD, 3),
      sent('D1', MANAGER, EXPERT, 'M', 4),
      sent('D2', LEAD, EXPERT, 'M', 5),
    ];
    render(log, k('M', MANAGER));
    const lead = TestBed.createComponent(TraceTreeComponent);
    lead.componentRef.setInput('graph', runGraphFold(log));
    lead.componentRef.setInput('root', k('M', LEAD));
    lead.detectChanges();

    node(k('M', MANAGER)).querySelector<HTMLButtonElement>('.node-chevron')!.click();
    fixture.detectChanges();
    lead.detectChanges();
    expect(host().querySelectorAll('.tree-leaf').length).toBe(0);
    expect((lead.nativeElement as HTMLElement).querySelectorAll('.tree-leaf').length).toBe(1);
  });

  it('nothing expands by itself: a new child or a new waiting seat under a folded node', () => {
    const base: AkgenticMessage[] = [
      sent('U1', HUMAN, MANAGER, null, 1),
      received('U1', MANAGER, 2),
      sent('D1', MANAGER, EXPERT, 'U1', 3),
      received('D1', EXPERT, 4),
    ];
    render(base);
    expect(visibleKeys()).toEqual([ROOT, k('D1', EXPERT)]);
    render([
      ...base,
      sent('D2', EXPERT, ASSISTANT, 'D1', 5),
      received('D2', ASSISTANT, 6),
      sent('S', EXPERT, SUPPORT, 'D1', 7),
      received('S', SUPPORT, 8),
      processed('S', SUPPORT, 9),
    ]);
    expect(visibleKeys()).toEqual([ROOT, k('D1', EXPERT)]);
    expect(host().querySelector('.node-answer')).toBeNull();
  });

  it('chevrons are buttons with aria-expanded and a label; run lines are buttons', () => {
    render(CASE_2);
    const chevron = node(k('De', EXPERT)).querySelector('.node-chevron')!;
    expect(chevron.tagName).toBe('BUTTON');
    expect(chevron.getAttribute('type')).toBe('button');
    expect(chevron.getAttribute('aria-expanded')).toBe('false');
    expect(chevron.getAttribute('aria-label')).toBe('Show what this run did');
    expand(k('De', EXPERT));
    const open = node(k('De', EXPERT)).querySelector('.node-chevron')!;
    expect(open.getAttribute('aria-expanded')).toBe('true');
    expect(open.getAttribute('aria-label')).toBe('Hide what this run did');

    const selected: string[] = [];
    fixture.componentInstance.selectRun.subscribe((key) => selected.push(key));
    node(k('De', EXPERT)).querySelector<HTMLButtonElement>('button.node-main')!.click();
    expect(selected).toEqual([k('De', EXPERT)]);
    // A node click selects; it never folds (only the chevron does).
    expect(folds.isNodeExpanded(k('De', EXPERT), ROOT)).toBeTrue();
  });

  describe('the @Human row', () => {
    const Q_ENVELOPE = envId('Q', HUMAN);

    it('is not a button and speaks in envelope ids', () => {
      fixture.componentRef.setInput('bubbleIds', new Map([['Q', Q_ENVELOPE]]));
      render(CASE_4);
      const row = host().querySelector<HTMLElement>('.tree-human')!;
      expect(row.tagName).toBe('LI');
      expect(row.closest('button')).toBeNull();
      expect(text(row.querySelector('.node-agent'))).toBe('@Human');
      expect(row.querySelector('.node-from')!.getAttribute('title')).toBe('from @Manager');
      expect(text(row.querySelector('.node-excerpt'))).toBe('content of Q');

      const hovered: (string | null)[] = [];
      const shown: string[] = [];
      fixture.componentInstance.humanRowHover.subscribe((id) => hovered.push(id));
      fixture.componentInstance.showInChat.subscribe((id) => shown.push(id));
      row.dispatchEvent(new MouseEvent('mouseenter'));
      row.dispatchEvent(new MouseEvent('mouseleave'));
      row.querySelector<HTMLButtonElement>('button.node-in-chat')!.click();
      expect(hovered).toEqual([Q_ENVELOPE, null]);
      expect(shown).toEqual([Q_ENVELOPE]);
    });

    it('fails open when its bubble is not rendered', () => {
      render(CASE_4);
      const row = host().querySelector<HTMLElement>('.tree-human')!;
      const hovered: (string | null)[] = [];
      fixture.componentInstance.humanRowHover.subscribe((id) => hovered.push(id));
      row.dispatchEvent(new MouseEvent('mouseenter'));
      expect(hovered).toEqual([]);
      expect(row.querySelector('.node-in-chat')).toBeNull();
    });
  });

  describe('the clock', () => {
    beforeEach(() => jasmine.clock().install());
    afterEach(() => jasmine.clock().uninstall());

    const RUNNING: AkgenticMessage[] = [
      sent('U1', HUMAN, MANAGER, null, 1),
      received('U1', MANAGER, 2),
      toolCall('t1', 'web_search', MANAGER, 'U1', 3),
    ];

    it('ticks a running node, and stops once nothing is live', () => {
      jasmine.clock().mockDate(at(10));
      render(RUNNING);
      const status = (): string => text(node(ROOT).querySelector('.node-status'));
      expect(status()).toBe('8s');
      expect(chips(ROOT)).toEqual(['web_search', 'after web_search…']);

      jasmine.clock().tick(1000);
      fixture.detectChanges();
      expect(status()).toBe('9s');

      render([...RUNNING, processed('U1', MANAGER, 12)]);
      const stopped = fixture.componentInstance.now();
      jasmine.clock().tick(5000);
      expect(fixture.componentInstance.now()).toBe(stopped);
      expect(status()).toBe('10s');
    });

    it('a running run whose last step is not a tool is "thinking…"', () => {
      jasmine.clock().mockDate(at(10));
      render(RUNNING.slice(0, 2));
      expect(chips(ROOT)).toEqual(['thinking…']);
    });
  });
});
