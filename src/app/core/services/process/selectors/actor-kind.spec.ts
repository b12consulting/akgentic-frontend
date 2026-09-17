import {
  HUMAN_ROLE,
  isAddressableAgent,
  isHumanNode,
  isToolActor,
  isToolNode,
  toolLabel,
} from './actor-kind';

describe('isToolActor', () => {
  it('recognises the tool prefix', () => {
    expect(isToolActor('#VectorStore')).toBeTrue();
    expect(isToolActor('#KnowledgeGraphTool')).toBeTrue();
    expect(isToolActor('#NotificationTool')).toBeTrue();
  });

  it('leaves agents and the human alone', () => {
    expect(isToolActor('@Generalist')).toBeFalse();
    expect(isToolActor('@Human')).toBeFalse();
    expect(isToolActor('@Expert-Analyst-BATCH-1')).toBeFalse();
  });

  it('treats an unidentifiable actor as NOT a tool', () => {
    // Deliberate: an actor we cannot name is better offered and ignored than
    // silently withheld from a list the user is choosing from.
    expect(isToolActor(null)).toBeFalse();
    expect(isToolActor(undefined)).toBeFalse();
    expect(isToolActor('')).toBeFalse();
  });

  it('does not match a hash that is not the prefix', () => {
    expect(isToolActor('@Agent#1')).toBeFalse();
  });
});

/**
 * The '#'-prefix rule and the human role, on their own.
 *
 * MOVED HERE WITH THE CODE. These assertions used to live beside a second copy
 * of the predicates under `console/inspector/team-panel/tool-actors.ts`; they
 * are what keeps the inspector's member list, the Member dropdown, the reader's
 * left-hand column and the hierarchy graph filtering the SAME actors, so they
 * belong to the one module all four now ask.
 */
describe('tool actors (moved from the inspector)', () => {
  describe('isToolNode', () => {
    it('recognises the canonical Knowledge Graph actor', () => {
      // The exact name the backend emits (KG_ACTOR_NAME); if this stops being a
      // tool the graph pane gains a member that cannot speak.
      expect(isToolNode({ actorName: '#KnowledgeGraphTool' })).toBe(true);
    });

    it('does not treat an ordinary agent name as a tool', () => {
      expect(isToolNode({ actorName: 'Manager-Supervisor-0' })).toBe(false);
    });

    it('does not treat a name containing a later # as a tool', () => {
      // The marker is a PREFIX. A '#' anywhere else is part of the name.
      expect(isToolNode({ actorName: 'Agent#2' })).toBe(false);
    });

    it('survives a missing actorName rather than throwing', () => {
      // `actorName` is typed `string` but arrives off the wire. A throw here
      // would empty the whole member list over one malformed frame.
      const undefinedName = { actorName: undefined } as unknown as {
        actorName: string;
      };
      const nullName = { actorName: null } as unknown as { actorName: string };
      expect(isToolNode(undefinedName)).toBe(false);
      expect(isToolNode(nullName)).toBe(false);
    });
  });

  describe('toolLabel', () => {
    it('strips the marker prefix', () => {
      expect(toolLabel({ actorName: '#KnowledgeGraphTool' })).toBe(
        'KnowledgeGraphTool',
      );
    });

    it('strips exactly one #, so a tool named "#odd" keeps its own hash', () => {
      expect(toolLabel({ actorName: '##odd' })).toBe('#odd');
    });

    it('returns a non-tool name unchanged', () => {
      expect(toolLabel({ actorName: 'Researcher' })).toBe('Researcher');
    });

    it('returns the empty string for a missing actorName', () => {
      const missing = { actorName: undefined } as unknown as {
        actorName: string;
      };
      expect(toolLabel(missing)).toBe('');
    });
  });

  describe('isHumanNode', () => {
    it('recognises the protocol human role', () => {
      expect(isHumanNode({ role: HUMAN_ROLE })).toBe(true);
    });

    it('rejects an agent role', () => {
      expect(isHumanNode({ role: 'Assistant' })).toBe(false);
    });

    it('is case-sensitive, matching the protocol value rather than a guess', () => {
      expect(isHumanNode({ role: 'human' })).toBe(false);
    });
  });
});

/**
 * The narrowing every "list of people" surface applies.
 *
 * This is the predicate that fixes the reader: its left-hand column dropped the
 * tools and kept the human, so the person reading it was offered their own
 * transcript beside the agents' — which is the main chat, one pane over.
 */
describe('isAddressableAgent', () => {
  it('offers an ordinary agent', () => {
    expect(
      isAddressableAgent({ actorName: '@Manager', role: 'Assistant' }),
    ).toBeTrue();
  });

  it('withholds the human, who is not somebody to read', () => {
    expect(
      isAddressableAgent({ actorName: '@Human', role: HUMAN_ROLE }),
    ).toBeFalse();
  });

  it('withholds a tool, which is held rather than spoken to', () => {
    expect(
      isAddressableAgent({ actorName: '#VectorStore', role: 'Tool' }),
    ).toBeFalse();
  });

  it('withholds a human-proxy node whatever its actor name is', () => {
    // Role, not name: deployments name the proxy differently
    // (`Human-Proxy-0`), and only the role is protocol.
    expect(
      isAddressableAgent({ actorName: 'Human-Proxy-0', role: HUMAN_ROLE }),
    ).toBeFalse();
  });
});
