import { actorInitial, displayActorName, makeAgentNameUserFriendly } from './util';

const WORKSPACE = '#Workspace-anonymous/_meta/folder-Documents';

describe('displayActorName', () => {
  it('keeps only the leaf of the workspace actor path, without the #', () => {
    expect(displayActorName(WORKSPACE)).toBe('Workspace/folder-Documents');
  });

  it('reads the same without the leading #', () => {
    expect(displayActorName('Workspace-anonymous/_meta/folder-Documents')).toBe(
      'Workspace/folder-Documents',
    );
  });

  it('keeps a path with no slash whole', () => {
    expect(displayActorName('#Workspace-team-42')).toBe('Workspace/team-42');
  });

  it('returns every other name unchanged', () => {
    expect(displayActorName('@Expert')).toBe('@Expert');
    expect(displayActorName('#PlanningTool')).toBe('#PlanningTool');
    expect(displayActorName('@Workspace-Manager')).toBe('@Workspace-Manager');
  });

  it('returns malformed input unchanged without throwing', () => {
    expect(displayActorName('')).toBe('');
    expect(displayActorName('#Workspace-')).toBe('#Workspace-');
    expect(displayActorName('#Workspace-a/b/')).toBe('#Workspace-a/b/');
  });
});

describe('actorInitial', () => {
  it('takes the initial from the display name', () => {
    expect(actorInitial(WORKSPACE)).toBe('W');
    expect(actorInitial('@expert')).toBe('E');
    expect(actorInitial('')).toBe('·');
    expect(actorInitial(undefined)).toBe('·');
  });
});

describe('makeAgentNameUserFriendly', () => {
  it('shows the workspace actor as Workspace/<leaf>', () => {
    expect(makeAgentNameUserFriendly(WORKSPACE)).toBe('Workspace/folder-Documents');
  });

  it('still splits an ordinary name into name and role', () => {
    expect(makeAgentNameUserFriendly('@Alice-data_analyst')).toBe('@Alice [Data analyst]');
    expect(makeAgentNameUserFriendly('@Human')).toBe('@Human');
  });
});
