import { CommonModule } from '@angular/common';
import { Component, computed, inject, input, output, signal } from '@angular/core';
import { animate, style, transition, trigger } from '@angular/animations';
import { TranslatePipe } from '@ngx-translate/core';

import { I18nService } from '../../../core/i18n/i18n.service';
import { ThinkingState, ThinkingToolEntry } from '../../../services/process/selectors/chat.selector';
import { describeStep, StepNarration } from '../../../services/process/selectors/step-narration';

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
/**
 * Opening and closing the step list.
 *
 * THIS ONE ANIMATES CLEANLY BECAUSE NOTHING SWAPS. The summary line stays put
 * and the list appears beneath it, so there is only ever one element entering
 * or leaving and no second row whose height has to be reconciled with it. The
 * notification row could not be animated this way, which is why it opens its
 * text in place instead.
 *
 * Height AND opacity: height alone slides fully-drawn rows through a moving
 * window, which reads as a clipping fault rather than as an opening.
 */
const STEPS_REVEAL = trigger('stepsReveal', [
  transition(':enter', [
    style({ height: 0, opacity: 0, overflow: 'hidden' }),
    animate(
      '210ms cubic-bezier(0.22, 0.61, 0.36, 1)',
      style({ height: '*', opacity: 1 }),
    ),
  ]),
  transition(':leave', [
    style({ height: '*', opacity: 1, overflow: 'hidden' }),
    animate(
      '210ms cubic-bezier(0.22, 0.61, 0.36, 1)',
      style({ height: 0, opacity: 0 }),
    ),
  ]),
]);

@Component({
  selector: 'app-chat-thinking',
  standalone: true,
  imports: [CommonModule, TranslatePipe],
  templateUrl: './chat-thinking.component.html',
  styleUrl: './chat-thinking.component.scss',
  animations: [STEPS_REVEAL],
})
export class ChatThinkingComponent {
  state = input.required<ThinkingState>();
  expanded = input<boolean>(false);
  toggleExpanded = output<string>();

  private readonly i18n = inject(I18nService);

  /** The step shown while collapsed. Last-in wins: the row reports what the
   *  agent is doing NOW, not what it started with. */
  latest = computed<ThinkingToolEntry | null>(() => {
    const tools = this.state().tools;
    return tools.length > 0 ? tools[tools.length - 1] : null;
  });

  stepCount = computed<number>(() => this.state().tools.length);

  /*
   * NOT A `quiet-line`, deliberately.
   *
   * The transcript runs consecutive quiet rows together — see
   * `ChatMessageComponent.isQuietLine` — and this fold looks like one of them
   * while collapsed: a single line saying what an agent did. It is not one.
   *
   * The rows that run together are what an agent's work PRODUCED — a string of
   * notices reporting the same piece of work. The fold is the work itself, and
   * it is the row a reader uses to tell where one agent's turn ends and the
   * next begins. Closing the notices up against it merges those two things into
   * one block and loses exactly the boundary the fold exists to draw.
   *
   * So the fold keeps a full turn's gap on both sides, and the notices beneath
   * it stack against each other.
   */

  /**
   * WHO THE RUN CONTACTED — all of them, in the order first reached.
   *
   * The row used to name `latest().tool_name`, which is the LAST step, so a
   * manager that asked two agents in one run reported only the second: "asked
   * @Assistant / asked @Expert" opened out of a fold whose closed line said
   * "contacted @Expert". The count beside it ("2 steps") said the row was
   * incomplete without saying what it had left out.
   *
   * Distinct, because asking the same agent twice in one run is one
   * relationship, not two — and a name repeated in a list reads as a bug.
   *
   * `Intl.ListFormat` rather than `join(' and ')`: the conjunction and the
   * comma rules are the locale's, not this component's, and this file has no
   * business deciding that French says "et". The language comes from
   * `I18nService`, the same one the pipes resolve against, so the row cannot
   * disagree with the sentence around it.
   */
  contactedAgents = computed<string>(() => {
    const names = [
      ...new Set(
        this.state()
          .tools.filter((step) => step.kind === 'contact')
          .map((step) => step.tool_name),
      ),
    ];
    return this.listFormatter().format(names);
  });

  /**
   * What the collapsed row names: every agent contacted, or the latest tool.
   *
   * One expression rather than a branch in the template, because the two cases
   * fill the SAME `{{tool}}` placeholder — `latestKey` has already decided
   * which sentence is being spoken, and this decides what goes in its one slot.
   */
  latestSubject = computed<string>(() => {
    const step = this.latest();
    return step?.kind === 'contact' ? this.contactedAgents() : (step?.tool_name ?? '');
  });

  private listFormatter = computed<Intl.ListFormat>(
    () =>
      new Intl.ListFormat(this.i18n.currentLanguage || undefined, {
        style: 'long',
        type: 'conjunction',
      }),
  );

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
