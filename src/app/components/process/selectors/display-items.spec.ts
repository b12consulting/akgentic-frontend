import {
  agentRuns,
  buildDisplayItems,
  DisplayItem,
  mainTranscriptRuns,
  trackDisplayItem,
} from './display-items';
import { ChatMessage } from './chat-message.model';
import { ThinkingState, ThinkingToolEntry } from './chat.selector';
import { ActorAddress } from '../../../protocol/message.types';

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

const HUMAN = makeAddress({ name: '@Human', role: 'Human', agent_id: 'human-1' });
/** A NAMED human seat. `classifyRule` gives its messages rule 4, not rule 1 —
 *  which is why the scoping rule keys on `role`, never on the `@Human` name. */
const SUPPORT = makeAddress({ name: '@Support', role: 'Human', agent_id: 'support-1' });
const MANAGER = makeAddress({ name: '@Manager', role: 'Manager', agent_id: 'manager' });
const EXPERT = makeAddress({ name: '@Expert', role: 'Worker', agent_id: 'expert' });

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  const id = overrides.id ?? 'm-1';
  return {
    id,
    message_id: 'inner-' + id,
    parent_id: null,
    content: 'hello',
    sender: HUMAN,
    recipient: MANAGER,
    timestamp: new Date('2026-04-12T10:00:00Z'),
    rule: 1,
    alignment: 'right',
    color: 'transparent',
    collapsed: false,
    label: 'You',
    ...overrides,
  };
}

function makeRun(overrides: Partial<ThinkingState> = {}): ThinkingState {
  return {
    agent_id: 'manager',
    agent_name: '@Manager',
    start_time: new Date('2026-04-12T10:00:01Z'),
    tools: [],
    anchor_message_id: 'inner-m-1',
    final: false,
    ...overrides,
  };
}

function contactStep(sentMessageId: string): ThinkingToolEntry {
  return {
    tool_call_id: sentMessageId,
    tool_name: '@Expert',
    arguments_preview: '',
    done: true,
    kind: 'contact',
  };
}

function kinds(items: DisplayItem[]): string[] {
  return items.map((i) => i.kind);
}

function keys(items: DisplayItem[]): string[] {
  return items.map((item, i) => trackDisplayItem(i, item));
}

describe('display-items selector', () => {
  // -------------------------------------------------------------------------
  // The scoping rule. This is the whole point of the module: a run belongs to
  // the conversation whose inbox is on screen, decided by the sender of its
  // ANCHOR message.
  // -------------------------------------------------------------------------
  describe('mainTranscriptRuns', () => {
    it('keeps a run the user themselves triggered', () => {
      const userTurn = makeMessage({ id: 'm-1', sender: HUMAN });
      const run = makeRun({ anchor_message_id: 'inner-m-1' });

      expect(mainTranscriptRuns([userTurn], [run])).toEqual([run]);
    });

    it('drops a run one agent triggered in another', () => {
      // This is the reported bug: with four agents the human read
      // "@Expert contacted @Manager" — work belonging to a conversation they
      // are not part of — merged into their own transcript.
      const delegation = makeMessage({
        id: 'm-2',
        sender: MANAGER,
        recipient: EXPERT,
        rule: 4,
      });
      const run = makeRun({ agent_id: 'expert', anchor_message_id: 'inner-m-2' });

      expect(mainTranscriptRuns([delegation], [run])).toEqual([]);
    });

    it('keeps a run triggered by a NAMED human seat, not just by @Human', () => {
      // Send-as and a routed human reply both produce a message from a human
      // actor that is not the entry point, and `classifyRule` calls those
      // rule 4. Keyed on the name instead of the role, every multi-human
      // deployment would lose its runs out of the transcript.
      const sendAs = makeMessage({
        id: 'm-3',
        sender: SUPPORT,
        recipient: EXPERT,
        rule: 4,
      });
      const run = makeRun({ agent_id: 'expert', anchor_message_id: 'inner-m-3' });

      expect(mainTranscriptRuns([sendAs], [run])).toEqual([run]);
    });

    it('fails OPEN when the anchor resolves to nothing', () => {
      // Empty-content and ActorSystem messages are dropped by the fold, a
      // compaction truncates history and a REST replay can begin
      // mid-conversation. Fail-closed would make a LIVE bubble vanish; the
      // worst case of fail-open is the behaviour that shipped before scoping.
      const run = makeRun({ anchor_message_id: 'inner-gone' });

      expect(mainTranscriptRuns([makeMessage({ id: 'm-1' })], [run])).toEqual([run]);
    });

    it('resolves the anchor by inner message_id, not by envelope id', () => {
      // The two id spaces are different and both are on the object. Matching
      // the envelope id would resolve nothing and fail-open would hide the bug.
      const delegation = makeMessage({
        id: 'inner-m-9', // envelope id deliberately shaped like an inner one
        message_id: 'inner-m-9-real',
        sender: MANAGER,
        recipient: EXPERT,
        rule: 4,
      });
      const run = makeRun({ agent_id: 'expert', anchor_message_id: 'inner-m-9-real' });

      expect(mainTranscriptRuns([delegation], [run])).toEqual([]);
    });

    it('scopes per RUN, not per agent', () => {
      // The same agent can be asked by the user AND by a peer. An agent-level
      // rule ("does @Manager ever talk to the user?") re-admits the internal
      // run the moment the graph has a cycle.
      const userTurn = makeMessage({ id: 'm-1', sender: HUMAN });
      const peerTurn = makeMessage({
        id: 'm-2',
        sender: EXPERT,
        recipient: MANAGER,
        rule: 4,
      });
      const forUser = makeRun({ anchor_message_id: 'inner-m-1' });
      const forPeer = makeRun({ anchor_message_id: 'inner-m-2' });

      expect(mainTranscriptRuns([userTurn, peerTurn], [forUser, forPeer])).toEqual([
        forUser,
      ]);
    });

    it('leaves the input arrays untouched', () => {
      const messages = [makeMessage({ id: 'm-1' })];
      const runs = [makeRun(), makeRun({ anchor_message_id: 'inner-x' })];
      mainTranscriptRuns(messages, runs);
      expect(messages.length).toBe(1);
      expect(runs.length).toBe(2);
    });
  });

  describe('agentRuns', () => {
    it('returns only the selected agent’s runs', () => {
      const mine = makeRun({ agent_id: 'expert', anchor_message_id: 'a' });
      const theirs = makeRun({ agent_id: 'manager', anchor_message_id: 'b' });
      expect(agentRuns([mine, theirs], 'expert')).toEqual([mine]);
    });

    it('returns nothing when no agent is selected', () => {
      expect(agentRuns([makeRun()], null)).toEqual([]);
      expect(agentRuns([makeRun()], '')).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // The invariant that makes one function safe for two differently-scoped
  // views.
  // -------------------------------------------------------------------------
  describe('buildDisplayItems — contact-step exclusion is scoped to the runs given', () => {
    it('hides a contact message that the rendered run absorbed', () => {
      const contact = makeMessage({
        id: 'contact-1',
        sender: MANAGER,
        recipient: EXPERT,
        rule: 4,
        timestamp: new Date('2026-04-12T10:00:05Z'),
      });
      const run = makeRun({ tools: [contactStep('contact-1')] });

      const items = buildDisplayItems([contact], [run]);

      expect(kinds(items)).toEqual(['thinking']);
    });

    it('KEEPS that message when the absorbing run is not being rendered', () => {
      // The reader shows @Expert's runs, not @Manager's. If exclusion were
      // computed from the global run list, @Manager's instruction to @Expert
      // would be deleted from the screen with no fold left to show it in —
      // taking with it the only explanation of why @Expert ran at all.
      const contact = makeMessage({
        id: 'contact-1',
        sender: MANAGER,
        recipient: EXPERT,
        rule: 4,
        timestamp: new Date('2026-04-12T10:00:05Z'),
      });
      const managerRun = makeRun({
        agent_id: 'manager',
        tools: [contactStep('contact-1')],
      });
      const expertRun = makeRun({
        agent_id: 'expert',
        anchor_message_id: 'inner-contact-1',
        start_time: new Date('2026-04-12T10:00:06Z'),
      });

      const items = buildDisplayItems(
        [contact],
        agentRuns([managerRun, expertRun], 'expert'),
      );

      expect(keys(items)).toEqual(['message:contact-1', 'thinking:inner-contact-1']);
    });

    /**
     * THE MAIN TRANSCRIPT'S OWN COMPOSITION, which neither half above covers.
     *
     * `ChatPanelComponent` calls `buildDisplayItems(classified,
     * mainTranscriptRuns(classified, runs))`, so a sub-agent's run is dropped
     * and its contact steps stop being absorbed — the rule-4 message they
     * pointed at gets a row of its own.
     *
     * THAT IS THE INTENDED OUTCOME, not a leak. The row is the MESSAGE, and it
     * is one the transcript has always shown: before the scoping rule existed
     * there was no contact-step absorption at all, so every rule-4 message had
     * its own collapsed row and the sub-agent's fold sat beside it. Scoping
     * removed the fold; suppressing the message as well would delete a message
     * from the log with nothing left on screen to show it in, which is the
     * failure the sibling spec above pins for the reader. Fewer rows than
     * before, never more.
     */
    it('keeps a sub-agent contact MESSAGE when its run is scoped out of the main transcript', () => {
      const ask = makeMessage({
        id: 'ask',
        sender: HUMAN,
        recipient: MANAGER,
        rule: 1,
      });
      // @Manager delegates to @Expert. The envelope is a rule-4 message AND the
      // contact step of @Manager's own run.
      const delegate = makeMessage({
        id: 'delegate',
        sender: MANAGER,
        recipient: EXPERT,
        rule: 4,
        timestamp: new Date('2026-04-12T10:00:05Z'),
      });
      // @Expert answers @Manager — a contact step of @EXPERT's run, whose
      // anchor is @Manager's message, so the run is not the user's.
      const report = makeMessage({
        id: 'report',
        sender: EXPERT,
        recipient: MANAGER,
        rule: 4,
        timestamp: new Date('2026-04-12T10:00:09Z'),
      });
      const managerRun = makeRun({
        agent_id: 'manager',
        anchor_message_id: 'inner-ask',
        tools: [contactStep('delegate')],
      });
      const expertRun = makeRun({
        agent_id: 'expert',
        anchor_message_id: 'inner-delegate',
        start_time: new Date('2026-04-12T10:00:06Z'),
        tools: [contactStep('report')],
      });

      const messages = [ask, delegate, report];
      const items = buildDisplayItems(
        messages,
        mainTranscriptRuns(messages, [managerRun, expertRun]),
      );

      // @Manager's fold is the user's and absorbs `delegate`; @Expert's fold is
      // somebody else's conversation and is gone, so `report` keeps its row.
      expect(keys(items)).toEqual([
        'message:ask',
        'thinking:inner-ask',
        'message:report',
      ]);
    });
  });

  describe('buildDisplayItems — ordering', () => {
    it('interleaves turns and runs chronologically', () => {
      const early = makeMessage({
        id: 'early',
        timestamp: new Date('2026-04-12T10:00:00Z'),
      });
      const late = makeMessage({
        id: 'late',
        timestamp: new Date('2026-04-12T10:00:10Z'),
      });
      const run = makeRun({ start_time: new Date('2026-04-12T10:00:05Z') });

      expect(keys(buildDisplayItems([early, late], [run]))).toEqual([
        'message:early',
        'thinking:inner-m-1',
        'message:late',
      ]);
    });

    it('orders a message BEFORE a run of the same instant', () => {
      // The question precedes the work it caused, and a tie in the clock must
      // not be allowed to invert that.
      const at = new Date('2026-04-12T10:00:00Z');
      const message = makeMessage({ id: 'tie', timestamp: at });
      const run = makeRun({ start_time: at });

      expect(kinds(buildDisplayItems([message], [run]))).toEqual([
        'message',
        'thinking',
      ]);
    });

    it('marks a calendar-day boundary across the merged list', () => {
      const day1 = makeMessage({
        id: 'd1',
        timestamp: new Date(2026, 3, 8, 10, 0, 0),
      });
      const day2run = makeRun({ start_time: new Date(2026, 3, 9, 9, 0, 0) });

      expect(kinds(buildDisplayItems([day1], [day2run]))).toEqual([
        'message',
        'day',
        'thinking',
      ]);
    });

    it('is empty exactly when there is nothing to show', () => {
      // Both templates gate their empty state on this being empty.
      expect(buildDisplayItems([], [])).toEqual([]);
    });
  });

  describe('trackDisplayItem', () => {
    it('separates the three id spaces even when the ids collide', () => {
      const shared = 'same-id';
      const message = trackDisplayItem(0, {
        kind: 'message',
        data: makeMessage({ id: shared }),
      });
      const thinking = trackDisplayItem(0, {
        kind: 'thinking',
        data: makeRun({ anchor_message_id: shared }),
      });
      const day = trackDisplayItem(0, {
        kind: 'day',
        data: { day: shared, label: shared },
      });

      expect(new Set([message, thinking, day]).size).toBe(3);
    });

    it('ignores the index, so a key survives a row being inserted above it', () => {
      const item: DisplayItem = { kind: 'message', data: makeMessage({ id: 'x' }) };
      expect(trackDisplayItem(0, item)).toBe(trackDisplayItem(9, item));
    });
  });
});
