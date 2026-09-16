import { TestBed } from '@angular/core/testing';

import {
  AkgenticMessage,
  BaseConfig,
  EventMessage,
  isWorkspaceAttached,
  StartMessage,
  StopMessage,
  ToolCardLite,
  WorkspaceAttached,
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
const EVENT_MODEL = 'akgentic.core.messages.orchestrator.EventMessage';
/**
 * Wire tag of the `WorkspaceAttached` payload. The MODULE segment is a
 * PLACEHOLDER — the tool slice that declares the dataclass is unwritten — and
 * only the class-name segment is anchored. The guard is a substring match on
 * that segment, so the module does not affect it. A derived fixture, not a
 * capture.
 */
const ATTACHED_MODEL = 'akgentic.tool.workspace.event.WorkspaceAttached';
/** The 52-1 top-level tag. Nothing released ever read it; it appears here only
 *  so the trap specs can prove the old read is gone. */
const OLD_TOP_LEVEL_MODEL =
  'akgentic.core.messages.orchestrator.ResourceAttached';

/** Every inner payload `__model__` this package discriminates (AC #3). */
const OTHER_INNER_MODELS = [
  'akgentic.core.messages.orchestrator.ClosedNotification',
  'akgentic.core.messages.orchestrator.TeamStoppingEvent',
  'akgentic.llm.event.ToolCallEvent',
  'akgentic.llm.event.ToolReturnEvent',
  'akgentic.llm.event.ToolStateEvent',
  'akgentic.tool.knowledge_graph.event.KnowledgeGraphStateEvent',
  'akgentic.llm.event.LlmMessageEvent',
  'akgentic.llm.event.LlmUsageEvent',
  'akgentic.llm.event.LlmSystemPromptEvent',
  'akgentic.llm.event.LlmContextCompactedEvent',
  'akgentic.llm.event.LlmContextClearedEvent',
  'akgentic.tool.command.event.CommandsAnnouncedEvent',
] as const;

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

/** The ORCHESTRATOR's address — the sender of every attach envelope, and never
 *  the binding agent. */
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

let frameSeq = 0;

/**
 * An `EventMessage` envelope sent by the ORCHESTRATOR around an arbitrary
 * payload. The AC #5 trap frames are built through THIS, never through
 * `workspaceAttached`, so a trap cannot accidentally carry the real payload.
 */
function orchestratorEnvelope(payload: unknown): EventMessage {
  frameSeq += 1;
  return {
    id: 'env-' + frameSeq,
    parent_id: null,
    team_id: TEAM_ID,
    timestamp: new Date().toISOString(),
    sender: orchestratorSender(),
    display_type: 'other',
    content: null,
    __model__: EVENT_MODEL,
    event: payload,
  };
}

/**
 * The orchestrator's `EventMessage` carrying a `WorkspaceAttached` payload
 * (ADR-022 §Decision 8, final form).
 *
 * The envelope's sender is ALWAYS the orchestrator; the binding agent is the
 * PAYLOAD's `agent_id`. The two are deliberately different ids in every fixture
 * so no spec can pass by keying on the wrong one.
 */
function workspaceAttached(
  agentName: string,
  workspacePath: string,
): EventMessage {
  return orchestratorEnvelope({
    __model__: ATTACHED_MODEL,
    agent_id: 'agent-' + agentName,
    workspace_path: workspacePath,
  });
}

/** The payload of an attach envelope, typed for the two extractors. */
function payloadOf(frame: EventMessage): WorkspaceAttached {
  return frame.event as WorkspaceAttached;
}

/** A TOP-LEVEL frame (no envelope) carrying `agent_id` / `workspace_path` on
 *  the message itself — the 52-1 shape, and the payload unwrapped. Neither is
 *  a workspace binding any more. */
function topLevelFrame(
  model: string,
  agentName: string,
  workspacePath: string,
): AkgenticMessage {
  frameSeq += 1;
  return {
    id: 'top-' + frameSeq,
    parent_id: null,
    team_id: TEAM_ID,
    timestamp: new Date().toISOString(),
    sender: orchestratorSender(),
    display_type: 'other',
    content: null,
    __model__: model,
    agent_id: 'agent-' + agentName,
    workspace_path: workspacePath,
  } as unknown as AkgenticMessage;
}

/**
 * The four frames of AC #5, all naming agent A on `users/u1/notes`: each one
 * carries a plausible `workspace_path`, and none is a workspace binding.
 */
function trapFrames(): AkgenticMessage[] {
  return [
    // A ClosedNotification that happens to carry a path.
    orchestratorEnvelope({
      __model__: 'akgentic.core.messages.orchestrator.ClosedNotification',
      message_id: 'n-1',
      agent_id: 'agent-A',
      workspace_path: 'users/u1/notes',
    }),
    // A sibling kind's attach event.
    orchestratorEnvelope({
      __model__: 'akgentic.tool.memory.event.MemoryAttached',
      agent_id: 'agent-A',
      workspace_path: 'users/u1/notes',
    }),
    // The 52-1 top-level frame.
    topLevelFrame(OLD_TOP_LEVEL_MODEL, 'A', 'users/u1/notes'),
    // The payload UNWRAPPED — the name on the outer frame, no envelope.
    topLevelFrame(ATTACHED_MODEL, 'A', 'users/u1/notes'),
  ];
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
// The guard (AC2, AC3)
// ---------------------------------------------------------------------

describe('isWorkspaceAttached (inner-event guard)', () => {
  it('(AC2) matches a payload whose __model__ contains the class name', () => {
    expect(isWorkspaceAttached(payloadOf(workspaceAttached('A', 'users/u1/notes'))))
      .toBe(true);
    // The module segment is never read: a different module, same verdict.
    expect(
      isWorkspaceAttached({ __model__: 'some.other.module.WorkspaceAttached' }),
    ).toBe(true);
  });

  it('(AC3) rejects every other inner payload model — checked in BOTH directions', () => {
    for (const model of OTHER_INNER_MODELS) {
      expect(isWorkspaceAttached({ __model__: model }))
        .withContext(model)
        .toBe(false);
      // And the reverse: the class name contains none of theirs, so no sibling
      // guard can claim an attach payload either.
      const className = model.slice(model.lastIndexOf('.') + 1);
      expect('WorkspaceAttached'.includes(className))
        .withContext(className)
        .toBe(false);
    }
  });

  it('(AC3) applied to the ENVELOPE it never matches — silently dead, never over-admitting', () => {
    expect(isWorkspaceAttached({ __model__: EVENT_MODEL })).toBe(false);
    // The real envelope, passed whole instead of its payload.
    expect(isWorkspaceAttached(workspaceAttached('A', 'users/u1/notes'))).toBe(
      false,
    );
  });

  it('(AC5) rejects the old top-level tag and a shape-alike with a path', () => {
    expect(isWorkspaceAttached({ __model__: OLD_TOP_LEVEL_MODEL })).toBe(false);
    expect(
      isWorkspaceAttached({
        __model__: 'akgentic.tool.memory.event.MemoryAttached',
        workspace_path: 'users/u1/notes',
      } as { __model__: string }),
    ).toBe(false);
  });

  it('(AC7) tolerates null, undefined, a string and a payload with no __model__', () => {
    expect(isWorkspaceAttached(null)).toBe(false);
    expect(isWorkspaceAttached(undefined)).toBe(false);
    expect(isWorkspaceAttached({})).toBe(false);
    expect(
      isWorkspaceAttached(
        ATTACHED_MODEL as unknown as { __model__?: string },
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------
// Leaf and binding-agent extraction (AC4, AC6, AC7)
// ---------------------------------------------------------------------

describe('attachedLeaf (the id is READ, never parsed)', () => {
  it('(AC4) reads the LAST path segment of the resolved path', () => {
    expect(attachedLeaf(payloadOf(workspaceAttached('A', '_meta/tenant-azerty'))))
      .toBe('tenant-azerty');
  });

  it('(AC4) the encoded metadata leaf is carried verbatim', () => {
    // Nothing splits it on `__` or `-`, and nothing percent-decodes it.
    expect(
      attachedLeaf(
        payloadOf(workspaceAttached('A', '_meta/customer_id-ACME__case_id-42')),
      ),
    ).toBe('customer_id-ACME__case_id-42');
    expect(
      attachedLeaf(payloadOf(workspaceAttached('A', '_meta/case_id-2026%2D42'))),
    ).toBe('case_id-2026%2D42');
  });

  it('(AC7) an empty last segment is not an id', () => {
    expect(attachedLeaf(payloadOf(workspaceAttached('A', 'users/u1/')))).toBe(null);
    expect(attachedLeaf(payloadOf(workspaceAttached('A', '')))).toBe(null);
  });

  it('(AC7) a non-string workspace_path degrades to null instead of throwing', () => {
    const frame = workspaceAttached('A', 'users/u1/notes');
    (frame.event as Record<string, unknown>)['workspace_path'] = 42;
    expect(() => attachedLeaf(payloadOf(frame))).not.toThrow();
    expect(attachedLeaf(payloadOf(frame))).toBe(null);
  });

  it('(AC7) an absent workspace_path degrades to null instead of throwing', () => {
    const frame = workspaceAttached('A', 'users/u1/notes');
    delete (frame.event as Record<string, unknown>)['workspace_path'];
    expect(() => attachedLeaf(payloadOf(frame))).not.toThrow();
    expect(attachedLeaf(payloadOf(frame))).toBe(null);
  });
});

describe('attachedAgentId (the BINDING agent, never the envelope sender)', () => {
  it('(AC6) reads the payload agent_id, which is NOT the envelope sender', () => {
    const frame = workspaceAttached('A', 'users/u1/notes');
    expect(attachedAgentId(payloadOf(frame))).toBe('agent-A');
    // The sender of the envelope is the orchestrator, and the two differ.
    expect(frame.sender.agent_id).toBe('agent-orchestrator');
    expect(attachedAgentId(payloadOf(frame))).not.toBe(frame.sender.agent_id);
  });

  it('(AC7) a missing or non-string agent_id degrades to null', () => {
    const missing = workspaceAttached('A', 'users/u1/notes');
    delete (missing.event as Record<string, unknown>)['agent_id'];
    expect(attachedAgentId(payloadOf(missing))).toBe(null);

    const wrongType = workspaceAttached('A', 'users/u1/notes');
    (wrongType.event as Record<string, unknown>)['agent_id'] = 7;
    expect(attachedAgentId(payloadOf(wrongType))).toBe(null);

    const empty = workspaceAttached('A', 'users/u1/notes');
    payloadOf(empty).agent_id = '';
    expect(attachedAgentId(payloadOf(empty))).toBe(null);
  });
});

// ---------------------------------------------------------------------
// The fold (AC1, AC4-AC7)
// ---------------------------------------------------------------------

describe('workspaceRegistryReduce (pure function)', () => {
  it('(AC1) empty log → no descriptors (no always-present default)', () => {
    expect(workspaceRegistryReduce([], TEAM_ID)).toEqual([]);
  });

  it('(AC4) the three ADR-048 layouts — default: <user_segment>/<team_id>', () => {
    const result = workspaceRegistryReduce(
      [workspaceAttached('A', 'users/u1/' + TEAM_ID)],
      TEAM_ID,
    );
    expect(result.length).toBe(1);
    expect(result[0].workspaceId).toBe(TEAM_ID);
    expect(result[0].isDefault).toBe(true);
    expect(result[0].label).toBe('Default workspace');
  });

  it('(AC4) the three ADR-048 layouts — named: <user_segment>/notes', () => {
    const result = workspaceRegistryReduce(
      [workspaceAttached('A', 'users/u1/notes')],
      TEAM_ID,
    );
    expect(result.length).toBe(1);
    expect(result[0].workspaceId).toBe('notes');
    expect(result[0].isDefault).toBe(false);
    expect(result[0].label).toBe('notes');
  });

  it('(AC4) the three ADR-048 layouts — metadata: the encoded leaf', () => {
    const result = workspaceRegistryReduce(
      [workspaceAttached('A', '_meta/customer_id-ACME__case_id-42')],
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

  it('(AC6) the member is the BINDING agent and NOT the envelope sender', () => {
    // The trap of this epic, asserted in BOTH directions against ONE envelope
    // with two different ids. Keying on `sender.agent_id` renders a plausible
    // chip rather than throwing, so "a chip exists" would not catch it.
    const frame = workspaceAttached('A', 'users/u1/notes');
    expect(payloadOf(frame).agent_id).not.toBe(frame.sender.agent_id);

    const result = workspaceRegistryReduce([frame], TEAM_ID);
    expect(result.length).toBe(1);
    expect(result[0].agentIds).toEqual(['agent-A']);
    expect(result[0].agentIds).not.toContain('agent-orchestrator');
    expect(result[0].agentIds).not.toContain(frame.sender.agent_id);
  });

  it('(AC6) two agents on one workspace → two envelopes, one descriptor, two members', () => {
    // Core emits one event per successful forward INCLUDING a cache hit, which
    // is what makes membership a field read rather than a reconstruction.
    const result = workspaceRegistryReduce(
      [
        workspaceAttached('B', 'users/u1/shared'),
        workspaceAttached('A', 'users/u1/shared'),
      ],
      TEAM_ID,
    );
    expect(result.length).toBe(1);
    expect(result[0].workspaceId).toBe('shared');
    expect(result[0].agentIds).toEqual(['agent-A', 'agent-B']);
  });

  it('(AC6) Stop removes the member from EVERY workspace and removes NO workspace', () => {
    // The non-empty state is asserted FIRST, so the empty one below is not
    // vacuous: without the first fold, "agentIds is []" would pass on a fold
    // that never added a member at all.
    const attachOne = workspaceAttached('A', 'users/u1/notes');
    const attachTwo = workspaceAttached('A', '_meta/tenant-azerty');
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

  it('(AC6) Stop is keyed by sender.agent_id — another agent keeps its membership', () => {
    const result = workspaceRegistryReduce(
      [
        workspaceAttached('A', 'users/u1/shared'),
        workspaceAttached('B', 'users/u1/shared'),
        makeStopMessage('A'),
      ],
      TEAM_ID,
    );
    expect(findById(result, 'shared')?.agentIds).toEqual(['agent-B']);
  });

  it('(AC6) a workspace stays listed after EVERY contributing agent stopped', () => {
    const attach = workspaceAttached('A', 'users/u1/notes');
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

  it('(AC6) ordered last-wins — attach → stop → attach ends with the member present', () => {
    const result = workspaceRegistryReduce(
      [
        workspaceAttached('A', 'users/u1/notes'),
        makeStopMessage('A'),
        workspaceAttached('A', 'users/u1/notes'),
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
      workspaceAttached('A', 'users/u1/notes'),
    ];
    const result = workspaceRegistryReduce(log, TEAM_ID);
    expect(result.map((d) => d.workspaceId)).toEqual(['notes']);
    expect(findById(result, 'ws-declared')).toBeUndefined();
  });

  it('(AC5) another payload carrying a workspace_path contributes NOTHING — the guard reads the NAME', () => {
    // A ClosedNotification with a path, a MemoryAttached, the 52-1 top-level
    // frame, and the payload unwrapped: four frames, each with a plausible
    // `workspace_path`, none a workspace binding. A guard matching on SHAPE
    // (`typeof event.workspace_path === 'string'`) lists the first two; one
    // broadened to `includes('Attached')` lists the second; the old top-level
    // read lists the third; a guard on the ENVELOPE's `__model__` lists the
    // fourth.
    expect(workspaceRegistryReduce(trapFrames(), TEAM_ID)).toEqual([]);

    // Not vacuous: the same four frames beside ONE real attach for the SAME
    // agent yield exactly one workspace with exactly one member — the real
    // one, on a different leaf, so an admitted trap is visible as a second
    // descriptor rather than merged into the first.
    const result = workspaceRegistryReduce(
      [...trapFrames(), workspaceAttached('A', 'users/u1/real')],
      TEAM_ID,
    );
    expect(result.map((d) => d.workspaceId)).toEqual(['real']);
    expect(result[0].agentIds).toEqual(['agent-A']);
    expect(findById(result, 'notes')).toBeUndefined();
  });

  it('(AC7) a malformed payload contributes nothing and does not throw', () => {
    const emptyLeaf = workspaceAttached('A', 'users/u1/');
    const emptyPath = workspaceAttached('E', '');
    const nonString = workspaceAttached('B', 'users/u1/x');
    (nonString.event as Record<string, unknown>)['workspace_path'] = null;
    const absent = workspaceAttached('D', 'users/u1/y');
    delete (absent.event as Record<string, unknown>)['workspace_path'];
    const good = workspaceAttached('C', 'users/u1/good');

    let result: WorkspaceDescriptor[] = [];
    expect(() => {
      result = workspaceRegistryReduce(
        [emptyLeaf, emptyPath, nonString, absent, good],
        TEAM_ID,
      );
    }).not.toThrow();
    // Only the well-formed payload produced a workspace.
    expect(result.map((d) => d.workspaceId)).toEqual(['good']);
    expect(result[0].agentIds).toEqual(['agent-C']);
  });

  it('(AC7) an envelope whose event is null, undefined or a string contributes nothing and does not throw', () => {
    // The invalidation unit already tolerates these inside a live
    // subscription; the registry branch must too, or one bad frame on the
    // stream blanks the picker for the rest of the session.
    const nullEvent = orchestratorEnvelope(null);
    const undefinedEvent = orchestratorEnvelope(undefined);
    const stringEvent = orchestratorEnvelope(ATTACHED_MODEL);
    const good = workspaceAttached('C', 'users/u1/good');

    let result: WorkspaceDescriptor[] = [];
    expect(() => {
      result = workspaceRegistryReduce(
        [nullEvent, undefinedEvent, stringEvent, good],
        TEAM_ID,
      );
    }).not.toThrow();
    expect(result.map((d) => d.workspaceId)).toEqual(['good']);
    expect(result[0].agentIds).toEqual(['agent-C']);
  });

  it('(AC7) an attach with a good leaf but no agent_id lists the workspace with no member', () => {
    const frame = workspaceAttached('A', 'users/u1/notes');
    delete (frame.event as Record<string, unknown>)['agent_id'];
    const result = workspaceRegistryReduce([frame], TEAM_ID);
    expect(result.map((d) => d.workspaceId)).toEqual(['notes']);
    expect(result[0].agentIds).toEqual([]);
  });

  it('(AC1) order — default first, named workspaces alphabetically', () => {
    const result = workspaceRegistryReduce(
      [
        workspaceAttached('A', 'users/u1/shared_workspace'),
        workspaceAttached('B', 'users/u1/' + TEAM_ID),
        workspaceAttached('C', 'users/u1/alpha'),
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
        workspaceAttached('C', 'users/u1/shared'),
        workspaceAttached('A', 'users/u1/shared'),
        workspaceAttached('B', 'users/u1/shared'),
      ],
      TEAM_ID,
    );
    expect(result[0].agentIds).toEqual(['agent-A', 'agent-B', 'agent-C']);
  });

  it('(AC6) two key sets in one team → two descriptors, no cross-contamination', () => {
    const result = workspaceRegistryReduce(
      [
        workspaceAttached('Coarse', '_meta/customer_id-ACME'),
        workspaceAttached('Fine', '_meta/customer_id-ACME__case_id-42'),
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
// AC10 — one guard anchored to the SERIALISER's output
// ---------------------------------------------------------------------

describe('workspaceRegistryReduce — the wire shape (AC10)', () => {
  it('folds an envelope written to the serialiser output: tagged payload, no content, no key list', () => {
    // DERIVED fixture, not a capture — the producer does not exist in source
    // yet. It is written to what `event.model_dump_json()` produces for an
    // `EventMessage` whose `event` is the tool package's `WorkspaceAttached`
    // frozen dataclass (ADR-022 §Decision 8, final form): the envelope's
    // fully-qualified tag; an ORCHESTRATOR sender whose `agent_id` is a
    // canonical lowercase hyphenated uuid; `recipient: null`; NO `content` key
    // at all (the Python `Message` base declares none); and the payload
    // serialised field by field with the serialiser's `module.ClassName` tag,
    // `agent_id` as `str(uuid)` — a DIFFERENT canonical uuid — and the resolved
    // `workspace_path`. No `metadata_keys`: the amendment dropped it.
    //
    // The MODULE segment of the payload tag is a PLACEHOLDER. Only the
    // class-name segment is anchored; the guard is a substring match on that
    // segment, so the module does not affect the verdict.
    const wire = {
      id: '0c7f6d3a-1b6e-4a41-9c2e-5a7e3f0b1d24',
      parent_id: null,
      team_id: '8f14e45f-ceea-467a-9f0e-4b2d1a3c7e91',
      timestamp: '2026-09-10T10:15:30.123456Z',
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
      __model__: 'akgentic.core.messages.orchestrator.EventMessage',
      event: {
        __model__: 'akgentic.tool.workspace.event.WorkspaceAttached',
        agent_id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
        workspace_path: '_meta/customer_id-ACME__case_id-42',
      },
    };

    // The envelope really does carry no `content`, and the payload no
    // `metadata_keys` — both structural claims are checked, not assumed.
    expect('content' in wire).toBe(false);
    expect('metadata_keys' in wire.event).toBe(false);
    // The two ids are both canonical, both lowercase-hyphenated, and DIFFERENT.
    expect(wire.event.agent_id).not.toBe(wire.sender.agent_id);

    const result = workspaceRegistryReduce(
      [wire as unknown as AkgenticMessage],
      wire.team_id,
    );
    expect(result.length).toBe(1);
    expect(result[0].workspaceId).toBe('customer_id-ACME__case_id-42');
    expect(result[0].isDefault).toBe(false);
    // Membership is the PAYLOAD's uuid, byte-identical, un-normalised — the
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

  it('(2) live append of an attach envelope → one named descriptor', () => {
    log.append(workspaceAttached('A', 'users/u1/ws-named'));
    const result = currentValue();
    expect(result.length).toBe(1);
    expect(findById(result, 'ws-named')?.agentIds).toEqual(['agent-A']);
    expect(findById(result, TEAM_ID)).toBeUndefined();
  });

  it('(3) distinctUntilChanged suppresses structurally identical re-emissions', () => {
    const emissions: WorkspaceDescriptor[][] = [];
    const sub = service.workspaces$.subscribe((v) => emissions.push(v));

    // Two DIFFERENT envelopes (unique ids, so neither is dropped by the log's
    // id-dedup) announcing the same agent on the same workspace: the second
    // yields a structurally identical fold, so no third emission.
    log.append(workspaceAttached('A', 'users/u1/ws-named'));
    log.append(workspaceAttached('A', 'users/u1/ws-named'));

    expect(emissions.length).toBe(2);
    sub.unsubscribe();
  });

  it('(4) log.reset() clears the registry on team switch', () => {
    log.append(workspaceAttached('A', 'users/u1/ws-named'));
    expect(currentValue().length).toBe(1);
    log.reset();
    expect(currentValue()).toEqual([]);
  });
});
