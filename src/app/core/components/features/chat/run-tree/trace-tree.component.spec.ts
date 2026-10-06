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
import { RunSelectionState } from '../../../../services/process/ui-state/run-selection';
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
      providers: [provideTranslateTesting(), TraceFoldState, RunSelectionState],
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
    expect(text(expert.querySelector('.node-excerpt'))).toBe('“content of De”');
    // De: received at 6, processed at 9.
    expect(text(expert.querySelector('.node-status'))).toBe('3s');
    expect(expert.querySelector('.node-status .pi-check')).not.toBeNull();
  });

  it('case 3: the join shows on both sides, each side quoting the message', () => {
    render(CASE_3);
    expand(k('De', EXPERT));
    // The recipient's avatar and name open the row, as a run row's do.
    const leaf = host().querySelector('.tree-leaf--absorbed')!;
    expect(text(leaf.querySelector('.node-avatar'))).toBe('M');
    expect(text(leaf.querySelector('.node-agent'))).toBe('@Manager');
    expect(text(leaf.querySelector('.node-leaf-label'))).toBe('· absorbed by @Manager ⤴');
    expect(text(leaf.querySelector('.node-excerpt'))).toBe('“content of Re”');
    expand(k('Da', ASSISTANT));
    expand(k('Ra', MANAGER));
    const join = host().querySelector('.tree-join')!;
    expect(text(join.querySelector('.node-leaf-label'))).toBe("⤵ took in @Expert's reply");
    expect(text(join.querySelector('.node-excerpt'))).toBe('“content of Re”');
    expect(chips(k('Ra', MANAGER))).toContain('took in 1 message');
  });

  it('case 3: the absorbed leaf and the join row both select the absorbing run', () => {
    render(CASE_3);
    expand(k('De', EXPERT));
    expand(k('Da', ASSISTANT));
    expand(k('Ra', MANAGER));
    const selected: string[] = [];
    const plain: string[] = [];
    fixture.componentInstance.selectAbsorbed.subscribe((key) => selected.push(key));
    fixture.componentInstance.selectRun.subscribe((key) => plain.push(key));

    const leaf = host().querySelector<HTMLButtonElement>('.tree-leaf--absorbed button.node-main')!;
    expect(leaf.getAttribute('title')).toBe(
      "Read inside @Manager's run above — select it to see the whole message",
    );
    leaf.click();
    expect(selected).toEqual([k('Ra', MANAGER)]);

    host().querySelector<HTMLButtonElement>('.tree-join button.node-main')!.click();
    expect(selected).toEqual([k('Ra', MANAGER), k('Ra', MANAGER)]);
    // Its own output, not a node's: the panel flashes the target as well.
    expect(plain).toEqual([]);
    // Neither row folds anything: they are not nodes.
    expect(folds.isNodeExpanded(k('Ra', MANAGER), ROOT)).toBeTrue();
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

  it('a message chip to the workspace actor names only its leaf', () => {
    const workspace = addr(
      '#Workspace-anonymous/_meta/folder-Documents',
      'ToolActor',
      'workspace-id',
    );
    render([
      sent('U1', HUMAN, MANAGER, null, 1),
      received('U1', MANAGER, 2),
      sent('W', MANAGER, workspace, 'U1', 3),
      processed('U1', MANAGER, 4),
    ]);
    node(ROOT).querySelector<HTMLButtonElement>('.node-chevron')!.click();
    fixture.detectChanges();
    expect(chips(ROOT)).toEqual(['💬 Workspace/folder-Documents']);
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
    // A node click selects AND folds, as its caret does.
    expect(folds.isNodeExpanded(k('De', EXPERT), ROOT)).toBeFalse();

    // The caret only folds: it never selects.
    fixture.detectChanges();
    node(k('De', EXPERT)).querySelector<HTMLButtonElement>('.node-chevron')!.click();
    expect(folds.isNodeExpanded(k('De', EXPERT), ROOT)).toBeTrue();
    expect(selected).toEqual([k('De', EXPERT)]);
  });

  it('draws the selected run, and only it, with aria-current — nothing before a selection', () => {
    render(CASE_2);
    expect(host().querySelector('.tree-node--selected')).toBeNull();
    expect(host().querySelector('[aria-current]')).toBeNull();

    TestBed.inject(RunSelectionState).select(runGraphFold(CASE_2), k('De', EXPERT), 'tree');
    fixture.detectChanges();
    const selected = [...host().querySelectorAll('.tree-node--selected')];
    expect(selected.map((n) => n.getAttribute('data-run-key'))).toEqual([k('De', EXPERT)]);
    expect(selected[0].querySelector('.node-main')!.getAttribute('aria-current')).toBe('true');
    expect(host().querySelectorAll('[aria-current]').length).toBe(1);
  });

  it('flashes the node the panel names', () => {
    render(CASE_2);
    fixture.componentRef.setInput('flashingRun', k('Da', ASSISTANT));
    fixture.detectChanges();
    expect(node(k('Da', ASSISTANT)).classList).toContain('tree-node--flash');
    expect(node(ROOT).classList).not.toContain('tree-node--flash');
    // A static ring, not only the fade: reduced motion drops the animation,
    // and the flash must still show. On the row's own box, not the indented li.
    const box = node(k('Da', ASSISTANT)).querySelector('.rn-body')!;
    expect(getComputedStyle(box).boxShadow).not.toBe('none');
  });

  describe('the caret and the spacing', () => {
    afterEach(() => document.getElementById('primeng-sim')?.remove());

    it('the caret is the shared 8px glyph, even under PrimeNG\'s icon size', () => {
      // The rule PrimeNG's base style injects into <head> at runtime.
      const style = document.createElement('style');
      style.id = 'primeng-sim';
      style.textContent = '.pi { font-size: 13px; }';
      document.head.appendChild(style);
      render(CASE_2);

      for (const glyph of [
        node(ROOT).querySelector('.node-chevron .pi')!,
        node(k('De', EXPERT)).querySelector('.node-chevron .pi')!,
      ]) {
        expect(glyph.classList).toContain('akg-caret');
        expect(getComputedStyle(glyph).fontSize).toBe('8px');
      }
    });

    it('a row\'s box and the tree around the rows breathe', () => {
      render(CASE_2);
      expect(getComputedStyle(node(ROOT).querySelector('.rn-body')!).paddingTop).toBe('8px');
      const tree = getComputedStyle(host().querySelector('.tree')!);
      expect(tree.marginTop).toBe('12px');
      expect(tree.marginBottom).toBe('4px');
    });

    it('the chevron stays level with line 1 inside the row\'s box', () => {
      render(CASE_2);
      const row = node(ROOT);
      const chevron = row.querySelector('.node-chevron')!.getBoundingClientRect();
      const line = row.querySelector('.rn-body .node-line')!.getBoundingClientRect();
      expect(chevron.top).toBe(line.top);
    });
  });

  describe('the @Human row', () => {
    const Q_ENVELOPE = envId('Q', HUMAN);

    it('folded away under the pointer, clears its bubble highlight', () => {
      fixture.componentRef.setInput('bubbleIds', new Map([['Q', Q_ENVELOPE]]));
      render(CASE_4);
      const hovered: (string | null)[] = [];
      fixture.componentInstance.humanRowHover.subscribe((id) => hovered.push(id));
      host().querySelector<HTMLElement>('.tree-human')!.dispatchEvent(new MouseEvent('mouseenter'));

      // The root's chevron folds the row away; no mouseleave will ever fire.
      node(ROOT).querySelector<HTMLButtonElement>('.node-chevron')!.click();
      fixture.detectChanges();
      expect(host().querySelector('.tree-human')).toBeNull();
      expect(hovered).toEqual([Q_ENVELOPE, null]);
    });

    it('is not a button and speaks in envelope ids', () => {
      fixture.componentRef.setInput('bubbleIds', new Map([['Q', Q_ENVELOPE]]));
      render(CASE_4);
      const row = host().querySelector<HTMLElement>('.tree-human')!;
      expect(row.tagName).toBe('LI');
      expect(row.closest('button')).toBeNull();
      expect(text(row.querySelector('.node-agent'))).toBe('@Human');
      expect(row.querySelector('.node-from')!.getAttribute('title')).toBe('from @Manager');
      expect(text(row.querySelector('.node-excerpt'))).toBe('“content of Q”');

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

    it('"in chat" releases the hover before it sends the reader to the bubble', () => {
      fixture.componentRef.setInput('bubbleIds', new Map([['Q', Q_ENVELOPE]]));
      render(CASE_4);
      const row = host().querySelector<HTMLElement>('.tree-human')!;
      const events: string[] = [];
      fixture.componentInstance.humanRowHover.subscribe((id) => events.push(`hover:${id}`));
      fixture.componentInstance.showInChat.subscribe((id) => events.push(`show:${id}`));
      // The scroll carries the row away from the pointer: no mouseleave follows.
      row.dispatchEvent(new MouseEvent('mouseenter'));
      row.querySelector<HTMLButtonElement>('button.node-in-chat')!.click();
      expect(events).toEqual([`hover:${Q_ENVELOPE}`, 'hover:null', `show:${Q_ENVELOPE}`]);
    });

    it('"in chat" is an outlined pill in its own ink, with no fill', () => {
      fixture.componentRef.setInput('bubbleIds', new Map([['Q', Q_ENVELOPE]]));
      render(CASE_4);
      const style = getComputedStyle(host().querySelector('.node-in-chat')!);
      expect(style.borderTopStyle).toBe('solid');
      expect(style.borderTopWidth).toBe('1px');
      expect(style.borderTopColor).toBe(style.color);
      expect(style.backgroundColor).toBe('rgba(0, 0, 0, 0)');
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

    it('repaints on its own: the out-of-zone tick needs no manual change detection', () => {
      jasmine.clock().mockDate(at(10));
      render(RUNNING);
      fixture.autoDetectChanges(true);
      const status = (): string => text(node(ROOT).querySelector('.node-status'));
      expect(status()).toBe('8s');

      // The interval runs outside the zone; only the signal write can schedule
      // the render. No `detectChanges()` here on purpose.
      jasmine.clock().tick(1000);
      jasmine.clock().tick(20);
      expect(status()).toBe('9s');
    });

    it('a running run whose last step is not a tool is "thinking…"', () => {
      jasmine.clock().mockDate(at(10));
      render(RUNNING.slice(0, 2));
      expect(chips(ROOT)).toEqual(['thinking…']);
    });
  });
});
