import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { BehaviorSubject } from 'rxjs';

import { UtilService } from '../../../../core/ui/utils.service';
import { ActorAddress } from '../../../../protocol/message.types';
import { provideTranslateTesting } from '../../../../../testing/i18n-testing';
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
 *
 * The selectors are the row's OWN classes (`.action-copy`, `.action-thumb-up`,
 * `.action-thumb-down`), not the glyph library's. They used to be `.pi-thumbs-up`
 * / `.pi-thumbs-down`, which pinned the icon set: swapping PrimeIcons for the
 * console's own inline SVGs broke every assertion here without a single one of
 * them being about an icon. A class the component states is the seam a spec is
 * entitled to hold.
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
  let copyToClipboard: jasmine.Spy;

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

    copyToClipboard = jasmine.createSpy('copyToClipboard');

    await TestBed.configureTestingModule({
      imports: [FeedbackComponent, NoopAnimationsModule],
      providers: [
        provideTranslateTesting(),
        { provide: FeedbackService, useValue: feedbackService },
        // The real one reaches for the CDK `Clipboard` and PrimeNG's
        // `MessageService`; neither is what any assertion here is about, and a
        // spec that mounted them would be testing the toast.
        { provide: UtilService, useValue: { copyToClipboard } as unknown as UtilService },
      ],
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
    it('shows the action row on an agent answer', () => {
      const el = render(makeChatMessage({ rule: 2 }));
      expect(el.querySelector('.action-row')).not.toBeNull();
    });

    it('shows nothing on a turn the rule excludes', () => {
      for (const rule of [1, 5, 6, 7] as const) {
        const el = render(makeChatMessage({ rule }));
        expect(el.querySelector('.action-row'))
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

      expect(el.querySelector('.action-thumb-up')!.classList).toContain('is-chosen');
      expect(el.querySelector('.action-thumb-down')!.classList).not.toContain(
        'is-chosen',
      );
    });

    it('marks the negative thumb for a negative rating', () => {
      const message = makeChatMessage({ id: 'rated-2' });
      feedbacks$.next([makeFeedback(message, false)]);

      const el = render(message);

      expect(el.querySelector('.action-thumb-down')!.classList).toContain(
        'is-chosen',
      );
      expect(el.querySelector('.action-thumb-up')!.classList).not.toContain(
        'is-chosen',
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

      expect(el.querySelector('.action-thumb-up')!.classList).not.toContain(
        'is-chosen',
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
      expect(el.querySelector('.action-thumb-up')!.classList).not.toContain(
        'is-chosen',
      );

      feedbacks$.next([makeFeedback(message, true)]);
      fixture.detectChanges();

      expect(el.querySelector('.action-thumb-up')!.classList).toContain('is-chosen');
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
        (rebuilt.nativeElement as HTMLElement).querySelector('.action-thumb-down')!
          .classList,
      ).toContain('is-chosen');
      expect(rebuilt.debugElement.nativeElement.classList).toContain('rated');
    });
  });

  describe('the action row is the mock\'s three controls', () => {
    it('renders copy, thumb-up and thumb-down, in that order', () => {
      // The order is the mock's and it is not arbitrary: copy is the thing a
      // reader reaches for constantly and the ratings are the thing they reach
      // for rarely, so the common action is nearest the prose.
      const el = render(makeChatMessage({ rule: 2 }));
      const buttons = Array.from(
        el.querySelectorAll('.action-row app-icon-button'),
      ).map((node) => node.className.split(/\s+/)[0]);

      expect(buttons).toEqual([
        'action-copy',
        'action-thumb-up',
        'action-thumb-down',
      ]);
    });

    it('gives every control a real button with an accessible name', () => {
      // The row shipped as three bare `<i>` glyphs: unreachable by keyboard and
      // unannounced. This is the assertion that stops that regressing.
      const el = render(makeChatMessage({ rule: 2 }));
      const buttons = el.querySelectorAll<HTMLButtonElement>(
        '.action-row app-icon-button button',
      );

      expect(buttons.length).toBe(3);
      for (const button of Array.from(buttons)) {
        expect(button.getAttribute('aria-label')).toBeTruthy();
      }
    });

    it('copies the turn\'s RAW content, not its rendered text', () => {
      // What the agent sent is markdown, and a paste is nearly always headed
      // somewhere that understands it. Scraping the rendered DOM would flatten
      // the structure the author put there.
      const message = makeChatMessage({ content: '# Heading\n\n- a\n- b' });
      const el = render(message);

      el.querySelector<HTMLButtonElement>('.action-copy button')!.click();

      expect(copyToClipboard).toHaveBeenCalledWith('# Heading\n\n- a\n- b');
    });

    it('does not open the rating dialog when copy is pressed', () => {
      const el = render(makeChatMessage());
      el.querySelector<HTMLButtonElement>('.action-copy button')!.click();
      expect(component.displayModal$.value).toBeFalse();
    });
  });

  describe('submitting', () => {
    it('opens the dialog on a thumb, and submits against the message id', async () => {
      const message = makeChatMessage({ id: 'submit-1' });
      const el = render(message);

      el.querySelector<HTMLButtonElement>('.action-thumb-up button')!.click();
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
