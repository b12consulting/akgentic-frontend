import { TestBed } from '@angular/core/testing';

import {
  ASSISTANT,
  EXPERT,
  HUMAN,
  MANAGER,
  received,
  sent,
  SUPPORT,
} from '../../../../../testing/run-log-builders';
import { CASE_4, CASE_5, CASE_5_VARIANT } from '../../../../../testing/run-log-cases';
import { RunGraph, runGraphFold, runKey } from '../selectors/run-graph.selector';
import { RunSelection, RunSelectionState } from './run-selection';
import { TraceFoldState } from './trace-fold-state';

const M = MANAGER.agent_id;
const E = EXPERT.agent_id;
const A = ASSISTANT.agent_id;
const S = SUPPORT.agent_id;

describe('RunSelectionState', () => {
  let selection: RunSelectionState;
  let folds: TraceFoldState;
  let events: RunSelection[];

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [TraceFoldState, RunSelectionState] });
    selection = TestBed.inject(RunSelectionState);
    folds = TestBed.inject(TraceFoldState);
    events = [];
    selection.selections$.subscribe((e) => events.push(e));
  });

  it('starts with nothing selected and emits nothing', () => {
    expect(selection.selected()).toBeNull();
    expect(events).toEqual([]);
  });

  it('opens the closed card, reveals its waiting seat, expands the path, selects', () => {
    const graph: RunGraph = runGraphFold(CASE_5_VARIANT);
    const root = runKey('U1', M);
    const target = runKey('D2', A);
    selection.select(graph, target, 'tree');

    expect(folds.isOpen(root)).toBeTrue();
    // The seat's path, as a header click would reveal it.
    expect(folds.isNodeExpanded(runKey('D1', E), root)).toBeTrue();
    expect(folds.isNodeExpanded(target, root)).toBeTrue();
    expect(selection.selected()).toBe(target);
    expect(events).toEqual([{ key: target, origin: 'tree' }]);
  });

  it('reveals a node three levels down', () => {
    const graph = runGraphFold(CASE_5);
    const root = runKey('U1', M);
    selection.select(graph, runKey('C', E), 'provenance');
    for (const key of [root, runKey('D1', E), runKey('D2', A), runKey('C', E)]) {
      expect(folds.isNodeExpanded(key, root)).withContext(key).toBeTrue();
    }
  });

  it('on an open card: no seat reveal, and a user-folded sibling stays folded', () => {
    const graph = runGraphFold(CASE_5_VARIANT);
    const root = runKey('U1', M);
    // Opened with its seat revealed (D1 expanded), then the reader folds D1.
    folds.open(root, [runKey('D1', E), root]);
    folds.toggleNode(runKey('D1', E), root);
    selection.select(graph, runKey('X', E), 'mini-tree');

    expect(folds.isNodeExpanded(runKey('D1', E), root)).toBeFalse();
    expect(folds.isNodeExpanded(runKey('D2', A), root)).toBeTrue();
    expect(folds.isNodeExpanded(runKey('X', E), root)).toBeTrue();
  });

  it('leaves other cards alone, open or closed', () => {
    const log = [
      ...CASE_5_VARIANT,
      sent('U8', HUMAN, MANAGER, null, 20),
      received('U8', MANAGER, 21),
      sent('U9', HUMAN, MANAGER, null, 22),
      received('U9', MANAGER, 23),
    ];
    const graph = runGraphFold(log);
    folds.open(runKey('U8', M));
    // The reader folded the other open card's root: the selection keeps it so.
    folds.toggleNode(runKey('U8', M), runKey('U8', M));
    selection.select(graph, runKey('D2', A), 'tree');
    expect(folds.isOpen(runKey('U8', M))).toBeTrue();
    expect(folds.isNodeExpanded(runKey('U8', M), runKey('U8', M))).toBeFalse();
    expect(folds.isOpen(runKey('U9', M))).toBeFalse();
  });

  it('emits once per call, including twice for the same key', () => {
    const graph = runGraphFold(CASE_5);
    selection.select(graph, runKey('S', S), 'tree');
    selection.select(graph, runKey('S', S), 'tree');
    expect(events.length).toBe(2);
    expect(selection.selected()).toBe(runKey('S', S));
  });

  it('case 4: a run in a trace continued from your reply opens THAT card', () => {
    const graph = runGraphFold(CASE_4);
    selection.select(graph, runKey('U2', M), 'provenance');
    expect(folds.isOpen(runKey('U2', M))).toBeTrue();
    expect(folds.isOpen(runKey('U1', M))).toBeFalse();
  });

  it('a late subscriber is not replayed a past selection', () => {
    selection.select(runGraphFold(CASE_5), runKey('S', S), 'tree');
    const late: RunSelection[] = [];
    selection.selections$.subscribe((e) => late.push(e));
    expect(late).toEqual([]);
  });
});
