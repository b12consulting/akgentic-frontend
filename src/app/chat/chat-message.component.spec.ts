import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideMarkdown } from 'ngx-markdown';
import { ChatMessageComponent } from './chat-message.component';
import { ChatMessage } from '../models/chat-message.model';
import { ActorAddress } from '../models/message.types';

function makeAddress(overrides: Partial<ActorAddress> = {}): ActorAddress {
  return {
    __actor_address__: true,
    address: 'addr',
    name: '@Agent',
    role: 'Worker',
    agent_id: 'agent-1',
    squad_id: 'squad-1',
    user_message: false,
    ...overrides,
  };
}

function makeChatMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg-1',
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
      imports: [ChatMessageComponent],
      providers: [provideMarkdown()],
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
        label: 'You -> Manager',
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
        label: 'You -> Manager',
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

  describe('Rule 3 (notification)', () => {
    it('should show notification placeholder', () => {
      const msg = makeChatMessage({
        rule: 3,
        alignment: 'left',
        label: 'Agent -> OtherHuman',
      });
      fixture.componentRef.setInput('message', msg);
      fixture.detectChanges();

      const el = fixture.nativeElement;
      expect(el.querySelector('.notification-placeholder')).toBeTruthy();
      expect(el.querySelector('.pi-bell')).toBeTruthy();
    });
  });

  describe('Rule 4 (AI-to-AI collapsed)', () => {
    it('should render collapsed line by default', () => {
      const msg = makeChatMessage({
        rule: 4,
        collapsed: true,
        label: 'Worker -> Manager',
      });
      fixture.componentRef.setInput('message', msg);
      fixture.detectChanges();

      const el = fixture.nativeElement;
      expect(el.querySelector('.collapsed-line')).toBeTruthy();
      expect(el.querySelector('.message-bubble')).toBeNull();
    });

    it('should show > indicator when collapsed', () => {
      const msg = makeChatMessage({ rule: 4, collapsed: true });
      fixture.componentRef.setInput('message', msg);
      fixture.detectChanges();

      const indicator = fixture.nativeElement.querySelector('.collapse-indicator');
      expect(indicator.textContent.trim()).toBe('>');
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

    it('should show v indicator when expanded', () => {
      const msg = makeChatMessage({ rule: 4, collapsed: false });
      fixture.componentRef.setInput('message', msg);
      fixture.detectChanges();

      const indicator = fixture.nativeElement.querySelector(
        '.collapse-indicator-bubble',
      );
      expect(indicator.textContent.trim()).toBe('v');
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
        label: 'You -> Manager',
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
    it('should emit rule3Clicked for Rule 3 bubble click', () => {
      const msg = makeChatMessage({
        rule: 3,
        alignment: 'left',
        label: 'Agent -> OtherHuman',
      });
      fixture.componentRef.setInput('message', msg);
      fixture.detectChanges();

      spyOn(component.rule3Clicked, 'emit');
      const messageEl = fixture.nativeElement.querySelector('.message');
      messageEl.click();

      expect(component.rule3Clicked.emit).toHaveBeenCalledWith(msg);
    });

    it('should NOT emit bubbleClicked for Rule 3', () => {
      const msg = makeChatMessage({ rule: 3, alignment: 'left' });
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
});
