import { UsdCostPipe } from './usd-cost.pipe';

describe('UsdCostPipe (Epic 57)', () => {
  let pipe: UsdCostPipe;

  beforeEach(() => {
    pipe = new UsdCostPipe();
  });

  it('renders 0 as nothing', () => {
    expect(pipe.transform(0)).toBe('');
  });

  it('renders null / undefined / non-finite / negative as nothing', () => {
    expect(pipe.transform(null)).toBe('');
    expect(pipe.transform(undefined)).toBe('');
    expect(pipe.transform(NaN)).toBe('');
    expect(pipe.transform(Infinity)).toBe('');
    expect(pipe.transform(-1)).toBe('');
  });

  it('renders a sub-cent value as "<$0.01", never "$0.00" or "$0.01"', () => {
    expect(pipe.transform(0.004)).toBe('<$0.01');
    expect(pipe.transform(0.00999)).toBe('<$0.01');
  });

  it('renders >= 0.01 as dollars with two decimals and thousands separators', () => {
    expect(pipe.transform(0.01)).toBe('$0.01');
    expect(pipe.transform(1.234)).toBe('$1.23');
    expect(pipe.transform(1234.5)).toBe('$1,234.50');
  });
});
