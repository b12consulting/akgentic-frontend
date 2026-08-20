import { TestBed } from '@angular/core/testing';

import {
  AkgenticMessage,
  BaseConfig,
  EventMessage,
  StartMessage,
  StopMessage,
  ToolCardLite,
} from '../../../protocol/message.types';
import { MessageLogService } from '../event/message-log.service';
import {
  isMutatingWorkspaceTool,
  MUTATING_WORKSPACE_TOOLS,
  WorkspaceInvalidation,
  WorkspaceInvalidationService,
} from './workspace-invalidation.selector';

// ---------------------------------------------------------------------
// Fixture helpers — the idiom from workspace-registry.selector.spec.ts,
// plus the two tool-event envelope factories this story needs.
//
// The inner `__model__` values are declared inline: these payloads are
// read-only on this side and export no wire-tag constant.
// ---------------------------------------------------------------------

const TEAM_ID = 'team-1';
const WORKSPACE_MODEL = 'akgentic.tool.workspace.tool.WorkspaceTool';
const EVENT_MODEL = 'akgentic.core.messages.orchestrator.EventMessage';
const TOOL_CALL_MODEL = 'akgentic.llm.event.ToolCallEvent';
const TOOL_RETURN_MODEL = 'akgentic.llm.event.ToolReturnEvent';

/** The five workspace tools that must invalidate NOTHING — even though
 *  `workspace_read` and `workspace_view` write `.`-prefixed sidecar caches. */
const READ_WORKSPACE_TOOLS = [
  'workspace_read',
  'workspace_view',
  'workspace_list',
  'workspace_glob',
  'workspace_grep',
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

function workspaceTool(workspaceId?: string | null): ToolCardLite {
  return { __model__: WORKSPACE_MODEL, workspace_id: workspaceId };
}

// NOTE: no `team_id` in config — the backend AgentConfig does not serialise it.
// The effective id resolves against the MESSAGE-level team_id.
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

/** Unique envelope ids: `MessageLogService.append` dedups by `id`, so a fixture
 *  reusing one would be silently dropped in the service block. */
let envelopeSeq = 0;

function makeEventMessage(agentName: string, event: unknown): EventMessage {
  envelopeSeq += 1;
  return {
    id: 'evt-' + envelopeSeq,
    parent_id: null,
    team_id: TEAM_ID,
    timestamp: new Date().toISOString(),
    sender: baseSender(agentName),
    display_type: 'other',
    content: null,
    __model__: EVENT_MODEL,
    event,
  };
}

function makeToolCall(
  agentName: string,
  toolName: string,
  argsJson: string,
  callId: string,
): EventMessage {
  return makeEventMessage(agentName, {
    __model__: TOOL_CALL_MODEL,
    run_id: 'run-1',
    tool_name: toolName,
    tool_call_id: callId,
    arguments: argsJson,
  });
}

function makeToolReturn(
  agentName: string,
  toolName: string,
  callId: string,
  success: boolean,
): EventMessage {
  return makeEventMessage(agentName, {
    __model__: TOOL_RETURN_MODEL,
    run_id: 'run-1',
    tool_name: toolName,
    tool_call_id: callId,
    success,
  });
}

/**
 * Feed a message array through a FRESH `MessageLogService` +
 * `WorkspaceInvalidationService` pair and return the instructions the stream
 * emitted, in order.
 *
 * `result` therefore holds exactly what the whole-log fold used to return: the
 * subscription is opened against an EMPTY log, so nothing is skipped, and
 * `appendAll` delivers the array in one ordered batch.
 *
 * Fresh instances per INVOCATION, not per `it`: several specs below drive two
 * message arrays inside one test, and the fixture ids are not unique
 * (`makeStartMessage('A')` is always `start-A`), so reusing one log would have
 * `appendAll`'s id-dedup silently drop the second `StartMessage` and break
 * attribution.
 */
function collectFromLog(messages: AkgenticMessage[]): WorkspaceInvalidation[] {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [MessageLogService, WorkspaceInvalidationService],
  });
  const log = TestBed.inject(MessageLogService);
  const service = TestBed.inject(WorkspaceInvalidationService);

  const seen: WorkspaceInvalidation[] = [];
  const sub = service.invalidations$.subscribe((i) => seen.push(i));
  log.appendAll(messages);
  sub.unsubscribe();
  return seen;
}

/** An agent bound to exactly one named workspace, plus a completed mutation. */
function mutationLog(
  toolName: string,
  argsJson: string,
  tools: ToolCardLite[] = [workspaceTool('ws-1')],
): AkgenticMessage[] {
  return [
    makeStartMessage('A', tools),
    makeToolCall('A', toolName, argsJson, 'call-1'),
    makeToolReturn('A', toolName, 'call-1', true),
  ];
}

// ---------------------------------------------------------------------
// The mutating set (FR4)
// ---------------------------------------------------------------------

describe('MUTATING_WORKSPACE_TOOLS', () => {
  it('(AC1) names exactly the six mutating tools', () => {
    expect([...MUTATING_WORKSPACE_TOOLS]).toEqual([
      'workspace_write',
      'workspace_delete',
      'workspace_edit',
      'workspace_mkdir',
      'workspace_multi_edit',
      'workspace_patch',
    ]);
    expect(MUTATING_WORKSPACE_TOOLS.length).toBe(6);
    for (const name of MUTATING_WORKSPACE_TOOLS) {
      expect(isMutatingWorkspaceTool(name)).toBe(true);
    }
  });

  it('(AC1) excludes the five read tools by name', () => {
    for (const name of READ_WORKSPACE_TOOLS) {
      expect(isMutatingWorkspaceTool(name)).toBe(false);
    }
  });

  it('(AC1) is not a workspace_* prefix match', () => {
    expect(isMutatingWorkspaceTool('workspace_something_new')).toBe(false);
    expect(isMutatingWorkspaceTool('workspace_')).toBe(false);
  });
});

describe('WorkspaceInvalidationService — the mutating set (FR4)', () => {
  // Asserted individually rather than in one loop-with-a-single-expect, so a
  // per-tool failure names the tool that broke it.
  //
  // Verified by mutation: replacing the six-name constant with a
  // `workspace_*` prefix match turns the two `MUTATING_WORKSPACE_TOOLS` specs
  // above red and leaves THESE five green. That is not a gap in them — it is
  // `parseToolCallArguments` acting as a second gate, since it too returns
  // `null` for a tool name outside the six. The read tools therefore cannot
  // produce an instruction under either implementation, and the specs above are
  // where the "explicit list, never a prefix" rule actually bites. These five
  // pin the end-to-end behaviour, which is what a future refactor of either
  // gate must preserve.
  for (const readTool of READ_WORKSPACE_TOOLS) {
    it(`(AC2) ${readTool} + success return → no instruction`, () => {
      const result = collectFromLog(
        mutationLog(readTool, JSON.stringify({ path: 'a/b/c.md' })),
      );
      expect(result).toEqual([]);
    });
  }

  it('(AC3) a tool the constant has never heard of → no instruction', () => {
    expect(
      collectFromLog(
        mutationLog('sandbox_exec_command', JSON.stringify({ path: 'a/b.md' })),
      ),
    ).toEqual([]);
    expect(
      collectFromLog(
        mutationLog('tavily_search', JSON.stringify({ query: 'x' })),
      ),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------
// Call → return correlation (FR7)
// ---------------------------------------------------------------------

describe('WorkspaceInvalidationService — correlation (FR7)', () => {
  const editArgs = JSON.stringify({ path: 'a/b/c.md', old_string: 'x' });

  it('(AC4) a workspace_edit call + matching success return → one instruction', () => {
    const result = collectFromLog(
      mutationLog('workspace_edit', editArgs),
    );
    expect(result.length).toBe(1);
    expect(result[0].workspaceId).toBe('ws-1');
    expect(result[0].wholeTree).toBe(false);
    expect(result[0].directories).toEqual(['a/b']);
    expect(result[0].files).toEqual(['a/b/c.md']);
  });

  it('(AC5) a success:false return produces no instruction', () => {
    const result = collectFromLog([
      makeStartMessage('A', [workspaceTool('ws-1')]),
      makeToolCall('A', 'workspace_edit', editArgs, 'call-1'),
      makeToolReturn('A', 'workspace_edit', 'call-1', false),
    ]);
    expect(result).toEqual([]);
  });

  it('(AC6) a return matching no recorded call is a no-op and does not throw', () => {
    let result: WorkspaceInvalidation[] = [];
    expect(() => {
      result = collectFromLog([
        makeStartMessage('A', [workspaceTool('ws-1')]),
        makeToolReturn('A', 'workspace_edit', 'never-called', true),
      ]);
    }).not.toThrow();
    expect(result).toEqual([]);
  });

  it('(AC7) the same tool_call_id returning twice fires exactly once', () => {
    const result = collectFromLog([
      makeStartMessage('A', [workspaceTool('ws-1')]),
      makeToolCall('A', 'workspace_edit', editArgs, 'call-1'),
      makeToolReturn('A', 'workspace_edit', 'call-1', true),
      makeToolReturn('A', 'workspace_edit', 'call-1', true),
    ]);
    expect(result.length).toBe(1);
  });

  it('(AC8) a false return consumes the entry: a later true return fires nothing', () => {
    const result = collectFromLog([
      makeStartMessage('A', [workspaceTool('ws-1')]),
      makeToolCall('A', 'workspace_edit', editArgs, 'call-1'),
      makeToolReturn('A', 'workspace_edit', 'call-1', false),
      makeToolReturn('A', 'workspace_edit', 'call-1', true),
    ]);
    expect(result).toEqual([]);
  });

  it('(AC9) a call with no return never fires on its own', () => {
    const result = collectFromLog([
      makeStartMessage('A', [workspaceTool('ws-1')]),
      makeToolCall('A', 'workspace_edit', editArgs, 'call-1'),
    ]);
    expect(result).toEqual([]);
  });

  it('(AC10) malformed-JSON arguments are not recorded, so the return fires nothing', () => {
    const result = collectFromLog(
      mutationLog('workspace_write', '{not json'),
    );
    expect(result).toEqual([]);
  });

  it('(AC10) a body missing `path` is not recorded', () => {
    const result = collectFromLog(
      mutationLog('workspace_write', JSON.stringify({ content: 'hello' })),
    );
    expect(result).toEqual([]);
  });

  it('(AC10) a multi-edit whose edits[i] lacks a path is not recorded', () => {
    const result = collectFromLog(
      mutationLog(
        'workspace_multi_edit',
        JSON.stringify({ edits: [{ path: 'a/b.md' }, { old_string: 'x' }] }),
      ),
    );
    expect(result).toEqual([]);
  });

  it('(AC11) nothing thrown by any frame escapes the fold', () => {
    const noEventAtAll = {
      id: 'weird-1',
      parent_id: null,
      team_id: TEAM_ID,
      timestamp: new Date().toISOString(),
      sender: baseSender('A'),
      display_type: 'other',
      content: null,
      __model__: EVENT_MODEL,
    } as unknown as AkgenticMessage;

    // No `__model__` at all: every guard below reads it, so the fold must skip
    // the frame before any of them runs. Drop the `!m.__model__` line in the
    // fold and this frame makes `isStartMessage` throw.
    const noModelAtAll = {
      id: 'weird-2',
      parent_id: null,
      team_id: TEAM_ID,
      timestamp: new Date().toISOString(),
      sender: baseSender('A'),
      display_type: 'other',
      content: null,
    } as unknown as AkgenticMessage;

    // No `sender`: typed as required, but it arrives off the wire. Reading
    // `m.sender.agent_id` unguarded throws here and freezes the projection for
    // the rest of the session.
    const noSender = {
      id: 'weird-3',
      parent_id: null,
      team_id: TEAM_ID,
      timestamp: new Date().toISOString(),
      display_type: 'other',
      content: null,
      __model__: 'akgentic.core.messages.orchestrator.StopMessage',
    } as unknown as AkgenticMessage;

    const log: AkgenticMessage[] = [
      makeStartMessage('A', [workspaceTool('ws-1')]),
      makeToolCall('A', 'workspace_write', '{', 'bad-json'),
      makeToolReturn('A', 'workspace_write', 'bad-json', true),
      makeEventMessage('A', null),
      noEventAtAll,
      noModelAtAll,
      noSender,
      makeEventMessage('A', { __model__: 'akgentic.llm.event.LlmMessageEvent' }),
      // A call+return pair still resolves after all of the above.
      makeToolCall('A', 'workspace_write', JSON.stringify({ path: 'ok.md' }), 'c9'),
      makeToolReturn('A', 'workspace_write', 'c9', true),
    ];

    let result: WorkspaceInvalidation[] = [];
    expect(() => {
      result = collectFromLog(log);
    }).not.toThrow();
    expect(result.length).toBe(1);
    expect(result[0].files).toEqual(['ok.md']);
  });

  it('(AC11) an EventMessage carrying a tool event fires only on the INNER model', () => {
    // The envelope tag contains neither 'ToolCallEvent' nor 'ToolReturnEvent':
    // a guard applied to the envelope would fire for every EventMessage on the
    // log and invalidate the workspace on every LLM message.
    const result = collectFromLog([
      makeStartMessage('A', [workspaceTool('ws-1')]),
      makeEventMessage('A', { __model__: 'akgentic.llm.event.ToolStateEvent' }),
      makeEventMessage('A', { __model__: EVENT_MODEL }),
    ]);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------
// Granularity (FR5)
// ---------------------------------------------------------------------

describe('WorkspaceInvalidationService — granularity (FR5)', () => {
  function onlyInstruction(
    toolName: string,
    args: unknown,
  ): WorkspaceInvalidation {
    const result = collectFromLog(
      mutationLog(toolName, JSON.stringify(args)),
    );
    expect(result.length).toBe(1);
    return result[0];
  }

  it('(AC12) write/edit/delete/mkdir invalidate the parent directory of path', () => {
    for (const tool of [
      'workspace_write',
      'workspace_edit',
      'workspace_delete',
      'workspace_mkdir',
    ]) {
      expect(onlyInstruction(tool, { path: 'a/b/c.md' }).directories).toEqual([
        'a/b',
      ]);
    }
  });

  it('(AC12) a root-level path yields the empty-string root listing', () => {
    expect(onlyInstruction('workspace_write', { path: 'c.md' }).directories)
      .toEqual(['']);
  });

  it('(AC12) one trailing slash is stripped before the parent is taken', () => {
    expect(onlyInstruction('workspace_mkdir', { path: 'a/b/' }).directories)
      .toEqual(['a']);
  });

  it('(AC13) multi_edit with three paths across two directories → one instruction, two directories', () => {
    const instruction = onlyInstruction('workspace_multi_edit', {
      edits: [
        { path: 'a/b/one.md' },
        { path: 'a/b/two.md' },
        { path: 'a/c/three.md' },
      ],
    });
    expect(instruction.directories).toEqual(['a/b', 'a/c']);
    expect(instruction.files).toEqual([
      'a/b/one.md',
      'a/b/two.md',
      'a/c/three.md',
    ]);
  });

  it('(AC15) multi_edit deduplicates repeated file paths', () => {
    const instruction = onlyInstruction('workspace_multi_edit', {
      edits: [{ path: 'a/b.md' }, { path: 'a/b.md' }],
    });
    expect(instruction.directories).toEqual(['a']);
    expect(instruction.files).toEqual(['a/b.md']);
  });

  it('(AC14) patch is whole-tree, names nothing, and its diff text is never scraped', () => {
    const patchText = [
      '--- a/some/file.md',
      '+++ b/some/file.md',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n');
    const instruction = onlyInstruction('workspace_patch', {
      patch_text: patchText,
    });

    expect(instruction.wholeTree).toBe(true);
    expect(instruction.directories).toEqual([]);
    expect(instruction.files).toEqual([]);
    expect(instruction.deletions).toEqual([]);

    // Nothing scraped out of the diff body reaches the instruction.
    const serialised = JSON.stringify(instruction);
    expect(serialised).not.toContain('some');
    expect(serialised).not.toContain('some/file.md');
  });

  it('(AC15) mkdir names no files', () => {
    const instruction = onlyInstruction('workspace_mkdir', { path: 'a/b' });
    expect(instruction.files).toEqual([]);
    expect(instruction.deletions).toEqual([]);
    expect(instruction.wholeTree).toBe(false);
  });

  it('(AC15) write and edit name their path as a file', () => {
    for (const tool of ['workspace_write', 'workspace_edit']) {
      const instruction = onlyInstruction(tool, { path: 'a/b/c.md' });
      expect(instruction.files).toEqual(['a/b/c.md']);
      expect(instruction.deletions).toEqual([]);
    }
  });

  it('(OQ2) delete reports its path in `deletions`, never in `files`', () => {
    // A deleted path is not a re-read instruction — re-reading it 404s — but
    // dropping it entirely would leave the pane rendering a file that no longer
    // exists. Its own field cannot be mistaken for either.
    const instruction = onlyInstruction('workspace_delete', {
      path: 'a/b/c.md',
    });
    expect(instruction.deletions).toEqual(['a/b/c.md']);
    expect(instruction.files).toEqual([]);
    expect(instruction.directories).toEqual(['a/b']);
  });
});

// ---------------------------------------------------------------------
// Attribution (FR6)
// ---------------------------------------------------------------------

describe('WorkspaceInvalidationService — attribution (FR6)', () => {
  const writeArgs = JSON.stringify({ path: 'a/b.md' });

  it('(AC16) the workspace comes from the CALL envelope sender', () => {
    const result = collectFromLog([
      makeStartMessage('A', [workspaceTool('ws-a')]),
      makeStartMessage('B', [workspaceTool('ws-b')]),
      makeToolCall('B', 'workspace_write', writeArgs, 'call-1'),
      makeToolReturn('B', 'workspace_write', 'call-1', true),
    ]);
    expect(result.length).toBe(1);
    expect(result[0].workspaceId).toBe('ws-b');
  });

  it('(AC17) an agent contributing to two workspaces yields two instructions', () => {
    const result = collectFromLog(
      mutationLog('workspace_write', writeArgs, [
        workspaceTool('ws-a'),
        workspaceTool('ws-b'),
      ]),
    );
    expect(result.length).toBe(2);
    expect(result.map((i) => i.workspaceId).sort()).toEqual(['ws-a', 'ws-b']);
    for (const instruction of result) {
      expect(instruction.directories).toEqual(['a']);
      expect(instruction.files).toEqual(['a/b.md']);
    }
  });

  it('(AC17) the two instructions do not share array references', () => {
    const result = collectFromLog(
      mutationLog('workspace_write', writeArgs, [
        workspaceTool('ws-a'),
        workspaceTool('ws-b'),
      ]),
    );
    expect(result[0].files).not.toBe(result[1].files);
    expect(result[0].directories).not.toBe(result[1].directories);
    expect(result[0].deletions).not.toBe(result[1].deletions);
  });

  it('(AC17) a two-workspace delete does not share its `deletions` array', () => {
    // `deletions` is the only list a write never populates, so the spec above
    // would keep passing if it alone were hoisted out of the per-workspace
    // build. A consumer that splices a handled deletion off one instruction
    // must not empty the other workspace's.
    const result = collectFromLog(
      mutationLog('workspace_delete', JSON.stringify({ path: 'a/b.md' }), [
        workspaceTool('ws-a'),
        workspaceTool('ws-b'),
      ]),
    );
    expect(result.length).toBe(2);
    for (const instruction of result) {
      expect(instruction.deletions).toEqual(['a/b.md']);
    }
    expect(result[0].deletions).not.toBe(result[1].deletions);
    expect(result[0].directories).not.toBe(result[1].directories);
  });

  it('(AC18) an agent with no WorkspaceTool yields no instruction and no phantom id', () => {
    const result = collectFromLog(
      mutationLog('workspace_write', writeArgs, []),
    );
    expect(result).toEqual([]);
  });

  it('(AC18) an agent with no StartMessage at all yields no instruction', () => {
    const result = collectFromLog([
      makeToolCall('ghost', 'workspace_write', writeArgs, 'call-1'),
      makeToolReturn('ghost', 'workspace_write', 'call-1', true),
    ]);
    expect(result).toEqual([]);
  });

  it('(AC19) a WorkspaceTool with no workspace_id attributes to the team default', () => {
    const result = collectFromLog(
      mutationLog('workspace_write', writeArgs, [workspaceTool(null)]),
    );
    expect(result.length).toBe(1);
    expect(result[0].workspaceId).toBe(TEAM_ID);
  });

  it('(AC16) attribution is resolved at CALL time, not at return time', () => {
    // A StopMessage between the call and its return must NOT retroactively
    // erase the instruction — the workspace ids are captured at call time and
    // held with the in-flight entry, so nothing later can rewrite them.
    const result = collectFromLog([
      makeStartMessage('A', [workspaceTool('ws-1')]),
      makeToolCall('A', 'workspace_write', writeArgs, 'call-1'),
      makeStopMessage('A'),
      makeToolReturn('A', 'workspace_write', 'call-1', true),
    ]);
    expect(result.length).toBe(1);
    expect(result[0].workspaceId).toBe('ws-1');
  });

  it('(AC16) a call placed after the agent stopped attributes to nothing', () => {
    const result = collectFromLog([
      makeStartMessage('A', [workspaceTool('ws-1')]),
      makeStopMessage('A'),
      makeToolCall('A', 'workspace_write', writeArgs, 'call-1'),
      makeToolReturn('A', 'workspace_write', 'call-1', true),
    ]);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------
// Tier and lifecycle (FR3 / NFR1) — the service and its delta stream
// ---------------------------------------------------------------------

describe('WorkspaceInvalidationService (reads MessageLogService.appended$; log$ for reset only)', () => {
  let log: MessageLogService;
  let service: WorkspaceInvalidationService;

  const writeArgs = JSON.stringify({ path: 'a/b.md' });

  beforeEach(() => {
    // Only MessageLogService is provided: the service injects nothing else —
    // no WorkspaceService, no HttpClient, no ContextService, no PrimeNG
    // MessageService — so TestBed would fail to construct it if it did (AC24).
    TestBed.configureTestingModule({
      providers: [MessageLogService, WorkspaceInvalidationService],
    });
    log = TestBed.inject(MessageLogService);
    service = TestBed.inject(WorkspaceInvalidationService);
  });

  function collect(): WorkspaceInvalidation[] {
    const seen: WorkspaceInvalidation[] = [];
    service.invalidations$.subscribe((i) => seen.push(i));
    return seen;
  }

  it('(AC24) constructs with MessageLogService alone', () => {
    expect(service).toBeTruthy();
    expect(service.invalidations$).toBeDefined();
  });

  it('(AC22) a call+return appended after subscribe emits exactly one instruction', () => {
    log.append(makeStartMessage('A', [workspaceTool('ws-1')]));
    const seen = collect();
    log.append(makeToolCall('A', 'workspace_write', writeArgs, 'call-1'));
    log.append(makeToolReturn('A', 'workspace_write', 'call-1', true));

    expect(seen.length).toBe(1);
    expect(seen[0].workspaceId).toBe('ws-1');
    expect(seen[0].files).toEqual(['a/b.md']);
  });

  it('(AC22) further unrelated appends do not re-announce it', () => {
    log.append(makeStartMessage('A', [workspaceTool('ws-1')]));
    const seen = collect();
    log.append(makeToolCall('A', 'workspace_write', writeArgs, 'call-1'));
    log.append(makeToolReturn('A', 'workspace_write', 'call-1', true));
    log.append(makeStartMessage('B', [workspaceTool('ws-2')]));
    log.append(makeStopMessage('B'));

    expect(seen.length).toBe(1);
  });

  it('(AC22) a second completed mutation emits only the new instruction', () => {
    log.append(makeStartMessage('A', [workspaceTool('ws-1')]));
    const seen = collect();
    log.append(makeToolCall('A', 'workspace_write', writeArgs, 'call-1'));
    log.append(makeToolReturn('A', 'workspace_write', 'call-1', true));
    log.append(
      makeToolCall(
        'A',
        'workspace_write',
        JSON.stringify({ path: 'x/y.md' }),
        'call-2',
      ),
    );
    log.append(makeToolReturn('A', 'workspace_write', 'call-2', true));

    expect(seen.length).toBe(2);
    expect(seen[1].files).toEqual(['x/y.md']);
  });

  it('(AC23) subscribing to a log that already holds a completed mutation emits nothing', () => {
    log.appendAll([
      makeStartMessage('A', [workspaceTool('ws-1')]),
      makeToolCall('A', 'workspace_write', writeArgs, 'call-1'),
      makeToolReturn('A', 'workspace_write', 'call-1', true),
    ]);

    const seen = collect();
    expect(seen).toEqual([]);
  });

  it('(AC23) after the baseline, a NEW mutation on the pre-seeded log still fires', () => {
    log.appendAll([
      makeStartMessage('A', [workspaceTool('ws-1')]),
      makeToolCall('A', 'workspace_write', writeArgs, 'call-1'),
      makeToolReturn('A', 'workspace_write', 'call-1', true),
    ]);
    const seen = collect();
    log.append(
      makeToolCall(
        'A',
        'workspace_write',
        JSON.stringify({ path: 'later.md' }),
        'call-2',
      ),
    );
    log.append(makeToolReturn('A', 'workspace_write', 'call-2', true));

    expect(seen.length).toBe(1);
    expect(seen[0].files).toEqual(['later.md']);
  });

  it('(AC21) reset() between a call and its return leaves the in-flight map empty', () => {
    log.append(makeStartMessage('A', [workspaceTool('ws-1')]));
    const seen = collect();
    log.append(makeToolCall('A', 'workspace_write', writeArgs, 'call-1'));
    log.reset();
    log.append(makeToolReturn('A', 'workspace_write', 'call-1', true));

    expect(seen).toEqual([]);
  });

  it('(AC21) reset() clears the state: a full mutation after it still fires once', () => {
    log.append(makeStartMessage('A', [workspaceTool('ws-1')]));
    const seen = collect();
    log.append(makeToolCall('A', 'workspace_write', writeArgs, 'call-1'));
    log.append(makeToolReturn('A', 'workspace_write', 'call-1', true));
    expect(seen.length).toBe(1);

    log.reset();
    log.append(makeStartMessage('A', [workspaceTool('ws-1')]));
    log.append(
      makeToolCall(
        'A',
        'workspace_write',
        JSON.stringify({ path: 'fresh.md' }),
        'call-3',
      ),
    );
    log.append(makeToolReturn('A', 'workspace_write', 'call-3', true));

    expect(seen.length).toBe(2);
    expect(seen[1].files).toEqual(['fresh.md']);
  });

  it('(AC24) the stream is not shareReplay-ed: a late subscriber gets no history', () => {
    log.append(makeStartMessage('A', [workspaceTool('ws-1')]));
    const first = collect();
    log.append(makeToolCall('A', 'workspace_write', writeArgs, 'call-1'));
    log.append(makeToolReturn('A', 'workspace_write', 'call-1', true));
    expect(first.length).toBe(1);

    const late = collect();
    expect(late).toEqual([]);
  });

  it('(AC20) two independent subscribers each hold their own state and seed', () => {
    log.append(makeStartMessage('A', [workspaceTool('ws-1')]));
    const early = collect();
    log.append(makeToolCall('A', 'workspace_write', writeArgs, 'call-1'));
    log.append(makeToolReturn('A', 'workspace_write', 'call-1', true));

    const late = collect();
    log.append(
      makeToolCall(
        'A',
        'workspace_write',
        JSON.stringify({ path: 'shared.md' }),
        'call-2',
      ),
    );
    log.append(makeToolReturn('A', 'workspace_write', 'call-2', true));

    expect(early.length).toBe(2);
    expect(late.length).toBe(1);
    expect(late[0].files).toEqual(['shared.md']);
  });
});

// ---------------------------------------------------------------------
// Incremental reading (Epic 42) — a message is processed once, the batch
// arrives synchronously, a team switch empties what is held, and the
// stopped-team replay announces nothing.
// ---------------------------------------------------------------------

describe('WorkspaceInvalidationService — incremental reading (Epic 42)', () => {
  let log: MessageLogService;
  let service: WorkspaceInvalidationService;

  const writeArgs = JSON.stringify({ path: 'a/b.md' });

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [MessageLogService, WorkspaceInvalidationService],
    });
    log = TestBed.inject(MessageLogService);
    service = TestBed.inject(WorkspaceInvalidationService);
  });

  function collect(): WorkspaceInvalidation[] {
    const seen: WorkspaceInvalidation[] = [];
    service.invalidations$.subscribe((i) => seen.push(i));
    return seen;
  }

  /**
   * A `workspace_write` call whose `arguments` string counts its own reads.
   *
   * `parseToolCallArguments` reads `event.arguments` exactly ONCE per parse, and
   * it is the only reader in the unit, so the counter is an exact count of how
   * many times this call was processed. A timer would measure the machine and a
   * spy on the module import would measure the wiring; this measures the thing.
   */
  function countingToolCall(
    callId: string,
    argsJson: string,
  ): { message: EventMessage; reads: () => number } {
    let reads = 0;
    const payload = {
      __model__: TOOL_CALL_MODEL,
      run_id: 'run-1',
      tool_name: 'workspace_write',
      tool_call_id: callId,
      get arguments(): string {
        reads += 1;
        return argsJson;
      },
    };
    return { message: makeEventMessage('A', payload), reads: () => reads };
  }

  it('(AC25) a completed call is processed once, not once per subsequent append', () => {
    const counted = countingToolCall(
      'counted-1',
      JSON.stringify({ path: 'a/b.md', content: 'a whole file body' }),
    );

    log.append(makeStartMessage('A', [workspaceTool('ws-1')]));
    const seen = collect();
    log.append(counted.message);
    log.append(makeToolReturn('A', 'workspace_write', 'counted-1', true));
    expect(seen.length).toBe(1);

    // Ten further appends, none of which mention the completed call.
    for (let i = 0; i < 10; i += 1) {
      log.append(
        makeToolCall(
          'A',
          'workspace_read',
          JSON.stringify({ path: 'r.md' }),
          'read-' + i,
        ),
      );
    }

    expect(seen.length).toBe(1);
    expect(counted.reads()).toBe(1);
  });

  it('(AC26) one appendAll batch carrying two completed mutations emits both synchronously, in log order', () => {
    // The explorer coalesces its listings on a microtask and relies on the whole
    // burst having arrived by the time that microtask runs. An asynchronous
    // scheduler here turns one coalesced listing per directory back into one
    // listing per event — and every other spec in this file would still pass.
    log.append(makeStartMessage('A', [workspaceTool('ws-1')]));
    const seen = collect();

    log.appendAll([
      makeToolCall(
        'A',
        'workspace_write',
        JSON.stringify({ path: 'one.md' }),
        'b-1',
      ),
      makeToolReturn('A', 'workspace_write', 'b-1', true),
      makeToolCall(
        'A',
        'workspace_write',
        JSON.stringify({ path: 'two.md' }),
        'b-2',
      ),
      makeToolReturn('A', 'workspace_write', 'b-2', true),
    ]);

    // Read immediately after the synchronous `appendAll` returns — no `await`,
    // no `fakeAsync`, no `tick()`.
    expect(seen.length).toBe(2);
    expect(seen.map((i) => i.files[0])).toEqual(['one.md', 'two.md']);
  });

  it('(AC27) reset() also drops the agent→workspace attribution, so nothing leaks across a team switch', () => {
    // `IngestionService.init()` runs several times per component lifetime (team
    // switch) and this service is scoped to the `ProcessComponent`, which
    // survives it. A whole-log fold got both maps emptied for free by folding an
    // empty array; a subscriber that only reads what was just appended has to do
    // it explicitly. A surviving contribution would attribute the NEXT team's
    // mutation to the PREVIOUS team's workspace.
    log.append(makeStartMessage('A', [workspaceTool('ws-old')]));
    const seen = collect();

    log.reset();
    log.append(makeToolCall('A', 'workspace_write', writeArgs, 'after-switch'));
    log.append(makeToolReturn('A', 'workspace_write', 'after-switch', true));

    expect(seen).toEqual([]);
  });

  it('(AC28) a stopped team\'s REST replay announces nothing, because it lands before any consumer subscribes', () => {
    // WHY this spec exists, and why it is not a rule in this file: the property
    // is INHERITED from a file this unit does not own. `IngestionService.init()`
    // is four ordered steps — (a) dispose the prior cycle, (b) `log.reset()`,
    // (c) seed the replay for a STOPPED team via `appendAll`, (d) wire the
    // consumers, then open the socket. The replay lands at (c), before any
    // consumer exists, and `appended$` is a plain `Subject` with no replay
    // buffer, so a subscriber wired at or after (d) never receives it as a
    // batch. What it does instead is absorb the log at subscribe time and
    // announce nothing — which is why the live mutation below still attributes
    // to `ws-1` rather than to no workspace at all.
    //
    // What this spec pins is THIS unit's half of the property: a subscriber
    // arriving after a batch registers it silently. It cannot pin the other
    // half. Move the consumer wiring above the replay seed in
    // `ingestion.service.ts` and opening the panel on a stopped team bursts one
    // listing per historical mutation again — silently, with every spec in this
    // file still green, THIS ONE INCLUDED, because it drives the correct order
    // itself. No spec anywhere pins that ordering; the gap is recorded on epic
    // 42.
    log.reset(); // (b)
    log.appendAll([
      // (c) the REST replay
      makeStartMessage('A', [workspaceTool('ws-1')]),
      makeToolCall('A', 'workspace_write', writeArgs, 'replay-1'),
      makeToolReturn('A', 'workspace_write', 'replay-1', true),
      makeToolCall(
        'A',
        'workspace_write',
        JSON.stringify({ path: 'c/d.md' }),
        'replay-2',
      ),
      makeToolReturn('A', 'workspace_write', 'replay-2', true),
    ]);
    const seen = collect(); // (d) the consumer subscribes

    expect(seen).toEqual([]);

    // And it does not pass by the stream being dead: a live mutation after the
    // replay still fires exactly once, attributed to the replayed StartMessage.
    log.append(
      makeToolCall(
        'A',
        'workspace_write',
        JSON.stringify({ path: 'live.md' }),
        'live-1',
      ),
    );
    log.append(makeToolReturn('A', 'workspace_write', 'live-1', true));

    expect(seen.length).toBe(1);
    expect(seen[0].workspaceId).toBe('ws-1');
    expect(seen[0].files).toEqual(['live.md']);
  });
});
