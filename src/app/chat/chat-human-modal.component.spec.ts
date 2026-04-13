import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { provideMarkdown } from 'ngx-markdown';

import {
  ChatHumanModalComponent,
  HumanModalReply,
} from './chat-human-modal.component';
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
    parent_id: null,
    content: 'Hello world',
    sender: makeAddress({ name: '@Manager', role: 'Manager' }),
    recipient: makeAddress({ name: '@QATester', role: 'Human' }),
    timestamp: new Date('2026-04-08T10:00:00Z'),
    rule: 3,
    alignment: 'left',
    color: '#9ebbcb',
    collapsed: false,
    label: 'Manager ⇒ QATester',
    ...overrides,
  };
}

describe('ChatHumanModalComponent', () => {
  let component: ChatHumanModalComponent;
  let fixture: ComponentFixture<ChatHumanModalComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ChatHumanModalComponent, NoopAnimationsModule],
      providers: [provideMarkdown()],
    }).compileComponents();

    fixture = TestBed.createComponent(ChatHumanModalComponent);
    component = fixture.componentInstance;
  });

  it('should create', () => {
    fixture.detectChanges();
    expect(component).toBeTruthy();
  });

  describe('headerText', () => {
    it('should return default header when no agentPair', () => {
      fixture.detectChanges();
      expect(component.headerText).toBe('Human Input');
    });

    it('should format header with agent names', () => {
      fixture.componentRef.setInput('agentPair', {
        sender: makeAddress({ name: '@Manager-manager' }),
        recipient: makeAddress({ name: '@QATester-qa_tester' }),
      });
      fixture.detectChanges();

      expect(component.headerText).toContain('Manager');
      expect(component.headerText).toContain('⇒');
      expect(component.headerText).toContain('QATester');
    });
  });

  describe('onSend', () => {
    it('should emit reply with last message id and content', () => {
      const msgs = [
        makeChatMessage({ id: 'msg-1' }),
        makeChatMessage({ id: 'msg-2' }),
        makeChatMessage({ id: 'msg-3' }),
      ];
      fixture.componentRef.setInput('visible', true);
      fixture.componentRef.setInput('pendingMessages', msgs);
      fixture.detectChanges();

      const emitted: HumanModalReply[] = [];
      component.reply.subscribe((r: HumanModalReply) => emitted.push(r));

      component.replyText = 'Approved!';
      component.onSend();

      expect(emitted.length).toBe(1);
      expect(emitted[0].content).toBe('Approved!');
      expect(emitted[0].messageId).toBe('msg-3');
    });

    it('should not emit if reply text is empty', () => {
      fixture.componentRef.setInput('visible', true);
      fixture.componentRef.setInput('pendingMessages', [makeChatMessage()]);
      fixture.detectChanges();

      const emitted: HumanModalReply[] = [];
      component.reply.subscribe((r: HumanModalReply) => emitted.push(r));

      component.replyText = '   ';
      component.onSend();

      expect(emitted.length).toBe(0);
    });

    it('should not emit if no pending messages', () => {
      fixture.componentRef.setInput('visible', true);
      fixture.componentRef.setInput('pendingMessages', []);
      fixture.detectChanges();

      const emitted: HumanModalReply[] = [];
      component.reply.subscribe((r: HumanModalReply) => emitted.push(r));

      component.replyText = 'reply';
      component.onSend();

      expect(emitted.length).toBe(0);
    });

    it('should clear reply text after sending', () => {
      fixture.componentRef.setInput('visible', true);
      fixture.componentRef.setInput('pendingMessages', [makeChatMessage()]);
      fixture.detectChanges();

      component.replyText = 'test reply';
      component.onSend();

      expect(component.replyText).toBe('');
    });

    it('should emit visibleChange(false) after sending', () => {
      fixture.componentRef.setInput('visible', true);
      fixture.componentRef.setInput('pendingMessages', [makeChatMessage()]);
      fixture.detectChanges();

      const visibleChanges: boolean[] = [];
      component.visibleChange.subscribe((v: boolean) => visibleChanges.push(v));

      component.replyText = 'done';
      component.onSend();

      expect(visibleChanges).toContain(false);
    });
  });

  describe('onVisibleChange', () => {
    it('should emit false when dialog is closed', () => {
      fixture.detectChanges();
      const emitted: boolean[] = [];
      component.visibleChange.subscribe((v: boolean) => emitted.push(v));

      component.onVisibleChange(false);

      expect(emitted).toEqual([false]);
    });

    it('should NOT emit when value is true (dialog opens)', () => {
      fixture.detectChanges();
      const emitted: boolean[] = [];
      component.visibleChange.subscribe((v: boolean) => emitted.push(v));

      component.onVisibleChange(true);

      expect(emitted.length).toBe(0);
    });
  });
});
