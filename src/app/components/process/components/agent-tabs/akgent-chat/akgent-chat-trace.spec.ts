import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { BehaviorSubject, Observable, of } from 'rxjs';

import { AkgentChatComponent } from './akgent-chat.component';
import { ApiService } from '../../../../../core/http/api.service';
import { UtilService } from '../../../../../core/ui/utils.service';
import { ContextService } from '../../../../../core/context/context.service';
import { IngestionService } from '../../../../../features/process/event/ingestion.service';
import { MessageLogService } from '../../../../../features/process/event/message-log.service';
import { PerAgentStoreRegistry } from '../../../../../features/process/event/per-agent-store';
import {
  SystemPromptSelector,
  SystemPromptValue,
  systemPromptMatch,
  systemPromptReduce,
} from '../../../../../features/process/selectors/system-prompt.selector';
import { TokenUsageSelector } from '../../../../../features/process/selectors/token-usage.selector';
import { AgentTokenUsage } from '../../../../../features/process/event/per-agent-specs';
import { provideTranslateTesting } from '../../../../../../testing/i18n-testing';

/**
 * THE MEMBER PANE'S SHAPE, after it came off the library chrome.
 *
 * What is pinned here is not the styling — that is the stylesheet's business
 * and a spec asserting padding would pin the design rather than the behaviour.
 * It is the three things a redesign can quietly undo and nothing else was
 * watching: that the trace says each fact ONCE, that every word the pane shows
 * the user comes through a translation key, and that the composer names the
 * member rather than naming itself.
 */
describe('AkgentChatComponent — the trace, in the console\'s language', () => {
  const AGENT = 'a-mgr';

  function setup(): {
    fixture: ComponentFixture<AkgentChatComponent>;
    component: AkgentChatComponent;
  } {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [AkgentChatComponent],
      providers: [
        provideTranslateTesting(),
        {
          provide: ApiService,
          useValue: { sendMessage: jasmine.createSpy('sendMessage') },
        },
        {
          provide: UtilService,
          useValue: {
            copyToClipboard: () => {},
            // The real service pretty-prints; identity is enough here and keeps
            // the assertions about the MARKUP rather than about JSON spacing.
            formatJSON: (value: unknown) => String(value),
          },
        },
        {
          provide: ContextService,
          useValue: {
            currentTeamRunning$: new BehaviorSubject<boolean>(true),
            currentProcessId$: new BehaviorSubject<string>('proc-1'),
          },
        },
        MessageLogService,
        PerAgentStoreRegistry,
        {
          provide: IngestionService,
          useFactory: (registry: PerAgentStoreRegistry) => ({
            commands: { snapshot: (_id: string) => undefined },
            systemPrompt: registry.register<SystemPromptValue>({
              name: 'systemPrompt',
              match: systemPromptMatch,
              reduce: systemPromptReduce,
            }),
          }),
          deps: [PerAgentStoreRegistry],
        },
        SystemPromptSelector,
        {
          provide: TokenUsageSelector,
          useValue: {
            perAgent$: (_id: string): Observable<AgentTokenUsage | undefined> =>
              of(undefined),
          },
        },
        provideNoopAnimations(),
      ],
    });

    const fixture = TestBed.createComponent(AkgentChatComponent);
    const component = fixture.componentInstance;
    component.context$ = new BehaviorSubject<unknown[]>([]) as BehaviorSubject<
      any[]
    >;
    component.agentId = AGENT;
    component.agentName = '@Manager';
    return { fixture, component };
  }

  function html(fixture: ComponentFixture<AkgentChatComponent>): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  /**
   * The WIRE shape, not the projected row. `updateContext` is the projection —
   * feeding it its own output would test nothing, and a tool call only acquires
   * a result by being matched to the `tool-return` part that answers it.
   */
  function toolCallExchange(result: string | null = 'three hits'): unknown[] {
    const call = {
      kind: 'response',
      parts: [
        {
          part_kind: 'tool-call',
          tool_name: 'search_knowledge',
          args: { query: 'payroll' },
          tool_call_id: 'tc-1',
        },
      ],
    };
    if (result === null) return [call];
    return [
      call,
      {
        kind: 'request',
        parts: [
          { part_kind: 'tool-return', tool_call_id: 'tc-1', content: result },
        ],
      },
    ];
  }

  function aiTurn(text: string): unknown {
    return { kind: 'response', parts: [{ part_kind: 'text', content: text }] };
  }

  /**
   * A TOOL CALL NAMED ITS TOOL THREE TIMES.
   *
   * The old markup put `message.name` in the card header, then wrapped the call
   * in a `<p-fieldset legend="Tool">` whose entire body was `{{ message.name }}`
   * again — a bordered box, a legend and a line, to restate the string directly
   * above it. In a 278px lane that is a third of the card's height spent on a
   * repeat. This fails on the old template (two occurrences) and passes on the
   * new one.
   */
  it('names the tool once, not once per box that could hold it', () => {
    const { fixture, component } = setup();
    component.context$.next(toolCallExchange() as any[]);
    fixture.detectChanges();

    const entry = html(fixture).querySelector('.collapsible-container .card-container');
    expect(entry).not.toBeNull();

    const occurrences = (entry!.textContent ?? '').split('search_knowledge').length - 1;
    expect(occurrences)
      .withContext('the tool name should appear in the header and nowhere else')
      .toBe(1);
  });

  it('keeps what was asked and what came back, each under its own label', () => {
    const { fixture, component } = setup();
    component.context$.next(toolCallExchange() as any[]);
    fixture.detectChanges();

    const labels = Array.from(
      html(fixture).querySelectorAll('.entry-well-label'),
    ).map((n) => (n.textContent ?? '').trim());

    // Keys, not copy: under the no-op loader a key renders back as itself, so
    // an assertion here cannot accidentally pin English.
    expect(labels).toEqual(['inspector.trace.args', 'inspector.trace.result']);
    expect(html(fixture).textContent).toContain('three hits');
  });

  it('omits the result well entirely when the call has not returned', () => {
    const { fixture, component } = setup();
    component.context$.next(toolCallExchange(null) as any[]);
    fixture.detectChanges();

    const labels = Array.from(
      html(fixture).querySelectorAll('.entry-well-label'),
    ).map((n) => (n.textContent ?? '').trim());
    expect(labels).toEqual(['inspector.trace.args']);
  });

  /**
   * The header is two elements, and which is which is structural rather than
   * punctuational. A future edit that collapses them back into one interpolated
   * `"Ai : @Manager"` string fails here.
   */
  it('separates the wire kind from the member name', () => {
    const { fixture, component } = setup();
    component.context$.next([aiTurn('on it')] as any[]);
    fixture.detectChanges();

    const header = html(fixture).querySelector('.collapsible-container .card-header');
    expect(header?.querySelector('.entry-kind')?.textContent?.trim()).toBe('Ai');
    expect(header?.querySelector('.entry-name')?.textContent?.trim()).toBe(
      'Assistant',
    );
    // The colon was punctuation doing a label's job. It should be gone, not
    // moved into one of the two spans.
    expect(header?.textContent).not.toContain(':');
  });

  /**
   * NO LIBRARY CHROME LEFT IN THE TRACE.
   *
   * A `<p-table>` with no header row, no columns and no sort was supplying
   * nothing but a ground and a border, and a `<p-fieldset>` per message was
   * legending the content "Content". Both are gone; asserting their absence is
   * what stops one being reached for again the next time a row needs a box.
   */
  it('draws the trace itself rather than borrowing a table and a fieldset per message', () => {
    const { fixture, component } = setup();
    component.context$.next([
      aiTurn('on it'),
      ...toolCallExchange(),
    ] as any[]);
    fixture.detectChanges();

    const el = html(fixture);
    expect(el.querySelector('table')).toBeNull();
    expect(el.querySelector('fieldset')).toBeNull();
    expect(el.querySelector('legend')).toBeNull();
    // Two messages, two cards.
    expect(
      el.querySelectorAll('.collapsible-container .card-container').length,
    ).toBe(2);
  });

  /**
   * THE COMPOSER NAMES THE MEMBER.
   *
   * Its caption was the string "Chat input" in a `<p-floatlabel>` — interface
   * describing itself, in English, over a control whose purpose the Send button
   * beside it already gives away. What the user does not know by looking is
   * WHICH of the team this box talks to.
   */
  it('asks the user to message the member, in their own language', () => {
    const { fixture } = setup();
    fixture.detectChanges();

    const textarea = html(fixture).querySelector('textarea');
    expect(textarea).not.toBeNull();
    expect(textarea!.getAttribute('placeholder')).toBe(
      'chat.reader.composer.placeholder',
    );
    expect(textarea!.getAttribute('aria-label')).toBe(
      'chat.reader.composer.placeholder',
    );
    expect(html(fixture).textContent).not.toContain('Chat input');
  });

  it('labels its send control through a key rather than the word "Submit"', () => {
    const { fixture } = setup();
    fixture.detectChanges();

    const send = html(fixture).querySelector('.send-button');
    expect(send).not.toBeNull();
    expect((send!.textContent ?? '').trim()).toBe('chat.input.send');
    expect(html(fixture).textContent).not.toContain('Submit');
  });

  /**
   * The follow-mode pill's two sentences were the last untranslated copy in the
   * pane. They are keys the main transcript already shipped, so this is reuse
   * rather than new copy — and `indicatorIcon` still has to agree with whichever
   * one is set, which is the half a rename would break silently.
   */
  it('carries the follow-mode state as a key, and keeps the glyph in step with it', () => {
    const { fixture, component } = setup();
    fixture.detectChanges();

    component.indicatorLabel = AkgentChatComponent.FOLLOWING_KEY;
    expect(component.indicatorLabel).toBe('chat.autoScrolling');
    expect(component.indicatorIcon).toBe('pi-sync');

    component.indicatorLabel = AkgentChatComponent.BEHIND_KEY;
    expect(component.indicatorLabel).toBe('chat.messages');
    expect(component.indicatorIcon).toBe('pi-arrow-down');
  });
});
