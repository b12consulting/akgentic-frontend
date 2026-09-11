import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';

import { ChatThinkingComponent } from './chat-thinking.component';
import { ThinkingState, ThinkingToolEntry } from '../../selectors/chat.selector';
import {
  provideTranslateTesting,
  setTestTranslations,
} from '../../../../../testing/i18n-testing';

function makeState(overrides: Partial<ThinkingState> = {}): ThinkingState {
  return {
    agent_id: 'a1',
    agent_name: '@Researcher',
    start_time: new Date('2026-04-12T10:00:00Z'),
    tools: [],
    anchor_message_id: 'anchor-1',
    final: false,
    ...overrides,
  };
}

function tool(id: string, name: string, done = false): ThinkingToolEntry {
  return {
    tool_call_id: id,
    tool_name: name,
    arguments_preview: 'q=x',
    done,
    kind: 'tool',
  };
}

/** A message to another agent — the other half of a run's step list. */
function contact(id: string, agent: string): ThinkingToolEntry {
  return {
    tool_call_id: id,
    tool_name: agent,
    arguments_preview: 'can you help',
    done: true,
    kind: 'contact',
  };
}

/**
 * The activity fold.
 *
 * These specs replace a set that pinned the PREVIOUS shape, in which the step
 * list rendered unconditionally. That behaviour disagreed with the component's
 * own docstring ("tool list only if `expanded()`"), and it meant a long run
 * buried the conversation under its own tool calls. Collapsed is now one row
 * carrying the latest step; the caret opens the rest.
 */
describe('ChatThinkingComponent — the activity fold', () => {
  let fixture: ComponentFixture<ChatThinkingComponent>;
  let component: ChatThinkingComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ChatThinkingComponent, NoopAnimationsModule],
      providers: [provideTranslateTesting()],
    }).compileComponents();
    fixture = TestBed.createComponent(ChatThinkingComponent);
    component = fixture.componentInstance;
  });

  function setInputs(state: ThinkingState, expanded = false): void {
    fixture.componentRef.setInput('state', state);
    fixture.componentRef.setInput('expanded', expanded);
    fixture.detectChanges();
  }

  function el(): HTMLElement {
    return fixture.nativeElement;
  }

  it('should create', () => {
    setInputs(makeState());
    expect(component).toBeTruthy();
  });

  it('collapsed: renders one row and NO step list, however many steps ran', () => {
    setInputs(
      makeState({ tools: [tool('c1', 'search_web'), tool('c2', 'analyze')] }),
      false,
    );
    expect(el().querySelector('.activity-row')).not.toBeNull();
    expect(el().querySelector('.activity-list')).toBeNull();
  });

  it('collapsed: the row reports the LATEST step, not the first', () => {
    // Synthetic copy on purpose (NFR3): asserting the real English here would
    // pin the wording through the back door. What matters is WHICH step is
    // interpolated, not how the sentence reads.
    setTestTranslations({ chat: { activity: { latest: '<<latest:{{tool}}>>' } } });
    setInputs(
      makeState({ tools: [tool('c1', 'search_web'), tool('c2', 'analyze')] }),
      false,
    );
    // The row is what the agent is doing NOW — the reason it is worth one line.
    expect(component.latest()?.tool_name).toBe('analyze');
    expect(el().querySelector('.activity-latest')?.textContent).toContain(
      'analyze',
    );
    expect(el().querySelector('.activity-latest')?.textContent).not.toContain(
      'search_web',
    );
  });

  it('expanded: the caret opens the full sequence, in order', () => {
    setTestTranslations({ chat: { activity: { step: '<<step:{{tool}}>>' } } });
    setInputs(
      makeState({ tools: [tool('c1', 'search_web', true), tool('c2', 'analyze')] }),
      true,
    );
    const entries = el().querySelectorAll('.activity-entry');
    expect(entries.length).toBe(2);
    expect(entries[0].textContent).toContain('search_web');
    expect(entries[1].textContent).toContain('analyze');
  });

  it('marks finished steps so the running one stays legible', () => {
    setInputs(
      makeState({ tools: [tool('c1', 'search_web', true), tool('c2', 'analyze')] }),
      true,
    );
    const entries = el().querySelectorAll('.activity-entry');
    expect(entries[0].classList).toContain('done');
    expect(entries[1].classList).not.toContain('done');
  });

  it('shows a step count only once there is more than one step', () => {
    setInputs(makeState({ tools: [tool('c1', 'search_web')] }), false);
    expect(el().querySelector('.activity-count')).toBeNull();

    setInputs(
      makeState({ tools: [tool('c1', 'search_web'), tool('c2', 'analyze')] }),
      false,
    );
    expect(el().querySelector('.activity-count')).not.toBeNull();
  });

  it('live vs answered: the mark pulses only while the agent is working', () => {
    setInputs(makeState({ final: false }));
    expect(el().querySelector('.activity')?.classList).toContain('live');

    setInputs(makeState({ final: true }));
    expect(el().querySelector('.activity')?.classList).not.toContain('live');
  });

  it('leads with the tool glyph, not a dot, and pulses only while live', () => {
    // The mark is what says "a tool ran" before a word is read. A dot said only
    // "something is here", which the reader could already see.
    setInputs(makeState({ final: false, tools: [tool('c1', 'search_web')] }));
    const mark = el().querySelector('.activity-mark');
    expect(mark).not.toBeNull();
    expect(mark!.tagName.toLowerCase()).toBe('svg');
    expect(el().querySelector('.activity')?.classList).toContain('live');

    setInputs(makeState({ final: true, tools: [tool('c1', 'search_web')] }));
    // The glyph stays — a finished tool step is still a tool step. Only the
    // `live` class, which is what drives the pulse, goes.
    expect(el().querySelector('.activity-mark')).not.toBeNull();
    expect(el().querySelector('.activity')?.classList).not.toContain('live');
  });

  it('closes the row with a keyboard-reachable toggle whose label names the state', () => {
    setTestTranslations({
      chat: { activity: { expand: '<<open>>', collapse: '<<close>>' } },
    });

    setInputs(makeState({ tools: [tool('c1', 'search_web')] }), false);
    const closed = el().querySelector<HTMLButtonElement>('.activity-toggle');
    // A real button: the fold's row is a div, so this is the only thing on it a
    // keyboard can land on.
    expect(closed?.tagName.toLowerCase()).toBe('button');
    expect(closed?.textContent?.trim()).toBe('<<open>>');
    expect(closed?.getAttribute('aria-expanded')).toBe('false');

    setInputs(makeState({ tools: [tool('c1', 'search_web')] }), true);
    const open = el().querySelector<HTMLButtonElement>('.activity-toggle');
    expect(open?.textContent?.trim()).toBe('<<close>>');
    expect(open?.getAttribute('aria-expanded')).toBe('true');
  });

  it('pressing the toggle opens the fold exactly once', (done) => {
    // The label sits INSIDE the row's own click target. Without the guard the
    // click would be counted twice and the fold would land back where it was.
    setInputs(
      makeState({ anchor_message_id: 'anchor-1', tools: [tool('c1', 'search_web')] }),
      false,
    );

    const emitted: string[] = [];
    component.toggleExpanded.subscribe((id: string) => emitted.push(id));

    el().querySelector<HTMLButtonElement>('.activity-toggle')!.click();

    setTimeout(() => {
      expect(emitted).toEqual(['anchor-1']);
      done();
    });
  });

  it('a run with no steps offers no toggle and does not toggle', () => {
    let emitted = false;
    setInputs(makeState({ tools: [] }), false);
    component.toggleExpanded.subscribe(() => (emitted = true));

    expect(el().querySelector('.activity-toggle')).toBeNull();
    expect(el().querySelector('.activity')?.classList).not.toContain('openable');

    (el().querySelector('.activity') as HTMLElement).click();
    // Nothing to open, so nothing is claimed to have opened: emitting here would
    // toggle a Set entry the template can never act on.
    expect(emitted).toBeFalse();
  });

  it('clicking a run WITH steps emits its anchor id', (done) => {
    setInputs(
      makeState({ anchor_message_id: 'my-anchor', tools: [tool('c1', 'search_web')] }),
      false,
    );
    component.toggleExpanded.subscribe((id: string) => {
      expect(id).toBe('my-anchor');
      done();
    });
    (el().querySelector('.activity') as HTMLElement).click();
  });

  it('a known tool narrates itself; a contact names who was asked', () => {
    setTestTranslations({
      chat: {
        activity: {
          contactTitle: '<<asked:{{tool}}>>',
          tool: { hireMembers: '<<hired>>' },
        },
      },
    });
    setInputs(
      makeState({
        tools: [tool('c1', 'hire_members', true), contact('m1', '@Expert934')],
      }),
      true,
    );
    const entries = el().querySelectorAll('.activity-entry');
    // One sequence, two kinds — the reader should not be able to tell which
    // transport each step arrived on, only what the agent did.
    expect(entries.length).toBe(2);
    expect(entries[0].querySelector('.entry-title')?.textContent).toContain('<<hired>>');
    expect(entries[1].querySelector('.entry-title')?.textContent).toContain(
      '<<asked:@Expert934>>',
    );
    // The detail carries the particulars, not the title.
    expect(entries[1].querySelector('.entry-detail')?.textContent).toContain(
      'can you help',
    );
  });

  it('an unknown tool narrates with its own name rather than an apology', () => {
    setInputs(makeState({ tools: [tool('c1', 'customer_registered_thing')] }), true);
    // A framework cannot have copy for a tool a deployment invented. The name is
    // short and true, which beats "Unknown tool" and beats a raw dump.
    expect(el().querySelector('.entry-title')?.textContent).toContain(
      'customer_registered_thing',
    );
  });

  it('raw payloads are hidden until asked for, and reset when the fold closes', () => {
    setInputs(makeState({ tools: [tool('c1', 'hire_members')] }), true);
    expect(el().querySelector('.activity-raw')).toBeNull();

    (el().querySelector('.activity-raw-toggle') as HTMLElement).click();
    fixture.detectChanges();
    const raw = el().querySelector('.raw-line');
    expect(raw).not.toBeNull();
    expect(raw!.textContent).toContain('hire_members');
    expect(raw!.textContent).toContain('q=x');

    // Collapsing the fold puts the hatch back: a run that reopens should not
    // greet you with JSON you asked for three runs ago.
    (el().querySelector('.activity') as HTMLElement).click();
    fixture.componentRef.setInput('expanded', false);
    fixture.detectChanges();
    fixture.componentRef.setInput('expanded', true);
    fixture.detectChanges();
    expect(el().querySelector('.activity-raw')).toBeNull();
  });

  it('the raw toggle does not also collapse the fold', () => {
    let toggled = false;
    setInputs(makeState({ tools: [tool('c1', 'hire_members')] }), true);
    component.toggleExpanded.subscribe(() => (toggled = true));
    (el().querySelector('.activity-raw-toggle') as HTMLElement).click();
    expect(toggled).toBeFalse();
  });

  it('the collapsed row uses contact copy when the latest step is a contact', () => {
    setTestTranslations({
      chat: { activity: { latestContact: '<<contacting:{{tool}}>>' } },
    });
    setInputs(makeState({ tools: [contact('m1', '@Expert934')] }), false);
    expect(el().querySelector('.activity-latest')?.textContent).toContain(
      '<<contacting:@Expert934>>',
    );
  });

  it('trackByToolId returns the tool_call_id', () => {
    expect(component.trackByToolId(0, tool('call-9', 'foo'))).toBe('call-9');
  });
});
