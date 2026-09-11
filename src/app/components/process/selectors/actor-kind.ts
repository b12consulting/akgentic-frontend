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
