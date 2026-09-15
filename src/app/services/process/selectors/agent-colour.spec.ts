import { ActorNode } from './actor-kind';
import { agentColours, NO_AGENT_COLOURS } from './agent-colour';

const RAMP = ['#aa0000', '#00bb00', '#0000cc'];

function node(actorName: string, role = 'Assistant'): ActorNode {
  return { actorName, role };
}

/**
 * The lookup that ties the graph, the transcript and the inspector together.
 *
 * No `TestBed`: the module is pure by design and takes its palette as an
 * argument precisely so these can run without a DOM to resolve tokens against.
 */
describe('agentColours', () => {
  it('gives each agent a distinct stop, in discovery order', () => {
    const colours = agentColours(
      [node('@Manager'), node('@Researcher'), node('@Writer')],
      RAMP,
    );

    expect(colours.of('@Manager')).toBe('#aa0000');
    expect(colours.of('@Researcher')).toBe('#00bb00');
    expect(colours.of('@Writer')).toBe('#0000cc');
  });

  it('withholds a colour from the tools', () => {
    // A tool is held by an agent rather than being one; the inspector lists it
    // as a chip, and no surface draws it as a speaker.
    const colours = agentColours([node('#VectorStore', 'Tool')], RAMP);
    expect(colours.of('#VectorStore')).toBeNull();
  });

  it('withholds a colour from the human', () => {
    // The person keeps `--akg-avatar-human-bg` — the palette's one warm tone,
    // which is what carries the human/agent distinction.
    const colours = agentColours([node('@Human', 'Human')], RAMP);
    expect(colours.of('@Human')).toBeNull();
  });

  it('does not let a tool consume a stop', () => {
    // THE REGRESSION THIS GUARDS. If tools took stops, a team that interleaves
    // them would scatter its agents across the ramp, and adding a tool would
    // silently recolour every agent after it.
    const colours = agentColours(
      [
        node('@Manager'),
        node('#VectorStore', 'Tool'),
        node('#Notifier', 'Tool'),
        node('@Researcher'),
      ],
      RAMP,
    );

    expect(colours.of('@Manager')).toBe('#aa0000');
    expect(colours.of('@Researcher')).toBe('#00bb00');
  });

  it('keeps an agent on its first stop when it re-announces itself', () => {
    // The roster is republished on every graph change. Re-assigning would move
    // a node's colour under the user mid-conversation.
    const colours = agentColours(
      [node('@Manager'), node('@Researcher'), node('@Manager')],
      RAMP,
    );

    expect(colours.of('@Manager')).toBe('#aa0000');
    expect(colours.of('@Researcher')).toBe('#00bb00');
  });

  it('wraps rather than running out', () => {
    const colours = agentColours(
      [node('@A'), node('@B'), node('@C'), node('@D')],
      RAMP,
    );
    expect(colours.of('@D')).toBe('#aa0000');
  });

  it('returns null for an actor that is not on the roster', () => {
    // A transport listener on an envelope, or a name read from a message that
    // arrived before the graph did.
    const colours = agentColours([node('@Manager')], RAMP);
    expect(colours.of('@Stranger')).toBeNull();
    expect(colours.of(null)).toBeNull();
    expect(colours.of(undefined)).toBeNull();
  });

  it('is the empty lookup when the deployment declared no ramp', () => {
    // `graphCategoryColors()` drops undeclared tokens, so an empty array is a
    // real state and is what keeps `%` off a zero length.
    const colours = agentColours([node('@Manager')], []);
    expect(colours.of('@Manager')).toBeNull();
  });

  it('exposes an empty lookup for callers with no roster yet', () => {
    expect(NO_AGENT_COLOURS.of('@Manager')).toBeNull();
  });
});
