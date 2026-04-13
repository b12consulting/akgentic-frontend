import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
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
      imports: [ChatMessageComponent, NoopAnimationsModule],
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

  describe('Rule 3 (notification + collapse + Open button)', () => {
    it('should show hand-raised icon (🙋) on expanded bubble when notification is true', () => {
      const msg = makeChatMessage({
        rule: 3,
        alignment: 'left',
        collapsed: false,
        label: 'Agent -> OtherHuman',
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
        label: 'Agent -> OtherHuman',
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
        label: 'Agent -> OtherHuman',
      });
      fixture.componentRef.setInput('message', msg);
      fixture.detectChanges();

      const el = fixture.nativeElement;
      expect(el.querySelector('.collapsed-line')).toBeTruthy();
      expect(el.querySelector('.message-bubble')).toBeNull();
      const label = el.querySelector('.collapsed-label');
      expect(label.textContent).toContain('Agent -> OtherHuman');
    });

    it('should append (🙋) in collapsed line when notification is true', () => {
      const msg = makeChatMessage({
        rule: 3,
        collapsed: true,
        label: 'Agent -> OtherHuman',
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
        label: 'Agent -> OtherHuman',
      });
      fixture.componentRef.setInput('message', msg);
      fixture.componentRef.setInput('notification', false);
      fixture.detectChanges();

      const label = fixture.nativeElement.querySelector('.collapsed-label');
      expect(label.textContent).not.toContain('🙋');
    });

    it('should render Open button on collapsed Rule 3 line', () => {
      const msg = makeChatMessage({ rule: 3, collapsed: true });
      fixture.componentRef.setInput('message', msg);
      fixture.detectChanges();

      const btn = fixture.nativeElement.querySelector('.open-button');
      expect(btn).toBeTruthy();
      expect(btn.textContent).toContain('Open');
    });

    it('should render Open button on expanded Rule 3 bubble header', () => {
      const msg = makeChatMessage({ rule: 3, collapsed: false });
      fixture.componentRef.setInput('message', msg);
      fixture.detectChanges();

      const header = fixture.nativeElement.querySelector('.bubble-header');
      const btn = header.querySelector('.open-button');
      expect(btn).toBeTruthy();
      expect(btn.textContent).toContain('Open');
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

    it('Open button click should emit rule3Clicked and NOT toggleCollapse', () => {
      const msg = makeChatMessage({ rule: 3, collapsed: true });
      fixture.componentRef.setInput('message', msg);
      fixture.detectChanges();

      spyOn(component.toggleCollapse, 'emit');
      spyOn(component.rule3Clicked, 'emit');

      const btn = fixture.nativeElement.querySelector('.open-button button');
      btn.click();

      expect(component.rule3Clicked.emit).toHaveBeenCalledWith(msg);
      expect(component.toggleCollapse.emit).not.toHaveBeenCalled();
    });
  });

  describe('Open button visibility (Rule 3 only)', () => {
    it('should NOT render Open button for Rule 1', () => {
      const msg = makeChatMessage({ rule: 1, alignment: 'right' });
      fixture.componentRef.setInput('message', msg);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.open-button')).toBeNull();
    });

    it('should NOT render Open button for Rule 2', () => {
      const msg = makeChatMessage({ rule: 2, alignment: 'left' });
      fixture.componentRef.setInput('message', msg);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.open-button')).toBeNull();
    });

    it('should NOT render Open button for Rule 4 (collapsed or expanded)', () => {
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
