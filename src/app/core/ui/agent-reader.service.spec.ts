import { TestBed } from '@angular/core/testing';

import { AgentReaderService, AgentRef } from './agent-reader.service';

/**
 * The seam between a control that asks for the reader (a member row in the
 * inspector) and the reader itself (mounted in the chat panel, on the far side
 * of the split).
 *
 * What is worth pinning here is exactly what a signal-shaped implementation
 * would get wrong — repetition — plus the fact that there is only ONE of these
 * streams. An earlier round shipped two, and the asking side published into a
 * service nobody was listening to.
 */
describe('AgentReaderService', () => {
  let reader: AgentReaderService;
  let seen: AgentRef[];

  beforeEach(() => {
    TestBed.configureTestingModule({});
    reader = TestBed.inject(AgentReaderService);
    seen = [];
    reader.open$.subscribe((a) => seen.push(a));
  });

  it('forwards the agent it was asked for, id and actor name together', () => {
    // Both fields travel because the host needs the id to SELECT and the raw
    // actor name to ADDRESS a message — the friendly label can do neither.
    reader.open({ agentId: 'agent-42', actorName: 'expert-analyst-batch-1' });

    expect(seen).toEqual([
      { agentId: 'agent-42', actorName: 'expert-analyst-batch-1' },
    ]);
  });

  it('fires AGAIN for the same agent — the user may re-open what they closed', () => {
    // The one assertion that rules out holding the current agent in a signal:
    // setting a signal to the value it already has notifies nobody, so the
    // second click on the same row would silently do nothing.
    reader.open({ agentId: 'agent-42', actorName: 'A' });
    reader.open({ agentId: 'agent-42', actorName: 'A' });

    expect(seen.length).toBe(2);
  });

  it('drops a blank id instead of opening the reader on nobody', () => {
    // An empty id would put an agent-less dialog over the team the user was
    // looking at — worse than the click appearing to do nothing.
    reader.open({ agentId: '', actorName: 'A' });
    reader.open({ agentId: '   ', actorName: 'A' });

    expect(seen).toEqual([]);
  });

  it('does not replay the last request to a late subscriber', () => {
    // A replayed request would pop the reader open on a view the user has
    // already navigated to.
    reader.open({ agentId: 'agent-1', actorName: 'A' });

    const late: AgentRef[] = [];
    reader.open$.subscribe((a) => late.push(a));

    expect(late).toEqual([]);
  });

  it('is root-scoped — the asking row and the reader share ONE stream', () => {
    // The regression this pins: two separately-provided instances meant the
    // inspector's read button published where the chat panel was not listening.
    expect(TestBed.inject(AgentReaderService)).toBe(reader);
  });
});
