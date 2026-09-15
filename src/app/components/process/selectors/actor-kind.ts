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
  return String(actorName ?? '').startsWith('#');
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
