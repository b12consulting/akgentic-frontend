import {
  buildInspectorTeam,
  inspectorTeamsEqual,
  MAX_MEMBER_DEPTH,
} from './team-members.selector';
import { NodeInterface } from '../../../process/models/types';
import { HUMAN_ROLE } from '../../../process/selectors/graph.selector';

/** A graph node with only the fields this selector reads spelled out. */
function node(overrides: Partial<NodeInterface> & { name: string }): NodeInterface {
  return {
    role: 'Assistant',
    actorName: overrides.name,
    parentId: '',
    squadId: 's1',
    symbol: 'roundRect',
    category: 0,
    userMessage: false,
    ...overrides,
  };
}

/**
 * The Team panel's derivation.
 *
 * Pure functions, no `TestBed` — the hierarchy rules are the thing under test
 * and a component harness would only put a render between the assertion and the
 * behaviour. The guards asserted here came from the deleted
 * `TreeComponent.buildTree`; with that component gone this is the only
 * parent/child derivation left in the inspector, so these specs are no longer
 * pinning an agreement between two panes — they are pinning the rules
 * themselves.
 */
describe('buildInspectorTeam', () => {
  describe('hierarchy', () => {
    it('gives a supervisor depth 0 and its two workers depth 1', () => {
      const view = buildInspectorTeam([
        node({ name: 'boss', actorName: 'Manager-Supervisor-0' }),
        node({ name: 'w1', actorName: 'Alpha-Worker-0', parentId: 'boss' }),
        node({ name: 'w2', actorName: 'Beta-Worker-0', parentId: 'boss' }),
      ]);

      expect(view.members.map((m) => m.depth)).toEqual([0, 1, 1]);
      expect(view.members.map((m) => m.kind)).toEqual([
        'supervisor',
        'worker',
        'worker',
      ]);
    });

    it('flattens depth-first, so a member follows the supervisor it reports to', () => {
      // Breadth-first would put both supervisors above both workers and the
      // indent would then be the ONLY thing saying who reports to whom.
      const view = buildInspectorTeam([
        node({ name: 'a', actorName: 'A' }),
        node({ name: 'b', actorName: 'B' }),
        node({ name: 'a1', actorName: 'A1', parentId: 'a' }),
        node({ name: 'b1', actorName: 'B1', parentId: 'b' }),
      ]);

      expect(view.members.map((m) => m.id)).toEqual(['a', 'a1', 'b', 'b1']);
    });

    it('kind is structural: a node with children supervises, one without works', () => {
      // Nothing here reads `role`. A team whose copy calls everyone "Assistant"
      // must still render one supervisor and one worker.
      const view = buildInspectorTeam([
        node({ name: 'p', actorName: 'P', role: 'Assistant' }),
        node({ name: 'c', actorName: 'C', role: 'Assistant', parentId: 'p' }),
      ]);

      expect(view.members.map((m) => m.kind)).toEqual(['supervisor', 'worker']);
      expect(view.members.map((m) => m.roleKey)).toEqual([
        'inspector.role.supervisor',
        'inspector.role.worker',
      ]);
    });

    it('treats a self-parenting node as a root instead of looping', () => {
      // `buildTree`'s `parentId !== n.name` guard. Without it the node becomes
      // its own child and the flatten never returns.
      const view = buildInspectorTeam([
        node({ name: 'loop', actorName: 'Loop', parentId: 'loop' }),
      ]);

      expect(view.members.map((m) => m.id)).toEqual(['loop']);
      expect(view.members[0].depth).toBe(0);
    });

    it('treats an orphan — a parentId naming an absent node — as a root', () => {
      // Happens routinely: `applyStopMessage` splices a stopped supervisor out
      // while its children are still running. They must stay visible.
      const view = buildInspectorTeam([
        node({ name: 'child', actorName: 'Child', parentId: 'ghost' }),
      ]);

      expect(view.members.map((m) => m.id)).toEqual(['child']);
      expect(view.members[0].depth).toBe(0);
    });

    it('renders a mutual-parent cycle as no members rather than recursing forever', () => {
      // Neither node qualifies as a root, so neither is reachable — the same
      // empty result `buildTree` produces, arrived at the same way.
      const view = buildInspectorTeam([
        node({ name: 'x', actorName: 'X', parentId: 'y' }),
        node({ name: 'y', actorName: 'Y', parentId: 'x' }),
      ]);

      expect(view.members).toEqual([]);
    });

    it('caps a six-deep chain at the maximum indent', () => {
      // Beyond the cap the indent has stopped meaning "one level deeper" and
      // started meaning "this pane is too narrow".
      const chain: NodeInterface[] = [];
      for (let i = 0; i < 6; i++) {
        chain.push(
          node({
            name: `n${i}`,
            actorName: `N${i}`,
            parentId: i === 0 ? '' : `n${i - 1}`,
          }),
        );
      }

      const view = buildInspectorTeam(chain);

      expect(view.members.map((m) => m.depth)).toEqual([0, 1, 2, 3, 3, 3]);
      expect(MAX_MEMBER_DEPTH).toBe(3);
    });
  });

  describe('partitioning', () => {
    it('extracts the human node and keeps it out of the member list', () => {
      const view = buildInspectorTeam([
        node({ name: 'me', actorName: 'Human-Proxy-0', role: HUMAN_ROLE, category: 2 }),
        node({ name: 'a', actorName: 'Agent-Worker-0' }),
      ]);

      expect(view.human?.id).toBe('me');
      expect(view.humanTeam).toBe(2);
      expect(view.members.map((m) => m.id)).toEqual(['a']);
    });

    it('promotes an agent parented to the human to a top-level member', () => {
      // The human is rendered as its own card above the list, so hanging its
      // children off it would indent every member under a card they cannot see.
      const view = buildInspectorTeam([
        node({ name: 'me', actorName: 'Human-Proxy-0', role: HUMAN_ROLE }),
        node({ name: 'a', actorName: 'Agent-Worker-0', parentId: 'me' }),
      ]);

      expect(view.members.map((m) => m.depth)).toEqual([0]);
    });

    it('reports no human and no team when the graph has none yet', () => {
      const view = buildInspectorTeam([node({ name: 'a', actorName: 'A' })]);

      expect(view.human).toBeNull();
      expect(view.humanTeam).toBeNull();
    });

    it('routes #-prefixed actors to tools only, de-duped in first-seen order', () => {
      const view = buildInspectorTeam([
        node({ name: 't1', actorName: '#KnowledgeGraphTool' }),
        node({ name: 'a', actorName: 'Agent-Worker-0' }),
        node({ name: 't2', actorName: '#VectorStore' }),
        // Same tool, second actor instance — one chip, not two.
        node({ name: 't3', actorName: '#KnowledgeGraphTool' }),
      ]);

      expect(view.tools).toEqual(['KnowledgeGraphTool', 'VectorStore']);
      expect(view.members.map((m) => m.id)).toEqual(['a']);
    });

    it('does not let a tool actor become a parent of an agent', () => {
      // Tools are removed before the tree is built, so an agent pointing at one
      // is an orphan and stays visible at depth 0.
      const view = buildInspectorTeam([
        node({ name: 't', actorName: '#Tool' }),
        node({ name: 'a', actorName: 'A', parentId: 't' }),
      ]);

      expect(view.members.map((m) => m.depth)).toEqual([0]);
    });

    it('returns an entirely empty view for an empty graph', () => {
      const view = buildInspectorTeam([]);

      expect(view).toEqual({
        human: null,
        humanTeam: null,
        members: [],
        tools: [],
      });
    });
  });

  describe('member fields', () => {
    it('renders the friendly label and its initial rather than the raw actor name', () => {
      const view = buildInspectorTeam([
        node({ name: 'n', actorName: 'researcher-analyst-batch-1' }),
      ]);

      expect(view.members[0].label).toBe('researcher [Analyst]');
      expect(view.members[0].initial).toBe('R');
    });

    it('marks every present node active, because presence is the liveness signal', () => {
      // `applyStopMessage` splices a stopped agent OUT of `nodes$`; a node that
      // is here is running. There is no idle state to fabricate.
      const view = buildInspectorTeam([
        node({ name: 'a', actorName: 'A' }),
        node({ name: 'b', actorName: 'B', errorMessage: 'boom' }),
      ]);

      expect(view.members.every((m) => m.active)).toBe(true);
    });

    it('gives the human a neutral role key rather than a structural one', () => {
      const view = buildInspectorTeam([
        node({ name: 'me', actorName: 'Human-Proxy-0', role: HUMAN_ROLE }),
      ]);

      expect(view.human?.roleKey).toBe('inspector.role.member');
    });
  });
});

describe('inspectorTeamsEqual', () => {
  const nodes = [
    node({ name: 'boss', actorName: 'Manager-Supervisor-0' }),
    node({ name: 'w', actorName: 'Worker-0', parentId: 'boss' }),
    node({ name: 't', actorName: '#Tool' }),
  ];

  it('holds across two builds of the same graph, which is what suppresses repaints', () => {
    // The two views are distinct objects; a reference comparator on the OnPush
    // panel would repaint on every message frame.
    const a = buildInspectorTeam(nodes);
    const b = buildInspectorTeam(nodes);

    expect(a).not.toBe(b);
    expect(inspectorTeamsEqual(a, b)).toBe(true);
  });

  it('fails when a member joins', () => {
    const before = buildInspectorTeam(nodes);
    const after = buildInspectorTeam([
      ...nodes,
      node({ name: 'w2', actorName: 'Worker-1', parentId: 'boss' }),
    ]);

    expect(inspectorTeamsEqual(before, after)).toBe(false);
  });

  it('fails when a worker gains a report and becomes a supervisor', () => {
    const before = buildInspectorTeam(nodes);
    const after = buildInspectorTeam([
      ...nodes,
      node({ name: 'sub', actorName: 'Sub-0', parentId: 'w' }),
    ]);

    expect(inspectorTeamsEqual(before, after)).toBe(false);
  });

  it('fails when a tool arrives', () => {
    const before = buildInspectorTeam(nodes);
    const after = buildInspectorTeam([
      ...nodes,
      node({ name: 't2', actorName: '#VectorStore' }),
    ]);

    expect(inspectorTeamsEqual(before, after)).toBe(false);
  });

  /**
   * The reader routes a message on `actorName`, and the friendly label cannot
   * be turned back into one: `makeAgentNameUserFriendly` takes only the first
   * two dash-separated segments, so both names below render as "Worker [0]".
   * Comparing labels alone therefore reports "unchanged" for a node whose
   * routing address moved, and the cached view keeps handing out the old one.
   */
  it('fails when only the actorName changes, which the label cannot show', () => {
    const before = buildInspectorTeam(nodes);
    const after = buildInspectorTeam([
      node({ name: 'boss', actorName: 'Manager-Supervisor-0' }),
      node({ name: 'w', actorName: 'Worker-0-BATCH-2', parentId: 'boss' }),
      node({ name: 't', actorName: '#Tool' }),
    ]);

    expect(after.members.map((m) => m.label)).toEqual(
      before.members.map((m) => m.label),
    );
    expect(inspectorTeamsEqual(before, after)).toBe(false);
  });

  it('fails when the human appears', () => {
    const before = buildInspectorTeam(nodes);
    const after = buildInspectorTeam([
      ...nodes,
      node({ name: 'me', actorName: 'Human-Proxy-0', role: HUMAN_ROLE }),
    ]);

    expect(inspectorTeamsEqual(before, after)).toBe(false);
  });
});
