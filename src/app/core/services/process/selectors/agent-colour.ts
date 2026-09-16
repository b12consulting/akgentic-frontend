import { ActorNode, isAddressableAgent } from './actor-kind';

/**
 * ONE COLOUR PER AGENT, read the same way by every surface that draws one.
 *
 * The console shows the same agent in three places — the hierarchy graph, the
 * transcript's speaker marks, and the inspector's member list — and until now
 * each of them answered "what colour is @Manager?" differently, or did not
 * answer it at all. The graph coloured by SQUAD, so in the single-squad
 * deployments that are the common case every node came out the same colour; the
 * transcript and the inspector used one flat avatar fill for everybody. Nothing
 * tied the three together, so following one agent across them meant reading
 * names.
 *
 * THE RAMP IS THE ONE ALREADY DECLARED. `--akg-graph-category-1..10` in
 * `_conversation-tokens.scss` was built as a categorical palette and is already
 * contrast-checked; this reuses it rather than introducing a second series that
 * a rebrand would have to be told about separately.
 *
 * PURE, AND THE PALETTE IS AN ARGUMENT. Resolving a custom property needs
 * `getComputedStyle`, which is a DOM call and a layout flush; taking the
 * resolved ramp in keeps this module testable without a browser and leaves the
 * memoising where it already is (`CategoryService.COLORS`).
 */

/**
 * A resolved agent→colour lookup for one team.
 *
 * An interface rather than a bare `Map` so the miss case is stated once, in one
 * place, instead of at every `?? null` call site — and so the key can stay an
 * implementation detail of the builder below.
 */
export interface AgentColours {
  /**
   * This actor's colour, or `null` when it has none.
   *
   * `null` is returned for the tools, for the human, and for an actor that is
   * not on the roster at all — a transport listener on an envelope, say, or a
   * name read from a message that arrived before the graph did. Callers bind it
   * straight through: a null background is no background, which is the resting
   * appearance these surfaces already had.
   */
  of(actorName: string | null | undefined): string | null;
}

/** The empty lookup. Handed out before a roster exists so callers never have to
 *  hold a nullable lookup as well as a nullable colour. */
export const NO_AGENT_COLOURS: AgentColours = { of: () => null };

/**
 * Build the lookup for one team's roster.
 *
 * KEYED ON `actorName`, which is the one identity all three surfaces hold: the
 * graph node carries it beside its `agent_id`, a chat turn's sender IS it, and
 * the inspector's row keeps it precisely because it is the routable name. It is
 * unique within a team by construction — the composer routes on it, so two
 * agents answering to `@Manager` would already be a routing bug.
 *
 * DISCOVERY ORDER, not a hash of the name. The roster arrives from a fold over
 * the replayed message log, so the order is deterministic for a given team and
 * the same agent keeps the same colour across a reload. A hash would survive
 * across teams too, but at the cost of collisions WITHIN one — two agents of a
 * three-agent team sharing a colour is the one outcome that makes the whole
 * device useless, and it is not detectable by looking.
 *
 * TOOLS AND THE HUMAN ARE SKIPPED, not merely unassigned: they must not consume
 * a stop. A team whose roster interleaves six tools with three agents would
 * otherwise scatter its agents across the ramp, and adding a tool would
 * silently recolour the agents after it.
 *
 * The human keeps `--akg-avatar-human-bg`, which `_conversation-tokens.scss`
 * describes as the only warm tone in the palette and the carrier of the
 * human/agent distinction. Giving the person a stop from the agent ramp would
 * spend that distinction to say something the shape already says.
 */
export function agentColours(
  nodes: readonly ActorNode[],
  palette: readonly string[],
): AgentColours {
  // An empty ramp is a real state: `graphCategoryColors()` drops undeclared
  // tokens, so a deployment that declared none leaves nothing to index into.
  // Returning the empty lookup is what keeps `%` off a zero length.
  if (palette.length === 0) return NO_AGENT_COLOURS;

  const byActorName = new Map<string, string>();
  let stop = 0;
  for (const node of nodes) {
    if (!isAddressableAgent(node)) continue;
    // First emission wins. The roster is re-published on every graph change and
    // an agent that re-announces itself is the same participant; re-assigning
    // here would let a node's colour move under the user mid-conversation.
    if (byActorName.has(node.actorName)) continue;
    // Wrapped, because a team with more agents than the ramp has stops is a
    // repeat rather than a crash — the same decision the squad colouring makes
    // one module over.
    byActorName.set(node.actorName, palette[stop % palette.length]);
    stop += 1;
  }

  return {
    of: (actorName) =>
      actorName ? (byActorName.get(actorName) ?? null) : null,
  };
}
