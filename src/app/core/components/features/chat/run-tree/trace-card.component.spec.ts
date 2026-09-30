import { ComponentFixture, TestBed } from '@angular/core/testing';

import en from '../../../../platform/i18n/locales/en.json';
import { AkgenticMessage } from '../../../../protocol/message.types';
import {
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
} from '../../../../../../testing/run-log-builders';
import {
  provideTranslateTesting,
  setTestTranslations,
} from '../../../../../../testing/i18n-testing';
import { runGraphFold, runKey } from '../../../../services/process/selectors/run-graph.selector';
import {
  TraceSummary,
  traceSummary,
} from '../../../../services/process/selectors/trace-summary';
import { RunSelectionState } from '../../../../services/process/ui-state/run-selection';
import { TraceFoldState } from '../../../../services/process/ui-state/trace-fold-state';
import { TraceCardComponent } from './trace-card.component';

const U1 = runKey('U1', MANAGER.agent_id);

const CASE_1: AkgenticMessage[] = [
  sent('U1', HUMAN, MANAGER, null, 1),
  received('U1', MANAGER, 2),
  toolCall('t1', 'search', MANAGER, 'U1', 3),
  toolReturn('t1', 'search', MANAGER, 'U1', 4),
  sent('A1', MANAGER, HUMAN, 'U1', 5),
  processed('U1', MANAGER, 6),
  received('A1', HUMAN, 7),
  processed('A1', HUMAN, 8),
];

const MANY: AkgenticMessage[] = [
  sent('U1', HUMAN, MANAGER, null, 1),
  received('U1', MANAGER, 2),
  sent('De', MANAGER, EXPERT, 'U1', 3),
  sent('Da', MANAGER, ASSISTANT, 'U1', 4),
  processed('U1', MANAGER, 5),
  received('De', EXPERT, 6),
  toolCall('w1', 'web_search', EXPERT, 'De', 7),
  received('Da', ASSISTANT, 8),
  processed('Da', ASSISTANT, 9),
];

const WAITING: AkgenticMessage[] = [
  sent('U1', HUMAN, MANAGER, null, 1),
  received('U1', MANAGER, 2),
  sent('S', MANAGER, SUPPORT, 'U1', 3),
  processed('U1', MANAGER, 4),
  received('S', SUPPORT, 5),
  processed('S', SUPPORT, 6),
];

function summaryOf(log: AkgenticMessage[]): TraceSummary {
  const s = traceSummary(runGraphFold(log), U1);
  if (s === null) throw new Error('no trace');
  return s;
}

describe('TraceCardComponent', () => {
  let fixture: ComponentFixture<TraceCardComponent>;

  function render(summary: TraceSummary, open = false): HTMLElement {
    fixture.componentRef.setInput('summary', summary);
    fixture.componentRef.setInput('open', open);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  function text(selector: string): string {
    const el = (fixture.nativeElement as HTMLElement).querySelector(selector);
    return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  }

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TraceCardComponent],
      providers: [provideTranslateTesting(), TraceFoldState, RunSelectionState],
    }).compileComponents();
    fixture = TestBed.createComponent(TraceCardComponent);
  });

  describe('the four header titles, in the shipped English', () => {
    beforeEach(() => setTestTranslations(en));

    it('case 1 reads "@Manager handled this in 1 run · 1 tool"', () => {
      render(summaryOf(CASE_1));
      expect(text('.trace-title')).toBe('@Manager handled this in 1 run · 1 tool');
      expect(text('.trace-meta')).toBe('1 run · 1 tool · 4s');
    });

    it('running: the latest tool of the most recent running run, and "N running"', () => {
      render(summaryOf(MANY));
      expect(text('.trace-title')).toBe('@Expert used web_search');
      expect(text('.trace-status')).toBe('1 running');
      expect(text('.trace-meta')).toBe('3 runs · 1 tool');
    });

    it('waiting: "Waiting for @Support" with the amber dot', () => {
      const el = render(summaryOf(WAITING));
      expect(text('.trace-title')).toBe('Waiting for @Support');
      expect(el.querySelector('.trace-dot--waiting')).not.toBeNull();
    });

    it('done with several agents: the root agent, then the others', () => {
      render(summaryOf([...MANY, processed('De', EXPERT, 10)]));
      expect(text('.trace-title')).toBe('@Manager worked with @Expert and @Assistant');
    });
  });

  it('threads the counts into the count keys (synthetic templates)', () => {
    setTestTranslations({
      chat: { runTree: { runsMany: '<R{{count}}>', toolsOne: '<T1>', meta: '{{runs}}+{{tools}}' } },
    });
    render(summaryOf(MANY));
    expect(text('.trace-meta')).toBe('<R3>+<T1>');
  });

  it('shows the end time when done, and no duration while running', () => {
    render(summaryOf(CASE_1));
    expect(text('.trace-status')).toMatch(/^\d\d:\d\d$/);
    render(summaryOf(MANY));
    expect(text('.trace-meta')).not.toContain('·');
  });

  it('stacks one avatar per distinct agent', () => {
    const el = render(summaryOf(MANY));
    const initials = [...el.querySelectorAll('.trace-avatar')].map((a) => a.textContent);
    expect(initials).toEqual(['M', 'E', 'A']);
  });

  it('starts collapsed: no body, chevron not expanded', () => {
    const el = render(summaryOf(CASE_1));
    expect(el.querySelector('.trace-body')).toBeNull();
    expect(el.querySelector('.trace-toggle')!.getAttribute('aria-expanded')).toBe('false');
    expect(el.querySelector('.trace-toggle')!.getAttribute('aria-label')).toBe(
      'chat.runTree.expand',
    );
  });

  it('open: renders the tree rooted at the card\'s root, and an expanded chevron', () => {
    const graph = runGraphFold(MANY);
    fixture.componentRef.setInput('graph', graph);
    const el = render(summaryOf(MANY), true);
    const nodes = [...el.querySelectorAll('.trace-body app-trace-tree .tree-node')];
    expect(nodes.map((n) => n.getAttribute('data-run-key'))).toEqual([
      U1,
      runKey('De', EXPERT.agent_id),
      runKey('Da', ASSISTANT.agent_id),
    ]);
    expect(nodes.map((n) => n.getAttribute('data-depth'))).toEqual(['0', '1', '1']);
    expect(el.querySelector('.trace-toggle')!.getAttribute('aria-expanded')).toBe('true');
  });

  it('passes the tree\'s Answer up with the seat\'s run key', () => {
    fixture.componentRef.setInput('graph', runGraphFold(WAITING));
    const el = render(summaryOf(WAITING), true);
    const answered: string[] = [];
    fixture.componentInstance.answer.subscribe((k) => answered.push(k));
    el.querySelector<HTMLButtonElement>('.node-answer')!.click();
    expect(answered).toEqual([runKey('S', SUPPORT.agent_id)]);
  });

  it('a trace waiting on a seat shows no duration in its meta', () => {
    setTestTranslations(en);
    render(summaryOf(WAITING));
    expect(text('.trace-meta')).toBe('2 runs · 0 tools');
  });

  it('the header and the chevron each emit one toggle with the root key', () => {
    const el = render(summaryOf(CASE_1));
    const emitted: string[] = [];
    fixture.componentInstance.toggle.subscribe((k) => emitted.push(k));
    (el.querySelector('.trace-toggle') as HTMLButtonElement).click();
    expect(emitted).toEqual([U1]);
    (el.querySelector('.trace-header') as HTMLElement).click();
    expect(emitted).toEqual([U1, U1]);
  });

  it('heads a continued trace with the asker', () => {
    fixture.componentRef.setInput('continuesFrom', MANAGER);
    render(summaryOf(CASE_1));
    expect(text('.trace-continues')).toBe('chat.runTree.continuesTrace');
  });
});
