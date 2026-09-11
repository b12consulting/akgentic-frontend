import { CommonModule } from '@angular/common';
import { Component, computed, input, output, signal } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';

import { ThinkingState, ThinkingToolEntry } from '../../selectors/chat.selector';
import { describeStep, StepNarration } from '../../selectors/step-narration';

/** A step plus the sentence it renders as. */
export interface NarratedStep extends StepNarration {
  step: ThinkingToolEntry;
}

/**
 * The activity fold: what an agent DID between being asked and answering.
 *
 * Collapsed (the default) it is one row carrying the latest step, replaced as
 * the next one starts. Expanded, the caret reveals the whole sequence. The
 * answer itself is never in here — it is a turn of its own, and the fold sits
 * strictly between the question and it.
 *
 * `expanded()` now GATES the list. It always had an input and the parent always
 * owned a `thinkingExpanded` Set, but the template rendered every entry
 * unconditionally and no `.expanded` rule existed, so the wiring was inert and
 * a long run buried the conversation under its own tool calls. The docstring
 * this replaces already described the gate as though it were implemented.
 *
 * Clicking the row emits `toggleExpanded` with the state's
 * `anchor_message_id`; the parent owns the expansion Set so it survives
 * re-emissions of `thinkingAgents$`.
 */
@Component({
  selector: 'app-chat-thinking',
  standalone: true,
  imports: [CommonModule, TranslatePipe],
  templateUrl: './chat-thinking.component.html',
  styleUrl: './chat-thinking.component.scss',
})
export class ChatThinkingComponent {
  state = input.required<ThinkingState>();
  expanded = input<boolean>(false);
  toggleExpanded = output<string>();

  /** The step shown while collapsed. Last-in wins: the row reports what the
   *  agent is doing NOW, not what it started with. */
  latest = computed<ThinkingToolEntry | null>(() => {
    const tools = this.state().tools;
    return tools.length > 0 ? tools[tools.length - 1] : null;
  });

  stepCount = computed<number>(() => this.state().tools.length);

  /** Copy for the collapsed row: what kind of step, and whether it is still
   *  running. Four keys rather than a built string, so a translator sees whole
   *  sentences and word order stays theirs. */
  latestKey = computed<string>(() => {
    const step = this.latest();
    if (step?.kind === 'contact') {
      return this.state().final
        ? 'chat.activity.latestContactDone'
        : 'chat.activity.latestContact';
    }
    return this.state().final
      ? 'chat.activity.latestDone'
      : 'chat.activity.latest';
  });

  /** Steps as sentences. Recomputed with the state, so a step appended
   *  mid-run narrates itself without a second source of truth. */
  narratedSteps = computed<NarratedStep[]>(() =>
    this.state().tools.map((step) => ({ ...describeStep(step), step })),
  );

  /** Raw payloads are OFF every time the fold opens. It is an escape hatch, not
   *  a preference: a run whose raw stayed open from three runs ago is a wall of
   *  JSON nobody asked for. */
  rawOpen = signal(false);

  onToggleRaw(event: MouseEvent): void {
    // The row toggles the fold; this button must not also collapse it.
    event.stopPropagation();
    this.rawOpen.update((v) => !v);
  }

  trackByStepId(_: number, n: NarratedStep): string {
    return n.step.tool_call_id;
  }

  /**
   * The trailing "What happened" / "Hide" label.
   *
   * The whole row is a click target and this button sits inside it, so a bare
   * bubbling click would toggle twice and land back where it started. It stops
   * there and re-enters through the same method the row uses, rather than
   * duplicating the guard and the raw-close that method owns.
   *
   * The button exists at all because the row is a `<div>`: a click target with
   * nothing focusable in it cannot be reached from a keyboard, and this label
   * is what a reader is looking at when they decide to open the fold.
   */
  onToggleFromLabel(event: MouseEvent): void {
    event.stopPropagation();
    this.onClick();
  }

  onClick(): void {
    // A run with no steps has nothing to open; emitting anyway would toggle a
    // Set entry the template can never act on.
    if (this.stepCount() === 0) return;
    // Closing the fold closes the raw with it, so reopening starts clean.
    if (this.expanded()) this.rawOpen.set(false);
    this.toggleExpanded.emit(this.state().anchor_message_id);
  }

  /** Stable tracking so a new tool append does not re-render existing rows. */
  trackByToolId(_: number, t: ThinkingToolEntry): string {
    return t.tool_call_id;
  }
}
