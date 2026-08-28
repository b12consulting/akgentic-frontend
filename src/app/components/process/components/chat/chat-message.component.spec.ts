import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { provideMarkdown } from 'ngx-markdown';
import { BehaviorSubject } from 'rxjs';
import { ConfigService } from '../../../../core/config/config.service';
import { ChatMessageComponent } from './chat-message.component';
import { ChatMessage } from '../../selectors/chat-message.model';
import { isRateable } from '../../selectors/rateable';
import { Feedback, FeedbackService } from '../../ui-state/feedback.service';
import { ActorAddress } from '../../../../protocol/message.types';

import { provideTranslateTesting } from '../../../../../testing/i18n-testing';

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

    it('should disable label pill for Rule 1', () => {
      const msg = makeChatMessage({
        rule: 1,
        alignment: 'right',
        label: 'You ⇒ Manager',
      });
      fixture.componentRef.setInput('message', msg);
      fixture.detectChanges();

      const btn = fixture.nativeElement.querySelector('.label-pill');
      expect(btn.disabled).toBe(true);
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

    it('should render collapsed line by default when Rule 3 collapsed', () => {
      const msg = makeChatMessage({
        rule: 3,
        collapsed: true,
        label: 'Agent ⇒ OtherHuman',
      });
      fixture.componentRef.setInput('message', msg);
      fixture.detectChanges();

      const el = fixture.nativeElement;
      expect(el.querySelector('.collapsed-line')).toBeTruthy();
      expect(el.querySelector('.message-bubble')).toBeNull();
      const label = el.querySelector('.collapsed-label');
      expect(label.textContent).toContain('Agent ⇒ OtherHuman');
    });

    it('should append (🙋) in collapsed line when notification is true', () => {
      const msg = makeChatMessage({
        rule: 3,
        collapsed: true,
        label: 'Agent ⇒ OtherHuman',
      });
      fixture.componentRef.setInput('message', msg);
      fixture.componentRef.setInput('notification', true);
      fixture.detectChanges();

      const label = fixture.nativeElement.querySelector('.collapsed-label');
      expect(label.textContent).toContain('🙋');
      expect(label.textContent).toContain('(');
      expect(label.textContent).toContain(')');
    });

    it('should NOT append (🙋) in collapsed line when notification is false', () => {
      const msg = makeChatMessage({
        rule: 3,
        collapsed: true,
        label: 'Agent ⇒ OtherHuman',
      });
      fixture.componentRef.setInput('message', msg);
      fixture.componentRef.setInput('notification', false);
      fixture.detectChanges();

      const label = fixture.nativeElement.querySelector('.collapsed-label');
      expect(label.textContent).not.toContain('🙋');
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
      const messageEl = fixture.nativeElement.querySelector('.message');
      messageEl.click();

      expect(component.toggleCollapse.emit).toHaveBeenCalledWith(msg);
    });
  });

  describe('bubbleClicked output', () => {
    it('should emit bubbleClicked for Rule 1 bubble click', () => {
      const msg = makeChatMessage({
        rule: 1,
        alignment: 'right',
        color: '#efeeee',
        label: 'You ⇒ Manager',
      });
      fixture.componentRef.setInput('message', msg);
      fixture.detectChanges();

      spyOn(component.bubbleClicked, 'emit');
      const messageEl = fixture.nativeElement.querySelector('.message');
      messageEl.click();

      expect(component.bubbleClicked.emit).toHaveBeenCalledWith(msg);
    });

    it('should emit bubbleClicked for Rule 2 bubble click', () => {
      const msg = makeChatMessage({ rule: 2, alignment: 'left' });
      fixture.componentRef.setInput('message', msg);
      fixture.detectChanges();

      spyOn(component.bubbleClicked, 'emit');
      const messageEl = fixture.nativeElement.querySelector('.message');
      messageEl.click();

      expect(component.bubbleClicked.emit).toHaveBeenCalledWith(msg);
    });

    it('should NOT emit bubbleClicked for Rule 4 bubble click', () => {
      const msg = makeChatMessage({ rule: 4, collapsed: false });
      fixture.componentRef.setInput('message', msg);
      fixture.detectChanges();

      spyOn(component.bubbleClicked, 'emit');
      const messageEl = fixture.nativeElement.querySelector('.message');
      messageEl.click();

      expect(component.bubbleClicked.emit).not.toHaveBeenCalled();
    });
  });

  describe('rule3Clicked output', () => {
    it('should NOT emit bubbleClicked for Rule 3 bubble click', () => {
      const msg = makeChatMessage({ rule: 3, alignment: 'left', collapsed: false });
      fixture.componentRef.setInput('message', msg);
      fixture.detectChanges();

      spyOn(component.bubbleClicked, 'emit');
      const messageEl = fixture.nativeElement.querySelector('.message');
      messageEl.click();

      expect(component.bubbleClicked.emit).not.toHaveBeenCalled();
    });
  });

  describe('selected input', () => {
    it('should apply .selected class when selected is true', () => {
      const msg = makeChatMessage({ rule: 2 });
      fixture.componentRef.setInput('message', msg);
      fixture.componentRef.setInput('selected', true);
      fixture.detectChanges();

      const bubble = fixture.nativeElement.querySelector('.message-bubble');
      expect(bubble.classList.contains('selected')).toBe(true);
    });

    it('should NOT apply .selected class when selected is false', () => {
      const msg = makeChatMessage({ rule: 2 });
      fixture.componentRef.setInput('message', msg);
      fixture.componentRef.setInput('selected', false);
      fixture.detectChanges();

      const bubble = fixture.nativeElement.querySelector('.message-bubble');
      expect(bubble.classList.contains('selected')).toBe(false);
    });

    it('should default selected to false', () => {
      const msg = makeChatMessage({ rule: 2 });
      fixture.componentRef.setInput('message', msg);
      fixture.detectChanges();

      const bubble = fixture.nativeElement.querySelector('.message-bubble');
      expect(bubble.classList.contains('selected')).toBe(false);
    });
  });

  describe('collapsed line preview (Story 4.2)', () => {
    it('Rule 4 collapsed line renders preview after " : " when content is non-empty', () => {
      const msg = makeChatMessage({
        rule: 4,
        collapsed: true,
        label: 'Worker ⇒ Manager',
        content: 'Start of the message',
      });
      fixture.componentRef.setInput('message', msg);
      fixture.detectChanges();

      const label = fixture.nativeElement.querySelector('.collapsed-label');
      expect(label.textContent).toContain('[Worker ⇒ Manager]');
      expect(label.textContent).toContain(' : Start of the message');
    });

    it('Rule 4 collapsed line omits " : " and preview when content is empty', () => {
      const msg = makeChatMessage({
        rule: 4,
        collapsed: true,
        label: 'Worker ⇒ Manager',
        content: '',
      });
      fixture.componentRef.setInput('message', msg);
      fixture.detectChanges();

      const label = fixture.nativeElement.querySelector('.collapsed-label');
      expect(label.textContent).toContain('[Worker ⇒ Manager]');
      expect(label.textContent).not.toContain(' : ');
      expect(label.querySelector('.collapsed-preview')).toBeNull();
    });

    it('Rule 3 collapsed with notification renders (🙋) inside bracket, preview after " : "', () => {
      const msg = makeChatMessage({
        rule: 3,
        collapsed: true,
        label: 'Manager ⇒ Support',
        content: 'Can you verify the auth flow',
      });
      fixture.componentRef.setInput('message', msg);
      fixture.componentRef.setInput('notification', true);
      fixture.detectChanges();

      const label = fixture.nativeElement.querySelector('.collapsed-label');
      const text = label.textContent.replace(/\s+/g, ' ');
      // Bracket encloses label + marker, then preview follows
      expect(text).toContain('[Manager ⇒ Support (🙋)]');
      expect(text).toContain(' : Can you verify the auth flow');
    });

    it('Rule 3 collapsed without notification omits (🙋) marker, preview still present', () => {
      const msg = makeChatMessage({
        rule: 3,
        collapsed: true,
        label: 'Manager ⇒ Support',
        content: 'Hello',
      });
      fixture.componentRef.setInput('message', msg);
      fixture.componentRef.setInput('notification', false);
      fixture.detectChanges();

      const label = fixture.nativeElement.querySelector('.collapsed-label');
      const text = label.textContent.replace(/\s+/g, ' ');
      expect(text).not.toContain('🙋');
      expect(text).toContain('[Manager ⇒ Support]');
      expect(text).toContain(' : Hello');
    });

    it('long content is truncated with "..." in the rendered preview', () => {
      const longContent = 'x'.repeat(80);
      const msg = makeChatMessage({
        rule: 4,
        collapsed: true,
        label: 'Worker ⇒ Manager',
        content: longContent,
      });
      fixture.componentRef.setInput('message', msg);
      fixture.detectChanges();

      const label = fixture.nativeElement.querySelector('.collapsed-label');
      expect(label.textContent).toContain('...');
      // Preview span ends with "..."
      const preview = label.querySelector('.collapsed-preview');
      expect(preview.textContent.trim().endsWith('...')).toBe(true);
    });

    it('timestamp remains visible on the same collapsed row', () => {
      const msg = makeChatMessage({
        rule: 4,
        collapsed: true,
        label: 'Worker ⇒ Manager',
        content: 'hi',
      });
      fixture.componentRef.setInput('message', msg);
      fixture.detectChanges();

      const ts = fixture.nativeElement.querySelector('.collapsed-timestamp');
      expect(ts).toBeTruthy();
      expect(ts.textContent.trim().length).toBeGreaterThan(0);
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

    it('renders as a left-aligned expanded bubble (no collapsed line)', () => {
      fixture.componentRef.setInput('message', makeRule5());
      fixture.detectChanges();

      const el = fixture.nativeElement;
      expect(el.querySelector('.message.left')).toBeTruthy();
      expect(el.querySelector('.message-bubble')).toBeTruthy();
      expect(el.querySelector('.collapsed-line')).toBeNull();
    });

    it('renders the label pill disabled', () => {
      fixture.componentRef.setInput('message', makeRule5());
      fixture.detectChanges();

      const btn = fixture.nativeElement.querySelector('.label-pill');
      expect(btn.textContent.trim()).toBe('System message');
      expect(btn.disabled).toBe(true);
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

    it('onBubbleClick is a no-op for Rule 5', () => {
      fixture.componentRef.setInput('message', makeRule5());
      fixture.detectChanges();

      spyOn(component.bubbleClicked, 'emit');
      spyOn(component.toggleCollapse, 'emit');
      const messageEl = fixture.nativeElement.querySelector('.message');
      messageEl.click();

      expect(component.bubbleClicked.emit).not.toHaveBeenCalled();
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

    for (const rule of [1, 2, 3, 4] as const) {
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

    it('Rule 3 expanded: .bubble-timestamp is the last element child of .bubble-header', () => {
      fixture.componentRef.setInput('message', makeExpanded(3));
      fixture.detectChanges();

      const header = fixture.nativeElement.querySelector('.bubble-header');
      expect(header).toBeTruthy();
      expect(header.lastElementChild.classList.contains('bubble-timestamp')).toBe(true);
    });

    it('Rule 4 expanded: .bubble-timestamp is the last element child of .bubble-header', () => {
      fixture.componentRef.setInput('message', makeExpanded(4));
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
      const pill = f.nativeElement.querySelector('.label-pill');
      expect(pill).withContext('system label is not an agent name').not.toBeNull();
      expect(pill.textContent.trim()).toBe('SYSTEM');
    });

    it('substitutes a collapsed line rather than leaving empty brackets', async () => {
      const collapsed = makeChatMessage({
        rule: 4,
        collapsed: true,
        label: '@Manager ⇒ @Worker',
        content: 'some body',
      });
      const shown = await renderWith(false, collapsed);
      expect(shown.nativeElement.textContent).toContain('@Manager ⇒ @Worker');

      const hidden = await renderWith(true, collapsed);
      const text = hidden.nativeElement.textContent as string;
      expect(text).not.toContain('@Manager');
      // `[] : preview` reads as a rendering fault, so the row still says what
      // it is — just not who.
      expect(text).toContain('chat.teamMessage');
      expect(text).toContain('some body');
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
      for (const rule of [2, 3, 4] as const) {
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

    it('does not select the turn when the control is clicked', () => {
      // The bubble is itself a click target. Without stopPropagation, opening
      // the feedback dialog would also select the message behind it.
      const spy = jasmine.createSpy('bubbleClicked');
      component.bubbleClicked.subscribe(spy);
      const control = renderRule(2);

      control.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      fixture.detectChanges();

      expect(spy).not.toHaveBeenCalled();
    });

    it('keeps the control inside the turn it rates', () => {
      // Not a cosmetic assertion: a control rendered as a sibling of the
      // bubble would sit outside the hover target that reveals it, and would
      // be permanently invisible.
      renderRule(2);
      const bubble = fixture.nativeElement.querySelector('.message-bubble');
      expect(bubble.querySelector('app-feedback')).not.toBeNull();
    });

    it('gives the collapsed line no control', () => {
      // A rule 4 line that has not been expanded is one row of grey preview
      // text; a pair of thumbs on it would be most of the row.
      fixture.componentRef.setInput(
        'message',
        makeChatMessage({ rule: 4, collapsed: true }),
      );
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('.collapsed-line')).not.toBeNull();
      expect(fixture.nativeElement.querySelector('app-feedback')).toBeNull();
    });
  });
});
