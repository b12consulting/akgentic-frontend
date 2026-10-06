import { ComponentFixture, TestBed } from '@angular/core/testing';
import { BehaviorSubject } from 'rxjs';

import en from '../../../platform/i18n/locales/en.json';
import {
  provideTranslateTesting,
  setTestTranslations,
} from '../../../../../testing/i18n-testing';
import {
  addr,
  ASSISTANT,
  EXPERT,
  HUMAN,
  MANAGER,
  processed,
  received,
  sent,
  SUPPORT,
  toolCall,
  toolReturn,
} from '../../../../../testing/run-log-builders';
import {
  CASE_2,
  CASE_3,
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
    // Handling: one card, the route its first line, then the message —
    // nothing else; the ids and the send time live in the Event log.
    const handling = host().querySelectorAll('.ri-section')[1];
    expect([...handling.children].map((c) => c.className)).toEqual([
      'ri-section-title',
      'ri-handling',
    ]);
    const card = handling.querySelector('.ri-handling')!;
    expect([...card.children].map((c) => c.className)).toEqual(['ri-route', 'ri-text']);
    expect(text(card.querySelector('.ri-route'))).toBe('@Expert → @Assistant');
    expect(text(card.querySelector('.ri-text'))).toBe('content of D2');
    // The card is the box; the body inside it keeps the Steps' type size.
    expect(getComputedStyle(card).borderTopWidth).toBe('1px');
    // The route line is the quiet header, the message the content.
    const route = getComputedStyle(card.querySelector('.ri-route')!);
    const body = getComputedStyle(card.querySelector('.ri-text')!);
    expect(route.fontWeight).toBe('400');
    expect(route.color).not.toBe(body.color);
    expect(getComputedStyle(card.querySelector('.ri-text')!).borderTopWidth).toBe('0px');
    expect(getComputedStyle(card.querySelector('.ri-text')!).fontSize).toBe(
      getComputedStyle(host().querySelector('.ri-step-label')!).fontSize,
    );
    expect(handling.querySelector('dl, dt, dd')).toBeNull();
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

  it('a tool step names its tool, then what it was called with; a call with none, the name alone', () => {
    const call = (id: string, name: string, args: string, t: number) => {
      const m = toolCall(id, name, MANAGER, 'U1', t);
      (m.event as { arguments: string }).arguments = args;
      return m;
    };
    log.appendAll([
      sent('U1', HUMAN, MANAGER, null, 1),
      received('U1', MANAGER, 2),
      call('t1', 'workspace_read', '{"path": "onboarding/sept-signups.csv"}', 3),
      toolReturn('t1', 'workspace_read', MANAGER, 'U1', 4),
      call('t2', 'get_planning', '{}', 5),
      toolReturn('t2', 'get_planning', MANAGER, 'U1', 6),
    ]);
    mount();
    select(runKey('U1', M));

    const tools = Array.from(host().querySelectorAll('.ri-step[data-step="tool"]'));
    const [read, plan] = tools;
    expect(text(read.querySelector('.ri-tool-name'))).toBe('workspace_read');
    const args = text(read.querySelector('.ri-tool-args'));
    expect(args).toContain('onboarding/sept-signups.csv');
    // The whole preview on hover, since the line is cut to the pane.
    expect(read.querySelector('.ri-step-tool')!.getAttribute('title')).toBe(args);

    expect(text(plan.querySelector('.ri-tool-name'))).toBe('get_planning');
    expect(plan.querySelector('.ri-tool-args')).toBeNull();
    expect(plan.querySelector('.ri-step-tool')!.getAttribute('title')).toBeNull();
  });

  it('a seat reads "waiting for a person", then "answered"', () => {
    log.appendAll(CASE_5_PREFIX);
    mount();
    select(runKey('S', S));
    expect(text(host().querySelector('.ri-pill'))).toBe('waiting for a person');
    // Styled by the pill's value, never by its translation key.
    expect(host().querySelector('.ri-pill')!.getAttribute('data-pill')).toBe('waiting');
    log.appendAll(CASE_5_ANSWER);
    fixture.detectChanges();
    expect(text(host().querySelector('.ri-pill'))).toBe('answered');
    expect(host().querySelector('.ri-pill')!.getAttribute('data-pill')).toBe('answered');
  });

  it('names the workspace actor by its leaf, in the header, the route and a step', () => {
    const workspace = addr(
      '#Workspace-anonymous/_meta/folder-Documents',
      'ToolActor',
      'workspace-id',
    );
    log.appendAll([
      sent('U1', HUMAN, MANAGER, null, 1),
      received('U1', MANAGER, 2),
      sent('W', MANAGER, workspace, 'U1', 3),
      processed('U1', MANAGER, 4),
      received('W', workspace, 5),
      processed('W', workspace, 6),
    ]);
    mount();

    select(runKey('W', workspace.agent_id));
    expect(text(host().querySelector('.ri-agent'))).toBe('Workspace/folder-Documents');
    expect(text(host().querySelector('.ri-avatar'))).toBe('W');
    expect(text(host().querySelector('.ri-route'))).toBe('@Manager → Workspace/folder-Documents');

    select(runKey('U1', M));
    expect(texts('.ri-step-label')).toContain('sent to Workspace/folder-Documents');
  });

  it('an unknown trigger replaces Handling\'s route and text with one note', () => {
    // A replay that starts at the ReceivedMessage: the send was never loaded.
    log.appendAll([received('D2', ASSISTANT, 11)]);
    mount();
    expect(text(host().querySelector('.ri-agent'))).toBe('@Assistant');
    expect(host().querySelector('.ri-route')).toBeNull();
    expect(host().querySelector('.ri-text')).toBeNull();
    expect(texts('.ri-note')).toContain(
      'The message that started this run is not in the loaded log.',
    );
  });

  it('case 3: Handling lists the reply the run took in, whole, after its trigger', () => {
    log.appendAll(CASE_3);
    mount();
    select(runKey('Ra', M));

    const handling = host().querySelectorAll('.ri-section')[1];
    expect([...handling.children].map((c) => c.className)).toEqual([
      'ri-section-title',
      'ri-handling',
      'ri-handling ri-handling--absorbed',
    ]);
    const [trigger, absorbed] = [...handling.querySelectorAll('.ri-handling')];
    expect(text(trigger.querySelector('.ri-route'))).toBe('@Assistant → @Manager');
    expect(text(trigger.querySelector('.ri-text'))).toBe('content of Ra');
    // The same card as the trigger's: the route, when the run read it, the
    // message whole. The tree only ever shows its excerpt.
    expect(absorbed.getAttribute('data-inner-id')).toBe('Re');
    expect(text(absorbed.querySelector('.ri-route'))).toBe('@Expert → @Manager · ⤵ took in at +6s');
    expect(text(absorbed.querySelector('.ri-text'))).toBe('content of Re');
    expect(getComputedStyle(absorbed).borderTopStyle).toBe('dashed');
    // The step quotes it too, in the arguments' quiet tone.
    const step = host().querySelector('.ri-step[data-step="absorbed"]')!;
    expect(text(step.querySelector('.ri-tool-name'))).toBe("took in @Expert's message");
    expect(text(step.querySelector('.ri-step-excerpt'))).toBe('“content of Re”');

    // A run that took nothing in shows its trigger alone.
    select(runKey('De', E));
    expect(host().querySelectorAll('.ri-handling').length).toBe(1);
    expect(host().querySelector('.ri-handling--absorbed')).toBeNull();
  });

  it('case 3: the mini-tree\'s absorbed leaf is a node-shaped button that selects the absorbing run', () => {
    log.appendAll(CASE_3);
    mount();
    select(runKey('De', E));
    const events: RunSelection[] = [];
    selection.selections$.subscribe((e) => events.push(e));

    const leaf = host().querySelector<HTMLButtonElement>('.mini-leaf .mini-main--absorbed')!;
    expect(text(leaf.querySelector('.mini-avatar'))).toBe('M');
    expect(leaf.querySelector('.mini-avatar')!.classList).toContain('mini-avatar--quiet');
    expect(text(leaf.querySelector('.mini-name'))).toBe('@Manager');
    expect(text(leaf.querySelector('.mini-hint'))).toBe('· absorbed by @Manager ⤴');
    expect(leaf.getAttribute('title')).toBe(
      "Read inside @Manager's run — select it to see the whole message",
    );

    leaf.click();
    fixture.detectChanges();
    expect(events).toEqual([{ key: runKey('Ra', M), origin: 'mini-tree' }]);
    expect(text(host().querySelector('.ri-agent'))).toBe('@Manager');
    expect(host().querySelector('.ri-handling--absorbed')).not.toBeNull();
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

    it('sits in a box under a root line; each node shows an avatar and its short id', () => {
      const box = host().querySelector('.mini-box')!;
      expect(box).not.toBeNull();
      expect(box.querySelector('.mini-tree')).not.toBeNull();
      // The top run's trigger: you → @Manager, and the id as the Event log cuts it.
      expect(text(box.querySelector('.mini-root'))).toBe('you → @Manager #U1');
      const manager = miniNode(runKey('U1', M));
      expect(text(manager.querySelector('.mini-avatar'))).toBe('M');
      expect(text(manager.querySelector('.mini-id'))).toBe('#U1');
      // A seat's avatar is round; an agent's is not.
      expect(miniNode(runKey('S', S)).querySelector('.mini-avatar--human')).not.toBeNull();
      expect(manager.querySelector('.mini-avatar--human')).toBeNull();
    });

    it('a folded node\'s summary pill counts what it hides and opens it', () => {
      const pill = miniNode(runKey('S', S)).querySelector<HTMLButtonElement>('button.mini-folded')!;
      expect(text(pill)).toBe('1 run · @Manager');
      pill.click();
      fixture.detectChanges();
      expect(miniKeys()).toContain(runKey('Sa', M));
      expect(miniNode(runKey('S', S)).querySelector('.mini-folded')).toBeNull();
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
    // The same row form, not a button: a round H, then plain muted words.
    expect(text(entry.querySelector('.mini-avatar--human'))).toBe('H');
    expect(text(entry.querySelector('.mini-hint'))).toBe('you answered');
    // Below your reply's run: the answer you received, still not a button.
    const answer = miniNode(runKey('A', 'human-id'));
    expect(answer.querySelector('button')).toBeNull();
    expect(text(answer.querySelector('.mini-hint'))).toBe('to you');
  });

  /*
   * Emphasis follows the displayed run's path, and only it: the run and its
   * ancestors at full strength, every other node muted. Read from computed
   * styles, with the two text tones pinned to literals on the host so the
   * comparison does not depend on the palette.
   */
  describe('path-only emphasis', () => {
    const FULL = 'rgb(1, 2, 3)';
    const MUTED = 'rgb(4, 5, 6)';

    function mountTinted(): void {
      mount();
      host().style.setProperty('--akg-text', FULL);
      host().style.setProperty('--akg-text-muted', MUTED);
    }

    /** Opens every folded mini-tree node, so every node is on screen. */
    function unfoldAll(): void {
      for (;;) {
        const folded = host().querySelector<HTMLButtonElement>(
          '.mini-chevron[aria-expanded="false"]',
        );
        if (folded === null) return;
        folded.click();
        fixture.detectChanges();
      }
    }

    /** 'full' or 'muted' when name, id, weight and avatar all agree; the
     *  disagreement spelled out otherwise. */
    function emphasis(key: string): string {
      const row = miniNode(key);
      const main = row.querySelector('.mini-main')!;
      const label = row.querySelector('.mini-name') ?? row.querySelector('.mini-hint')!;
      const id = row.querySelector('.mini-id');
      const avatar = row.querySelector('.mini-avatar')!;
      const colour = getComputedStyle(label).color;
      const weight = getComputedStyle(main).fontWeight;
      const idColour = id === null ? colour : getComputedStyle(id).color;
      const agent = !avatar.classList.contains('mini-avatar--human');
      const quiet = avatar.classList.contains('mini-avatar--quiet');
      if (colour === FULL && idColour === FULL && weight === '600' && !(agent && quiet)) {
        return 'full';
      }
      if (colour === MUTED && idColour === MUTED && weight === '400' && !(agent && !quiet)) {
        return 'muted';
      }
      return `mixed(${colour} ${idColour} ${weight} ${agent ? (quiet ? 'quiet' : 'own') : 'human'})`;
    }

    /** Every node on screen but the displayed one, split by emphasis. */
    function partition(): { full: string[]; muted: string[]; other: string[] } {
      const out = { full: [] as string[], muted: [] as string[], other: [] as string[] };
      for (const node of host().querySelectorAll('.mini-node:not(.mini-node--displayed)')) {
        const key = node.getAttribute('data-mini-run-key')!;
        const e = emphasis(key);
        if (e === 'full') out.full.push(key);
        else if (e === 'muted') out.muted.push(key);
        else out.other.push(`${key}: ${e}`);
      }
      return out;
    }

    function displayedKeys(): (string | null)[] {
      return [...host().querySelectorAll('.mini-node--displayed')].map((n) =>
        n.getAttribute('data-mini-run-key'),
      );
    }

    it('case 5, a deep run displayed: its ancestors full, every other node muted', () => {
      log.appendAll(CASE_5);
      mountTinted();
      select(runKey('D2', A));
      unfoldAll();

      expect(miniKeys()).toEqual([
        runKey('U1', M),
        runKey('S', S),
        runKey('Sa', M),
        runKey('D1', E),
        runKey('D2', A),
        runKey('C', E),
        runKey('B', M),
      ]);
      expect(partition()).toEqual({
        full: [runKey('U1', M), runKey('D1', E)],
        muted: [runKey('S', S), runKey('Sa', M), runKey('C', E), runKey('B', M)],
        other: [],
      });
      // The displayed run itself: inverted, on the full tone.
      expect(displayedKeys()).toEqual([runKey('D2', A)]);
      const shown = miniNode(runKey('D2', A)).querySelector('.mini-main')!;
      expect(getComputedStyle(shown).backgroundColor).toBe(FULL);
      expect(getComputedStyle(shown).fontWeight).toBe('600');
      // Its id takes the inverted ink, not the path's tone on the full ground.
      expect(getComputedStyle(shown.querySelector('.mini-id')!).color).toBe(
        getComputedStyle(shown).color,
      );
      expect(getComputedStyle(shown.querySelector('.mini-id')!).color).not.toBe(FULL);
    });

    it('case 5, the root displayed: every other node muted', () => {
      log.appendAll(CASE_5);
      mountTinted();
      select(runKey('U1', M));
      unfoldAll();

      expect(displayedKeys()).toEqual([runKey('U1', M)]);
      expect(partition()).toEqual({
        full: [],
        muted: [
          runKey('S', S),
          runKey('Sa', M),
          runKey('D1', E),
          runKey('D2', A),
          runKey('C', E),
          runKey('B', M),
        ],
        other: [],
      });
    });

    it('case 4: the entry rows are muted off the path, and "you answered" is full on it', () => {
      log.appendAll(CASE_4);
      mountTinted();
      select(runKey('U1', M));
      unfoldAll();
      expect(partition()).toEqual({
        full: [],
        muted: [runKey('Q', 'human-id'), runKey('U2', M), runKey('A', 'human-id')],
        other: [],
      });

      select(runKey('U2', M));
      unfoldAll();
      expect(partition()).toEqual({
        full: [runKey('U1', M), runKey('Q', 'human-id')],
        muted: [runKey('A', 'human-id')],
        other: [],
      });
    });

    it('folding a node, on the path or off it, moves no node\'s emphasis', () => {
      log.appendAll(CASE_5);
      mountTinted();
      select(runKey('C', E));
      unfoldAll();
      const before = new Map(miniKeys().map((key) => [key, emphasis(key!)]));

      // Off the path, then on it.
      for (const key of [runKey('S', S), runKey('D1', E)]) {
        miniNode(key).querySelector<HTMLButtonElement>('.mini-chevron')!.click();
        fixture.detectChanges();
        for (const shown of miniKeys()) {
          expect(`${shown}: ${emphasis(shown!)}`).toBe(`${shown}: ${before.get(shown)}`);
        }
      }
      expect(before.get(runKey('S', S))).toBe('muted');
      expect(before.get(runKey('D1', E))).toBe('full');
    });

    it('the root line stays muted, as the mockup draws it', () => {
      log.appendAll(CASE_5);
      mountTinted();
      select(runKey('D2', A));
      const root = host().querySelector('.mini-root')!;
      expect(getComputedStyle(root).color).toBe(MUTED);
      expect(getComputedStyle(root).fontWeight).toBe('400');
      expect(getComputedStyle(root.querySelector('.mini-id')!).color).toBe(MUTED);
    });
  });

  describe('the mini-tree\'s caret and spacing', () => {
    beforeEach(() => {
      log.appendAll(CASE_5);
      mount();
      select(runKey('B', M));
    });

    afterEach(() => document.getElementById('primeng-sim')?.remove());

    it('the caret is the shared 8px glyph, even under PrimeNG\'s icon size', () => {
      // The rule PrimeNG's base style injects into <head> at runtime.
      const style = document.createElement('style');
      style.id = 'primeng-sim';
      style.textContent = '.pi { font-size: 13px; }';
      document.head.appendChild(style);

      const glyph = miniNode(runKey('S', S)).querySelector('.mini-chevron .pi')!;
      expect(glyph.classList).toContain('akg-caret');
      expect(getComputedStyle(glyph).fontSize).toBe('8px');
    });

    it('the box, the root line and every row breathe', () => {
      const box = getComputedStyle(host().querySelector('.mini-box')!);
      expect(box.paddingTop).toBe('12px');
      expect(box.paddingLeft).toBe('14px');
      expect(getComputedStyle(host().querySelector('.mini-root')!).marginBottom).toBe('8px');
      const row = miniNode(runKey('D1', E));
      expect(getComputedStyle(row).paddingTop).toBe('3px');
      expect(getComputedStyle(row.querySelector('.mini-main')!).paddingTop).toBe('4px');
    });
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
