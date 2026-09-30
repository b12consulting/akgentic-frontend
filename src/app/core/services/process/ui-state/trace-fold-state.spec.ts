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
