import MyPreset from './app.theme';

/**
 * The theme's first spec, and it pins exactly one thing: that the PrimeNG
 * primary ramp has no colour of its own.
 *
 * This is not a style assertion. `_conversation-tokens.scss` documents
 * re-declaring `--akg-accent-*` as THE way to rebrand a deployment, and for as
 * long as any stop here is a literal hex that promise is only half true — the
 * product's surfaces move and every PrimeNG button, tab and highlight stays on
 * the old green, with nothing failing to say so. A literal is invisible in
 * review precisely because it looks correct: four of these stops used to be
 * byte-identical copies of the tokens they were meant to follow.
 *
 * It asserts the SHAPE (every stop is a `var()`), never the values, so the
 * palette can be re-tuned freely in the file that owns it.
 */
type Ramp = Record<string, unknown>;

function primaryRamp(): Ramp {
  const semantic = (MyPreset as { semantic?: { primary?: Ramp } }).semantic;
  expect(semantic?.primary).withContext('the preset defines a primary ramp').toBeTruthy();
  return semantic!.primary!;
}

describe('the PrimeNG preset', () => {
  it('defines the eleven stops the library expects', () => {
    // Fewer, and PrimeNG interpolates the gaps against Aura's own sky-blue
    // defaults — which is how blue got underneath a green ramp the first time.
    expect(Object.keys(primaryRamp()).sort()).toEqual(
      ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950'].sort(),
    );
  });

  it('carries no colour of its own — every stop defers to a token', () => {
    for (const [stop, value] of Object.entries(primaryRamp())) {
      expect(value)
        .withContext(`primary.${stop} must be a var() reference, not a literal`)
        .toMatch(/^var\(--akg-accent-[a-z0-9-]+\)$/);
    }
  });

  it('points its role-named stops at the accent tokens the app already uses', () => {
    // The four the product surfaces also read by name. Pinned individually
    // because these are the ones whose drift is silent: the other seven are
    // used by nothing else, so a mismatch there shows up immediately as a
    // wrong-looking control.
    const ramp = primaryRamp();
    expect(ramp['50']).toBe('var(--akg-accent-bg)');
    expect(ramp['100']).toBe('var(--akg-accent-border)');
    expect(ramp['700']).toBe('var(--akg-accent-fg)');
    expect(ramp['800']).toBe('var(--akg-accent-hover)');
  });
});
