import { TestBed } from '@angular/core/testing';

import {
  AkgenticMessage,
  BaseConfig,
  isResourceAttached,
  ResourceAttached,
  StartMessage,
  StopMessage,
  ToolCardLite,
} from '../../../protocol/message.types';
import { MessageLogService } from '../event/message-log.service';
import {
  attachedAgentId,
  attachedLeaf,
  WorkspaceDescriptor,
  WorkspaceRegistryService,
  workspaceRegistryReduce,
} from './workspace-registry.selector';

// ---------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------

const TEAM_ID = 'team-1';
const WORKSPACE_MODEL = 'akgentic.tool.workspace.tool.WorkspaceTool';
const ATTACHED_MODEL = 'akgentic.core.messages.orchestrator.ResourceAttached';

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

/** The ORCHESTRATOR's address — the sender of every attach event, and never the
 *  binding agent. */
function orchestratorSender() {
  return {
    __actor_address__: true as const,
    agent_id: 'agent-orchestrator',
    name: 'orchestrator',
    role: 'Orchestrator',
    squad_id: 's1',
    user_message: false,
  };
}

let attachSeq = 0;

/**
 * A `ResourceAttached` as the orchestrator emits it (ADR-022 §Decision 8).
 *
 * The sender is ALWAYS the orchestrator; the binding agent is the top-level
 * `agent_id`. The two are deliberately different ids in every fixture so no spec
 * can pass by keying on the wrong one.
 */
function resourceAttached(
  agentName: string,
  workspacePath: string,
  metadataKeys?: string[],
): ResourceAttached {
  attachSeq += 1;
  const frame: ResourceAttached = {
    id: 'attach-' + attachSeq,
    parent_id: null,
    team_id: TEAM_ID,
    timestamp: new Date().toISOString(),
    sender: orchestratorSender(),
    display_type: 'other',
    content: null,
    __model__: ATTACHED_MODEL,
    agent_id: 'agent-' + agentName,
    workspace_path: workspacePath,
  };
  if (metadataKeys !== undefined) frame.metadata_keys = metadataKeys;
  return frame;
}

function workspaceTool(workspaceId?: string | null): ToolCardLite {
  return { __model__: WORKSPACE_MODEL, workspace_id: workspaceId };
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

// ---------------------------------------------------------------------
// The guard (AC9/AC11)
// ---------------------------------------------------------------------

describe('isResourceAttached (guard)', () => {
  it('matches the fully-qualified attach discriminator', () => {
    expect(isResourceAttached(resourceAttached('A', 'users/u1/notes'))).toBe(
      true,
    );
  });

  it('rejects every other message model reaching a team stream', () => {
    // The substring check, exercised in the admitting direction: none of the
    // lifecycle or telemetry models this package folds contains
    // 'ResourceAttached'.
    for (const model of [
      'akgentic.core.messages.orchestrator.StartMessage',
      'akgentic.core.messages.orchestrator.StopMessage',
      'akgentic.core.messages.orchestrator.SentMessage',
      'akgentic.core.messages.orchestrator.EventMessage',
      'akgentic.core.messages.orchestrator.ErrorMessage',
      'akgentic.core.messages.orchestrator.StateChangedMessage',
      '',
    ]) {
      const frame = { __model__: model } as unknown as StartMessage;
      expect(isResourceAttached(frame)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------
// Leaf and binding-agent extraction (AC2, AC4, AC7)
// ---------------------------------------------------------------------

describe('attachedLeaf (the id is READ, never parsed)', () => {
  it('(AC2) reads the LAST path segment of the resolved path', () => {
    expect(attachedLeaf(resourceAttached('A', '_meta/tenant-azerty'))).toBe(
      'tenant-azerty',
    );
  });

  it('(AC2) the encoded metadata leaf is carried verbatim', () => {
    // Nothing splits it on `__` or `-`, and nothing percent-decodes it.
    expect(
      attachedLeaf(
        resourceAttached('A', '_meta/customer_id-ACME__case_id-42'),
      ),
    ).toBe('customer_id-ACME__case_id-42');
    expect(
      attachedLeaf(resourceAttached('A', '_meta/case_id-2026%2D42')),
    ).toBe('case_id-2026%2D42');
  });

  it('(AC7) an empty last segment is not an id', () => {
    expect(attachedLeaf(resourceAttached('A', 'users/u1/'))).toBe(null);
    expect(attachedLeaf(resourceAttached('A', ''))).toBe(null);
  });

  it('(AC7) a non-string workspace_path degrades to null instead of throwing', () => {
    const frame = resourceAttached('A', 'users/u1/notes');
    (frame as unknown as Record<string, unknown>)['workspace_path'] = 42;
    expect(() => attachedLeaf(frame)).not.toThrow();
    expect(attachedLeaf(frame)).toBe(null);
  });

  it('(AC7) an absent workspace_path degrades to null instead of throwing', () => {
    const frame = resourceAttached('A', 'users/u1/notes');
    delete (frame as unknown as Record<string, unknown>)['workspace_path'];
    expect(() => attachedLeaf(frame)).not.toThrow();
    expect(attachedLeaf(frame)).toBe(null);
  });
});

describe('attachedAgentId (the BINDING agent, never the sender)', () => {
  it('(AC4) reads the top-level agent_id, which is NOT the sender', () => {
    const frame = resourceAttached('A', 'users/u1/notes');
    expect(attachedAgentId(frame)).toBe('agent-A');
    // The sender of this frame is the orchestrator, and the two differ.
    expect(frame.sender.agent_id).toBe('agent-orchestrator');
    expect(attachedAgentId(frame)).not.toBe(frame.sender.agent_id);
  });

  it('(AC7) a missing or non-string agent_id degrades to null', () => {
    const missing = resourceAttached('A', 'users/u1/notes');
    delete (missing as unknown as Record<string, unknown>)['agent_id'];
    expect(attachedAgentId(missing)).toBe(null);

    const wrongType = resourceAttached('A', 'users/u1/notes');
    (wrongType as unknown as Record<string, unknown>)['agent_id'] = 7;
    expect(attachedAgentId(wrongType)).toBe(null);

    const empty = resourceAttached('A', 'users/u1/notes');
    empty.agent_id = '';
    expect(attachedAgentId(empty)).toBe(null);
  });
});

// ---------------------------------------------------------------------
// The fold (AC1-AC7)
// ---------------------------------------------------------------------

describe('workspaceRegistryReduce (pure function)', () => {
  it('(AC1) empty log → no descriptors (no always-present default)', () => {
    expect(workspaceRegistryReduce([], TEAM_ID)).toEqual([]);
  });

  it('(AC2) the three ADR-048 layouts — default: <user_segment>/<team_id>', () => {
    const result = workspaceRegistryReduce(
      [resourceAttached('A', 'users/u1/' + TEAM_ID)],
      TEAM_ID,
    );
    expect(result.length).toBe(1);
    expect(result[0].workspaceId).toBe(TEAM_ID);
    expect(result[0].isDefault).toBe(true);
    expect(result[0].label).toBe('Default workspace');
  });

  it('(AC2) the three ADR-048 layouts — named: <user_segment>/notes', () => {
    const result = workspaceRegistryReduce(
      [resourceAttached('A', 'users/u1/notes')],
      TEAM_ID,
    );
    expect(result.length).toBe(1);
    expect(result[0].workspaceId).toBe('notes');
    expect(result[0].isDefault).toBe(false);
    expect(result[0].label).toBe('notes');
  });

  it('(AC2) the three ADR-048 layouts — metadata: the encoded leaf', () => {
    const result = workspaceRegistryReduce(
      [
        resourceAttached('A', '_meta/customer_id-ACME__case_id-42', [
          'customer_id',
          'case_id',
        ]),
      ],
      TEAM_ID,
    );
    expect(result.map((d) => d.workspaceId)).toEqual([
      'customer_id-ACME__case_id-42',
    ]);
    expect(result[0].isDefault).toBe(false);
    // The bug epic 51 removed and this story must not reintroduce: the metadata
    // workspace collapsing into the team default.
    expect(findById(result, TEAM_ID)).toBeUndefined();
  });

  it('(AC4) the member is the BINDING agent and NOT the sender', () => {
    // The trap of this epic, asserted in BOTH directions against ONE event with
    // two different ids. Keying on `sender.agent_id` renders a plausible chip
    // rather than throwing, so "a chip exists" would not catch it.
    const frame = resourceAttached('A', 'users/u1/notes');
    expect(frame.agent_id).not.toBe(frame.sender.agent_id);

    const result = workspaceRegistryReduce([frame], TEAM_ID);
    expect(result.length).toBe(1);
    expect(result[0].agentIds).toEqual(['agent-A']);
    expect(result[0].agentIds).not.toContain('agent-orchestrator');
    expect(result[0].agentIds).not.toContain(frame.sender.agent_id);
  });

  it('(AC5) two agents on one workspace → two events, one descriptor, two members', () => {
    // Core emits one event per successful forward INCLUDING a cache hit, which
    // is what makes membership a field read rather than a reconstruction.
    const result = workspaceRegistryReduce(
      [
        resourceAttached('B', 'users/u1/shared'),
        resourceAttached('A', 'users/u1/shared'),
      ],
      TEAM_ID,
    );
    expect(result.length).toBe(1);
    expect(result[0].workspaceId).toBe('shared');
    expect(result[0].agentIds).toEqual(['agent-A', 'agent-B']);
  });

  it('(AC3) Stop removes the member from EVERY workspace and removes NO workspace', () => {
    // The non-empty state is asserted FIRST, so the empty one below is not
    // vacuous: without the first fold, "agentIds is []" would pass on a fold
    // that never added a member at all.
    const attachOne = resourceAttached('A', 'users/u1/notes');
    const attachTwo = resourceAttached('A', '_meta/tenant-azerty', ['tenant']);
    const before = workspaceRegistryReduce([attachOne, attachTwo], TEAM_ID);
    expect(before.map((d) => d.workspaceId).sort()).toEqual([
      'notes',
      'tenant-azerty',
    ]);
    expect(findById(before, 'notes')?.agentIds).toEqual(['agent-A']);
    expect(findById(before, 'tenant-azerty')?.agentIds).toEqual(['agent-A']);

    const after = workspaceRegistryReduce(
      [attachOne, attachTwo, makeStopMessage('A')],
      TEAM_ID,
    );
    // Both workspaces survive; the member is gone from both.
    expect(after.map((d) => d.workspaceId).sort()).toEqual([
      'notes',
      'tenant-azerty',
    ]);
    expect(findById(after, 'notes')?.agentIds).toEqual([]);
    expect(findById(after, 'tenant-azerty')?.agentIds).toEqual([]);
  });

  it('(AC3) Stop is keyed by sender.agent_id — another agent keeps its membership', () => {
    const result = workspaceRegistryReduce(
      [
        resourceAttached('A', 'users/u1/shared'),
        resourceAttached('B', 'users/u1/shared'),
        makeStopMessage('A'),
      ],
      TEAM_ID,
    );
    expect(findById(result, 'shared')?.agentIds).toEqual(['agent-B']);
  });

  it('(AC3) a workspace stays listed after EVERY contributing agent stopped', () => {
    const attach = resourceAttached('A', 'users/u1/notes');
    const before = workspaceRegistryReduce([attach], TEAM_ID);
    expect(before[0].agentIds).toEqual(['agent-A']);

    const after = workspaceRegistryReduce(
      [attach, makeStopMessage('A')],
      TEAM_ID,
    );
    expect(after.length).toBe(1);
    expect(after[0].workspaceId).toBe('notes');
    expect(after[0].agentIds).toEqual([]);
  });

  it('(AC3) ordered last-wins — attach → stop → attach ends with the member present', () => {
    const result = workspaceRegistryReduce(
      [
        resourceAttached('A', 'users/u1/notes'),
        makeStopMessage('A'),
        resourceAttached('A', 'users/u1/notes'),
      ],
      TEAM_ID,
    );
    expect(findById(result, 'notes')?.agentIds).toEqual(['agent-A']);
  });

  it('(AC6) an agent that never bound contributes NOTHING, not even a team-id fallback', () => {
    // The StartMessage declares a WorkspaceTool, so "the card is not read" is
    // actually exercised rather than passing on an empty log.
    const log: AkgenticMessage[] = [
      makeStartMessage('A', [workspaceTool('ws-declared'), workspaceTool(null)]),
      makeStopMessage('B'),
    ];
    expect(workspaceRegistryReduce(log, TEAM_ID)).toEqual([]);
  });

  it('(AC6) a declared card beside a real attach adds no second descriptor', () => {
    const log: AkgenticMessage[] = [
      makeStartMessage('A', [workspaceTool('ws-declared')]),
      resourceAttached('A', 'users/u1/notes'),
    ];
    const result = workspaceRegistryReduce(log, TEAM_ID);
    expect(result.map((d) => d.workspaceId)).toEqual(['notes']);
    expect(findById(result, 'ws-declared')).toBeUndefined();
  });

  it('(AC7) a malformed frame contributes nothing and does not throw', () => {
    const emptyLeaf = resourceAttached('A', 'users/u1/');
    const nonString = resourceAttached('B', 'users/u1/x');
    (nonString as unknown as Record<string, unknown>)['workspace_path'] = null;
    const noKeys = resourceAttached('C', 'users/u1/good');
    (noKeys as unknown as Record<string, unknown>)['metadata_keys'] = 'tenant';

    let result: WorkspaceDescriptor[] = [];
    expect(() => {
      result = workspaceRegistryReduce([emptyLeaf, nonString, noKeys], TEAM_ID);
    }).not.toThrow();
    // Only the well-formed frame produced a workspace; a non-array
    // `metadata_keys` is tolerated because nothing joins on it.
    expect(result.map((d) => d.workspaceId)).toEqual(['good']);
    expect(result[0].agentIds).toEqual(['agent-C']);
  });

  it('(AC7) an attach with a good leaf but no agent_id lists the workspace with no member', () => {
    const frame = resourceAttached('A', 'users/u1/notes');
    delete (frame as unknown as Record<string, unknown>)['agent_id'];
    const result = workspaceRegistryReduce([frame], TEAM_ID);
    expect(result.map((d) => d.workspaceId)).toEqual(['notes']);
    expect(result[0].agentIds).toEqual([]);
  });

  it('(AC1) order — default first, named workspaces alphabetically', () => {
    const result = workspaceRegistryReduce(
      [
        resourceAttached('A', 'users/u1/shared_workspace'),
        resourceAttached('B', 'users/u1/' + TEAM_ID),
        resourceAttached('C', 'users/u1/alpha'),
      ],
      TEAM_ID,
    );
    expect(result.map((d) => d.workspaceId)).toEqual([
      TEAM_ID,
      'alpha',
      'shared_workspace',
    ]);
    expect(result[0].isDefault).toBe(true);
  });

  it('(AC1) agentIds is sorted regardless of arrival order', () => {
    const result = workspaceRegistryReduce(
      [
        resourceAttached('C', 'users/u1/shared'),
        resourceAttached('A', 'users/u1/shared'),
        resourceAttached('B', 'users/u1/shared'),
      ],
      TEAM_ID,
    );
    expect(result[0].agentIds).toEqual(['agent-A', 'agent-B', 'agent-C']);
  });

  it('(AC5) two key sets in one team → two descriptors, no cross-contamination', () => {
    const result = workspaceRegistryReduce(
      [
        resourceAttached('Coarse', '_meta/customer_id-ACME', ['customer_id']),
        resourceAttached('Fine', '_meta/customer_id-ACME__case_id-42', [
          'customer_id',
          'case_id',
        ]),
      ],
      TEAM_ID,
    );
    expect(result.length).toBe(2);
    expect(findById(result, 'customer_id-ACME')?.agentIds).toEqual([
      'agent-Coarse',
    ]);
    expect(findById(result, 'customer_id-ACME__case_id-42')?.agentIds).toEqual([
      'agent-Fine',
    ]);
  });
});

// ---------------------------------------------------------------------
// AC11 — one guard anchored to the SERIALISER's output
// ---------------------------------------------------------------------

describe('workspaceRegistryReduce — the wire shape (AC11)', () => {
  it('folds a frame written to the serialiser output, content key absent', () => {
    // DERIVED fixture, not a capture. It is written to what
    // `event.model_dump_json()` produces for
    // `akgentic.core.messages.orchestrator.ResourceAttached`: the
    // fully-qualified discriminator injected by `serialize_type`, `agent_id`
    // serialised by `str(uuid)` as a canonical lowercase hyphenated string, an
    // ORCHESTRATOR sender whose own `agent_id` is a different uuid in the same
    // form, `metadata_keys` present as a list, and NO `content` key at all —
    // the Python `Message` base declares none, exactly as for `StartMessage`.
    const wire = {
      id: '0c7f6d3a-1b6e-4a41-9c2e-5a7e3f0b1d24',
      parent_id: null,
      team_id: '8f14e45f-ceea-467a-9f0e-4b2d1a3c7e91',
      timestamp: '2026-09-09T10:15:30.123456Z',
      sender: {
        __actor_address__: true,
        __actor_type__: 'akgentic.core.orchestrator.Orchestrator',
        agent_id: 'd94f2a18-3c5b-4e77-8a01-6b9c2d4e8f13',
        name: 'orchestrator',
        role: 'Orchestrator',
        team_id: '8f14e45f-ceea-467a-9f0e-4b2d1a3c7e91',
        squad_id: 'e3b0c442-98fc-4c14-9afb-f4c8996fb924',
        user_message: false,
      },
      recipient: null,
      display_type: 'other',
      __model__: 'akgentic.core.messages.orchestrator.ResourceAttached',
      agent_id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
      workspace_path: '_meta/customer_id-ACME__case_id-42',
      metadata_keys: ['customer_id', 'case_id'],
    };

    // The frame really does carry no `content` — this is the structural claim
    // the interface encodes, and it is checked rather than assumed.
    expect('content' in wire).toBe(false);
    // The two ids are both canonical, both lowercase-hyphenated, and DIFFERENT.
    expect(wire.agent_id).not.toBe(wire.sender.agent_id);

    const result = workspaceRegistryReduce(
      [wire as unknown as AkgenticMessage],
      wire.team_id,
    );
    expect(result.length).toBe(1);
    expect(result[0].workspaceId).toBe('customer_id-ACME__case_id-42');
    expect(result[0].isDefault).toBe(false);
    // Membership is the top-level uuid, byte-identical, un-normalised — the
    // same id space `AgentsByIdService` keys its map by.
    expect(result[0].agentIds).toEqual([
      'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
    ]);
    expect(result[0].agentIds).not.toContain(wire.sender.agent_id);
  });
});

// ---------------------------------------------------------------------
// The service (AC1)
// ---------------------------------------------------------------------

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
    expect(currentValue()).toEqual([]);
  });

  it('(2) live append of an attach event → one named descriptor', () => {
    log.append(resourceAttached('A', 'users/u1/ws-named'));
    const result = currentValue();
    expect(result.length).toBe(1);
    expect(findById(result, 'ws-named')?.agentIds).toEqual(['agent-A']);
    expect(findById(result, TEAM_ID)).toBeUndefined();
  });

  it('(3) distinctUntilChanged suppresses structurally identical re-emissions', () => {
    const emissions: WorkspaceDescriptor[][] = [];
    const sub = service.workspaces$.subscribe((v) => emissions.push(v));

    // Two DIFFERENT frames (unique ids, so neither is dropped by the log's
    // id-dedup) announcing the same agent on the same workspace: the second
    // yields a structurally identical fold, so no third emission.
    log.append(resourceAttached('A', 'users/u1/ws-named'));
    log.append(resourceAttached('A', 'users/u1/ws-named'));

    expect(emissions.length).toBe(2);
    sub.unsubscribe();
  });

  it('(4) log.reset() clears the registry on team switch', () => {
    log.append(resourceAttached('A', 'users/u1/ws-named'));
    expect(currentValue().length).toBe(1);
    log.reset();
    expect(currentValue()).toEqual([]);
  });
});
