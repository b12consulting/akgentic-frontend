import { NodeInterface } from '../../../process/models/types';
import { HUMAN_ROLE } from '../../../process/selectors/graph.selector';

/**
 * The backend spells a TOOL actor with a leading '#' on the actor name — see
 * `KG_ACTOR_NAME` (`'#KnowledgeGraphTool'`) in `tool-presence.selector.ts`,
 * which mirrors the backend's `kg_actor.py`. The '#' is the whole convention;
 * there is no flag on `NodeInterface` that says "this is a tool".
 *
 * The rule already existed, inlined over `any`-typed nodes inside
 * `agent-tabs.component.ts`, which is one copy too few to keep two lists
 * agreeing: the Member dropdown and the inspector's member list must hide
 * exactly the same actors or a tool shows up as a colleague in one of them.
 * This module is that rule, typed and testable, with no DI so a spec can call
 * it without a `TestBed`.
 */
const TOOL_ACTOR_PREFIX = '#';

/**
 * `true` when the node is a tool actor rather than an agent.
 *
 * `String(node.actorName ?? '')` rather than `node.actorName.startsWith(...)`:
 * `actorName` is typed `string` but is built from `message.sender.name` off the
 * wire, so a malformed frame can put `undefined` there at runtime. The existing
 * inline rule coerces for exactly that reason and this must not disagree with
 * it — a throw here would empty the whole member list.
 */
export function isToolActor(node: Pick<NodeInterface, 'actorName'>): boolean {
  return String(node.actorName ?? '').startsWith(TOOL_ACTOR_PREFIX);
}

/**
 * The label a tool chip carries: the actor name with its marker prefix removed.
 *
 * Exactly ONE '#' comes off. The prefix is a marker, not padding, so `'##odd'`
 * is a tool whose name legitimately begins with '#'; stripping greedily would
 * silently rename it. A node that is not a tool is returned unchanged rather
 * than throwing — callers filter first, and a defensive throw would turn a data
 * oddity into a blank pane.
 */
export function toolLabel(node: Pick<NodeInterface, 'actorName'>): string {
  const name = String(node.actorName ?? '');
  return name.startsWith(TOOL_ACTOR_PREFIX) ? name.slice(1) : name;
}

/**
 * `true` for the human-proxy node — the person, not an agent.
 *
 * Keyed on `role`, not on the actor name, because that is what the graph
 * builder writes (`GraphBuilder.buildNode` sets `symbol: 'circle'` from the
 * same comparison) and role is a protocol field rather than a display string.
 */
export function isHumanNode(node: Pick<NodeInterface, 'role'>): boolean {
  return node.role === HUMAN_ROLE;
}
