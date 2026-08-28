import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { BehaviorSubject } from 'rxjs';

import { ActorAddress } from '../../../../protocol/message.types';
import { ChatMessage } from '../../selectors/chat-message.model';
import { Feedback, FeedbackService } from '../../ui-state/feedback.service';
import { FeedbackComponent } from './feedback.component';

/**
 * Epic 57 — the first specs this component has ever had. It was written,
 * committed and imported by nothing, so none of its assumptions about
 * `ChatMessage` had been exercised even once.
 *
 * What is pinned here is what wiring it made true: the gate is the shared
 * predicate rather than a magic number, a rating already given comes back
 * visible (FR8), and neither of those depends on the component instance
 * surviving — the chat list rebuilds rows constantly (T4).
 */

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
    content: 'the answer',
    sender: makeAddress({ name: '@Manager', role: 'Manager' }),
    recipient: makeAddress({ name: '@Human', role: 'Human' }),
    timestamp: new Date('2026-04-08T10:00:00Z'),
    rule: 2,
    alignment: 'left',
    color: 'transparent',
    collapsed: false,
    label: '@Manager ⇒ You',
    ...overrides,
  };
}

function makeFeedback(message: ChatMessage, isPositive: boolean): Feedback {
  return { message, isPositive, comment: 'because it was accurate' };
}

describe('FeedbackComponent', () => {
  let fixture: ComponentFixture<FeedbackComponent>;
  let component: FeedbackComponent;
  let feedbacks$: BehaviorSubject<Feedback[]>;
  let loadCalls: number;
  let setFeedback: jasmine.Spy;

  beforeEach(async () => {
    feedbacks$ = new BehaviorSubject<Feedback[]>([]);
    loadCalls = 0;
    setFeedback = jasmine.createSpy('setFeedback').and.resolveTo(undefined);

    const feedbackService = {
      feedbacks$,
      loadFeedback: () => {
        loadCalls += 1;
        return Promise.resolve();
      },
      setFeedback,
    } as unknown as FeedbackService;

    await TestBed.configureTestingModule({
      imports: [FeedbackComponent, NoopAnimationsModule],
      providers: [{ provide: FeedbackService, useValue: feedbackService }],
    }).compileComponents();

    fixture = TestBed.createComponent(FeedbackComponent);
    component = fixture.componentInstance;
  });

  function render(message: ChatMessage) {
    fixture.componentRef.setInput('message', message);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  describe('the gate is the shared rule', () => {
    it('shows the thumbs on an agent answer', () => {
      const el = render(makeChatMessage({ rule: 2 }));
      expect(el.querySelector('.feedback-icons')).not.toBeNull();
    });

    it('shows nothing on a turn the rule excludes', () => {
      for (const rule of [1, 5, 6, 7] as const) {
        const el = render(makeChatMessage({ rule }));
        expect(el.querySelector('.feedback-icons'))
          .withContext(`rule ${rule}`)
          .toBeNull();
      }
    });
  });

  describe('FR8 — a rating already given is visible on return', () => {
    it('marks the thumb the user chose when a rating already exists', () => {
      const message = makeChatMessage({ id: 'rated-1' });
      feedbacks$.next([makeFeedback(message, true)]);

      const el = render(message);

      expect(el.querySelector('.pi-thumbs-up')!.classList).toContain('selected');
      expect(el.querySelector('.pi-thumbs-down')!.classList).not.toContain(
        'selected',
      );
    });

    it('marks the negative thumb for a negative rating', () => {
      const message = makeChatMessage({ id: 'rated-2' });
      feedbacks$.next([makeFeedback(message, false)]);

      const el = render(message);

      expect(el.querySelector('.pi-thumbs-down')!.classList).toContain(
        'selected',
      );
      expect(el.querySelector('.pi-thumbs-up')!.classList).not.toContain(
        'selected',
      );
    });

    it('keeps a rated control visible when the turn is not hovered', () => {
      // The `rated` host class is what overrides the hover-to-reveal rule.
      // Without it a returning user sees nothing and rates the same answer
      // twice, which is the failure FR8 names.
      const message = makeChatMessage({ id: 'rated-3' });
      feedbacks$.next([makeFeedback(message, true)]);

      render(message);

      expect(fixture.debugElement.nativeElement.classList).toContain('rated');
    });

    it('leaves an unrated turn unmarked, so its control stays quiet', () => {
      render(makeChatMessage({ id: 'unrated-1' }));
      expect(fixture.debugElement.nativeElement.classList).not.toContain(
        'rated',
      );
    });

    it('ignores a rating belonging to a different message', () => {
      // Keyed by message id, not by position or arrival order — the whole
      // list re-emits and every control sees every rating.
      feedbacks$.next([makeFeedback(makeChatMessage({ id: 'other' }), true)]);

      const el = render(makeChatMessage({ id: 'mine' }));

      expect(el.querySelector('.pi-thumbs-up')!.classList).not.toContain(
        'selected',
      );
      expect(fixture.debugElement.nativeElement.classList).not.toContain(
        'rated',
      );
    });
  });

  describe('T4 — the rating outlives the list re-emitting', () => {
    it('picks a rating up when it arrives after the control rendered', () => {
      const message = makeChatMessage({ id: 'late-1' });
      const el = render(message);
      expect(el.querySelector('.pi-thumbs-up')!.classList).not.toContain(
        'selected',
      );

      feedbacks$.next([makeFeedback(message, true)]);
      fixture.detectChanges();

      expect(el.querySelector('.pi-thumbs-up')!.classList).toContain('selected');
    });

    it('recovers the rating on a freshly built control for the same message', () => {
      // The chat list rebuilds rows on every emission. State held privately by
      // a component would be gone here, and the rating would look unsaved
      // while the request had in fact succeeded.
      const message = makeChatMessage({ id: 'rebuilt-1' });
      feedbacks$.next([makeFeedback(message, false)]);

      const rebuilt = TestBed.createComponent(FeedbackComponent);
      rebuilt.componentRef.setInput('message', message);
      rebuilt.detectChanges();

      expect(
        (rebuilt.nativeElement as HTMLElement).querySelector('.pi-thumbs-down')!
          .classList,
      ).toContain('selected');
      expect(rebuilt.debugElement.nativeElement.classList).toContain('rated');
    });
  });

  describe('submitting', () => {
    it('opens the dialog on a thumb, and submits against the message id', async () => {
      const message = makeChatMessage({ id: 'submit-1' });
      const el = render(message);

      el.querySelector<HTMLElement>('.pi-thumbs-up')!.click();
      fixture.detectChanges();
      expect(component.displayModal$.value).toBeTrue();

      component.onInputChange('clear and correct');
      component.submitFeedback();

      expect(setFeedback).toHaveBeenCalledWith('submit-1', {
        message,
        isPositive: true,
        comment: 'clear and correct',
      });
      expect(component.displayModal$.value).toBeFalse();
    });

    it('closes the dialog without submitting on cancel', () => {
      render(makeChatMessage());
      component.openFeedbackModal(false);
      expect(component.displayModal$.value).toBeTrue();

      component.onCancel();

      expect(component.displayModal$.value).toBeFalse();
      expect(setFeedback).not.toHaveBeenCalled();
    });
  });

  describe('loading', () => {
    it('asks the service to load, once, when it mounts', () => {
      render(makeChatMessage());
      expect(loadCalls).toBe(1);
    });

    it('drops its subscription when the turn is destroyed', () => {
      render(makeChatMessage({ id: 'destroyed-1' }));
      expect(feedbacks$.observed).toBeTrue();

      fixture.destroy();

      expect(feedbacks$.observed).toBeFalse();
    });
  });
});
