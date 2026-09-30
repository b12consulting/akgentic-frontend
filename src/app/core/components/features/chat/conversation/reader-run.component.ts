import { Component, input, output } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';

import { ActorAddress } from '../../../../protocol/message.types';
import {
  AgentColours,
  NO_AGENT_COLOURS,
} from '../../../../services/process/selectors/agent-colour';
import { ReaderRunBlock } from '../../../../services/process/selectors/agent-reader-items';
import { ChatMessage } from '../../../../services/process/selectors/chat-message.model';
import { RunKey } from '../../../../services/process/selectors/run-graph.selector';
import { RunPill } from '../../../../services/process/selectors/run-inspector';
import type { AgentRef } from '../agent-reader.service';
import { ChatMessageComponent } from '../message/chat-message.component';

/** The Run tab's pill keys, reused as they are. */
const PILL_KEYS: Record<RunPill, string> = {
  running: 'runInspector.status.running',
  done: 'runInspector.status.done',
  doneSilent: 'runInspector.status.doneSilent',
  waiting: 'runInspector.status.waiting',
  answered: 'runInspector.status.answered',
};

/**
 * One run of the open agent in the sub-agent reader (Epic 55, ADR-037 §D10):
 * who asked, the message that asked, and what the run did.
 *
 * Presentational. The trigger and the run's sent / absorbed messages are
 * bubbles, always shown; the activity steps are one-line rows behind the
 * block's fold. The host owns the fold (keyed by run key) and the bubbles'
 * collapse copies, and hands both down; this component writes nothing.
 */
@Component({
  selector: 'app-reader-run',
  standalone: true,
  imports: [ChatMessageComponent, TranslatePipe],
  templateUrl: './reader-run.component.html',
  styleUrl: './reader-run.component.scss',
})
export class ReaderRunComponent {
  readonly block = input.required<ReaderRunBlock>();
  readonly expanded = input<boolean>(false);
  /** The asker is on the reader's list and is not the open agent. */
  readonly askerSelectable = input<boolean>(false);
  readonly agentColours = input<AgentColours>(NO_AGENT_COLOURS);
  /** Inner ids of the rule-3 questions still owed an answer. */
  readonly pendingIds = input<ReadonlySet<string>>(new Set<string>());

  readonly blockToggle = output<RunKey>();
  readonly askerSelected = output<AgentRef>();
  readonly messageSelected = output<ChatMessage>();
  readonly agentSelected = output<AgentRef>();
  readonly toggleCollapse = output<ChatMessage>();

  readonly pillKeys = PILL_KEYS;

  isPending(message: ChatMessage): boolean {
    return message.rule === 3 && this.pendingIds().has(message.message_id);
  }

  stepsKey(count: number): string {
    return count === 1 ? 'chat.reader.run.stepsOne' : 'chat.reader.run.stepsMany';
  }

  onAsker(asker: ActorAddress): void {
    this.askerSelected.emit({ agentId: asker.agent_id, actorName: asker.name });
  }
}
