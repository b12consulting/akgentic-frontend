import { NodeInterface } from '../../../process/models/types';
import { makeAgentNameUserFriendly } from '../../../../shared/util/util';
import {
  isHumanNode,
  isToolNode,
  toolLabel,
} from '../../../process/selectors/actor-kind';
import {
  AgentColours,
  NO_AGENT_COLOURS,
} from '../../../process/selectors/agent-colour';

/**
 * What a member IS, structurally: a node that has children supervises them, a
 * node that has none does the work. There is no field on `NodeInterface` that
 * says "supervisor" — deriving one by string-matching `role` would be reading
 * COPY to decide what a thing is, and copy is exactly the layer that changes
 * without telling anyone.
 */
export type MemberKind = 'supervisor' | 'worker';

/** One row of the inspector's member list, fully resolved: the template does no
 *  derivation of its own, so what a card renders and what a spec asserts are the
 *  same value. */
export interface InspectorMember {
  /** `node.name` — the agent_id. Stable across re-emissions, so it is the
   *  `track` key AND what a click reports upward. */
  readonly id: string;
  readonly label: string;
  /**
   * The RAW `node.actorName`, kept beside the friendly `label` because the two
   * answer different questions. `label` is for the eye and is LOSSY
   * (`makeAgentNameUserFriendly` rewrites it), so it cannot be turned back into
   * something the API will route a message on — and opening a member's reader
   * hands exactly that name to the send path. Deriving it here rather than at
   * the click keeps the card from re-reading the graph it was built from.
   */
  readonly actorName: string;
  /** Monogram for the avatar tile. Derived, never a hardcoded letter. */
  readonly initial: string;
  /** An i18n KEY, not a word. Rendering the role means translating it. */
  readonly roleKey: string;
  readonly kind: MemberKind;
  /** 0-based nesting, CAPPED at {@link MAX_MEMBER_DEPTH}. */
  readonly depth: number;
  /**
   * THIS MEMBER'S OWN COLOUR, or null when the roster gave it none.
   *
   * The same value the hierarchy graph fills this agent's node with and the
   * transcript fills its speaker mark with — one identity, so following an
   * agent from the member list to the drawing to what it said is a matter of
   * looking rather than reading names.
   *
   * Pre-derived here with everything else the card renders: a card that
   * resolved its own colour would need the roster, and two surfaces resolving
   * from two roster views is how they come to disagree.
   */
  readonly colour: string | null;
  readonly active: boolean;
}

/** Everything the team panel renders, derived in one pass so the three sections
 *  can never disagree about who is on the team. */
export interface InspectorTeamView {
  readonly human: InspectorMember | null;
  /** The team's squad index (`node.category`) as carried by the human node, for
   *  the human card's sub-line. It is NOT on `InspectorMember` because the
   *  member cards neither have nor want it, and widening the shared row shape to
   *  carry one card's field would put an always-ignored value on every row. */
  readonly humanTeam: number | null;
  /** Pre-flattened depth-first in tree order, so the template needs no
   *  recursion — a recursive template in a 310px pane is a lot of machinery to
   *  render an indent. */
  readonly members: readonly InspectorMember[];
  /** `toolLabel` of every tool actor, de-duped, first-seen order. */
  readonly tools: readonly string[];
}

/**
 * Indent cap. The mock indents one flat step because its seed data is two
 * levels deep; a real team tree is deeper, and at 16px a step an unbounded
 * depth marches a name off the right edge of a 310px pane. Past three steps the
 * indent has stopped communicating hierarchy anyway — it is communicating that
 * the pane is too narrow.
 */
export const MAX_MEMBER_DEPTH = 3;

/* The SIZE of one step is deliberately NOT here. It lives in
 * `--akg-member-indent` (`_conversation-tokens.scss`) and nowhere else. This
 * module owns the DEPTH — how many steps a member is in — which is a fact about
 * the team; how wide a step is drawn is a fact about the design, and a
 * deployment re-pointing the token got a card that ignored it for as long as a
 * `MEMBER_INDENT_PX` constant sat here shadowing it. The card binds the depth as
 * a custom property and the stylesheet multiplies. */

const ROLE_KEY_SUPERVISOR = 'inspector.role.supervisor';
const ROLE_KEY_WORKER = 'inspector.role.worker';
/** Neutral role for a member whose function is not structural — the human. */
const ROLE_KEY_MEMBER = 'inspector.role.member';

function roleKeyFor(kind: MemberKind): string {
  return kind === 'supervisor' ? ROLE_KEY_SUPERVISOR : ROLE_KEY_WORKER;
}

function toMember(
  node: NodeInterface,
  kind: MemberKind,
  depth: number,
  roleKey: string,
  colours: AgentColours,
): InspectorMember {
  const actorName = String(node.actorName ?? '');
  const label = makeAgentNameUserFriendly(actorName);
  return {
    id: node.name,
    label,
    actorName,
    colour: colours.of(actorName),
    initial: label.charAt(0).toUpperCase(),
    roleKey,
    kind,
    depth,
    // WORKING RIGHT NOW, which is what the dot and its two titles always
    // claimed to mean.
    //
    // This was `true` for everybody, on the reasoning that presence is liveness:
    // `applyStopMessage` splices a stopped agent out of `nodes$`, so being in
    // the array means being on the team. That reasoning was sound about the
    // array and wrong about the word — a member list where every dot is lit
    // says nothing, and "active / idle" was already the copy beside it.
    //
    // The fact it wanted existed the whole time; it was only readable as the
    // colour the canvas painted a border. `node.thinking` states it now, from
    // the same `ReceivedMessage` → `ProcessedMessage` window the deleted tree
    // pulsed its highlight over.
    active: node.thinking === true,
  };
}

/**
 * Fold the graph's nodes into the three things the inspector's Team panel
 * shows: the person, the agents, and the tools.
 *
 * The hierarchy was lifted from the deleted `TreeComponent.buildTree`, guards
 * included. That component was the second pane drawing this team and the reason
 * the guards had to agree; it is gone (the hierarchy tab is the graph now), so
 * this is the only parent/child derivation left outside the graph fold — which
 * makes the guards below load-bearing rather than merely consistent.
 *
 * Carried over verbatim from `buildTree`:
 *  - a node attaches to its parent only when `parentId` is set, names a node
 *    that is actually PRESENT, and is not the node itself; anything else is a
 *    root. The self-parent guard is load-bearing — the graph fold can emit
 *    `parentId === name` and without it the node becomes its own child.
 *  - map keyed on `n.name` (the agent_id), which is what `parentId` references.
 *
 * Deliberately NOT carried over: the human and the tool actors are removed
 * before the tree is built, so an agent parented to the human proxy surfaces as
 * a top-level member instead of hanging off a card that is rendered separately.
 *
 * Termination: a node has at most one parent, so any node reachable from a root
 * has an acyclic chain up to it. A mutual-parent cycle produces no root and is
 * simply unreachable — the same way `buildTree` rendered it as an empty tree —
 * rather than recursing forever.
 */
export function buildInspectorTeam(
  nodes: readonly NodeInterface[],
  colours: AgentColours = NO_AGENT_COLOURS,
): InspectorTeamView {
  let human: InspectorMember | null = null;
  let humanTeam: number | null = null;
  const tools: string[] = [];
  const seenTools = new Set<string>();
  const agents: NodeInterface[] = [];

  // Partition first — human, tools, everyone else — so the tree pass below
  // never has to ask what kind of node it is holding.
  for (const node of nodes) {
    if (isHumanNode(node)) {
      // First human wins. A second human node would be a protocol surprise, and
      // a list of "you" cards is not a thing this panel can mean.
      if (human === null) {
        human = toMember(node, 'worker', 0, ROLE_KEY_MEMBER, colours);
        humanTeam = node.category;
      }
      continue;
    }
    if (isToolNode(node)) {
      const label = toolLabel(node);
      if (!seenTools.has(label)) {
        seenTools.add(label);
        tools.push(label);
      }
      continue;
    }
    agents.push(node);
  }

  // A Map rather than `buildTree`'s object literal: an agent_id is arbitrary
  // wire data, and `'__proto__'` as a key on a plain object is a hole rather
  // than an entry. The GUARDS are what had to match, not the container.
  const byId = new Map<string, NodeInterface>();
  for (const node of agents) {
    byId.set(node.name, node);
  }

  const childrenOf = new Map<string, NodeInterface[]>();
  const roots: NodeInterface[] = [];
  for (const node of agents) {
    const parentId = node.parentId;
    if (parentId && byId.has(parentId) && parentId !== node.name) {
      const siblings = childrenOf.get(parentId);
      if (siblings) {
        siblings.push(node);
      } else {
        childrenOf.set(parentId, [node]);
      }
    } else {
      roots.push(node);
    }
  }

  const members: InspectorMember[] = [];
  const visit = (node: NodeInterface, depth: number): void => {
    const children = childrenOf.get(node.name) ?? [];
    const kind: MemberKind = children.length > 0 ? 'supervisor' : 'worker';
    members.push(
      toMember(
        node,
        kind,
        Math.min(depth, MAX_MEMBER_DEPTH),
        roleKeyFor(kind),
        colours,
      ),
    );
    for (const child of children) {
      visit(child, depth + 1);
    }
  };
  for (const root of roots) {
    visit(root, 0);
  }

  return { human, humanTeam, members, tools };
}

/**
 * Structural equality for the derived view.
 *
 * `buildInspectorTeam` returns a fresh object on every emission of `nodes$`, so
 * a reference comparator would never suppress anything and an OnPush panel
 * would repaint on every message. Compared field by field rather than by
 * `JSON.stringify` so the cost is bounded by the team size and not by the
 * serialiser.
 */
export function inspectorTeamsEqual(
  a: InspectorTeamView,
  b: InspectorTeamView,
): boolean {
  return (
    membersEqual(a.human, b.human) &&
    a.humanTeam === b.humanTeam &&
    a.members.length === b.members.length &&
    a.members.every((member, i) => membersEqual(member, b.members[i])) &&
    a.tools.length === b.tools.length &&
    a.tools.every((tool, i) => tool === b.tools[i])
  );
}

/**
 * `initial` is a pure function of `label`, so comparing the label covers it.
 *
 * `actorName` is NOT covered by `label` and must be compared on its own:
 * `makeAgentNameUserFriendly` is lossy (it collapses
 * `@Expert-Analyst-BATCH-1-TASK-2` to `@Expert [Analyst]`), so two different
 * actor names share one label. Omitting it here let a node whose routing
 * address changed while its id and friendly label did not be swallowed by
 * `distinctUntilChanged`, leaving the cached view handing a stale address to
 * the reader.
 */
function membersEqual(
  a: InspectorMember | null,
  b: InspectorMember | null,
): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return (
    a.id === b.id &&
    a.label === b.label &&
    a.actorName === b.actorName &&
    a.roleKey === b.roleKey &&
    a.kind === b.kind &&
    a.depth === b.depth &&
    a.active === b.active &&
    // AND THE COLOUR. It is derived from the agent's POSITION in the roster, so
    // it can change while every other field on the row stays put — an agent
    // ahead of this one leaving shifts the stops behind it. Omitted here, that
    // move would be swallowed by `distinctUntilChanged` and the member list
    // would go on drawing tiles in colours the graph had stopped using.
    a.colour === b.colour
  );
}
