import { CommonModule } from '@angular/common';
import { Component, inject, Input, OnInit, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';

import { Observable, of } from 'rxjs';

import { MessageService } from 'primeng/api';
import { DropdownModule } from 'primeng/dropdown';
import { MultiSelectModule } from 'primeng/multiselect';
import { TextareaModule } from 'primeng/textarea';
import { TranslatePipe } from '@ngx-translate/core';
import { MentionModule } from 'angular-mentions';

import { TokenCountPipe } from '../../../../shared/pipes/token-count.pipe';

import { makeAgentNameUserFriendly } from '../../../../shared/util/util';
import { ConfigService } from '../../../../core/config/config.service';

import { ApiService } from '../../../../core/http/api.service';
import { FetchFailure } from '../../../../core/http/fetch.service';
import { ChatService } from '../../../../features/process/selectors/chat.selector';
import { ContextService } from '../../../../core/context/context.service';
import { GraphDataService, HUMAN_ROLE } from '../../../../features/process/selectors/graph.selector';
import { IngestionService } from '../../../../features/process/event/ingestion.service';

import {
  TeamTokenTotals,
  TokenUsageSelector,
} from '../../../../features/process/selectors/token-usage.selector';

import { ENTRY_POINT_NAME } from '../../../../features/process/selectors/chat-message.model';
import { defaultRecipientName } from '../../../../features/process/selectors/actor-kind';
import { CommandDescriptor } from '../../../../protocol/message.types';
import { NodeInterface } from '../../../../features/process/models/types';

/**
 * MATCH ANYWHERE IN THE NAME, not just at the front.
 *
 * `angular-mentions` filters with `startsWith`, which is the wrong end for
 * these two lists. A command is named for its FAMILY first — `get_graph`,
 * `search_graph`, `get_planning_task`, `search_planning` — so typing the thing
 * you are looking for (`graph`, `planning`) matches nothing, and you have to
 * already know the prefix to find the command that would have told you it. The
 * agent list has the same shape wherever a deployment prefixes its names.
 *
 * Substring, not fuzzy: a fuzzy matcher would reorder the list by score, and
 * both of these lists are deliberately ordered — the `/` list by tool family
 * (`disableSort: true` right below), the `@` list by the roster. Keeping the
 * order and narrowing it is the behaviour a reader can predict.
 *
 * Shared by both triggers so the two cannot drift into answering the same
 * keystroke differently.
 */
function matchesAnywhere(
  searchString: string,
  items: readonly { name?: string }[] = [],
): unknown[] {
  const needle = (searchString ?? '').toLowerCase();
  if (needle === '') return [...items];
  return items.filter((item) =>
    (item.name ?? '').toLowerCase().includes(needle),
  );
}

/**
 * Story 33-3: the submit lifecycle, as ONE value. `'restarting'` and
 * `'sending'` are separate phases because the control renders them
 * differently — a single boolean cannot say which one is in progress.
 */
type SubmitPhase = 'idle' | 'restarting' | 'sending';

@Component({
  selector: 'app-user-input',
  imports: [
    CommonModule,
    FormsModule,
    TextareaModule,
    DropdownModule,
    MultiSelectModule,
    MentionModule,
    TranslatePipe,
    TokenCountPipe,
  ],
  templateUrl: './user-input.component.html',
  styleUrl: './user-input.component.scss',
})
export class ProcessUserInputComponent implements OnInit {
  @Input() processId!: string;

  apiService: ApiService = inject(ApiService);
  chatService: ChatService = inject(ChatService);
  contextService: ContextService = inject(ContextService);
  graphDataService: GraphDataService = inject(GraphDataService);
  ingestionService: IngestionService = inject(IngestionService);
  private config = inject(ConfigService);
  private messageService: MessageService = inject(MessageService);
  userInput: string = '';
  userInputEnterKeySubmit: boolean = this.config.userInputEnterKeySubmit;

  /**
   * The team's running token cost, for the line beside the send button.
   *
   * OPTIONAL injection, and the reason is a real seam rather than defensiveness.
   * `TokenUsageSelector` is component-scoped on `ProcessComponent.providers`
   * (never `providedIn: 'root'`, because a root instance would carry one team's
   * totals into the next), and in the running app this composer is always
   * mounted inside that injector. It is NOT always mounted inside it in tests:
   * `ChatPanelComponent`'s spec builds the panel — and therefore this child —
   * in a bare TestBed, where a required injection would throw.
   *
   * Re-providing the selector here instead would compile and would be WRONG: it
   * would build a second one over a second `IngestionService` and report zeros
   * forever while the real totals climbed. Falling back to an explicit
   * all-zeros stream keeps the "no data" case exactly what the selector's own
   * contract says it is — zeros, never undefined — so the template needs no
   * null check and the line simply stays hidden.
   */
  private readonly tokenUsage = inject(TokenUsageSelector, { optional: true });
  readonly teamTotals$: Observable<TeamTokenTotals> =
    this.tokenUsage?.teamTotals$ ??
    of({ totalSent: 0, totalReceived: 0, totalCacheRead: 0, totalCacheWrite: 0 });

  /**
   * Story 33-3 (revises 33-1): where this submit is. Written ONLY in
   * `sendMessage()`, and returned to `'idle'` by the single `finally` there —
   * so its lifetime is the whole submit, restore *and* dispatch, rather than
   * just the restore. It both rejects a re-entrant submit (never queues it) and
   * drives the control's transient busy state, and because those two readings
   * come from one value they cannot disagree.
   */
  phase: SubmitPhase = 'idle';
  /**
   * Submit-control accessible-name KEY while the phase is `'restarting'`.
   * It was a visible label until the control became a circular glyph; the state
   * still has to be announced, so it moved to `aria-label`/`title` rather than
   * being dropped.
   */
  readonly restoreLabelKey: string = 'chat.input.restarting';

  /**
   * The one predicate the re-entrancy guard, the send button's `[disabled]` and
   * its spinner all share. A second boolean here would reintroduce
   * exactly the "two flags that must never disagree" defect story 33-3 removes.
   */
  get busy(): boolean {
    return this.phase !== 'idle';
  }

  // Mention configuration
  mentionItems: { name: string; actorName: string; agentId: string }[] = [];

  /**
   * ADR-013: live snapshot of the graph nodes — used to derive the
   * supervisor / entry-point default target for the main chat (Task 2.1).
   */
  private nodes: NodeInterface[] = [];
  // Dropdown configuration
  dropdownAgents: { label: string; value: string }[] = [];
  selectedAgents: string[] = [];
  // "Send as" human selector state (Story 7-1)
  humanAgents: NodeInterface[] = [];
  humanAgentOptions: { label: string; value: string }[] = [];
  selectedSender: string | null = null;
  /**
   * The last built mention config, with the identity of what it was built from.
   *
   * Keyed on references rather than contents: every part of the key is either a
   * primitive or an array the producer replaces wholesale, so `===` is both
   * cheap enough for a getter read on every change-detection pass and accurate.
   * See `buildMentionConfig` for why the reference must not churn.
   */
  private mentionConfigCache: {
    key: readonly unknown[];
    value: ReturnType<ProcessUserInputComponent['buildMentionConfig']>;
  } | null = null;

  private destroyRef = inject(DestroyRef);

  ngOnInit() {
    // Subscribe to nodes to populate mention items and dropdown agents
    this.graphDataService.nodes$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((nodes) => {
        this.nodes = nodes;
        const agents = nodes.filter(
          (n) => n.actorName.startsWith('@') && n.actorName !== ENTRY_POINT_NAME,
        );

        this.mentionItems = agents.map((node) => ({
          name: makeAgentNameUserFriendly(node.actorName),
          actorName: node.actorName,
          agentId: node.name,
        }));

        this.dropdownAgents = agents.map((node) => ({
          label: makeAgentNameUserFriendly(node.actorName),
          value: node.actorName,
        }));

        // Remove fired agents from selection
        this.selectedAgents = this.selectedAgents.filter((a) =>
          agents.some((n) => n.actorName === a),
        );

        // "Send as" human selector (Story 7-1, revised Story 7-3): populate
        // humanAgents / humanAgentOptions from the same emission. Visibility is
        // template-driven by humanAgents.length > 1. Routing wiring is
        // Story 7-2. Story 7-3 drops the actorName !== ENTRY_POINT_NAME clause
        // so @Human is a first-class selectable sender (ADR-007 Revision
        // 2026-04-15, FR2 amendment).
        this.humanAgents = nodes.filter((n) => n.role === HUMAN_ROLE);
        this.humanAgentOptions = this.humanAgents.map((n) => ({
          label: makeAgentNameUserFriendly(n.actorName),
          value: n.actorName,
        }));

        // NFR1 / Story 7-2: keep selectedSender coherent with the live roster.
        // Clear the selection when the chosen sender is fired, OR when the
        // non-entry-point human count drops below 2 (dropdown hidden — selection
        // would be invisible and stale).
        if (
          this.selectedSender !== null &&
          (this.humanAgents.length < 2 ||
            !this.humanAgents.some((n) => n.actorName === this.selectedSender))
        ) {
          this.selectedSender = null;
        }
      });
  }

  /**
   * Is there anyone else to send as?
   *
   * The Send-as pill is DISABLED rather than removed below this threshold. It
   * was gated out of the DOM by the same condition, which made the composer a
   * different shape on a single-human deployment than on a multi-human one —
   * the controls sat in different places for a reason the user could not see,
   * and "can I send as somebody else here?" had no answer on screen at all.
   *
   * Two, not one: the entry-point `@Human` is itself a selectable sender
   * (Story 7-3 / ADR-007 Revision 2026-04-15), so a team with one human has
   * nothing to choose BETWEEN, and a control offering a single option that is
   * already in effect is a control with no purpose.
   */
  get canChooseSender(): boolean {
    return this.humanAgents.length > 1;
  }

  /**
   * Comma-joined friendly labels of the current dropdown selection, e.g.
   * `@AgentA, @AgentB`. Used by the Send-to echo indicator in the template.
   * Empty string when no agent is selected (broadcast case).
   */
  get selectedAgentsDisplay(): string {
    return this.selectedAgents.map(makeAgentNameUserFriendly).join(', ');
  }

  /**
   * Redundant convenience for clearing the Send-to dropdown selection.
   * The p-multiSelect's own `[showClear]` chip remains the canonical clear
   * control; this method backs the `×` button on the Send-to echo indicator.
   */
  clearSendTo(): void {
    this.selectedAgents = [];
  }

  /**
   * Story 19-1 (ADR-016 §Decision 1) — send-origin key source for the just-sent
   * signal. Wrapped as an overridable method so specs can pin a deterministic
   * value. `apiService.sendMessage*` returns no message id synchronously
   * (Open Question 1), so the panel keys the top-anchor by send time and matches
   * the first user-originated (Rule 1) message at/after this timestamp.
   */
  protected nextJustSentKey(): string {
    return String(Date.now());
  }

  /**
   * Story 33-1 (ADR-024 §2): restore-then-send. A stopped team is restarted
   * first and the typed message is sent afterwards, so a stopped team is no
   * longer a read-only dead end and the user's intent is not lost.
   *
   * Story 33-3: the whole critical section — restore AND dispatch — sits inside
   * one `try`/`finally`, so the guard's lifetime is the submit's by
   * construction. A future `await` added inside that `try` is covered without
   * anyone remembering to widen a flag.
   */
  async sendMessage() {
    // A submit already in flight: reject this one, never queue it. The
    // template's `[disabled]` covers the click affordance, but the keydown
    // handlers call this method directly, so this early return is the only
    // defence on the keyboard path (story 33-3) — do not drop it.
    if (this.busy) {
      return;
    }
    if (!this.userInput || this.userInput.trim() === '') {
      return;
    }

    try {
      // Run state is consulted ONCE, and solely to decide whether a restore is
      // needed. It is never re-read or re-used as a gate on the dispatch below:
      // after a multi-second restore the captured value is stale by
      // construction, and the live one flips only when the cache refresh lands
      // (issue #235).
      const running = this.contextService.currentTeamRunning$.value;
      if (!running) {
        this.phase = 'restarting';
        if (!(await this.restoreBeforeSend())) {
          return;
        }
      }

      this.phase = 'sending';

      // Capture the send-origin key AFTER any restore and immediately before
      // dispatch — ADR-016 keys the top-anchor by send time, so a key taken
      // before the restore would be stale by the length of the restore. Emitted
      // only when a dispatch actually happens (never on the guards above, never
      // on the no-candidate-recipient guard inside `dispatch`).
      const justSentKey = this.nextJustSentKey();
      if (!(await this.dispatch(justSentKey))) {
        return;
      }

      this.userInput = '';
    } finally {
      // The ONE write back to idle, covering every exit path of both awaits.
      this.phase = 'idle';
    }
  }

  /**
   * Restart the team and wait for the team cache to report it running, so the
   * send that follows cannot race the backend's "team is not running"
   * rejection. Returns false when the restore failed or timed out — the caller
   * then dispatches nothing and leaves `userInput` untouched so the user can
   * retry.
   *
   * Story 33-5 (ADR-026 §3): the guard narrows on `FetchFailure`, the base type
   * whose meaning is "`FetchService` has already raised its own error toast" —
   * *having been reported*, not *being HTTP*. So an unreachable server
   * (`NetworkError`) and a 5xx (`HttpError`) are both silent here, while an rxjs
   * `TimeoutError` — the restore returned 200 but the team never came up within
   * the window, which nothing else has told the user about — still gets the
   * toast below. Narrowing on the base keeps that correct when a third failure
   * mode is added, instead of silently starting to double-toast.
   *
   * Story 33-3: this method does NO busy-state bookkeeping. It restores,
   * handles its own error, and returns a boolean. The phase belongs to the
   * submit, and a `finally` here would clear it before the dispatch is even
   * awaited — which is precisely the double-send window this story closed.
   */
  private async restoreBeforeSend(): Promise<boolean> {
    try {
      await this.contextService.restoreTeamAndAwait(this.processId);
      return true;
    } catch (err) {
      if (!(err instanceof FetchFailure)) {
        this.messageService.add({
          severity: 'error',
          summary: 'Could not restart the team',
          detail:
            'The team did not come back up in time. Your message was not sent — try again.',
        });
      }
      return false;
    }
  }

  /**
   * The four sender/recipient dispatch priorities (Story 7-2), unchanged.
   * Returns false when no candidate recipient exists (Priority 2 edge case) so
   * the caller preserves `userInput` and emits no just-sent key.
   */
  private async dispatch(justSentKey: string): Promise<boolean> {
    const hasSender = this.selectedSender !== null && this.selectedSender !== '';
    const hasRecipients = this.selectedAgents.length > 0;

    if (hasSender && hasRecipients) {
      // Priority 1: explicit sender + explicit recipients
      for (const recipient of this.selectedAgents) {
        await this.apiService.sendMessageFromTo(
          this.processId, this.selectedSender!, recipient, this.userInput,
        );
      }
      this.chatService.emitJustSent(justSentKey);
    } else if (hasSender && !hasRecipients) {
      // Priority 2: explicit sender, no recipient -> first dropdown agent
      const defaultRecipient = this.dropdownAgents[0]?.value;
      if (!defaultRecipient) {
        // AC #3: no candidate recipient exists -> do not send, preserve input
        return false;
      }
      await this.apiService.sendMessageFromTo(
        this.processId, this.selectedSender!, defaultRecipient, this.userInput,
      );
      this.chatService.emitJustSent(justSentKey);
    } else if (hasRecipients) {
      // Priority 3: default sender + explicit recipients (Story 3-1 preserved)
      for (const agentName of this.selectedAgents) {
        await this.apiService.sendMessage(this.processId, this.userInput, agentName);
      }
      this.chatService.emitJustSent(justSentKey);
    } else {
      // Priority 4: broadcast (Story 3-1 preserved)
      await this.apiService.sendMessage(this.processId, this.userInput);
      this.chatService.emitJustSent(justSentKey);
    }

    return true;
  }

  selectAgent = (item: any) => {
    return `${item.name} `;
  };

  /**
   * ADR-013 §3 — resolve the SINGLE agent the `/` command list targets in the
   * MAIN chat, by raw actor `name` (the Send-to key); `targetedAgentId()` then
   * maps that name to the agent's `agent_id` for the `store.commands` lookup:
   *   - exactly one "Send to" recipient   → that recipient;
   *   - zero recipients                   → supervisor / entry-point default;
   *   - multiple recipients (broadcast)   → null (no single target, AC-4).
   * Returns null when no single target resolves (the `/` list is then empty).
   */
  private resolveTargetedAgent(): string | null {
    if (this.selectedAgents.length > 1) return null;
    if (this.selectedAgents.length === 1) return this.selectedAgents[0];
    return this.defaultSupervisorTarget();
  }

  /**
   * ADR-013 §3 — supervisor / entry-point default for the main chat when no
   * "Send to" recipient is selected. Derived from existing graph state (no new
   * backend field): the agent whose parent is the `@Human` entry-point node.
   * Falls back to the first non-human agent when the parent link is absent,
   * and to null when no candidate agent exists.
   */
  private defaultSupervisorTarget(): string | null {
    // The rule moved to `defaultRecipientName` when the transcript started
    // asking it too — the composer asks in order to ROUTE, the transcript in
    // order to decide whether a recipient is worth naming. Two copies would
    // caption ordinary turns and fall silent on deliberate ones.
    return defaultRecipientName(this.nodes, ENTRY_POINT_NAME);
  }

  /**
   * Epic 17 (ADR-014 §2 / ADR-013 §3) — resolve the `/` target to its immutable
   * `agent_id`. `resolveTargetedAgent()` still returns an actor `name`; this maps
   * that name → the matching graph node's `name` field (which IS the `agent_id`
   * UUID, the same value placed in `mentionItems[i].agentId`). A name that does
   * not resolve to a live node yields `null` → empty `/` list (acceptable
   * transient, same posture as the just-hired case, ADR-013 §3). Keying by
   * `agent_id` (not the friendly name) is the ADR-013 keying fix: a display-name
   * reused after a fire/re-hire can never serve the wrong agent's commands.
   */
  private targetedAgentId(): string | null {
    const target = this.resolveTargetedAgent();
    if (!target) return null;
    const node = this.nodes.find((n) => n.actorName === target);
    return node ? node.name : null;
  }

  /**
   * ADR-013 / Epic 17 (ADR-014) — the `/` mention candidate list: the resolved
   * targeted agent's command descriptors (read from `store.commands` by
   * `agent_id`), mapped to dropdown items (`name` + `description` + ordered
   * `args`). Empty when no single target resolves (none/ambiguous, AC-4) or no
   * CommandsAnnouncedEvent has arrived yet for it (AC-6).
   */
  get commandItems(): {
    name: string;
    description: string;
    args: CommandDescriptor['args'];
  }[] {
    const agentId = this.targetedAgentId();
    if (!agentId) return [];
    const descriptors = this.ingestionService.commands.snapshot(agentId) ?? [];
    return descriptors
      // `_`-prefixed commands (e.g. `_expand_media_refs`) are internal, not
      // user-invocable — keep them out of the `/` dropdown.
      .filter((d) => !d.name.startsWith('_'))
      // `angular-mentions` renders a single flat list with no group headers, so
      // the best we can do is keep tool families adjacent: order by provenance
      // (`tool_card`) then command name. `.filter()` above returns a fresh
      // array, so sorting in place does not mutate the stored descriptors.
      .sort(
        (a, b) =>
          a.tool_card.localeCompare(b.tool_card) || a.name.localeCompare(b.name),
      )
      .map((d) => ({
        name: d.name,
        description: d.description,
        args: d.args,
      }));
  }

  /**
   * ADR-013 §2 — multi-trigger `angular-mentions` config. The `@` entry is
   * unchanged (AC-7); the `/` entry lists the targeted agent's commands and
   * inserts `/${name} ` via `selectCommand`. `allowSpace: false` closes the
   * dropdown at the first space (after the command name) so the user types
   * args freely; `maxItems`/`dropUp` mirror the `@` list.
   */
  get mentionConfig() {
    const armed = this.slashCommandsArmed;
    const agentId = this.targetedAgentId();
    const descriptors = agentId
      ? (this.ingestionService.commands.snapshot(agentId) ?? null)
      : null;

    // The identity of everything the config is built FROM. Cheap reference
    // comparisons: `mentionItems` is replaced wholesale on a roster emission
    // and `snapshot` hands back the stored array, so neither changes without
    // the content changing.
    const key: readonly unknown[] = [this.mentionItems, armed, agentId, descriptors];
    const cached = this.mentionConfigCache;
    if (cached && cached.key.every((part, i) => part === key[i])) {
      return cached.value;
    }

    const value = this.buildMentionConfig(armed);
    this.mentionConfigCache = { key, value };
    return value;
  }

  /**
   * A STABLE REFERENCE, and that is the whole point of the cache above it.
   *
   * `[mentionConfig]` is an Angular input, so the directive's `ngOnChanges`
   * fires whenever the object IDENTITY changes — and a getter that builds a
   * fresh object answers every change-detection pass with a new one. The
   * directive's `updateConfig` then re-runs, and `addConfig` ends with:
   *
   *     if (this.activeConfig.triggerChar == config.triggerChar) {
   *       this.activeConfig = config;
   *       this.updateSearchList();
   *     }
   *
   * — so while the dropdown is OPEN, every pass rebuilt its item list and reset
   * the list's scroll. Scrolling the dropdown is itself zone activity, so it
   * triggered the pass that undid it: the list flickered and could never reach
   * its end. `commandItems` compounded it by sorting a fresh array each call.
   *
   * Building only when an input actually changes breaks the loop, and costs
   * nothing else: the config is pure with respect to that key.
   */
  private buildMentionConfig(armed: boolean) {
    return {
      mentions: [
        {
          triggerChar: '@',
          labelKey: 'name',
          returnTrigger: true,
          allowSpace: true,
          mentionSelect: this.selectAgent,
          dropUp: true,
          // -1 = unlimited (the library default). A positive cap hard-truncates
          // the match list before rendering — items past the cap are absent
          // from the DOM, unreachable by scroll or arrow keys (issue #272).
          // The list itself is height-capped and scrollable (.scrollable-menu).
          maxItems: -1,
          mentionFilter: matchesAnywhere,
          items: this.mentionItems,
        },
        ...(armed
          ? [{
          triggerChar: '/',
          labelKey: 'name',
          allowSpace: false,
          mentionSelect: this.selectCommand,
          dropUp: true,
          // -1 = unlimited, same rationale as the `@` entry above (issue #272):
          // a cap of 10 made every command past the 10th unreachable.
          maxItems: -1,
          // `angular-mentions` re-sorts every list by `labelKey` (here `name`)
          // unless told not to — that would clobber the tool-family ordering
          // `commandItems` builds. Opt out so our `tool_card`-then-name order
          // survives to the dropdown.
          disableSort: true,
          mentionFilter: matchesAnywhere,
          items: this.commandItems,
        }]
          : []),
      ],
    };
  }

  /**
   * MAY A `/` OPEN THE COMMAND LIST RIGHT NOW?
   *
   * Only as the FIRST character of the message. `angular-mentions` has no
   * notion of position — `keyHandler` opens the list on any occurrence of a
   * trigger char, with no check on what precedes it — so a URL (`http://…`) or
   * an ordinary `and/or` popped the command menu in the middle of a sentence.
   *
   * There is no config flag for this, so the entry is withheld from the config
   * instead: a trigger that is not registered cannot fire. Empty input is the
   * armed state, because that is exactly when the next character typed lands at
   * position 0.
   *
   * It STAYS armed while the command name is being typed (`/cle…`), or the list
   * would close on the first keystroke after the slash. The space test is what
   * disarms it again: once the user is into the arguments, a later `/` is part
   * of what they are writing, not a new command. `allowSpace: false` already
   * closes the open list at that point — this stops it reopening.
   *
   * The `@` trigger is deliberately NOT restricted: naming an agent
   * mid-sentence is the normal way to write one.
   */
  private get slashCommandsArmed(): boolean {
    const text = this.userInput ?? '';
    return text === '' || (text.startsWith('/') && !text.includes(' '));
  }

  /**
   * ADR-013 §2 — insert `/${name} ` (leading slash + trailing space) for the
   * chosen command so the user keeps typing arguments. Does NOT send; the
   * literal text is sent verbatim on the existing Enter path (AC-5).
   */
  selectCommand = (item: { name: string }) => {
    return `/${item.name} `;
  };

  /**
   * ADR-013 §2 — render an args hint for a command dropdown row, e.g.
   * `<role> [name]`: required args in angle brackets, optional in square
   * brackets, in declared order. Empty string when the command takes no args.
   */
  commandArgsHint(args: CommandDescriptor['args']): string {
    return args
      .map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`))
      .join(' ');
  }
}
