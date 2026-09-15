import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { provideMarkdown } from 'ngx-markdown';
import { MessageService } from 'primeng/api';
import { BehaviorSubject } from 'rxjs';
import { ConfigService } from '../../../../core/config/config.service';
import { ChatMessageComponent } from './chat-message.component';
import { ChatMessage } from '../../../../features/process/selectors/chat-message.model';
import { isRateable } from '../../../../features/process/selectors/rateable';
import { Feedback, FeedbackService } from '../../../../features/process/ui-state/feedback.service';
import { ActorAddress } from '../../../../protocol/message.types';

import {
  provideTranslateTesting,
  setTestTranslations,
} from '../../../../../testing/i18n-testing';

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

    it('should enable label pill', () => {
      const msg = makeChatMessage({ rule: 2, alignment: 'left' });
      fixture.componentRef.setInput('message', msg);
      fixture.detectChanges();

      const btn = fixture.nativeElement.querySelector('.label-pill');
      expect(btn.disabled).toBe(false);
    });
  });

  describe('Rule 3 (notification + collapse + Reply button)', () => {
    it('should show hand-raised icon (🙋) on expanded bubble when notification is true', () => {
      const msg = makeChatMessage({
        rule: 3,
        alignment: 'left',
        collapsed: false,
        label: 'Agent ⇒ OtherHuman',
      });
      fixture.componentRef.setInput('message', msg);
      fixture.componentRef.setInput('notification', true);
      fixture.detectChanges();

      const el = fixture.nativeElement;
      const icon = el.querySelector('.notification-icon');
      expect(icon).toBeTruthy();
      expect(icon.textContent).toContain('🙋');
      // Bell icon must NOT be present anywhere for Rule 3
      expect(el.querySelector('.pi-bell')).toBeNull();
    });

    it('should NOT show hand-raised icon when notification input is false', () => {
      const msg = makeChatMessage({
        rule: 3,
        alignment: 'left',
        collapsed: false,
        label: 'Agent ⇒ OtherHuman',
      });
      fixture.componentRef.setInput('message', msg);
      fixture.componentRef.setInput('notification', false);
      fixture.detectChanges();

      const el = fixture.nativeElement;
      expect(el.querySelector('.notification-icon')).toBeNull();
      expect(el.querySelector('.pi-bell')).toBeNull();
    });

    it('renders the folded request as a CALLOUT, not as a metadata row', () => {
      // W2a: the one message in the transcript that is blocked on the user used
      // to be its least legible row. The callout is the assertion that it is
      // now the loudest: the asking agent's avatar in the transcript's gutter,
      // so it still belongs to the conversation rather than floating beside it.
      const msg = makeChatMessage({
        rule: 3,
        collapsed: true,
        label: 'Agent ⇒ OtherHuman',
      });
      fixture.componentRef.setInput('message', msg);
      fixture.detectChanges();

      const el = fixture.nativeElement;
      expect(el.querySelector('.collapsed-request')).toBeTruthy();
      expect(el.querySelector('.collapsed-notice'))
        .withContext('a request is not a notification')
        .toBeNull();
      expect(el.querySelector('.message-bubble')).toBeNull();
      expect(el.querySelector('.collapsed-request .turn-avatar')).toBeTruthy();
    });

    it('names the seat being asked in words, outside any bracket', () => {
      // The recipient used to be the second half of `[@Manager ⇒ @Support]`,
      // which is where a reader stops looking. Synthetic template, so the
      // assertion is about the parameter reaching the phrase, not about copy.
      setTestTranslations({
        chat: { request: { asks: '<<asks:{{agent}}>>' } },
      });
      const msg = makeChatMessage({
        rule: 3,
        collapsed: true,
        sender: makeAddress({ name: '@Manager', role: 'Manager' }),
        recipient: makeAddress({ name: '@Support', role: 'Human' }),
      });
      fixture.componentRef.setInput('message', msg);
      fixture.detectChanges();

      const head = fixture.nativeElement.querySelector('.request-asks');
      const text = head.textContent.replace(/\s+/g, ' ');
      expect(text).toContain('@Manager');
      expect(text).toContain('<<asks:@Support>>');
      expect(text).withContext('bracket soup is gone').not.toContain('[');
      expect(text).not.toContain('⇒');
    });

    it('shows the question as prose, not clipped to sixty characters', () => {
      // The old row ran `buildPreview` at its 60-char default, which on a real
      // request is reliably the polite preamble and none of the question.
      const question =
        'Could you double-check whether the payroll export for March already ' +
        'includes the retroactive corrections we applied last week?';
      const msg = makeChatMessage({ rule: 3, collapsed: true, content: question });
      fixture.componentRef.setInput('message', msg);
      fixture.detectChanges();

      const body = fixture.nativeElement.querySelector('.request-body');
      expect(body.textContent.trim()).toBe(question);
      expect(body.textContent).not.toContain('...');
    });

    it('says PENDING while it waits and ANSWERED once it is resolved', () => {
      const msg = makeChatMessage({ rule: 3, collapsed: true });
      fixture.componentRef.setInput('message', msg);
      fixture.componentRef.setInput('notification', true);
      fixture.detectChanges();

      const state = () => fixture.nativeElement.querySelector('.request-state');
      expect(state().textContent).toContain('chat.request.pending');

      fixture.componentRef.setInput('notification', false);
      fixture.detectChanges();
      expect(state().textContent).toContain('chat.request.answered');
    });

    it('RECEDES once answered — the resolved request stops shouting', () => {
      // The accent card is the "something is waiting on you" signal. A request
      // that has been answered keeps its text and its fold but must give the
      // signal back, or a day-old conversation is a wall of callouts.
      const msg = makeChatMessage({ rule: 3, collapsed: true });
      fixture.componentRef.setInput('message', msg);
      fixture.componentRef.setInput('notification', true);
      fixture.detectChanges();

      const row = fixture.nativeElement.querySelector('.collapsed-request');
      expect(row.classList.contains('answered')).toBe(false);

      fixture.componentRef.setInput('notification', false);
      fixture.detectChanges();
      expect(row.classList.contains('answered')).toBe(true);
      expect(fixture.nativeElement.querySelector('.request-body'))
        .withContext('receding is not hiding')
        .toBeTruthy();
    });

    it('drops the 🙋 — the state is stated in words, not encoded in an emoji', () => {
      const msg = makeChatMessage({ rule: 3, collapsed: true });
      fixture.componentRef.setInput('message', msg);
      fixture.componentRef.setInput('notification', true);
      fixture.detectChanges();

      const row = fixture.nativeElement.querySelector('.collapsed-request');
      expect(row.textContent).not.toContain('🙋');
    });

    it('should render Reply button on collapsed Rule 3 line', () => {
      const msg = makeChatMessage({ rule: 3, collapsed: true });
      fixture.componentRef.setInput('message', msg);
      fixture.componentRef.setInput('notification', true);
      fixture.detectChanges();

      const btn = fixture.nativeElement.querySelector('.open-button');
      expect(btn).toBeTruthy();
      expect(btn.textContent).toContain('chat.reply');
    });

    it('should render Reply button on expanded Rule 3 bubble header', () => {
      const msg = makeChatMessage({ rule: 3, collapsed: false });
      fixture.componentRef.setInput('message', msg);
      fixture.componentRef.setInput('notification', true);
      fixture.detectChanges();

      const header = fixture.nativeElement.querySelector('.bubble-header');
      const btn = header.querySelector('.open-button');
      expect(btn).toBeTruthy();
      expect(btn.textContent).toContain('chat.reply');
    });

    it('bubble body click on expanded Rule 3 should emit toggleCollapse and NOT rule3Clicked', () => {
      const msg = makeChatMessage({ rule: 3, collapsed: false });
      fixture.componentRef.setInput('message', msg);
      fixture.detectChanges();

      spyOn(component.toggleCollapse, 'emit');
      spyOn(component.rule3Clicked, 'emit');

      const messageEl = fixture.nativeElement.querySelector('.message');
      messageEl.click();

      expect(component.toggleCollapse.emit).toHaveBeenCalledWith(msg);
      expect(component.rule3Clicked.emit).not.toHaveBeenCalled();
    });

    it('collapsed-line click on Rule 3 should emit toggleCollapse and NOT rule3Clicked', () => {
      const msg = makeChatMessage({ rule: 3, collapsed: true });
      fixture.componentRef.setInput('message', msg);
      fixture.detectChanges();

      spyOn(component.toggleCollapse, 'emit');
      spyOn(component.rule3Clicked, 'emit');

      const line = fixture.nativeElement.querySelector('.collapsed-line');
      line.click();

      expect(component.toggleCollapse.emit).toHaveBeenCalledWith(msg);
      expect(component.rule3Clicked.emit).not.toHaveBeenCalled();
    });

    it('Reply button click should emit rule3Clicked and NOT toggleCollapse', () => {
      const msg = makeChatMessage({ rule: 3, collapsed: true });
      fixture.componentRef.setInput('message', msg);
      fixture.componentRef.setInput('notification', true);
      fixture.detectChanges();

      spyOn(component.toggleCollapse, 'emit');
      spyOn(component.rule3Clicked, 'emit');

      const btn = fixture.nativeElement.querySelector('.open-button button');
      btn.click();

      expect(component.rule3Clicked.emit).toHaveBeenCalledWith(msg);
      expect(component.toggleCollapse.emit).not.toHaveBeenCalled();
    });
  });

  describe('Reply button visibility (Rule 3 only)', () => {
    it('should NOT render Reply button for Rule 1', () => {
      const msg = makeChatMessage({ rule: 1, alignment: 'right' });
      fixture.componentRef.setInput('message', msg);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.open-button')).toBeNull();
    });

    it('should NOT render Reply button for Rule 2', () => {
      const msg = makeChatMessage({ rule: 2, alignment: 'left' });
      fixture.componentRef.setInput('message', msg);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.open-button')).toBeNull();
    });

    it('should NOT render Reply button for Rule 4 (collapsed or expanded)', () => {
      const collapsed = makeChatMessage({ rule: 4, collapsed: true });
      fixture.componentRef.setInput('message', collapsed);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.open-button')).toBeNull();

      const expanded = makeChatMessage({ rule: 4, collapsed: false });
      fixture.componentRef.setInput('message', expanded);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.open-button')).toBeNull();
    });
  });

  describe('Reply button disabled state (Story 4.5)', () => {
    it('should disable Reply button on collapsed Rule 3 when notification is false', () => {
      const msg = makeChatMessage({ rule: 3, collapsed: true });
      fixture.componentRef.setInput('message', msg);
      fixture.componentRef.setInput('notification', false);
      fixture.detectChanges();

      const btn = fixture.nativeElement.querySelector('.open-button button');
      expect(btn).toBeTruthy();
      expect(btn.disabled).toBe(true);
    });

    it('should enable Reply button on collapsed Rule 3 when notification is true', () => {
      const msg = makeChatMessage({ rule: 3, collapsed: true });
      fixture.componentRef.setInput('message', msg);
      fixture.componentRef.setInput('notification', true);
      fixture.detectChanges();

      const btn = fixture.nativeElement.querySelector('.open-button button');
      expect(btn).toBeTruthy();
      expect(btn.disabled).toBe(false);
    });

    it('should disable Reply button on expanded Rule 3 when notification is false', () => {
      const msg = makeChatMessage({ rule: 3, collapsed: false });
      fixture.componentRef.setInput('message', msg);
      fixture.componentRef.setInput('notification', false);
      fixture.detectChanges();

      const btn = fixture.nativeElement.querySelector('.open-button button');
      expect(btn).toBeTruthy();
      expect(btn.disabled).toBe(true);
    });

    it('should enable Reply button on expanded Rule 3 when notification is true', () => {
      const msg = makeChatMessage({ rule: 3, collapsed: false });
      fixture.componentRef.setInput('message', msg);
      fixture.componentRef.setInput('notification', true);
      fixture.detectChanges();

      const btn = fixture.nativeElement.querySelector('.open-button button');
      expect(btn).toBeTruthy();
      expect(btn.disabled).toBe(false);
    });

    it('should NOT emit rule3Clicked when Reply button is disabled and clicked', () => {
      const msg = makeChatMessage({ rule: 3, collapsed: true });
      fixture.componentRef.setInput('message', msg);
      fixture.componentRef.setInput('notification', false);
      fixture.detectChanges();

      spyOn(component.rule3Clicked, 'emit');
      const btn = fixture.nativeElement.querySelector('.open-button button');
      btn.click();

      expect(component.rule3Clicked.emit).not.toHaveBeenCalled();
    });

    it('should emit rule3Clicked when Reply button is enabled and clicked', () => {
      const msg = makeChatMessage({ rule: 3, collapsed: true });
      fixture.componentRef.setInput('message', msg);
      fixture.componentRef.setInput('notification', true);
      fixture.detectChanges();

      spyOn(component.rule3Clicked, 'emit');
      const btn = fixture.nativeElement.querySelector('.open-button button');
      btn.click();

      expect(component.rule3Clicked.emit).toHaveBeenCalledWith(msg);
    });
  });

  describe('Rule 4 (AI-to-AI collapsed)', () => {
    it('should render collapsed line by default', () => {
      const msg = makeChatMessage({
        rule: 4,
        collapsed: true,
        label: 'Worker ⇒ Manager',
      });
      fixture.componentRef.setInput('message', msg);
      fixture.detectChanges();

      const el = fixture.nativeElement;
      expect(el.querySelector('.collapsed-line')).toBeTruthy();
      expect(el.querySelector('.message-bubble')).toBeNull();
    });

    it('should NOT render collapse-indicator when collapsed (caret removed)', () => {
      const msg = makeChatMessage({ rule: 4, collapsed: true });
      fixture.componentRef.setInput('message', msg);
      fixture.detectChanges();

      const indicator = fixture.nativeElement.querySelector('.collapse-indicator');
      expect(indicator).toBeNull();
    });

    it('should emit toggleCollapse on click', () => {
      const msg = makeChatMessage({
        rule: 4,
        collapsed: true,
        content: 'AI message',
      });
      fixture.componentRef.setInput('message', msg);
      fixture.detectChanges();

      spyOn(component.toggleCollapse, 'emit');
      const collapsedLine = fixture.nativeElement.querySelector('.collapsed-line');
      collapsedLine.click();

      expect(component.toggleCollapse.emit).toHaveBeenCalledWith(msg);
    });

    it('should NOT render collapse-indicator-bubble when expanded (caret removed)', () => {
      const msg = makeChatMessage({ rule: 4, collapsed: false });
      fixture.componentRef.setInput('message', msg);
      fixture.detectChanges();

      const indicator = fixture.nativeElement.querySelector(
        '.collapse-indicator-bubble',
      );
      expect(indicator).toBeNull();
    });

    it('should emit toggleCollapse on click when expanded', () => {
      const msg = makeChatMessage({ rule: 4, collapsed: false });
      fixture.componentRef.setInput('message', msg);
      fixture.detectChanges();

      spyOn(component.toggleCollapse, 'emit');
      // The ROW, open or shut — an expanded notification is the same row with
      // more of its text, not a bubble that replaced it.
      fixture.nativeElement.querySelector('.collapsed-notice').click();

      expect(component.toggleCollapse.emit).toHaveBeenCalledWith(msg);
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
   * The fold toggle on rules 3 and 4 is the real behaviour and stays. These
   * two halves are tested together on purpose: "no handler anywhere" would
   * have been the easy over-correction, and it would have taken the toggle
   * with it.
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

    it('still shuts an expanded rule-3 request', () => {
      const msg = makeChatMessage({
        rule: 3,
        alignment: 'left',
        collapsed: false,
      });
      fixture.componentRef.setInput('message', msg);
      fixture.detectChanges();

      spyOn(component.toggleCollapse, 'emit');

      expect(messageEl().classList.contains('clickable')).toBe(true);

      messageEl().click();
      expect(component.toggleCollapse.emit).toHaveBeenCalledWith(msg);
    });

    /**
     * RULE 4 HAS NO SECOND SHAPE to click. Opening a notification lets its own
     * sentence finish rather than swapping the row for a bubble, so there is no
     * `.message` on it in either state — the row itself is the toggle, open or
     * shut. Asserted rather than left implied, because the previous version of
     * this spec looped rules 3 and 4 together and would have been the thing
     * that caught a bubble creeping back.
     */
    it('gives a rule-4 notice no bubble to click, open or shut', () => {
      const emit = spyOn(component.toggleCollapse, 'emit');

      for (const collapsed of [true, false]) {
        emit.calls.reset();
        const msg = makeChatMessage({ rule: 4, alignment: 'left', collapsed });
        fixture.componentRef.setInput('message', msg);
        fixture.detectChanges();

        expect(fixture.nativeElement.querySelector('.message'))
          .withContext(`collapsed: ${collapsed}`)
          .toBeNull();

        fixture.nativeElement.querySelector('.collapsed-notice').click();
        expect(emit)
          .withContext(`collapsed: ${collapsed}`)
          .toHaveBeenCalledWith(msg);
      }
    });
  });

  // --- W2b: the ambient notification row -----------------------------------
  //
  // Rule 4 is the classifier's fall-through: agent-to-agent traffic and tool
  // announcements. Nothing is waiting on it, so it gets the new design language
  // as a QUIET row — legible, tokenised, with the thing that spoke named as the
  // subject of a sentence instead of parsed out of `[#NotificationTool ⇒
  // @Manager]`. The specs that matter here are the ones that pin it BELOW an
  // ordinary turn and below the request, because that ranking is the whole
  // reason the two folds were split.
  describe('folded notification (Rule 4)', () => {
    it('renders the quiet system row, never the request callout', () => {
      const msg = makeChatMessage({
        rule: 4,
        collapsed: true,
        label: 'Worker ⇒ Manager',
      });
      fixture.componentRef.setInput('message', msg);
      fixture.detectChanges();

      const el = fixture.nativeElement;
      expect(el.querySelector('.collapsed-notice')).toBeTruthy();
      expect(el.querySelector('.collapsed-request'))
        .withContext('a notification must not compete with a request')
        .toBeNull();
      expect(el.querySelector('.message-bubble')).toBeNull();
    });

    it('names the tool as the subject, in words rather than brackets', () => {
      setTestTranslations({
        chat: { notice: { contacted: '<<contacted:{{agent}}>>' } },
      });
      const msg = makeChatMessage({
        rule: 4,
        collapsed: true,
        label: '#NotificationTool ⇒ @Manager',
        sender: makeAddress({ name: '#NotificationTool', role: 'Worker' }),
        recipient: makeAddress({ name: '@Manager', role: 'Manager' }),
        content: 'Follow up: collect jokes from teammates',
      });
      fixture.componentRef.setInput('message', msg);
      fixture.detectChanges();

      const row = fixture.nativeElement.querySelector('.collapsed-notice');
      const text = row.textContent.replace(/\s+/g, ' ');
      expect(fixture.nativeElement.querySelector('.notice-subject').textContent)
        .withContext('the tool is the subject, on its own')
        .toContain('#NotificationTool');
      expect(text).toContain('<<contacted:@Manager>>');
      expect(text).withContext('bracket soup is gone').not.toContain('[');
      expect(text).not.toContain('⇒');
    });

    it('marks a TOOL sender with the bell and an agent sender without it', () => {
      const tool = makeChatMessage({
        rule: 4,
        collapsed: true,
        sender: makeAddress({ name: '#NotificationTool' }),
      });
      fixture.componentRef.setInput('message', tool);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.notice-icon.pi-bell')).toBeTruthy();

      const agent = makeChatMessage({
        rule: 4,
        collapsed: true,
        sender: makeAddress({ name: '@Expert' }),
      });
      fixture.componentRef.setInput('message', agent);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.notice-icon.pi-bell')).toBeNull();
      expect(fixture.nativeElement.querySelector('.notice-icon')).toBeTruthy();
    });

    it('carries no action and no state — it demands nothing', () => {
      // The line between W2a and W2b. A notification that grew a Reply or a
      // PENDING chip would be a second callout, and the user is back to
      // scanning every folded row to find the one that wants them.
      const msg = makeChatMessage({ rule: 4, collapsed: true });
      fixture.componentRef.setInput('message', msg);
      fixture.componentRef.setInput('notification', true);
      fixture.detectChanges();

      const row = fixture.nativeElement.querySelector('.collapsed-notice');
      expect(row.querySelector('.open-button')).toBeNull();
      expect(row.querySelector('.request-state')).toBeNull();
      expect(row.querySelector('.turn-avatar'))
        .withContext('no avatar: nobody is speaking, something is reporting')
        .toBeNull();
    });

    it('keeps the preview, the caret and the clock on the one row', () => {
      const msg = makeChatMessage({
        rule: 4,
        collapsed: true,
        content: 'Start of the message',
      });
      fixture.componentRef.setInput('message', msg);
      fixture.detectChanges();

      const row = fixture.nativeElement.querySelector('.collapsed-notice');
      expect(row.querySelector('.collapsed-preview').textContent).toContain(
        'Start of the message',
      );
      expect(row.querySelector('.collapsed-caret')).toBeTruthy();
      expect(row.querySelector('.collapsed-timestamp').textContent.trim().length)
        .toBeGreaterThan(0);
    });

    it('omits the preview entirely when there is no content', () => {
      const msg = makeChatMessage({ rule: 4, collapsed: true, content: '' });
      fixture.componentRef.setInput('message', msg);
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('.collapsed-preview')).toBeNull();
    });

    /**
     * THE ROW STAYS A ROW, and says so with an ellipsis — but the ellipsis is
     * PAINTED, not part of the text.
     *
     * It used to be characters in the string: `preview()` returned a shorter
     * body while the row was shut. That is what stopped the row animating
     * closed — the content finished shrinking in the frame the toggle fired, so
     * the height transition had nothing left to cover. The whole message is in
     * the DOM in both states now and the row clips it, so the mark has to come
     * from CSS.
     */
    it('marks a clipped body with an ellipsis, without shortening it', () => {
      const body = 'x'.repeat(80);
      fixture.componentRef.setInput(
        'message',
        makeChatMessage({ rule: 4, collapsed: true, content: body }),
      );
      fixture.detectChanges();

      const preview = fixture.nativeElement.querySelector('.collapsed-preview');
      // The text is whole: shortening it is what broke the close animation.
      expect(preview.textContent.trim()).toBe(body);

      const clipped = fixture.nativeElement.querySelector('.notice-text');
      expect(getComputedStyle(clipped, '::after').content).toContain('…');
    });

    /**
     * AND ONLY WHEN THERE IS SOMETHING TO CUT.
     *
     * The painted mark started life unconditional, so it also appeared on the
     * short rows that show their message in full — claiming a truncation that
     * had not happened. CSS cannot ask whether a box overflows, so the test is
     * the message's own length, matching what the row truncated at before it
     * learned to open in place.
     */
    it('leaves a body that fits unmarked', () => {
      const body = 'Verified: the applicant.';
      fixture.componentRef.setInput(
        'message',
        makeChatMessage({ rule: 4, collapsed: true, content: body }),
      );
      fixture.detectChanges();

      const row = fixture.nativeElement.querySelector('.notice-text');
      expect(row.textContent).toContain(body);
      expect(getComputedStyle(row, '::after').content).not.toContain('…');
    });

    it('drops the ellipsis once the row is opened', () => {
      fixture.componentRef.setInput(
        'message',
        makeChatMessage({ rule: 4, collapsed: false, content: 'x'.repeat(80) }),
      );
      fixture.detectChanges();

      const opened = fixture.nativeElement.querySelector('.notice-text');
      expect(getComputedStyle(opened, '::after').content).not.toContain('…');
    });
  });

  // --- The hierarchy the round is actually about ----------------------------
  //
  // REQUEST > TURN > NOTIFICATION. Both folds are collapsible and both are one
  // component, which is exactly how they ended up identical in the first place.
  // These are the assertions that make them diverge on purpose rather than by
  // accident, and that stop a later change collapsing them back together.
  describe('fold hierarchy (W2)', () => {
    function render(rule: 3 | 4) {
      fixture.componentRef.setInput(
        'message',
        makeChatMessage({ rule, collapsed: true, content: 'body text' }),
      );
      fixture.componentRef.setInput('notification', rule === 3);
      fixture.detectChanges();
      return fixture.nativeElement as HTMLElement;
    }

    it('gives the request a card and the notification none', () => {
      expect(render(3).querySelector('.request-card')).toBeTruthy();
      expect(render(4).querySelector('.request-card')).toBeNull();
    });

    it('gives the request the transcript gutter and the notification an indent', () => {
      // The request is someone speaking, so it sits in the same avatar gutter a
      // turn does. The notification is a consequence of the conversation, so it
      // sits under that gutter with nothing in it.
      expect(render(3).querySelector('.collapsed-request > .turn-avatar')).toBeTruthy();
      expect(render(4).querySelector('.turn-avatar')).toBeNull();
    });

    it('keeps BOTH folded rows collapsible and expandable', () => {
      // Whatever else changed, the fold is the contract: chat-panel re-applies
      // its expanded set on every re-emission of the pure fold, and it does it
      // through `toggleCollapse`.
      const emit = spyOn(component.toggleCollapse, 'emit');

      for (const rule of [3, 4] as const) {
        emit.calls.reset();
        const msg = makeChatMessage({ rule, collapsed: true });
        fixture.componentRef.setInput('message', msg);
        fixture.detectChanges();

        fixture.nativeElement.querySelector('.collapsed-line').click();
        expect(emit)
          .withContext(`rule ${rule} must still fold`)
          .toHaveBeenCalledWith(msg);

        // …and each opens into ITS OWN shape. A request becomes the ordinary
        // bubble; a notification stays the row it already was and simply lets
        // its sentence finish, which is why the two are asserted apart rather
        // than through one expectation that would have to be vague to cover
        // both.
        fixture.componentRef.setInput('message', { ...msg, collapsed: false });
        fixture.detectChanges();

        if (rule === 3) {
          expect(fixture.nativeElement.querySelector('.message-bubble')).toBeTruthy();
          expect(fixture.nativeElement.querySelector('.collapsed-line')).toBeNull();
        } else {
          expect(fixture.nativeElement.querySelector('.message-bubble')).toBeNull();
          expect(fixture.nativeElement.querySelector('.notice-text.expanded')).toBeTruthy();
        }
      }
    });
  });

  describe('messageSelected output', () => {
    it('should emit on label click for non-Rule-1 messages', () => {
      const msg = makeChatMessage({ rule: 2 });
      fixture.componentRef.setInput('message', msg);
      fixture.detectChanges();

      spyOn(component.messageSelected, 'emit');
      const btn = fixture.nativeElement.querySelector('.label-pill');
      btn.click();
      expect(component.messageSelected.emit).toHaveBeenCalledWith(msg);
    });

    it('should NOT emit on label click for Rule 1', () => {
      const msg = makeChatMessage({ rule: 1 });
      fixture.componentRef.setInput('message', msg);
      fixture.detectChanges();

      spyOn(component.messageSelected, 'emit');
      component.onLabelClick();
      expect(component.messageSelected.emit).not.toHaveBeenCalled();
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

    it('shows no notification icon and no Reply button', () => {
      fixture.componentRef.setInput('message', makeRule5());
      fixture.componentRef.setInput('notification', true);
      fixture.detectChanges();

      const el = fixture.nativeElement;
      expect(el.querySelector('.notification-icon')).toBeNull();
      expect(el.querySelector('.pi-bell')).toBeNull();
      expect(el.querySelector('.open-button')).toBeNull();
    });

    it('is inert — there is no turn there to click', () => {
      fixture.componentRef.setInput('message', makeRule5());
      fixture.detectChanges();

      spyOn(component.toggleCollapse, 'emit');
      fixture.nativeElement.querySelector('.system-rule').click();

      expect(component.toggleCollapse.emit).not.toHaveBeenCalled();
    });

    it('onLabelClick is a no-op for Rule 5', () => {
      fixture.componentRef.setInput('message', makeRule5());
      fixture.detectChanges();

      spyOn(component.messageSelected, 'emit');
      component.onLabelClick();

      expect(component.messageSelected.emit).not.toHaveBeenCalled();
    });

    it('onToggleCollapse is a no-op for Rule 5', () => {
      fixture.componentRef.setInput('message', makeRule5());
      fixture.detectChanges();

      spyOn(component.toggleCollapse, 'emit');
      component.onToggleCollapse();

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
      spyOn(component.messageSelected, 'emit');

      (el.querySelector('.system-announcement') as HTMLElement).click();

      expect(el.querySelector('.message-bubble')).toBeNull();
      expect(el.querySelector('.turn-avatar')).toBeNull();
      expect(el.querySelector('app-feedback')).toBeNull();
      expect(component.toggleCollapse.emit).not.toHaveBeenCalled();
      expect(component.messageSelected.emit).not.toHaveBeenCalled();
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

    it('Rule 2 label pill is NOT disabled (clickable for selection)', () => {
      const msg = makeChatMessage({
        rule: 2,
        alignment: 'left',
        label: '@Manager ⇒ You',
      });
      fixture.componentRef.setInput('message', msg);
      fixture.detectChanges();

      const pill = fixture.nativeElement.querySelector('.label-pill');
      expect(pill.disabled).toBe(false);
    });
  });

  describe('Expanded bubble header layout (Story 4.3)', () => {
    function makeExpanded(rule: 1 | 2 | 3 | 4): ChatMessage {
      return makeChatMessage({
        rule,
        alignment: rule === 1 ? 'right' : 'left',
        collapsed: false,
        label:
          rule === 1
            ? 'You ⇒ @Manager'
            : rule === 2
              ? '@Manager ⇒ You'
              : rule === 3
                ? '@Manager ⇒ @Support'
                : '@Worker ⇒ @Manager',
        timestamp: new Date('2026-04-08T10:45:00Z'),
      });
    }

    // RULE 1 IS EXCLUDED, and the spec below states why rather than the loop
    // quietly skipping it. Every other child of the header is already gated to
    // "not the user's own turn", so on rule 1 the header rendered as a lone
    // clock above the user's own words — which the redesign drops.
    //
    // RULE 4 IS EXCLUDED TOO, and for a different reason: it has no bubble in
    // either state. An opened notification is the same one-line row with more
    // of its text, and its clock is the row's own `.collapsed-timestamp`.
    for (const rule of [2, 3] as const) {
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

    /** And it belongs to the user's own turn alone: every other rule states
     *  the time in its header (rules 2 and 3) or on its folded row (rule 4),
     *  and two clocks on one row is a defect. */
    for (const rule of [2, 3, 4] as const) {
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

    it('Rule 3 expanded: .bubble-timestamp is the last element child of .bubble-header', () => {
      fixture.componentRef.setInput('message', makeExpanded(3));
      fixture.detectChanges();

      const header = fixture.nativeElement.querySelector('.bubble-header');
      expect(header).toBeTruthy();
      expect(header.lastElementChild.classList.contains('bubble-timestamp')).toBe(true);
    });

    /**
     * RULE 4 HAS NO HEADER TO PUT A CLOCK IN — it has no bubble at all, open or
     * shut. An opened notification is the same one-line row with more of its
     * text, and its time sits on that row where it always did. Asserted rather
     * than deleted, because "no header" is the claim, and a bubble creeping
     * back onto rule 4 is exactly what would make the surface swap shapes
     * again.
     */
    it('Rule 4 expanded: carries no bubble header, and keeps the row\'s own clock', () => {
      fixture.componentRef.setInput('message', makeExpanded(4));
      fixture.detectChanges();

      const el: HTMLElement = fixture.nativeElement;
      expect(el.querySelector('.bubble-header')).toBeNull();
      expect(el.querySelector('.message-bubble')).toBeNull();
      expect(
        el.querySelector('.collapsed-notice .collapsed-timestamp')?.textContent?.trim(),
      ).toMatch(/^\d{2}:\d{2}$/);
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
      // A marker is NOT a chat bubble or a Rule 3/4 collapsed line.
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

    it('markers render no label-pill and no Reply button', () => {
      fixture.componentRef.setInput('message', makeCompactionMarker());
      fixture.detectChanges();

      const el = fixture.nativeElement;
      expect(el.querySelector('.label-pill')).toBeNull();
      expect(el.querySelector('.open-button')).toBeNull();
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

    it('substitutes a kind for the identity on a folded NOTIFICATION', async () => {
      const collapsed = makeChatMessage({
        rule: 4,
        collapsed: true,
        sender: makeAddress({ name: '@Manager', role: 'Manager' }),
        recipient: makeAddress({ name: '@Worker', role: 'Worker' }),
        content: 'some body',
      });
      const shown = await renderWith(false, collapsed);
      expect(shown.nativeElement.querySelector('.notice-subject').textContent)
        .withContext('the thing that spoke is named by default')
        .toContain('@Manager');

      const hidden = await renderWith(true, collapsed);
      const text = hidden.nativeElement.textContent as string;
      expect(text).not.toContain('@Manager');
      expect(text).not.toContain('@Worker');
      // A subject-less row reads as a rendering fault, so it still says what
      // kind of thing it is — just not who.
      expect(text).toContain('chat.teamMessage');
      expect(text).toContain('some body');
    });

    it('substitutes a kind for the identity on a folded REQUEST', async () => {
      // The callout states WHO IT IS FOR in words, which is a second place the
      // recipient's name now appears. Hiding the pill and keeping the callout's
      // phrase would leak exactly the identity the flag promises to hide.
      const request = makeChatMessage({
        rule: 3,
        collapsed: true,
        sender: makeAddress({ name: '@Manager', role: 'Manager' }),
        recipient: makeAddress({ name: '@Support', role: 'Human' }),
        content: 'please confirm',
      });
      const hidden = await renderWith(true, request);
      const text = hidden.nativeElement.textContent as string;

      expect(text).not.toContain('@Manager');
      expect(text).not.toContain('@Support');
      expect(text).toContain('chat.messageForYou');
      expect(text)
        .withContext('the question itself is not an identity')
        .toContain('please confirm');
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

    /** Rules 2 and 3 only: rule 4 has no bubble in either state — an opened
     *  notification is the same one-line row with more of its text. */
    it('leaves an AGENT turn unmarked, so it renders flat', () => {
      for (const rule of [2, 3] as const) {
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

    it('renders a collapsed row with an unparseable timestamp', () => {
      fixture.componentRef.setInput(
        'message',
        makeChatMessage({ rule: 4, collapsed: true, timestamp: new Date(NaN) }),
      );
      expect(() => fixture.detectChanges()).not.toThrow();

      const el: HTMLElement = fixture.nativeElement;
      expect(el.querySelector('.collapsed-line')).not.toBeNull();
      expect(el.querySelector('.collapsed-timestamp')!.textContent!.trim()).toBe('');
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
      for (const rule of [2, 3, 4] as const) {
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

    it('agrees with the predicate for every message rule', () => {
      // The point of FR1: one answer, not two that drift. If this ever fails,
      // the template has started deciding for itself.
      for (const rule of [1, 2, 3, 4, 5, 6, 7] as const) {
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

    /**
     * A folded notice offers no rating — but it offers it by being INERT rather
     * than absent.
     *
     * Removing it from the DOM is what a reader expects, and it is what this
     * spec used to require. It also dropped the row's content height in a
     * single frame at the moment of the toggle, which left the closing
     * transition nothing to animate. It stays and is clipped by the row's
     * height; `inert` is what makes "cannot be seen" also mean "cannot be
     * reached", which a clip on its own does not.
     */
    it('makes the control unreachable on a collapsed line, not absent', () => {
      fixture.componentRef.setInput(
        'message',
        makeChatMessage({ rule: 4, collapsed: true }),
      );
      fixture.detectChanges();

      const control = fixture.nativeElement.querySelector('app-feedback');
      expect(fixture.nativeElement.querySelector('.collapsed-line')).not.toBeNull();
      expect(control).not.toBeNull();
      expect(control.hasAttribute('inert')).toBeTrue();
    });

    it('makes it reachable again once the line is opened', () => {
      fixture.componentRef.setInput(
        'message',
        makeChatMessage({ rule: 4, collapsed: false }),
      );
      fixture.detectChanges();

      const control = fixture.nativeElement.querySelector('app-feedback');
      expect(control).not.toBeNull();
      expect(control.hasAttribute('inert')).toBeFalse();
    });
  });

  /**
   * WHAT THE LIST NEEDS IN ORDER TO SPACE THIS ROW.
   *
   * The transcript spaces turns like paragraphs and runs quiet one-liners
   * together, and the rule that does it (`.quiet-line + .quiet-line`) lives in
   * the LIST's stylesheet — so it can only match the element the list has as a
   * child, which is this component's host. The class is on the host for that
   * reason rather than as a styling convenience.
   */
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
    for (const rule of [2, 3, 4] as const) {
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

  describe('the quiet-line host class', () => {
    function host(): HTMLElement {
      return fixture.nativeElement as HTMLElement;
    }

    function setRule(rule: ChatMessage['rule'], collapsed: boolean): void {
      fixture.componentRef.setInput('message', makeChatMessage({ rule, collapsed }));
      fixture.detectChanges();
    }

    it('marks a folded notice, which is the row that runs together', () => {
      setRule(4, true);
      expect(host().classList.contains('quiet-line')).toBe(true);
    });

    it('does not mark a turn, which is a paragraph and keeps its air', () => {
      setRule(2, false);
      expect(host().classList.contains('quiet-line')).toBe(false);
    });

    /**
     * AND KEEPS IT WHEN OPENED, which is the point of opening in place.
     *
     * An expanded notice is the same row with more of its text — not a bubble
     * of a different shape — so it is still a quiet line and still runs
     * together with the notices around it. When opening SWAPPED the row for a
     * bubble, this class went with it, and the neighbour's margin jumped from
     * nothing to a full turn's gap in one frame: the row grew smoothly while
     * the space beside it arrived at once. Nothing to animate now, because
     * nothing moves.
     */
    it('keeps the mark when the notice is expanded', () => {
      setRule(4, false);
      expect(host().classList.contains('quiet-line')).toBe(true);
    });

    /**
     * A FOLDED RULE 3 is not one of these. It is the request card — filled,
     * bordered, with a body and a button — and closing two of those up against
     * each other would merge them into one shape.
     */
    it('does not mark a folded request, which is a card rather than a line', () => {
      setRule(3, true);
      expect(host().classList.contains('quiet-line')).toBe(false);
    });
  });
});
