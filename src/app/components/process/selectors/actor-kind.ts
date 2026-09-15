/**
 * What KIND of thing an actor on the team graph is.
 *
 * The graph's node list is deliberately everything the team contains — the
 * agents, the human, and the tools — because it is the drawing's source and a
 * drawing that omitted the tools would be wrong. Every surface that offers a
 * list of people to READ or TALK TO has to narrow that down, and until now each
 * one spelled the rule out for itself.
 *
 * ONE PREDICATE, because a rule written twice is a rule that drifts. Three
 * separate defects in this codebase have had that exact shape: a provider slug
 * renamed on one surface and not the rewritten one, a seed gate fixed upstream
 * and not downstream, and a team/library filter applied on the teams page but
 * not in the creation dialog that duplicated its list.
 */

/**
 * The shape these predicates need of a graph node.
 *
 * STRUCTURAL, not `NodeInterface`. This module is pure and is imported by the
 * console as well as by the process feature; typing against the full node would
 * make every caller drag `models/types` in to ask a two-field question, and a
 * spec would have to build a whole node to test a prefix.
 */
export interface ActorNode {
  actorName: string;
  role: string;
}

/**
 * Whether `actorName` names a TOOL rather than an agent.
 *
 * Tools are prefixed `#` — `#VectorStore`, `#KnowledgeGraphTool`,
 * `#NotificationTool` — where agents are prefixed `@`. The prefix is the
 * protocol's own convention and is what the transcript already keys its
 * notification glyph off, so it is a contract rather than a formatting habit.
 *
 * Takes the NAME and not the node, so a caller holding only a sender string can
 * ask the same question as one holding a graph node, and the two cannot answer
 * it differently. A missing or null name is NOT a tool: an actor we cannot
 * identify is better offered and ignored than silently withheld.
 */
export function isToolActor(actorName: string | null | undefined): boolean {
  return String(actorName ?? '').startsWith(TOOL_ACTOR_PREFIX);
}

/**
 * The mark that tells a tool from an agent on the wire.
 *
 * `actorName` carries it: agents arrive as `@Manager`, tools as `#VectorStore`.
 * It is a display convention rather than a typed field, which is why every
 * question about it is a prefix test and not a `kind === 'tool'` — there is no
 * such field to read. Named once so that stripping it and testing for it cannot
 * disagree about how many characters it is.
 */
const TOOL_ACTOR_PREFIX = '#';

/**
 * The protocol's role for the person, as opposed to an agent.
 *
 * OWNED HERE because it is an actor-KIND fact, and this module is where the
 * other two live. It was previously declared in `graph.selector.ts` and again,
 * privately, in `chat.selector.ts` — the same string written twice in the two
 * folds that classify the same messages. Both now read it from here;
 * `graph.selector.ts` re-exports it so its existing importers are undisturbed.
 */
export const HUMAN_ROLE = 'Human';

/**
 * The same question as `isToolActor`, asked by a caller holding a NODE.
 *
 * Delegates rather than re-testing the prefix. Three copies of that test had
 * accumulated — this module's, the inspector's `tool-actors.ts`, and an inline
 * one in the hierarchy graph — which is exactly the drift this module's opening
 * paragraph warns about, reproduced inside the module that warns about it.
 */
export function isToolNode(node: Pick<ActorNode, 'actorName'>): boolean {
  return isToolActor(node.actorName);
}

/**
 * `true` for the human-proxy node — the person, not an agent.
 *
 * Keyed on `role`, not on the actor name, because that is what the graph
 * builder writes (it picks the node's very symbol from the same comparison) and
 * role is a protocol field rather than a display string.
 */
export function isHumanNode(node: Pick<ActorNode, 'role'>): boolean {
  return node.role === HUMAN_ROLE;
}

/**
 * Whether this node is somebody the user can READ or TALK TO.
 *
 * The graph's node list is everything the team contains, and every surface that
 * offers a list of PEOPLE narrows it the same way: no tools, and not the user
 * themselves. Stated once, as one predicate, because the two exclusions had
 * started being applied in different combinations — the reader's left-hand
 * column dropped the tools and kept the human, so the person reading it was
 * offered their own transcript beside the agents', which is the main chat.
 */
export function isAddressableAgent(
  node: Pick<ActorNode, 'actorName' | 'role'>,
): boolean {
  return !isToolNode(node) && !isHumanNode(node);
}

/**
 * The label a tool chip carries: the actor name with its marker prefix removed.
 *
 * Exactly ONE prefix character comes off. It is a marker, not padding, so
 * `'##odd'` is a tool whose name legitimately begins with '#'; stripping
 * greedily would silently rename it. A node that is not a tool is returned
 * unchanged rather than throwing — callers filter first, and a defensive throw
 * would turn a data oddity into a blank pane.
 */
export function toolLabel(node: Pick<ActorNode, 'actorName'>): string {
  const name = String(node.actorName ?? '');
  return name.startsWith(TOOL_ACTOR_PREFIX) ? name.slice(1) : name;
}

/**
 * The agent a message goes to when the user names nobody.
 *
 * The composer's "Send to" field is optional: leave it empty and the message
 * routes to the team's entry supervisor — the agent whose parent is the
 * `@Human` node — falling back to the first agent when that link is absent.
 *
 * SHARED, because two surfaces now ask it and they must not disagree. The
 * composer asks in order to route; the transcript asks in order to decide
 * whether a turn's recipient is worth NAMING — a recipient the user did not
 * choose is not news, and labelling every turn with it trains the reader to
 * stop seeing the label on the turns that matter. If the two definitions ever
 * drift, the transcript starts captioning ordinary turns and falls silent on
 * deliberate ones, which is precisely backwards.
 *
 * Returns the ACTOR NAME (`@Manager`), the same key the composer routes on.
 */
export function defaultRecipientName(
  nodes: readonly { actorName: string; name: string; parentId?: string }[],
  entryPointName: string,
): string | null {
  const candidates = nodes.filter(
    (n) => n.actorName.startsWith('@') && n.actorName !== entryPointName,
  );
  if (candidates.length === 0) return null;

  const entry = nodes.find((n) => n.actorName === entryPointName);
  const child = entry
    ? candidates.find((n) => n.parentId === entry.name)
    : undefined;

  return (child ?? candidates[0]).actorName;
}
