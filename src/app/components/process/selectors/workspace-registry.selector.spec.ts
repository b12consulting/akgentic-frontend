import { TestBed } from '@angular/core/testing';

import {
  AkgenticMessage,
  BaseConfig,
  isWorkspaceTool,
  StartMessage,
  StopMessage,
  ToolCardLite,
} from '../../../protocol/message.types';
import { MessageLogService } from '../event/message-log.service';
import {
  resolveJoinKeys,
  startContribution,
  WorkspaceDescriptor,
  WorkspaceIdentity,
  workspaceIdentity,
  WorkspaceRegistryService,
  workspaceRegistryReduce,
} from './workspace-registry.selector';

// ---------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------

const TEAM_ID = 'team-1';
const WORKSPACE_MODEL = 'akgentic.tool.workspace.tool.WorkspaceTool';
const WORKSPACE_CONFIG_MODEL = 'akgentic.tool.workspace.models.WorkspaceConfig';

function baseSender(agentName: string) {
  return {
    __actor_address__: true as const,
    agent_id: 'agent-' + agentName,
    name: agentName,
    role: 'Agent',
    squad_id: 's1',
    user_message: false,
  };
}

function workspaceTool(workspaceId?: string | null): ToolCardLite {
  return { __model__: WORKSPACE_MODEL, workspace_id: workspaceId };
}

/** A metadata-layout `WorkspaceTool` card: `workspace_id` is NULL on the wire
 *  (the backend `model_validator` makes the two fields mutually exclusive), so
 *  this is exactly the shape that used to fall back to the team id. */
function metadataTool(keys: string[]): ToolCardLite {
  return {
    __model__: WORKSPACE_MODEL,
    workspace_id: null,
    workspace_metadata_keys: keys,
  };
}

/**
 * The `#Workspace` ACTOR's own `StartMessage` — a child of the orchestrator,
 * `role: 'Tool'`, whose config is a `WorkspaceConfig` rather than an
 * `AgentConfig`. This is the frame that carries the backend's resolved path.
 *
 * `metadataKeys` is omitted deliberately when not passed: `config.metadata_keys`
 * does not exist on the wire until akgentic-tool story 48-4 lands.
 */
function workspaceActorStart(
  path: string,
  metadataKeys?: string[],
): StartMessage {
  const config: Record<string, unknown> = {
    __model__: WORKSPACE_CONFIG_MODEL,
    name: '#Workspace-' + path,
    workspace_path: path,
  };
  if (metadataKeys !== undefined) config['metadata_keys'] = metadataKeys;
  return {
    id: 'start-ws-' + path,
    parent_id: null,
    team_id: TEAM_ID,
    timestamp: new Date().toISOString(),
    sender: {
      __actor_address__: true as const,
      agent_id: 'actor-ws-' + path,
      name: '#Workspace-' + path,
      role: 'Tool',
      squad_id: 's1',
      user_message: false,
    },
    display_type: 'other',
    content: null,
    __model__: 'akgentic.core.messages.orchestrator.StartMessage',
    config: config as unknown as BaseConfig,
    parent: null,
  };
}

// NOTE: the backend AgentConfig does NOT serialise `team_id` — it is absent
// from `config` on the wire. The fixtures omit it deliberately so the fold is
// exercised against the real payload shape (the team id is read from the
// message level, `StartMessage.team_id`, not from `config`).
function makeConfig(tools?: ToolCardLite[]): BaseConfig {
  return {
    name: 'cfg',
    role: 'Agent',
    user_id: 'u1',
    user_email: 'u@x',
    squad_id: 's1',
    orchestrator: baseSender('orchestrator'),
    tools,
  };
}

function makeStartMessage(
  agentName: string,
  tools?: ToolCardLite[],
): StartMessage {
  return {
    id: 'start-' + agentName,
    parent_id: null,
    team_id: TEAM_ID,
    timestamp: new Date().toISOString(),
    sender: baseSender(agentName),
    display_type: 'other',
    content: null,
    __model__: 'akgentic.core.messages.orchestrator.StartMessage',
    config: makeConfig(tools),
    parent: null,
  };
}

function makeStopMessage(agentName: string): StopMessage {
  return {
    id: 'stop-' + agentName,
    parent_id: null,
    team_id: TEAM_ID,
    timestamp: new Date().toISOString(),
    sender: baseSender(agentName),
    display_type: 'other',
    content: null,
    __model__: 'akgentic.core.messages.orchestrator.StopMessage',
  };
}

function findById(
  result: WorkspaceDescriptor[],
  workspaceId: string,
): WorkspaceDescriptor | undefined {
  return result.find((d) => d.workspaceId === workspaceId);
}

describe('isWorkspaceTool (guard)', () => {
  it('matches a __model__ ending in WorkspaceTool', () => {
    expect(isWorkspaceTool(workspaceTool('w1'))).toBe(true);
  });

  it('rejects other tools, empty, and mid-string WorkspaceTool', () => {
    expect(
      isWorkspaceTool({ __model__: 'akgentic.tool.kg.tool.KnowledgeGraphTool' }),
    ).toBe(false);
    expect(
      isWorkspaceTool({ __model__: 'akgentic.tool.vector.VectorStoreTool' }),
    ).toBe(false);
    expect(isWorkspaceTool({ __model__: '' })).toBe(false);
    // Contains WorkspaceTool mid-string but does NOT end in it → rejected.
    expect(isWorkspaceTool({ __model__: 'WorkspaceToolFactory' })).toBe(false);
  });
});

describe('workspaceRegistryReduce (pure function)', () => {
  it('(AC6) empty log → no descriptors (no always-present default)', () => {
    const result = workspaceRegistryReduce([], TEAM_ID);
    expect(result).toEqual([]);
  });

  it('(AC3) StartMessage with a named WorkspaceTool only → one named descriptor, no default', () => {
    const log: AkgenticMessage[] = [
      makeStartMessage('A', [workspaceTool('ws-named')]),
    ];
    const result = workspaceRegistryReduce(log, TEAM_ID);
    expect(result.length).toBe(1);
    const named = findById(result, 'ws-named');
    expect(named?.isDefault).toBe(false);
    expect(named?.agentIds).toEqual(['agent-A']);
    // No agent declared a no-workspace_id tool → there is NO default descriptor.
    expect(findById(result, TEAM_ID)).toBeUndefined();
  });

  it('(AC4) no workspace_id → creates the default descriptor keyed by the team id', () => {
    const log: AkgenticMessage[] = [
      makeStartMessage('A', [workspaceTool(null)]),
    ];
    const result = workspaceRegistryReduce(log, TEAM_ID);
    // A no-workspace_id tool resolves to the team id → the (only) default.
    expect(result.length).toBe(1);
    expect(findById(result, TEAM_ID)?.isDefault).toBe(true);
    expect(findById(result, TEAM_ID)?.agentIds).toEqual(['agent-A']);
  });

  it('(AC4) effective-id — explicit workspace_id resolves to that id', () => {
    const log: AkgenticMessage[] = [
      makeStartMessage('A', [workspaceTool('ws-x')]),
    ];
    const result = workspaceRegistryReduce(log, TEAM_ID);
    expect(findById(result, 'ws-x')).toBeDefined();
    expect(findById(result, 'ws-x')?.agentIds).toEqual(['agent-A']);
  });

  it('(order) default sorts first, named workspaces follow alphabetically', () => {
    const log: AkgenticMessage[] = [
      makeStartMessage('A', [workspaceTool('shared_workspace')]),
      makeStartMessage('B', [workspaceTool(null)]), // default, declared later
      makeStartMessage('C', [workspaceTool('alpha')]),
    ];
    const result = workspaceRegistryReduce(log, TEAM_ID);
    // Default first despite being declared second; named ones alphabetical.
    expect(result.map((d) => d.workspaceId)).toEqual([
      TEAM_ID,
      'alpha',
      'shared_workspace',
    ]);
    expect(result[0].isDefault).toBe(true);
  });

  it('(AC5) two agents sharing one effective id collapse to one descriptor recording both', () => {
    const log: AkgenticMessage[] = [
      makeStartMessage('A', [workspaceTool('ws-shared')]),
      makeStartMessage('B', [workspaceTool('ws-shared')]),
    ];
    const result = workspaceRegistryReduce(log, TEAM_ID);
    const shared = findById(result, 'ws-shared');
    expect(shared?.agentIds).toEqual(['agent-A', 'agent-B']);
    expect(result.filter((d) => d.workspaceId === 'ws-shared').length).toBe(1);
  });

  it('(AC6) a WorkspaceTool with effective id == team id folds into the default, no second default', () => {
    const log: AkgenticMessage[] = [
      makeStartMessage('A', [workspaceTool(TEAM_ID)]),
    ];
    const result = workspaceRegistryReduce(log, TEAM_ID);
    const defaults = result.filter((d) => d.isDefault);
    expect(defaults.length).toBe(1);
    expect(defaults[0].agentIds).toEqual(['agent-A']);
  });

  it('(AC7) Stop drops the member but KEEPS the workspace (sticky — operator retains access)', () => {
    const log: AkgenticMessage[] = [
      makeStartMessage('A', [workspaceTool('ws-named')]),
      makeStopMessage('A'),
    ];
    const result = workspaceRegistryReduce(log, TEAM_ID);
    const named = findById(result, 'ws-named');
    expect(named).toBeDefined();
    // The fired member is gone, but the workspace persists with no members.
    expect(named?.agentIds).toEqual([]);
  });

  it('(AC7) Stop — descriptor backed by another agent survives, stopped agent removed', () => {
    const log: AkgenticMessage[] = [
      makeStartMessage('A', [workspaceTool('ws-shared')]),
      makeStartMessage('B', [workspaceTool('ws-shared')]),
      makeStopMessage('A'),
    ];
    const result = workspaceRegistryReduce(log, TEAM_ID);
    const shared = findById(result, 'ws-shared');
    expect(shared).toBeDefined();
    expect(shared?.agentIds).toEqual(['agent-B']);
  });

  it('(AC7) ordered last-wins — Start → Stop → Start ends with the named workspace present', () => {
    const start1 = makeStartMessage('A', [workspaceTool('ws-named')]);
    start1.id = 'a-start-1';
    const stop1 = makeStopMessage('A');
    stop1.id = 'a-stop-1';
    const start2 = makeStartMessage('A', [workspaceTool('ws-named')]);
    start2.id = 'a-start-2';
    const result = workspaceRegistryReduce([start1, stop1, start2], TEAM_ID);
    expect(findById(result, 'ws-named')?.agentIds).toEqual(['agent-A']);
  });

  it('(AC7) Stop keeps the default workspace (sticky), drops its member', () => {
    const log: AkgenticMessage[] = [
      makeStartMessage('A', [workspaceTool(TEAM_ID)]),
      makeStopMessage('A'),
    ];
    const result = workspaceRegistryReduce(log, TEAM_ID);
    const def = findById(result, TEAM_ID);
    expect(def?.isDefault).toBe(true);
    expect(def?.agentIds).toEqual([]);
  });

  it('(sticky) a team that never declared a WorkspaceTool stays empty', () => {
    const log: AkgenticMessage[] = [makeStartMessage('A', [])];
    expect(workspaceRegistryReduce(log, TEAM_ID)).toEqual([]);
  });

  it('(NFR4) realistic serialized StartMessage fixture → named descriptor registered', () => {
    // A JSON-shaped StartMessage as it arrives on the wire: config serialised
    // in full, config.tools holding a nested WorkspaceTool object with both a
    // recursive __model__ and a workspace_id. If a future infra serialization
    // change drops `tools` or renames the discriminator, this fails in CI
    // rather than silently collapsing the registry to the default-only tab.
    const serialized = {
      id: 'start-serialized',
      parent_id: null,
      team_id: TEAM_ID,
      timestamp: '2026-06-16T00:00:00.000Z',
      sender: {
        __actor_address__: true,
        agent_id: 'agent-serialized',
        name: 'Researcher',
        role: 'Agent',
        squad_id: 's1',
        user_message: false,
      },
      display_type: 'other',
      content: null,
      __model__: 'akgentic.core.messages.orchestrator.StartMessage',
      parent: null,
      // NOTE: NO `team_id` in config — the backend AgentConfig does not
      // serialise it. The team id is only present at the MESSAGE level above.
      config: {
        name: 'Researcher',
        role: 'Agent',
        user_id: 'u1',
        user_email: 'u@x',
        squad_id: 's1',
        orchestrator: {
          __actor_address__: true,
          agent_id: 'orch',
          name: 'orchestrator',
          role: 'Orchestrator',
          squad_id: 's1',
          user_message: false,
        },
        tools: [
          {
            __model__: WORKSPACE_MODEL,
            workspace_id: 'ws-from-wire',
          },
          // Default workspace tool: NO workspace_id → must resolve to the
          // team default via the message-level team_id (NOT config.team_id,
          // which is absent on the wire). Regression guard for the bug where
          // default-workspace members showed no chips.
          {
            __model__: WORKSPACE_MODEL,
            workspace_id: null,
          },
        ],
      },
    } as unknown as AkgenticMessage;

    const result = workspaceRegistryReduce([serialized], TEAM_ID);
    const named = findById(result, 'ws-from-wire');
    expect(named).toBeDefined();
    expect(named?.isDefault).toBe(false);
    expect(named?.agentIds).toEqual(['agent-serialized']);
    // The default tool (no workspace_id, config without team_id) still lands
    // in the team-default descriptor — resolved from the message team_id.
    const def = findById(result, TEAM_ID);
    expect(def?.isDefault).toBe(true);
    expect(def?.agentIds).toEqual(['agent-serialized']);
  });
});

// ---------------------------------------------------------------------
// Story 51-1 — identity read off the `#Workspace` StartMessage
// ---------------------------------------------------------------------

describe('workspaceIdentity (identity off the wire)', () => {
  it('(AC1) reads the LAST path segment of a #Workspace actor config', () => {
    const identity = workspaceIdentity(
      workspaceActorStart('_meta/tenant-azerty', ['tenant']),
    );
    expect(identity).toEqual({
      leaf: 'tenant-azerty',
      metadataKeys: ['tenant'],
    });
  });

  it('(AC6) metadata_keys absent on the wire → an EMPTY key list, not a parse', () => {
    const identity = workspaceIdentity(
      workspaceActorStart('_meta/customer_id-ACME__case_id-42'),
    );
    // The leaf is carried verbatim; nothing splits it on `__` or `-`.
    expect(identity).toEqual({
      leaf: 'customer_id-ACME__case_id-42',
      metadataKeys: [],
    });
  });

  it('a non-array metadata_keys off the wire degrades to [] instead of throwing', () => {
    const frame = workspaceActorStart('_meta/tenant-azerty');
    (frame.config as unknown as Record<string, unknown>)['metadata_keys'] =
      'tenant';
    expect(workspaceIdentity(frame)).toEqual({
      leaf: 'tenant-azerty',
      metadataKeys: [],
    });
    // And the fold built on it stays intact rather than tearing down.
    const result = workspaceRegistryReduce(
      [frame, makeStartMessage('A', [metadataTool(['tenant'])])],
      TEAM_ID,
    );
    expect(result.map((d) => d.workspaceId)).toEqual(['tenant-azerty']);
    expect(result[0].agentIds).toEqual([]);
  });

  it('rejects an agent StartMessage, and an empty last segment', () => {
    expect(workspaceIdentity(makeStartMessage('A', [workspaceTool('w')]))).toBe(
      null,
    );
    expect(workspaceIdentity(workspaceActorStart('users/u1/'))).toBe(null);
    expect(workspaceIdentity(workspaceActorStart(''))).toBe(null);
  });
});

describe('startContribution (the card declaration, not an id)', () => {
  it('(AC3) maps the three card shapes to their join kinds', () => {
    expect(
      startContribution(
        makeStartMessage('A', [
          workspaceTool('notes'),
          workspaceTool(null),
          metadataTool(['customer_id']),
        ]),
      ),
    ).toEqual([
      { kind: 'named', workspaceId: 'notes' },
      { kind: 'default' },
      { kind: 'metadata', metadataKeys: ['customer_id'] },
    ]);
  });

  it('(AC1) a metadata card does NOT fall back to `default` despite a null workspace_id', () => {
    const keys = startContribution(
      makeStartMessage('A', [metadataTool(['tenant'])]),
    );
    expect(keys).toEqual([{ kind: 'metadata', metadataKeys: ['tenant'] }]);
    expect(keys.some((k) => k.kind === 'default')).toBe(false);
  });

  it('an EMPTY workspace_metadata_keys list is not a metadata card', () => {
    expect(
      startContribution(
        makeStartMessage('A', [
          { __model__: WORKSPACE_MODEL, workspace_metadata_keys: [] },
        ]),
      ),
    ).toEqual([{ kind: 'default' }]);
  });
});

describe('resolveJoinKeys (join, no normalisation)', () => {
  function identityMap(
    ...entries: WorkspaceIdentity[]
  ): Map<string, WorkspaceIdentity> {
    return new Map(entries.map((i) => [i.leaf, i]));
  }

  it('(AC5) key order is part of the identity — ["b","a"] does NOT join ["a","b"]', () => {
    const identities = identityMap({
      leaf: 'a-1__b-2',
      metadataKeys: ['a', 'b'],
    });
    const resolved = resolveJoinKeys(
      [{ kind: 'metadata', metadataKeys: ['b', 'a'] }],
      identities,
      TEAM_ID,
    );
    expect([...resolved]).toEqual([]);
  });

  it('(AC5) the same list in the same order DOES join', () => {
    const identities = identityMap({
      leaf: 'a-1__b-2',
      metadataKeys: ['a', 'b'],
    });
    const resolved = resolveJoinKeys(
      [{ kind: 'metadata', metadataKeys: ['a', 'b'] }],
      identities,
      TEAM_ID,
    );
    expect([...resolved]).toEqual(['a-1__b-2']);
  });

  it('a metadata key matching no identity resolves to NOTHING (no team-id fallback)', () => {
    const resolved = resolveJoinKeys(
      [{ kind: 'metadata', metadataKeys: ['tenant'] }],
      identityMap(),
      TEAM_ID,
    );
    expect([...resolved]).toEqual([]);
  });

  it('an EMPTY key list joins NOTHING, not every keyless identity', () => {
    // `listEquals([], [])` is TRUE, and a named workspace, a default one and a
    // pre-48-4 metadata one ALL announce `metadataKeys: []`. Without the guard
    // in `resolveJoinKeys` an empty declaration would join all three at once —
    // the cross-contamination AC4 forbids, reached from the one direction
    // `startContribution`'s own non-empty check does not cover.
    const identities = identityMap(
      { leaf: 'notes', metadataKeys: [] },
      { leaf: TEAM_ID, metadataKeys: [] },
      { leaf: 'customer_id-ACME', metadataKeys: [] },
    );
    const resolved = resolveJoinKeys(
      [{ kind: 'metadata', metadataKeys: [] }],
      identities,
      TEAM_ID,
    );
    expect([...resolved]).toEqual([]);
  });
});

describe('workspaceRegistryReduce — metadata workspaces (Story 51-1)', () => {
  it('(AC1) a metadata workspace is listed under its LEAF, not as the default', () => {
    const log: AkgenticMessage[] = [
      workspaceActorStart('_meta/tenant-azerty', ['tenant']),
      makeStartMessage('A', [metadataTool(['tenant'])]),
    ];
    const result = workspaceRegistryReduce(log, TEAM_ID);
    expect(result.length).toBe(1);
    const meta = findById(result, 'tenant-azerty');
    expect(meta?.isDefault).toBe(false);
    expect(meta?.label).toBe('tenant-azerty');
    expect(meta?.agentIds).toEqual(['agent-A']);
    // The bug this story removes: the card collapsing into the team default.
    expect(findById(result, TEAM_ID)).toBeUndefined();
    expect(result.some((d) => d.label === 'Default workspace')).toBe(false);
  });

  it('(AC1) the agent StartMessage may arrive BEFORE the #Workspace actor frame', () => {
    const log: AkgenticMessage[] = [
      makeStartMessage('A', [metadataTool(['tenant'])]),
      workspaceActorStart('_meta/tenant-azerty', ['tenant']),
    ];
    const result = workspaceRegistryReduce(log, TEAM_ID);
    expect(findById(result, 'tenant-azerty')?.agentIds).toEqual(['agent-A']);
  });

  it('(AC2) the descriptor id is byte-identical to the last path segment, percent escapes included', () => {
    const log: AkgenticMessage[] = [
      workspaceActorStart('_meta/case_id-2026%2D42', ['case_id']),
      makeStartMessage('A', [metadataTool(['case_id'])]),
    ];
    const result = workspaceRegistryReduce(log, TEAM_ID);
    expect(result.map((d) => d.workspaceId)).toEqual(['case_id-2026%2D42']);
    expect(result[0].agentIds).toEqual(['agent-A']);
  });

  it('(AC3) all three card shapes join their own workspace in one team', () => {
    const log: AkgenticMessage[] = [
      workspaceActorStart('_meta/tenant-azerty', ['tenant']),
      makeStartMessage('N', [workspaceTool('notes')]),
      makeStartMessage('D', [workspaceTool(null)]),
      makeStartMessage('M', [metadataTool(['tenant'])]),
    ];
    const result = workspaceRegistryReduce(log, TEAM_ID);
    expect(findById(result, 'notes')?.agentIds).toEqual(['agent-N']);
    expect(findById(result, TEAM_ID)?.isDefault).toBe(true);
    expect(findById(result, TEAM_ID)?.agentIds).toEqual(['agent-D']);
    expect(findById(result, 'tenant-azerty')?.agentIds).toEqual(['agent-M']);
  });

  it('(AC4) two key sets in one team → two descriptors, no cross-contamination', () => {
    const log: AkgenticMessage[] = [
      workspaceActorStart('_meta/customer_id-ACME', ['customer_id']),
      workspaceActorStart('_meta/customer_id-ACME__case_id-42', [
        'customer_id',
        'case_id',
      ]),
      makeStartMessage('Coarse', [metadataTool(['customer_id'])]),
      makeStartMessage('Fine', [metadataTool(['customer_id', 'case_id'])]),
    ];
    const result = workspaceRegistryReduce(log, TEAM_ID);
    expect(result.length).toBe(2);
    expect(findById(result, 'customer_id-ACME')?.agentIds).toEqual([
      'agent-Coarse',
    ]);
    expect(
      findById(result, 'customer_id-ACME__case_id-42')?.agentIds,
    ).toEqual(['agent-Fine']);
  });

  it('(AC5) a card declaring ["b","a"] joins NOTHING when the identity carries ["a","b"]', () => {
    const log: AkgenticMessage[] = [
      workspaceActorStart('_meta/a-1__b-2', ['a', 'b']),
      makeStartMessage('A', [metadataTool(['b', 'a'])]),
    ];
    const result = workspaceRegistryReduce(log, TEAM_ID);
    // The workspace is still listed (identity is monotonic) — with no members.
    expect(result.map((d) => d.workspaceId)).toEqual(['a-1__b-2']);
    expect(result[0].agentIds).toEqual([]);
  });

  it('(AC6) an identity without metadata_keys is listed, and joins no card', () => {
    const log: AkgenticMessage[] = [
      workspaceActorStart('_meta/customer_id-ACME__case_id-42'),
      makeStartMessage('A', [metadataTool(['customer_id', 'case_id'])]),
    ];
    const result = workspaceRegistryReduce(log, TEAM_ID);
    expect(result.map((d) => d.workspaceId)).toEqual([
      'customer_id-ACME__case_id-42',
    ]);
    expect(result[0].isDefault).toBe(false);
    // Nothing recovers the keys by splitting the leaf on `__` or `-`.
    expect(result[0].agentIds).toEqual([]);
    expect(findById(result, TEAM_ID)).toBeUndefined();
  });

  it('(AC8) a metadata workspace survives a StopMessage, with an empty member list', () => {
    const log: AkgenticMessage[] = [
      workspaceActorStart('_meta/tenant-azerty', ['tenant']),
      makeStartMessage('A', [metadataTool(['tenant'])]),
      makeStopMessage('A'),
    ];
    const result = workspaceRegistryReduce(log, TEAM_ID);
    const meta = findById(result, 'tenant-azerty');
    expect(meta).toBeDefined();
    expect(meta?.agentIds).toEqual([]);
  });

  it('(AC7) a legacy team announcing NO identity still lists its named/default workspaces', () => {
    // ADR-048 §Decision 7b: pre-rename WorkspaceConfig events are skipped as
    // corrupted on load, so no `#Workspace` frame ever arrives. `seen` reads
    // both sources precisely so this team does not go empty.
    const log: AkgenticMessage[] = [
      makeStartMessage('A', [workspaceTool('ws-named'), workspaceTool(null)]),
    ];
    const result = workspaceRegistryReduce(log, TEAM_ID);
    expect(result.map((d) => d.workspaceId)).toEqual([TEAM_ID, 'ws-named']);
  });

  it('(NFR4) realistic serialized #Workspace + metadata-card fixture', () => {
    // Both frames as they arrive on the wire: the `#Workspace` actor's own
    // StartMessage (config = WorkspaceConfig, role Tool, orchestrator child)
    // beside an agent StartMessage whose card declares the key list. If a
    // future serialization change renames `workspace_path`, drops
    // `metadata_keys`, or stops emitting the actor frame, this fails in CI
    // rather than silently emptying the picker.
    const workspaceActor = {
      id: 'start-ws-serialized',
      parent_id: null,
      team_id: TEAM_ID,
      timestamp: '2026-09-07T00:00:00.000Z',
      sender: {
        __actor_address__: true,
        agent_id: 'actor-ws-serialized',
        name: '#Workspace-_meta/tenant-azerty',
        role: 'Tool',
        squad_id: 's1',
        user_message: false,
      },
      display_type: 'other',
      content: null,
      __model__: 'akgentic.core.messages.orchestrator.StartMessage',
      parent: null,
      config: {
        __model__: WORKSPACE_CONFIG_MODEL,
        name: '#Workspace-_meta/tenant-azerty',
        workspace_path: '_meta/tenant-azerty',
        metadata_keys: ['tenant'],
      },
    } as unknown as AkgenticMessage;

    const agent = {
      id: 'start-agent-serialized',
      parent_id: null,
      team_id: TEAM_ID,
      timestamp: '2026-09-07T00:00:01.000Z',
      sender: {
        __actor_address__: true,
        agent_id: 'agent-serialized',
        name: 'Researcher',
        role: 'Agent',
        squad_id: 's1',
        user_message: false,
      },
      display_type: 'other',
      content: null,
      __model__: 'akgentic.core.messages.orchestrator.StartMessage',
      parent: null,
      config: {
        name: 'Researcher',
        role: 'Agent',
        user_id: 'u1',
        user_email: 'u@x',
        squad_id: 's1',
        orchestrator: {
          __actor_address__: true,
          agent_id: 'orch',
          name: 'orchestrator',
          role: 'Orchestrator',
          squad_id: 's1',
          user_message: false,
        },
        tools: [
          {
            __model__: WORKSPACE_MODEL,
            workspace_id: null,
            workspace_metadata_keys: ['tenant'],
          },
        ],
      },
    } as unknown as AkgenticMessage;

    const result = workspaceRegistryReduce([workspaceActor, agent], TEAM_ID);
    expect(result.map((d) => d.workspaceId)).toEqual(['tenant-azerty']);
    expect(result[0].isDefault).toBe(false);
    expect(result[0].agentIds).toEqual(['agent-serialized']);
  });
});

describe('WorkspaceRegistryService (selector over MessageLogService.log$)', () => {
  let log: MessageLogService;
  let service: WorkspaceRegistryService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [MessageLogService, WorkspaceRegistryService],
    });
    log = TestBed.inject(MessageLogService);
    service = TestBed.inject(WorkspaceRegistryService);
  });

  function currentValue(): WorkspaceDescriptor[] {
    let v: WorkspaceDescriptor[] | undefined;
    const sub = service.workspaces$.subscribe((x) => (v = x));
    sub.unsubscribe();
    return v as WorkspaceDescriptor[];
  }

  it('(1) initial empty log → no descriptors', () => {
    const result = currentValue();
    expect(result).toEqual([]);
  });

  it('(2) live append of a named-WorkspaceTool StartMessage → one named descriptor', () => {
    log.append(makeStartMessage('A', [workspaceTool('ws-named')]));
    const result = currentValue();
    expect(result.length).toBe(1);
    expect(findById(result, 'ws-named')?.agentIds).toEqual(['agent-A']);
    expect(findById(result, TEAM_ID)).toBeUndefined();
  });

  it('(3) distinctUntilChanged suppresses structurally identical re-emissions', () => {
    const emissions: WorkspaceDescriptor[][] = [];
    const sub = service.workspaces$.subscribe((v) => emissions.push(v));

    const start1 = makeStartMessage('A', [workspaceTool('ws-named')]);
    start1.id = 'a-1';
    const start2 = makeStartMessage('A', [workspaceTool('ws-named')]);
    start2.id = 'a-2';
    log.append(start1);
    log.append(start2);

    // [initial empty, after first named start]. The second start for the same
    // agent yields the same effective contribution → structurally identical
    // fold → distinctUntilChanged suppresses a third emission.
    expect(emissions.length).toBe(2);
    sub.unsubscribe();
  });

  it('(4) log.reset() clears the registry on team switch', () => {
    log.append(makeStartMessage('A', [workspaceTool('ws-named')]));
    expect(currentValue().length).toBe(1);
    log.reset();
    expect(currentValue()).toEqual([]);
  });
});
