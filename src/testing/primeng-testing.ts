import { EnvironmentProviders } from '@angular/core';
import { providePrimeNG } from 'primeng/config';

/**
 * PrimeNG providers for specs that open or close an overlay and then assert on
 * the DOM.
 *
 * PrimeNG 21 animates its overlays in CSS through its own motion directive, not
 * through `@angular/animations`, so `NoopAnimationsModule` no longer reaches
 * them. A closing toast or dialog stays mounted for the length of its leave
 * animation, and the toast only emits `onClose` once that animation ends — on a
 * timer that `fixture.whenStable()` does not wait for. A spec that closes one
 * and asserts straight after sees the overlay still there.
 *
 * Disabling the motion through pass-through options makes enter and leave run
 * synchronously, which is the timing those specs were written against when
 * `NoopAnimationsModule` still governed PrimeNG.
 */
export function providePrimeNGTesting(): EnvironmentProviders {
  return providePrimeNG({
    pt: {
      toast: { motion: { disabled: true } },
      dialog: { motion: { disabled: true } },
    },
  });
}
