import { ChatMessage } from './chat-message.model';
import { ThinkingState, contactStepMessageIds } from './chat.selector';
import { DaySeparator, daySeparatorsFor } from './day-separator';

/** A row of the transcript that is a TURN — something an agent or the user
 *  actually did. These are the rows the day arithmetic is computed over. */
export type TurnDisplayItem =
  | { kind: 'message'; data: ChatMessage }
  | { kind: 'thinking'; data: ThinkingState };

/**
 * Discriminated-union item rendered inline in a transcript.
 *
 * `day` is chrome, not content (Epic 54 / NFR1): it has no sender, is not
 * selectable, is not collapsible and takes no part in reply routing. It exists
 * only in this list — nothing upstream knows about it, and it is never counted
 * as a message (the chat panel's `chatMessages` and `prevCount` are still built
 * from the classified stream alone, so the scroll model and the "New messages"
 * pill are untouched by it).
 */
export type DisplayItem = TurnDisplayItem | { kind: 'day'; data: DaySeparator };

/**
 * Merge turns + activity folds into one chronologically sorted list, then mark
 * the calendar-day boundaries in it (Epic 54).
 *
 * ---------------------------------------------------------------------------
 * WHY THE SECOND ARGUMENT IS `runs` AND NOT "all runs plus a scope"
 * ---------------------------------------------------------------------------
 * The contact-step exclusion set below is derived from the array this function
 * is HANDED. That is the whole reason the signature is shaped this way, and it
 * is not a detail a caller may optimise away:
 *
 *   A rule-4 message that a run absorbed as a contact step is already on screen
 *   INSIDE that run's fold. Rendering its own row as well would show the same
 *   message twice. So an absorbed message is dropped — but only because the
 *   fold that swallowed it is being rendered.
 *
 * Hand in the GLOBAL run list while rendering a SUBSET of the runs and the
 * arithmetic inverts: messages get deleted from the screen with no fold left to
 * show them in. In the sub-agent reader that is @Manager's instruction to
 * @Expert vanishing — taking with it the only explanation of why @Expert ran.
 * The symptom is silent and looks like data loss, so keep exclusion and
 * rendering derived from one and the same array.
 */
export function buildDisplayItems(
  messages: readonly ChatMessage[],
  runs: readonly ThinkingState[],
): DisplayItem[] {
  const items: TurnDisplayItem[] = [];
  // Keyed by outer envelope id, so a rule-4 message that reached no live run
  // still gets a row of its own.
  const absorbed = contactStepMessageIds(runs);
  for (const m of messages) {
    if (absorbed.has(m.id)) continue;
    items.push({ kind: 'message', data: m });
  }
  for (const t of runs) items.push({ kind: 'thinking', data: t });
  items.sort((a, b) => {
    const ta = turnTime(a);
    const tb = turnTime(b);
    if (ta !== tb) return ta - tb;
    // Tie-break: messages before thinking bubbles.
    if (a.kind === b.kind) return 0;
    return a.kind === 'message' ? -1 : 1;
  });
  return withDaySeparators(items);
}

/**
 * The runs that belong in the MAIN transcript — the user's own inbox.
 *
 * ---------------------------------------------------------------------------
 * THE SCOPING RULE: a run belongs to the conversation whose inbox is on screen,
 * decided by the SENDER OF ITS ANCHOR MESSAGE.
 * ---------------------------------------------------------------------------
 * `anchor_message_id` is the inner `BaseMessage.id` of the message the run is
 * answering, which is the same id space as `ChatMessage.message_id`. Resolving
 * it answers the only question that matters here — "who asked for this work?" —
 * which `agent_id` cannot: `agent_id` says who RAN, never on whose behalf.
 * Without this, every agent's run lands in the user's transcript and the human
 * reads "@Expert contacted @Manager" out of a conversation they are not part
 * of; the noise scales with team size.
 *
 * Three things this rule is deliberately NOT:
 *
 *  - NOT keyed on the entry-point NAME (`@Human`). `sender.role === 'Human'` is
 *    the test. `classifyRule` gives rule 4 to a message from a non-entry-point
 *    human seat, which is exactly what Send-as and a routed human reply
 *    produce; keying on the name would drop every multi-human deployment's runs
 *    out of the main transcript.
 *  - NOT evaluated at run CLOSURE ("did this run produce a user-facing
 *    message?"). The anchor exists the instant the run opens, so a LIVE run is
 *    classified immediately. A closure rule leaves the bubble invisible for the
 *    whole time it is actually interesting and then pops it in after the answer
 *    it was meant to explain.
 *  - NOT an agent-LEVEL rule ("does this agent ever talk to the user?"). The
 *    moment the team graph has a cycle, that pulls an agent's purely internal
 *    runs back in. Attribution is per-RUN.
 *
 * FAIL-OPEN on an unresolved anchor. `messageFromSent` drops empty-content and
 * ActorSystem messages, a compaction or clear truncates history, and a REST
 * replay can begin mid-conversation — so an anchor that resolves to nothing is
 * normal, not corrupt. Fail-closed would make a live bubble silently disappear;
 * fail-open's worst case is the behaviour that shipped before this rule existed.
 *
 * `messages` MUST be the full classified list, never an already-filtered row
 * list: a rule-4 contact message is hidden as a ROW while still present in the
 * log, and it is precisely the anchor that scopes the delegated run OUT.
 * Resolving against rows makes it unresolvable, and fail-open then reinstates
 * the exact bug this function exists to fix.
 */
export function mainTranscriptRuns(
  messages: readonly ChatMessage[],
  runs: readonly ThinkingState[],
): ThinkingState[] {
  const byMessageId = new Map<string, ChatMessage>();
  for (const m of messages) byMessageId.set(m.message_id, m);
  return runs.filter((run) => {
    const anchor = byMessageId.get(run.anchor_message_id);
    if (anchor === undefined) return true; // fail-open — see docstring
    return anchor.sender.role === 'Human';
  });
}

/**
 * The runs of ONE agent — the reader's half of the same scoping rule.
 *
 * Matching is on `agent_id` because that is the identity the graph nodes and
 * the app's selection are keyed by, and two agents can share a display name.
 */
export function agentRuns(
  runs: readonly ThinkingState[],
  agentId: string | null | undefined,
): ThinkingState[] {
  if (!agentId) return [];
  return runs.filter((run) => run.agent_id === agentId);
}

/**
 * Stable tracking key for the mixed display list.
 *
 * A day separator has no message id (Trap T4). Keying it on its calendar day
 * gives it an identity that is unique within the list and CONSTANT across
 * emissions — a transcript re-emits on every event, and a key derived from the
 * index or from the neighbouring message id would move each time a turn was
 * appended, tearing down and rebuilding every row below it.
 */
export function trackDisplayItem(_: number, item: DisplayItem): string {
  switch (item.kind) {
    case 'message':
      return 'message:' + item.data.id;
    case 'thinking':
      return 'thinking:' + item.data.anchor_message_id;
    case 'day':
      return 'day:' + item.data.day;
  }
}

/** Milliseconds of a turn row (`NaN` when its timestamp is unusable — which
 *  `Array.prototype.sort` treats as "leave it where it is", the same as the
 *  pre-Epic-54 comparator did). */
function turnTime(item: TurnDisplayItem): number {
  return item.kind === 'message'
    ? item.data.timestamp.getTime()
    : item.data.start_time.getTime();
}

/**
 * Interleave day separators into an already-sorted run of turns.
 *
 * All of the judgement lives in `daySeparatorsFor` (pure, and unit-tested
 * without a fixture per NFR2); this function only splices. Note what is NOT
 * here:
 *
 * - No special case for a boundary inside a collapsed run (Trap T3). Collapsed
 *   Rule 3/4 rows are ordinary siblings of the flat list, not children of a
 *   wrapping block, so a separator between two of them breaks nothing and hides
 *   nothing. The rule is: the separator goes where the day changes, collapsed or
 *   not, and the collapsed rows either side keep their own behaviour.
 * - No special case for the first row. `daySeparatorsFor` already guarantees
 *   index 0 is never marked (FR2), so this can never emit a rule above the
 *   first turn — and the list is still empty exactly when there are no turns,
 *   which the templates' empty-state gates rely on.
 */
function withDaySeparators(items: TurnDisplayItem[]): DisplayItem[] {
  const separators = daySeparatorsFor(items.map(turnTimestamp));
  const out: DisplayItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const separator = separators[i];
    if (separator !== null) out.push({ kind: 'day', data: separator });
    out.push(items[i]);
  }
  return out;
}

function turnTimestamp(item: TurnDisplayItem): Date {
  return item.kind === 'message' ? item.data.timestamp : item.data.start_time;
}
