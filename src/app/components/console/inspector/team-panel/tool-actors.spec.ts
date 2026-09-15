import { isHumanNode, isToolActor, toolLabel } from './tool-actors';
import { HUMAN_ROLE } from '../../../process/selectors/graph.selector';

/**
 * The '#'-prefix rule, on its own.
 *
 * These are the assertions that keep the inspector's member list and the Member
 * dropdown in `agent-tabs` filtering the SAME actors. No `TestBed`: the module
 * has no DI, and a harness around three predicates would only make the failure
 * messages worse.
 */
describe('tool actors', () => {
  describe('isToolActor', () => {
    it('recognises the canonical Knowledge Graph actor', () => {
      // The exact name the backend emits (KG_ACTOR_NAME); if this stops being a
      // tool the graph pane gains a member that cannot speak.
      expect(isToolActor({ actorName: '#KnowledgeGraphTool' })).toBe(true);
    });

    it('does not treat an ordinary agent name as a tool', () => {
      expect(isToolActor({ actorName: 'Manager-Supervisor-0' })).toBe(false);
    });

    it('does not treat a name containing a later # as a tool', () => {
      // The marker is a PREFIX. A '#' anywhere else is part of the name.
      expect(isToolActor({ actorName: 'Agent#2' })).toBe(false);
    });

    it('survives a missing actorName rather than throwing', () => {
      // `actorName` is typed `string` but arrives off the wire. A throw here
      // would empty the whole member list over one malformed frame.
      const undefinedName = { actorName: undefined } as unknown as {
        actorName: string;
      };
      const nullName = { actorName: null } as unknown as { actorName: string };
      expect(isToolActor(undefinedName)).toBe(false);
      expect(isToolActor(nullName)).toBe(false);
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
