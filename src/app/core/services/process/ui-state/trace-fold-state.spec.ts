import { TraceFoldState } from './trace-fold-state';

describe('TraceFoldState', () => {
  it('starts with every card collapsed', () => {
    expect(new TraceFoldState().isOpen('U1|manager-id')).toBeFalse();
  });

  it('toggles one root without touching another', () => {
    const folds = new TraceFoldState();
    folds.toggle('U1|manager-id');
    expect(folds.isOpen('U1|manager-id')).toBeTrue();
    expect(folds.isOpen('U2|manager-id')).toBeFalse();
    folds.toggle('U1|manager-id');
    expect(folds.isOpen('U1|manager-id')).toBeFalse();
  });

  it('open never closes an open card', () => {
    const folds = new TraceFoldState();
    folds.open('U1|manager-id');
    folds.open('U1|manager-id');
    expect(folds.isOpen('U1|manager-id')).toBeTrue();
  });

  it('publishes a new set on each change, so a signal reader re-runs', () => {
    const folds = new TraceFoldState();
    const before = folds.openKeys();
    folds.open('U1|manager-id');
    expect(folds.openKeys()).not.toBe(before);
    expect([...folds.openKeys()]).toEqual(['U1|manager-id']);
  });
});

describe('TraceFoldState — nodes', () => {
  const ROOT = 'U1|manager-id';
  const EXPERT = 'D1|expert-id';
  const ASSISTANT = 'D2|assistant-id';

  it('expands only the root by default', () => {
    const folds = new TraceFoldState();
    expect(folds.isNodeExpanded(ROOT, ROOT)).toBeTrue();
    expect(folds.isNodeExpanded(EXPERT, ROOT)).toBeFalse();
  });

  it('a toggle persists and is keyed by run key', () => {
    const folds = new TraceFoldState();
    folds.toggleNode(EXPERT, ROOT);
    folds.toggleNode(ROOT, ROOT);
    expect(folds.isNodeExpanded(EXPERT, ROOT)).toBeTrue();
    expect(folds.isNodeExpanded(ROOT, ROOT)).toBeFalse();
    expect(folds.isNodeExpanded(ASSISTANT, ROOT)).toBeFalse();
    folds.toggleNode(EXPERT, ROOT);
    expect(folds.isNodeExpanded(EXPERT, ROOT)).toBeFalse();
  });

  it('reveal applies on open, and not on close', () => {
    const folds = new TraceFoldState();
    folds.toggle(ROOT, [EXPERT, ROOT]);
    expect(folds.isOpen(ROOT)).toBeTrue();
    expect(folds.isNodeExpanded(EXPERT, ROOT)).toBeTrue();

    folds.toggleNode(EXPERT, ROOT);
    folds.toggle(ROOT, [EXPERT, ROOT]);
    expect(folds.isOpen(ROOT)).toBeFalse();
    expect(folds.isNodeExpanded(EXPERT, ROOT)).toBeFalse();
  });

  it('open on an open card reveals nothing', () => {
    const folds = new TraceFoldState();
    folds.open(ROOT);
    folds.open(ROOT, [EXPERT]);
    expect(folds.isNodeExpanded(EXPERT, ROOT)).toBeFalse();
  });

  it('reveal leaves a user-folded node off the path folded', () => {
    const folds = new TraceFoldState();
    folds.toggleNode(ASSISTANT, ROOT);
    folds.toggleNode(ASSISTANT, ROOT);
    folds.open(ROOT, [EXPERT, ROOT]);
    expect(folds.isNodeExpanded(ASSISTANT, ROOT)).toBeFalse();
    expect(folds.isNodeExpanded(EXPERT, ROOT)).toBeTrue();
  });

  it('expandNodes expands exactly its keys and keeps every other override', () => {
    const folds = new TraceFoldState();
    const SIBLING = 'D3|expert-id';
    const OTHER_ROOT = 'U2|manager-id';
    folds.toggleNode(SIBLING, ROOT); // the reader opened a sibling branch
    folds.toggleNode(OTHER_ROOT, OTHER_ROOT); // and folded another card's root
    folds.toggleNode(ROOT, ROOT);
    folds.expandNodes([ROOT, EXPERT]);
    expect(folds.isNodeExpanded(ROOT, ROOT)).toBeTrue();
    expect(folds.isNodeExpanded(EXPERT, ROOT)).toBeTrue();
    expect(folds.isNodeExpanded(SIBLING, ROOT)).toBeTrue();
    expect(folds.isNodeExpanded(OTHER_ROOT, OTHER_ROOT)).toBeFalse();
    expect(folds.isNodeExpanded(ASSISTANT, ROOT)).toBeFalse();
  });

  it('expandNodes opens no card', () => {
    const folds = new TraceFoldState();
    folds.expandNodes([ROOT, EXPERT]);
    expect(folds.isOpen(ROOT)).toBeFalse();
  });

  it('re-opening re-applies reveal over a fold made in between', () => {
    const folds = new TraceFoldState();
    folds.open(ROOT, [EXPERT, ROOT]);
    folds.toggleNode(EXPERT, ROOT);
    folds.toggle(ROOT);
    folds.toggle(ROOT, [EXPERT, ROOT]);
    expect(folds.isNodeExpanded(EXPERT, ROOT)).toBeTrue();
  });
});
