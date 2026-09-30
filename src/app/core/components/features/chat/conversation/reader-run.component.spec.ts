import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideMarkdown } from 'ngx-markdown';

import { AkgenticMessage } from '../../../../protocol/message.types';
import {
  agentReaderItems,
  ReaderRunBlock,
} from '../../../../services/process/selectors/agent-reader-items';
import { ChatMessage } from '../../../../services/process/selectors/chat-message.model';
import { chatFold } from '../../../../services/process/selectors/chat.selector';
import { runGraphFold, runKey } from '../../../../services/process/selectors/run-graph.selector';
import {
  provideTranslateTesting,
  setTestTranslations,
} from '../../../../../../testing/i18n-testing';
import {
  ASSISTANT,
  EXPERT,
  MANAGER,
  processed,
  received,
  sent,
  toolCall,
} from '../../../../../../testing/run-log-builders';
import { CASE_2, CASE_3, CASE_5 } from '../../../../../../testing/run-log-cases';
import type { AgentRef } from '../agent-reader.service';
import { ReaderRunComponent } from './reader-run.component';

/** The block of `agentId`'s run on `messageId`, folded as production folds. */
function blockOf(
  log: AkgenticMessage[],
  agentId: string,
  messageId: string,
  messages: ChatMessage[] = chatFold(log).messages,
): ReaderRunBlock {
  const items = agentReaderItems(runGraphFold(log), messages, agentId);
  const key = runKey(messageId, agentId);
  for (const item of items) {
    if (item.kind === 'run' && item.data.key === key) return item.data;
  }
  throw new Error(`no block ${key}`);
}

describe('ReaderRunComponent', () => {
  let fixture: ComponentFixture<ReaderRunComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ReaderRunComponent],
      providers: [provideMarkdown(), provideTranslateTesting()],
    }).compileComponents();
    fixture = TestBed.createComponent(ReaderRunComponent);
  });

  function render(block: ReaderRunBlock, inputs: Record<string, unknown> = {}): HTMLElement {
    fixture.componentRef.setInput('block', block);
    for (const [name, value] of Object.entries(inputs)) {
      fixture.componentRef.setInput(name, value);
    }
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  function stepKinds(el: HTMLElement): string[] {
    return Array.from(el.querySelectorAll('.reader-run-step')).map(
      (row) => row.getAttribute('data-step') ?? '',
    );
  }

  function bubbleIds(el: HTMLElement): string[] {
    return Array.from(el.querySelectorAll('app-chat-message')).map(
      (b) => b.getAttribute('data-message-id') ?? '',
    );
  }

  describe('the header', () => {
    it('says who asked, the status pill and the duration', () => {
      const el = render(blockOf(CASE_2, EXPERT.agent_id, 'De'));
      const head = el.querySelector('.reader-run-head')!;
      expect(head.textContent).toContain('chat.reader.run.askedBy');
      expect(head.textContent).toContain('@Manager');
      const pill = el.querySelector('.reader-run-pill')!;
      expect(pill.getAttribute('data-pill')).toBe('done');
      expect(pill.textContent).toContain('runInspector.status.done');
      expect(el.querySelector('.reader-run-duration')?.textContent).toContain('3s');
      expect(el.getAttribute('data-run-key')).toBeNull();
      expect(el.querySelector('[data-reader-run-key]')?.getAttribute('data-reader-run-key')).toBe(
        runKey('De', EXPERT.agent_id),
      );
    });

    it('reads running, with no clock, while the run is open', () => {
      const log = [sent('De', MANAGER, EXPERT, null, 1), received('De', EXPERT, 2)];
      const el = render(blockOf(log, EXPERT.agent_id, 'De'));
      expect(el.querySelector('.reader-run-pill')?.getAttribute('data-pill')).toBe('running');
      expect(el.querySelector('.reader-run-duration')).toBeNull();
    });

    it('says "asked by you" as plain text for your own message', () => {
      const el = render(blockOf(CASE_2, MANAGER.agent_id, 'U1'), { askerSelectable: true });
      const asker = el.querySelector('.reader-run-asker')!;
      expect(asker.textContent).toContain('chat.reader.run.askedByYou');
      expect(asker.querySelector('button')).toBeNull();
    });

    it('makes the asker a button only when it is selectable, and emits it', () => {
      const block = blockOf(CASE_2, EXPERT.agent_id, 'De');
      let el = render(block);
      expect(el.querySelector('.reader-run-asker-link')).toBeNull();
      expect(el.querySelector('.reader-run-asker-name')?.textContent).toContain('@Manager');

      const seen: AgentRef[] = [];
      fixture.componentInstance.askerSelected.subscribe((a) => seen.push(a));
      el = render(block, { askerSelectable: true });
      el.querySelector<HTMLButtonElement>('.reader-run-asker-link')!.click();
      expect(seen).toEqual([{ agentId: MANAGER.agent_id, actorName: MANAGER.name }]);
    });

    it('threads the step count into the toggle', () => {
      setTestTranslations({ chat: { reader: { run: { stepsMany: '<<{{count}}>>' } } } });
      const el = render(blockOf(CASE_2, EXPERT.agent_id, 'De'));
      expect(el.querySelector('.reader-run-toggle')?.textContent).toContain('<<2>>');
    });
  });

  describe('the fold', () => {
    it('shows the trigger and message steps folded, and hides the activity steps', () => {
      const el = render(blockOf(CASE_2, EXPERT.agent_id, 'De'));
      expect(bubbleIds(el)).toEqual([`env-De-${EXPERT.agent_id}`, `env-Re-${MANAGER.agent_id}`]);
      expect(stepKinds(el)).toEqual([]);
      const toggle = el.querySelector('.reader-run-toggle')!;
      expect(toggle.tagName).toBe('BUTTON');
      expect(toggle.getAttribute('type')).toBe('button');
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(toggle.getAttribute('aria-label')).toBe('chat.reader.run.expand');
    });

    it('shows the activity steps with their offsets once expanded', () => {
      const el = render(blockOf(CASE_2, EXPERT.agent_id, 'De'), { expanded: true });
      expect(stepKinds(el)).toEqual(['received', 'processed']);
      const offsets = Array.from(el.querySelectorAll('.reader-run-offset')).map((o) =>
        (o.textContent ?? '').trim(),
      );
      expect(offsets).toEqual(['+0s', '+3s']);
      const toggle = el.querySelector('.reader-run-toggle')!;
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(toggle.getAttribute('aria-label')).toBe('chat.reader.run.collapse');
    });

    it('asks the host to toggle, by run key', () => {
      const seen: string[] = [];
      fixture.componentInstance.blockToggle.subscribe((k) => seen.push(k));
      const el = render(blockOf(CASE_2, EXPERT.agent_id, 'De'));
      el.querySelector<HTMLButtonElement>('.reader-run-toggle')!.click();
      expect(seen).toEqual([runKey('De', EXPERT.agent_id)]);
    });

    it('marks failed and pending tools as the Run tab does', () => {
      const el = render(blockOf(CASE_5, ASSISTANT.agent_id, 'D2'), { expanded: true });
      const failed = el.querySelectorAll('.reader-run-step--failed');
      expect(failed.length).toBe(1);
      expect(failed[0].textContent).toContain('runInspector.step.failed');

      const log = [
        sent('De', MANAGER, EXPERT, null, 1),
        received('De', EXPERT, 2),
        // A tool call with no return yet.
        toolCall('t1', 'search', EXPERT, 'De', 3),
      ];
      const pending = render(blockOf(log, EXPERT.agent_id, 'De'), { expanded: true });
      expect(pending.textContent).toContain('runInspector.step.pending');
    });
  });

  describe('messages', () => {
    it('says the trigger is not in the loaded log when no message matches', () => {
      const log = [received('De', EXPERT, 2), processed('De', EXPERT, 3)];
      const el = render(blockOf(log, EXPERT.agent_id, 'De'));
      expect(el.querySelector('.reader-run-note')?.textContent).toContain(
        'runInspector.handling.unknown',
      );
      expect(bubbleIds(el)).toEqual([]);
    });

    it('renders an absorbed step as a row and then the bubble', () => {
      const el = render(blockOf(CASE_3, MANAGER.agent_id, 'Ra'));
      const section = el.querySelector('.reader-run')!;
      const order = Array.from(section.children)
        .filter((c) => c.matches('.reader-run-step, app-chat-message'))
        .map((c) => c.getAttribute('data-step') ?? c.getAttribute('data-message-id'));
      expect(order).toEqual([
        `env-Ra-${MANAGER.agent_id}`,
        'absorbed',
        `env-Re-${MANAGER.agent_id}`,
        `env-A-human-id`,
      ]);
      expect(section.querySelector('[data-step="absorbed"]')?.textContent).toContain(
        'runInspector.step.absorbed',
      );
    });

    it('falls back to a sent row when the sent message is not a ChatMessage', () => {
      const el = render(blockOf(CASE_2, EXPERT.agent_id, 'De', []));
      expect(bubbleIds(el)).toEqual([]);
      expect(stepKinds(el)).toEqual(['sent']);
      expect(el.textContent).toContain('runInspector.step.sent');
    });

    it('binds a question’s pending state from the host’s set', () => {
      const block = blockOf(CASE_5, MANAGER.agent_id, 'U1');
      const reader = fixture.componentInstance;
      render(block, { pendingIds: new Set(['S']) });
      const question = block.steps.flatMap((s) =>
        s.kind === 'message' && s.message?.message_id === 'S' ? [s.message] : [],
      )[0];
      expect(reader.isPending(question)).toBe(true);
      render(block, { pendingIds: new Set<string>() });
      expect(reader.isPending(question)).toBe(false);
    });

    it('re-emits the bubbles’ outputs unchanged', () => {
      const seen: ChatMessage[] = [];
      fixture.componentInstance.toggleCollapse.subscribe((m) => seen.push(m));
      const el = render(blockOf(CASE_2, EXPERT.agent_id, 'De'));
      el.querySelector<HTMLElement>('.collapsed-line')?.click();
      expect(seen.length).toBe(1);
    });
  });
});
