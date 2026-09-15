import { ChatMessage } from './chat-message.model';

/**
 * IS THIS MESSAGE RATEABLE? — the one place that answers it (Epic 57 FR1).
 *
 * A conversation is not a list of answers. It also carries the user's own
 * turns, the system's opening announcement, context-management bookkeeping and
 * the generated summary a compaction leaves behind. Putting a thumb on those
 * invites feedback on things nobody authored and dilutes the signal that
 * reaches the backend, so the question has to be decided once, here, rather
 * than re-guessed by every surface that wants to show a control.
 *
 * WHY A SWITCH AND NOT AN EXCLUSION LIST. The natural way to write this is
 * `!EXCLUDED.includes(rule)` — and that is exactly the shape that rots. A rule
 * 8 added to `MessageRule` next year would become rateable in silence, because
 * nothing forces anyone to revisit this file. The exhaustive switch below has
 * no `default` arm: adding a member to `MessageRule` makes this function stop
 * compiling until someone states, in writing, whether the new kind is an
 * answer. The build is the reminder.
 *
 * WHAT IT KEYS ON. The message's RULE — what the message is — never how it is
 * drawn. Epic 50 removed the fill behind an agent's turn; "has a bubble", "has
 * a background colour" and "is collapsed" are all presentation and all moved
 * under that epic. A predicate keyed to any of them would have silently changed
 * what can be rated when the styling changed.
 *
 * WHAT IT DOES NOT LOOK AT. The conversation. `isRateable` takes one message
 * and nothing else, which is what makes FR7 true by construction: an agent
 * turn nobody asked for is still an answer. A rule phrased as "there was a
 * question before it" would exclude every proactive agent message, and the
 * failure would only show up in deployments that use them.
 */
export function isRateable(message: ChatMessage): boolean {
  switch (message.rule) {
    // FR2 — an agent's turn. Rule 2 answers the entry-point human directly;
    // rule 3 answers a human proxy; rule 4 is agent-to-agent. All three are
    // authored by an agent and all three are things a user can judge.
    case 2:
    case 3:
    case 4:
      return true;

    // FR3 — the user's own turn. Rating your own message is meaningless, and a
    // thumb next to it reads as a judgement of the wrong author.
    case 1:
      return false;

    // FR4 — the system announcement (the opening blurb). Nobody authored it;
    // there is no answer here to be right or wrong about.
    case 5:
      return false;

    // FR5 — context-management markers: the compaction fold (6) and the
    // conversation-clear line (7). Bookkeeping about the transcript, not a turn
    // in it.
    //
    // FR6 — and the same arm settles the generated summary. Rule 6 does not
    // just announce a compaction; its body IS the generated summary, revealed
    // when the fold is expanded, rendered as markdown and visually
    // indistinguishable from an agent's answer. Excluding the marker line while
    // leaving the summary inside it rateable would be the worst of both. The
    // summary is chrome about the conversation; rating it is a different signal
    // and, if a deployment ever wants it, a different epic.
    case 6:
    case 7:
      return false;

    // No `default`. See the note above: this arm exists only so that a new
    // `MessageRule` is a compile error rather than a silent "yes, rateable".
    default: {
      const unhandled: never = message.rule;
      return unhandled;
    }
  }
}
