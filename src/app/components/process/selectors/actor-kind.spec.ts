import { isToolActor } from './actor-kind';

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
