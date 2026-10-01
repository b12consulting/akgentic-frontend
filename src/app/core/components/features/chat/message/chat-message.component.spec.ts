import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { provideMarkdown } from 'ngx-markdown';
import { MessageService } from 'primeng/api';

import { NOTIFICATION_PORT } from '../../../../platform/notification/notification.port';
import { PrimeNgNotificationAdapter } from '../../../../../ui/console/notification.adapter';
import { BehaviorSubject } from 'rxjs';
import { ConfigService } from '../../../../platform/config/config.service';
import { ChatMessageComponent } from './chat-message.component';
import { ChatMessage } from '../../../../services/process/selectors/chat-message.model';
import { isRateable } from '../../../../services/process/selectors/rateable';
import { Feedback, FeedbackService } from '../../../../services/process/ui-state/feedback.service';
import { ActorAddress } from '../../../../protocol/message.types';

import {
  provideTranslateTesting,
  setTestTranslations,
} from '../../../../../../testing/i18n-testing';

/**
 * Epic 57: the turn now embeds the rating control, which reaches for
 * `FeedbackService`. A double rather than the real thing — the real service
 * pulls in `MessageLogService` and `FetchService`, and none of the assertions
 * in this file are about feedback.
 */
function makeFeedbackServiceStub(feedbacks: Feedback[] = []) {
  return {
    feedbacks$: new BehaviorSubject<Feedback[]>(feedbacks),
    loadFeedback: () => Promise.resolve(),
    setFeedback: () => Promise.resolve(),
  } as unknown as FeedbackService;
}

function makeAddress(overrides: Partial<ActorAddress> = {}): ActorAddress {
  return {
    __actor_address__: true,
    name: '@Agent',
    role: 'Worker',
    agent_id: 'agent-1',
    squad_id: 'squad-1',
    user_message: false,
    ...overrides,
  };
}

function makeChatMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  const id = overrides.id ?? 'msg-1';
  return {
    id,
    message_id: id,
    parent_id: null,
    content: 'Hello world',
    sender: makeAddress({ name: '@Manager', role: 'Manager' }),
    recipient: makeAddress({ name: '@Human', role: 'Human' }),
    timestamp: new Date('2026-04-08T10:00:00Z'),
    rule: 2,
    alignment: 'left',
    color: '#9ebbcb',
    collapsed: false,
    label: 'Manager [Manager]',
    ...overrides,
  };
}

describe('ChatMessageComponent', () => {
  let component: ChatMessageComponent;
  let fixture: ComponentFixture<ChatMessageComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ChatMessageComponent, NoopAnimationsModule],
      providers: [
        provideTranslateTesting(),
        provideMarkdown(),
        // The turn's action row copies through `UtilService`, which confirms
        // with a PrimeNG toast — so the whole component tree now needs a
        // `MessageService` to construct, not just to copy. Provided at the bed
        // rather than stubbed: the real one is inert until something is added
        // to it, and nothing here adds.
        MessageService,
        // Story 53-1: `UtilService` reaches the toast surface through the port
        // now. The real adapter is the production wiring and is just as inert
        // as the real `MessageService` above it until something notifies.
        { provide: NOTIFICATION_PORT, useClass: PrimeNgNotificationAdapter },
        { provide: FeedbackService, useValue: makeFeedbackServiceStub() },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(ChatMessageComponent);
    component = fixture.componentInstance;
  });

  it('should create', () => {
    fixture.componentRef.setInput('message', makeChatMessage());
    fixture.detectChanges();
    expect(component).toBeTruthy();
  });

  describe('Rule 1 (user sends)', () => {
    it('should render right-aligned bubble', () => {
      const msg = makeChatMessage({
        rule: 1,
        alignment: 'right',
        color: '#efeeee',
        label: 'You ⇒ Manager',
      });
      fixture.componentRef.setInput('message', msg);
      fixture.detectChanges();

      const el = fixture.nativeElement;
      const bubble = el.querySelector('.message.right');
      expect(bubble).toBeTruthy();
      expect(el.querySelector('.collapsed-line')).toBeNull();
    });

    it('carries NO speaker label — the bubble on your side already says it', () => {
      const msg = makeChatMessage({ rule: 1, alignment: 'right', label: 'You' });
      fixture.componentRef.setInput('message', msg);
      fixture.detectChanges();

      // A label over your own words names the person reading them.
      expect(fixture.nativeElement.querySelector('.label-pill')).toBeNull();
    });
  });

  describe('Rule 2 (reply to @Human)', () => {
    it('should render left-aligned bubble', () => {
      const msg = makeChatMessage({ rule: 2, alignment: 'left' });
      fixture.componentRef.setInput('message', msg);
      fixture.detectChanges();

      const el = fixture.nativeElement;
      expect(el.querySelector('.message.left')).toBeTruthy();
    });

    it('renders the speaker\'s name as plain text, not a control', () => {
      const msg = makeChatMessage({ rule: 2, alignment: 'left' });
      fixture.componentRef.setInput('message', msg);
      fixture.detectChanges();

      // The name opens nothing (Epic 55 removed the reader it used to open), so
      // it must not be a button that promises otherwise.
      const pill: HTMLElement = fixture.nativeElement.querySelector('.label-pill');
      expect(pill.tagName).toBe('SPAN');
      expect(fixture.nativeElement.querySelector('.bubble-header button')).toBeNull();
    });
  });

  /**
   * A TURN IS NOT A BUTTON, and the cursor must not say it is.
   *
   * Rules 1 and 2 used to answer a click by emitting `bubbleClicked`, which the
   * panel recorded as `selectedMessageId`, which drew
   * `border: 2px solid var(--primary-color)` — a custom property this
   * application defines nowhere, so the declaration was invalid and nothing
   * appeared. Every ordinary turn in the conversation therefore carried a
   * pointer cursor promising a result no user could ever see.
   *
   * The one click this component still answers is the compaction marker's
   * fold (rule 6), pinned with the markers below.
   */
  describe('clicking a turn', () => {
    function messageEl(): HTMLElement {
      return fixture.nativeElement.querySelector('.message');
    }

    for (const rule of [1, 2] as const) {
      it(`leaves a rule-${rule} turn inert, cursor included`, () => {
        fixture.componentRef.setInput(
          'message',
          makeChatMessage({
            rule,
            alignment: rule === 1 ? 'right' : 'left',
          }),
        );
        fixture.detectChanges();

        spyOn(component.toggleCollapse, 'emit');

        // The POINTER is the half the user reads BEFORE clicking, so an inert
        // handler alone would not fix what they reported.
        expect(messageEl().classList.contains('clickable')).toBe(false);

        messageEl().click();
        expect(component.toggleCollapse.emit).not.toHaveBeenCalled();
      });
    }

    /**
     * RULES 3 AND 4 ARE NOT ROWS. A question to a human seat and traffic
     * between agents live in the run tree (Epic 55), which never hands them to
     * this component — and if one arrived anyway, it must not grow a bubble.
     */
    it('renders nothing for a rule-3 question or a rule-4 delegation', () => {
      for (const rule of [3, 4] as const) {
        fixture.componentRef.setInput('message', makeChatMessage({ rule, collapsed: false }));
        fixture.detectChanges();

        expect((fixture.nativeElement as HTMLElement).children.length)
          .withContext(`rule ${rule}`)
          .toBe(0);
      }
    });
  });

  describe('Rule 5 (welcome / system message) — Story 2.6', () => {
    function makeRule5(): ChatMessage {
      return makeChatMessage({
        rule: 5,
        alignment: 'left',
        color: '#9ebbcb',
        collapsed: false,
        label: 'System message',
        sender: makeAddress({ name: '@Orchestrator', role: 'Orchestrator' }),
        content: 'Welcome to the agent team !',
      });
    }

    it('renders as a centred rule, not as a turn', () => {
      fixture.componentRef.setInput('message', makeRule5());
      fixture.detectChanges();

      const el = fixture.nativeElement;
      // Nobody said it, so it gets no bubble, no side and no avatar. It is the
      // page telling you where you are.
      expect(el.querySelector('.system-rule')).toBeTruthy();
      expect(el.querySelector('.message-bubble')).toBeNull();
      expect(el.querySelector('.collapsed-line')).toBeNull();
    });

    it('shows its text in the rule', () => {
      fixture.componentRef.setInput('message', makeRule5());
      fixture.detectChanges();

      const label = fixture.nativeElement.querySelector('.system-rule-label');
      expect(label).not.toBeNull();
      expect(label.textContent.trim().length).toBeGreaterThan(0);
    });

    it('shows no bubble header, so nothing to act on', () => {
      fixture.componentRef.setInput('message', makeRule5());
      fixture.detectChanges();

      const el = fixture.nativeElement;
      expect(el.querySelector('.bubble-header')).toBeNull();
      expect(el.querySelector('button')).toBeNull();
    });

    it('is inert — there is no turn there to click', () => {
      fixture.componentRef.setInput('message', makeRule5());
      fixture.detectChanges();

      spyOn(component.toggleCollapse, 'emit');
      fixture.nativeElement.querySelector('.system-rule').click();

      expect(component.toggleCollapse.emit).not.toHaveBeenCalled();
    });
  });

  describe('Rule 5 with a BODY — a team\'s welcome message (W19b)', () => {
    /**
     * What "General Team" actually ships: a multi-paragraph markdown welcome,
     * arriving on rule 5 exactly like "Team started" does.
     *
     * Held as one fixture because all three of its properties matter and each
     * one alone would let a wrong implementation through: it has NEWLINES (a
     * flex row collapses them), it is LONG (a nowrap caption clips it), and it
     * is MARKDOWN (an interpolated caption shows the markup).
     */
    const WELCOME = [
      '## Welcome to the General Team',
      '',
      'I can help you with **research**, drafting and analysis.',
      '',
      'Ask me anything to get started.',
    ].join('\n');

    function makeWelcome(content: string): ChatMessage {
      return makeChatMessage({
        rule: 5,
        alignment: 'left',
        collapsed: false,
        label: 'System message',
        content,
      });
    }

    async function renderRule5(content: string): Promise<HTMLElement> {
      fixture.componentRef.setInput('message', makeWelcome(content));
      fixture.detectChanges();
      // `<markdown [data]>` parses in a promise, so the parsed HTML lands a
      // microtask after the binding does.
      await fixture.whenStable();
      fixture.detectChanges();
      return fixture.nativeElement as HTMLElement;
    }

    it('renders the welcome through the markdown pipeline, not as source text', async () => {
      const el = await renderRule5(WELCOME);

      const block = el.querySelector('.system-announcement');
      expect(block).withContext('a body needs a block, not a divider').not.toBeNull();
      expect(block!.querySelector('markdown')).not.toBeNull();
      // The proof that it was PARSED: `##` became a heading and `**bold**` an
      // emphasis element. An interpolated span would still contain the hashes.
      expect(block!.querySelector('h2')).not.toBeNull();
      expect(block!.querySelector('strong')).not.toBeNull();
      expect(el.textContent).not.toContain('##');
      expect(el.textContent).not.toContain('**');
    });

    it('keeps every paragraph — the divider collapsed them into one line', async () => {
      const el = await renderRule5(WELCOME);

      const paragraphs = el.querySelectorAll('.system-announcement p');
      expect(paragraphs.length).toBeGreaterThanOrEqual(2);
      expect(el.textContent).toContain('Ask me anything to get started.');
    });

    it('WRAPS: nothing in the block refuses to break a line', async () => {
      // The clipping half of the defect. `.system-rule-label` is
      // `white-space: nowrap`, so the welcome ran off the panel's edge; a block
      // that inherited that would look fixed and read identically.
      const el = await renderRule5(WELCOME);
      const block = el.querySelector('.system-announcement') as HTMLElement;

      expect(getComputedStyle(block).whiteSpace).not.toBe('nowrap');
      for (const node of Array.from(block.querySelectorAll('*'))) {
        expect(getComputedStyle(node as HTMLElement).whiteSpace)
          .withContext(`${(node as HTMLElement).tagName} must wrap`)
          .not.toBe('nowrap');
      }
    });

    it('is NOT a divider — the two treatments are mutually exclusive', async () => {
      const el = await renderRule5(WELCOME);

      expect(el.querySelector('.system-rule')).toBeNull();
      expect(el.querySelector('.system-rule-label')).toBeNull();
    });

    it('stays chrome: no bubble, no avatar, no rating, nothing to click', async () => {
      // Rule 5 is inert (ADR-011 Decision 3), and gaining a body must not have
      // turned it into a participant.
      const el = await renderRule5(WELCOME);
      spyOn(component.toggleCollapse, 'emit');

      (el.querySelector('.system-announcement') as HTMLElement).click();

      expect(el.querySelector('.message-bubble')).toBeNull();
      expect(el.querySelector('.turn-avatar')).toBeNull();
      expect(el.querySelector('app-feedback')).toBeNull();
      expect(component.toggleCollapse.emit).not.toHaveBeenCalled();
    });

    // --- where the line is drawn -----------------------------------------

    it('a short plain status line is still a DIVIDER', async () => {
      const el = await renderRule5('Team started');

      expect(el.querySelector('.system-rule')).not.toBeNull();
      expect(el.querySelector('.system-announcement')).toBeNull();
    });

    it('a trailing newline alone does not promote a status line to a block', async () => {
      // Whitespace is not a body. Trimming first is what keeps a backend that
      // terminates its lines from changing how they are drawn.
      const el = await renderRule5('Team started\n');

      expect(el.querySelector('.system-rule')).not.toBeNull();
    });

    it('pins the length threshold at 80 characters, on both sides of it', async () => {
      const eighty = 'x'.repeat(80);
      expect(eighty.length).toBe(80);

      const caption = await renderRule5(eighty);
      expect(caption.querySelector('.system-rule')).not.toBeNull();

      const body = await renderRule5(`${eighty}x`);
      expect(body.querySelector('.system-rule')).toBeNull();
      expect(body.querySelector('.system-announcement')).not.toBeNull();
    });

    it('a SHORT markdown announcement is a block, because a caption would leak its markup', async () => {
      // Eleven characters — it clears the length test comfortably, and
      // interpolated it reads as `**Welcome**`.
      const el = await renderRule5('**Welcome**');

      expect(el.querySelector('.system-announcement strong')).not.toBeNull();
      expect(el.textContent).not.toContain('**');
    });

    it('does not mistake ordinary punctuation for markdown', async () => {
      // A hyphen mid-sentence is punctuation. Treating it as a list bullet
      // would push ordinary status lines into the block treatment for nothing.
      const el = await renderRule5('Team started - 3 agents ready');

      expect(el.querySelector('.system-rule')).not.toBeNull();
    });
  });

  describe('Rule 2 label — @Sender ⇒ You (Story 4.3)', () => {
    it('renders label pill ending with "⇒ You" for Rule 2', () => {
      const msg = makeChatMessage({
        rule: 2,
        alignment: 'left',
        label: '@Manager ⇒ You',
      });
      fixture.componentRef.setInput('message', msg);
      fixture.detectChanges();

      const pill = fixture.nativeElement.querySelector('.label-pill');
      expect(pill).toBeTruthy();
      expect(pill.textContent.trim().endsWith('⇒ You')).toBe(true);
    });
  });

  describe('Expanded bubble header layout (Story 4.3)', () => {
    function makeExpanded(rule: 1 | 2): ChatMessage {
      return makeChatMessage({
        rule,
        alignment: rule === 1 ? 'right' : 'left',
        collapsed: false,
        label: rule === 1 ? 'You ⇒ @Manager' : '@Manager ⇒ You',
        timestamp: new Date('2026-04-08T10:45:00Z'),
      });
    }

    // RULE 1 IS EXCLUDED, and the spec below states why rather than the loop
    // quietly skipping it. Every other child of the header is already gated to
    // "not the user's own turn", so on rule 1 the header rendered as a lone
    // clock above the user's own words — which the redesign drops.
    for (const rule of [2] as const) {
      it(`Rule ${rule}: .bubble-header .bubble-timestamp exists and matches HH:mm`, () => {
        fixture.componentRef.setInput('message', makeExpanded(rule));
        fixture.detectChanges();

        const ts = fixture.nativeElement.querySelector(
          '.bubble-header .bubble-timestamp',
        );
        expect(ts).toBeTruthy();
        expect(ts.textContent.trim()).toMatch(/^\d{2}:\d{2}$/);
      });

      it(`Rule ${rule}: standalone .timestamp span removed`, () => {
        fixture.componentRef.setInput('message', makeExpanded(rule));
        fixture.detectChanges();

        const standalone = fixture.nativeElement.querySelectorAll(
          '.message-bubble > .timestamp',
        );
        expect(standalone.length).toBe(0);
      });
    }

    it('Rule 1 carries no header at all — nothing in it applies to a user turn', () => {
      fixture.componentRef.setInput('message', makeExpanded(1));
      fixture.detectChanges();

      const el: HTMLElement = fixture.nativeElement;
      expect(el.querySelector('.bubble-header')).toBeNull();
      expect(el.querySelector('.bubble-timestamp')).toBeNull();
      // The turn itself is emphatically still there — this is a header being
      // dropped, not a message.
      expect(el.querySelector('.message-bubble')).not.toBeNull();
    });

    /**
     * THE HEADER WENT; THE CLOCK CAME BACK ON ITS OWN TERMS.
     *
     * Dropping the header took the stamp with it, and that left the user's own
     * message as the ONE item in the transcript with no time on it — every
     * other row carries one. It returns UNDER the words instead of heading
     * them, which is the position that does not push the message down.
     */
    it('Rule 1 stamps the time after the words, not above them', () => {
      fixture.componentRef.setInput('message', makeExpanded(1));
      fixture.detectChanges();

      const el: HTMLElement = fixture.nativeElement;
      const stamp = el.querySelector('.own-timestamp');

      expect(stamp).not.toBeNull();
      expect(stamp!.textContent!.trim()).toMatch(/^\d{2}:\d{2}$/);

      // After the words, in document order — the whole point of the position.
      const body = el.querySelector('.own-text')!;
      expect(
        body.compareDocumentPosition(stamp!) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    /** And it belongs to the user's own turn alone: an agent's turn states
     *  the time in its header, and two clocks on one row is a defect. */
    for (const rule of [2] as const) {
      it(`Rule ${rule} carries no trailing stamp — its header already has one`, () => {
        fixture.componentRef.setInput('message', makeExpanded(rule));
        fixture.detectChanges();

        expect(fixture.nativeElement.querySelector('.own-timestamp')).toBeNull();
      });
    }

    it('Rule 1 renders the user\'s words as text, never through markdown', () => {
      // A `#` a user typed is a `#`, not a heading. Rendering their own typing
      // through the markdown pipeline silently rewrites it and gives them no
      // way to escape it.
      fixture.componentRef.setInput(
        'message',
        makeChatMessage({
          rule: 1,
          alignment: 'right',
          content: '# not a heading\n* not a bullet',
        }),
      );
      fixture.detectChanges();

      const el: HTMLElement = fixture.nativeElement;
      expect(el.querySelector('markdown')).toBeNull();
      const own = el.querySelector('.own-text');
      expect(own).not.toBeNull();
      expect(own!.textContent).toBe('# not a heading\n* not a bullet');
    });

    it('an agent turn still goes through markdown', () => {
      // The counterpart to the spec above: the change is scoped to the one rule
      // whose author is the user, and must not quietly turn the transcript into
      // plain text.
      fixture.componentRef.setInput('message', makeExpanded(2));
      fixture.detectChanges();

      const el: HTMLElement = fixture.nativeElement;
      expect(el.querySelector('.markdown-content markdown')).not.toBeNull();
      expect(el.querySelector('.own-text')).toBeNull();
    });

    it('Rule 2: .bubble-timestamp is the last element child of .bubble-header', () => {
      fixture.componentRef.setInput('message', makeExpanded(2));
      fixture.detectChanges();

      const header = fixture.nativeElement.querySelector('.bubble-header');
      expect(header).toBeTruthy();
      expect(header.lastElementChild.classList.contains('bubble-timestamp')).toBe(true);
    });
  });

  describe('Rule 6/7 context-management markers (Epic 29 / ADR-010)', () => {
    function makeCompactionMarker(collapsed = true): ChatMessage {
      return makeChatMessage({
        id: 'evt-1',
        rule: 6,
        alignment: 'left',
        color: '',
        collapsed,
        label: 'Summarized 8 messages',
        content: 'the summary text body',
      });
    }

    function makeClearMarker(): ChatMessage {
      return makeChatMessage({
        id: 'evt-2',
        rule: 7,
        alignment: 'left',
        color: '',
        collapsed: false,
        label: 'Conversation cleared (5 messages)',
        content: '',
      });
    }

    it('compaction marker renders a .system-marker row with the count label + icon, not a bubble', () => {
      fixture.componentRef.setInput('message', makeCompactionMarker());
      fixture.detectChanges();

      const el = fixture.nativeElement;
      expect(el.querySelector('.system-marker')).toBeTruthy();
      expect(el.querySelector('.system-marker-icon')).toBeTruthy();
      expect(el.querySelector('.system-marker-label').textContent).toContain(
        'Summarized 8 messages',
      );
      // A marker is NOT a chat bubble.
      expect(el.querySelector('.message-bubble')).toBeNull();
      expect(el.querySelector('.collapsed-line')).toBeNull();
    });

    it('collapsed compaction marker hides the summary body but shows a caret', () => {
      fixture.componentRef.setInput('message', makeCompactionMarker(true));
      fixture.detectChanges();

      const el = fixture.nativeElement;
      expect(el.querySelector('.system-marker-summary')).toBeNull();
      expect(el.querySelector('.system-marker-caret')).toBeTruthy();
    });

    it('expanded compaction marker reveals the summary body (markdown)', () => {
      fixture.componentRef.setInput('message', makeCompactionMarker(false));
      fixture.detectChanges();

      const summary = fixture.nativeElement.querySelector('.system-marker-summary');
      expect(summary).toBeTruthy();
      expect(summary.querySelector('markdown')).toBeTruthy();
    });

    it('clicking the compaction line emits toggleCollapse', () => {
      const msg = makeCompactionMarker(true);
      fixture.componentRef.setInput('message', msg);
      fixture.detectChanges();

      spyOn(component.toggleCollapse, 'emit');
      fixture.nativeElement.querySelector('.system-marker-line').click();
      expect(component.toggleCollapse.emit).toHaveBeenCalledWith(msg);
    });

    it('clear marker renders the cleared line — no caret, no summary, no bubble', () => {
      fixture.componentRef.setInput('message', makeClearMarker());
      fixture.detectChanges();

      const el = fixture.nativeElement;
      expect(el.querySelector('.system-marker')).toBeTruthy();
      expect(el.querySelector('.system-marker-label').textContent).toContain(
        'Conversation cleared (5 messages)',
      );
      expect(el.querySelector('.system-marker-caret')).toBeNull();
      expect(el.querySelector('.system-marker-summary')).toBeNull();
      expect(el.querySelector('.message-bubble')).toBeNull();
    });

    it('clicking the clear marker line is inert — does NOT emit toggleCollapse', () => {
      fixture.componentRef.setInput('message', makeClearMarker());
      fixture.detectChanges();

      spyOn(component.toggleCollapse, 'emit');
      fixture.nativeElement.querySelector('.system-marker-line').click();
      expect(component.toggleCollapse.emit).not.toHaveBeenCalled();
    });

    it('markers render no label-pill', () => {
      fixture.componentRef.setInput('message', makeCompactionMarker());
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('.label-pill')).toBeNull();
    });
  });
  // --- hideAgentNames -------------------------------------------------------
  //
  // A deployment can present the team as ONE assistant rather than a cast. The
  // framework shows the identity by default; this hides it and nothing else.
  describe('hideAgentNames', () => {
    /**
     * Rebuild the bed with the flag set.
     *
     * `showAgentNames` is read once in a field initialiser, so the config has to
     * be in place BEFORE the component is constructed — setting it on an
     * existing fixture would change nothing and the spec would pass for the
     * wrong reason.
     */
    async function renderWith(hideAgentNames: boolean, message: ChatMessage) {
      TestBed.resetTestingModule();
      await TestBed.configureTestingModule({
        imports: [ChatMessageComponent, NoopAnimationsModule],
        providers: [
          provideTranslateTesting(),
          provideMarkdown(),
          MessageService,
          // Story 53-1: `UtilService` reaches the toast surface through the port
          // now. The real adapter is the production wiring and is just as inert
          // as the real `MessageService` above it until something notifies.
          { provide: NOTIFICATION_PORT, useClass: PrimeNgNotificationAdapter },
          { provide: ConfigService, useValue: { hideAgentNames } },
          { provide: FeedbackService, useValue: makeFeedbackServiceStub() },
        ],
      }).compileComponents();
      const f = TestBed.createComponent(ChatMessageComponent);
      f.componentRef.setInput('message', message);
      f.detectChanges();
      return f;
    }

    it('shows the identity pill by DEFAULT — the framework names its agents', async () => {
      const f = await renderWith(false, makeChatMessage({ label: 'Manager ⇒ You' }));
      const pill = f.nativeElement.querySelector('.label-pill');
      expect(pill).withContext('label pill must render by default').not.toBeNull();
      expect(pill.textContent.trim()).toBe('Manager ⇒ You');
    });

    it('removes the identity pill when hidden', async () => {
      const f = await renderWith(true, makeChatMessage({ label: 'Manager ⇒ You' }));
      expect(f.nativeElement.querySelector('.label-pill')).toBeNull();
      // The identity must not survive anywhere else in the bubble either.
      expect(f.nativeElement.textContent).not.toContain('Manager');
    });

    it('KEEPS the system label, which names no agent', async () => {
      // Rule 5 says "this came from the system". Hiding it would remove
      // information without hiding an identity, so the flag does not apply.
      const f = await renderWith(
        true,
        makeChatMessage({ rule: 5, label: 'SYSTEM', alignment: 'left' }),
      );
      // The intent is unchanged — the system line still shows when agent names
      // are hidden, because it names no agent. It just is not a pill any more:
      // rule 5 renders as a rule, and the rule is unconditional.
      const rule = f.nativeElement.querySelector('.system-rule-label');
      expect(rule).withContext('system line is not an agent name').not.toBeNull();
    });

    it('does not leak the agent\'s initial through the turn avatar', async () => {
      // The avatar's monogram is taken from `label` — the same string the pill
      // renders. Hiding the pill and keeping the monogram hides the name from a
      // reader and not from an observer, which is not what the flag promises.
      const f = await renderWith(
        true,
        makeChatMessage({ rule: 2, alignment: 'left', label: 'Manager ⇒ You' }),
      );

      const avatar = f.nativeElement.querySelector('.turn-avatar');
      expect(avatar).withContext('the gutter mark still holds its column').not.toBeNull();
      expect(avatar.textContent.trim()).toBe('·');
    });

    it('still shows the initial by DEFAULT — the framework names its agents', async () => {
      const f = await renderWith(
        false,
        makeChatMessage({ rule: 2, alignment: 'left', label: 'Manager ⇒ You' }),
      );

      expect(
        f.nativeElement.querySelector('.turn-avatar').textContent.trim(),
      ).toBe('M');
    });

    it('leaves alignment and colour alone — only the identity goes', async () => {
      const msg = makeChatMessage({ rule: 1, alignment: 'right', color: '#efeeee' });
      const f = await renderWith(true, msg);
      const bubble = f.nativeElement.querySelector('.message-bubble');
      expect(bubble).withContext('a bubble still renders').not.toBeNull();
      // Hiding WHO said it must not change WHERE or HOW it is drawn: the
      // conversation stays readable without the identity.
      expect(bubble.style.backgroundColor).toBe('rgb(239, 238, 238)');
      expect(f.nativeElement.querySelector('.right')).not.toBeNull();
    });
  });

  // --- The conversation surface --------------------------------------------
  //
  // The agent's turns carry no bubble; the user's own turn does. That contrast
  // is the whole design, and it is invisible to every other spec in this file —
  // they assert content and structure, never fill. Without these, re-tinting
  // rules 2-4 would pass the suite and silently undo it.
  describe('turn surface', () => {
    it('gives the USER\'s own turn a fill and a radius', () => {
      fixture.componentRef.setInput(
        'message',
        makeChatMessage({ rule: 1, alignment: 'right', color: 'var(--akg-surface)' }),
      );
      fixture.detectChanges();

      const bubble = fixture.nativeElement.querySelector('.message-bubble');
      expect(bubble.classList).withContext('own turn is marked').toContain('own-turn');
    });

    it('leaves an AGENT turn unmarked, so it renders flat', () => {
      for (const rule of [2] as const) {
        fixture.componentRef.setInput(
          'message',
          makeChatMessage({ rule, collapsed: false, color: 'transparent' }),
        );
        fixture.detectChanges();

        const bubble = fixture.nativeElement.querySelector('.message-bubble');
        expect(bubble.classList)
          .withContext(`rule ${rule} must not be an own turn`)
          .not.toContain('own-turn');
      }
    });
  });

  describe('unparseable timestamp (Epic 54 FR5)', () => {
    it('renders the turn instead of throwing', () => {
      // `classifyMessage` builds `timestamp` with `new Date(...)`, so a
      // malformed backend string arrives here as an Invalid Date. DatePipe
      // throws on one; a single bad row must not take the transcript with it.
      fixture.componentRef.setInput(
        'message',
        makeChatMessage({ timestamp: new Date('not a date'), content: 'still here' }),
      );
      expect(() => fixture.detectChanges()).not.toThrow();

      const el: HTMLElement = fixture.nativeElement;
      expect(el.querySelector('.message-bubble')).not.toBeNull();
      expect(el.querySelector('.bubble-timestamp')!.textContent!.trim()).toBe('');
    });

    it('renders a marker row with an unparseable timestamp', () => {
      fixture.componentRef.setInput(
        'message',
        makeChatMessage({ rule: 6, collapsed: true, timestamp: new Date(NaN) }),
      );
      expect(() => fixture.detectChanges()).not.toThrow();

      const el: HTMLElement = fixture.nativeElement;
      expect(el.querySelector('.system-marker')).not.toBeNull();
      expect(el.querySelector('.system-marker-timestamp')!.textContent!.trim()).toBe('');
    });

    it('still shows the time for a parseable one', () => {
      fixture.componentRef.setInput('message', makeChatMessage());
      fixture.detectChanges();

      const el: HTMLElement = fixture.nativeElement;
      expect(el.querySelector('.bubble-timestamp')!.textContent!.trim()).not.toBe('');
    });
  });


  // --- the rating control (Epic 57) ------------------------------------------
  //
  // These specs pin the WIRING, not the rule: which turns get a control, and
  // that the control does not hijack the click the bubble already owned. The
  // rule itself is pinned case-by-case in `selectors/rateable.spec.ts` — asked
  // here rather than restated, exactly as the template asks rather than
  // restates it.
  describe('rating control', () => {
    function renderRule(rule: ChatMessage['rule']) {
      fixture.componentRef.setInput(
        'message',
        makeChatMessage({ rule, collapsed: false }),
      );
      fixture.detectChanges();
      return fixture.nativeElement.querySelector('app-feedback');
    }

    it('renders the control on an agent turn', () => {
      for (const rule of [2] as const) {
        expect(renderRule(rule))
          .withContext(`rule ${rule} is an answer and must be rateable`)
          .not.toBeNull();
      }
    });

    it('renders NO control on a turn the rule excludes', () => {
      for (const rule of [1, 5, 6, 7] as const) {
        expect(renderRule(rule))
          .withContext(`rule ${rule} must carry no rating control`)
          .toBeNull();
      }
    });

    it('agrees with the predicate for every rule it renders', () => {
      // The point of FR1: one answer, not two that drift. If this ever fails,
      // the template has started deciding for itself. Rules 3 and 4 are left
      // out: this component does not render them (the run tree does).
      for (const rule of [1, 2, 5, 6, 7] as const) {
        const rendered = renderRule(rule) !== null;
        expect(rendered)
          .withContext(`rule ${rule}`)
          .toBe(isRateable(makeChatMessage({ rule })));
      }
    });

    /*
     * DELETED: 'does not select the turn when the control is clicked'.
     *
     * It guarded the rating control's click against reaching the turn behind
     * it and selecting the message. There is no selection any more, and the
     * turns the control renders on — the rateable ones, rule 2 — are inert, so
     * there is nothing left for the click to escape into. The template still
     * stops the event; what is gone is the thing it was stopping it from.
     */

    it('keeps the control inside the turn it rates', () => {
      // Not a cosmetic assertion: a control rendered as a sibling of the
      // bubble would sit outside the hover target that reveals it, and would
      // be permanently invisible.
      renderRule(2);
      const bubble = fixture.nativeElement.querySelector('.message-bubble');
      expect(bubble.querySelector('app-feedback')).not.toBeNull();
    });
  });

  /**
   * WHERE THE USER'S MESSAGE WENT — on the turns where that is not obvious.
   *
   * Two identical "Hello" bubbles three minutes apart went to two different
   * agents and rendered the same. The only cue available was the name on the
   * reply below, and that inference is wrong exactly when the team does the
   * interesting thing: address @Manager, watch it delegate, read @Expert.
   *
   * The three-way rule is the whole design, and the SILENT arm is the one worth
   * guarding hardest: a label that appears on every turn is a label nobody
   * reads by the fourth one, which would cost precisely the turns it exists for.
   */
  describe('the recipient on the user\'s own turn', () => {
    function ownTurnTo(recipient: string, theDefault: string | null): void {
      fixture.componentRef.setInput(
        'message',
        makeChatMessage({
          rule: 1,
          alignment: 'right',
          recipient: makeAddress({ name: recipient }),
        }),
      );
      fixture.componentRef.setInput('defaultRecipient', theDefault);
      fixture.detectChanges();
    }

    function shown(): string | null {
      const el = fixture.nativeElement.querySelector('.own-recipient');
      return el ? el.textContent.replace(/\s+/g, ' ').trim() : null;
    }

    it('names an agent the user chose over the default', () => {
      ownTurnTo('@Expert', '@Manager');
      expect(shown()).toContain('@Expert');
    });

    it('says nothing when the message went to the default', () => {
      ownTurnTo('@Manager', '@Manager');
      expect(shown()).toBeNull();
    });

    /** No roster yet is not "not the default" — it is "we do not know", and a
     *  guess here would caption every turn during startup. */
    it('says nothing while the default is still unknown', () => {
      ownTurnTo('@Expert', null);
      expect(shown()).toBeNull();
    });

    it('says nothing on the entry point itself', () => {
      ownTurnTo('@Human', '@Manager');
      expect(shown()).toBeNull();
    });

    /** An agent's turn already names its speaker in the header; a second
     *  address on it would be describing the wrong direction. */
    for (const rule of [2] as const) {
      it(`says nothing on a rule-${rule} turn, which is not the user's`, () => {
        fixture.componentRef.setInput(
          'message',
          makeChatMessage({ rule, recipient: makeAddress({ name: '@Expert' }) }),
        );
        fixture.componentRef.setInput('defaultRecipient', '@Manager');
        fixture.detectChanges();

        expect(shown()).toBeNull();
      });
    }

    /** The arrow is for the eye. "right-arrow at Expert" is not a sentence, so
     *  the accessible name carries the same fact in words. */
    it('states it in words for a screen reader, not as a glyph', () => {
      setTestTranslations({ chat: { sentTo: '<<to:{{agent}}>>' } });
      ownTurnTo('@Expert', '@Manager');

      const el = fixture.nativeElement.querySelector('.own-recipient');
      expect(el.getAttribute('aria-label')).toBe('<<to:@Expert>>');
      expect(el.querySelector('[aria-hidden="true"]')).not.toBeNull();
    });
  });
});
