//mypreset.ts
import { definePreset } from '@primeng/themes';
import Aura from '@primeng/themes/aura';

const MyPreset = definePreset(Aura, {
  components: {
    // The spinner is ONE colour, and a neutral one.
    //
    // Aura ships a four-stop cycle — red, blue, green, yellow — animated over
    // six seconds. On a short fetch you see whichever stop it happened to be
    // on, so the same action looks red one time and green the next; and red in
    // particular reads as an error on a screen where red means exactly that.
    // All four stops are set to the same neutral grey, which leaves the
    // animation running and removes the colour from it.
    progressspinner: {
      colorScheme: {
        light: {
          'color.1': '{slate.400}',
          'color.2': '{slate.400}',
          'color.3': '{slate.400}',
          'color.4': '{slate.400}',
        },
      },
    },
    datatable: {
      headerCellBackground: 'transparent',
      headerCellColor: '{text.color}',
      headerCellSelectedBackground: 'transparent',
      headerCellSelectedColor: '{text.color}',
    },
  },
  semantic: {
    // The library's primary follows the product's accent. Left on sky, every
    // PrimeNG button, tab and highlight stayed blue while the app around them
    // went green — the chrome and the content disagreeing about the brand.
    //
    // ONE SOURCE OF TRUTH, and `var()` rather than a hex is what makes it one.
    // This ramp was eleven literals, four of which were byte-identical copies of
    // `--akg-accent-*`: a deployment re-pointing the accent — the documented way
    // to rebrand, see the header of `_conversation-tokens.scss` — moved the
    // product's surfaces and left every PrimeNG control on the old green, with
    // nothing to indicate the two had ever been meant to agree.
    //
    // A `var()` resolves here because these values are not read by the theme;
    // they are EMITTED, straight into `--p-primary-50` … `--p-primary-950` on
    // the document, where the browser resolves them against the same `:root`
    // the tokens are declared on. The four the product also uses by name keep
    // their role names, so the reference reads as "the accent" rather than as a
    // number; the seven it does not are positions on a curve and are named as
    // such.
    primary: {
      50: 'var(--akg-accent-bg)',
      100: 'var(--akg-accent-border)',
      200: 'var(--akg-accent-200)',
      300: 'var(--akg-accent-300)',
      400: 'var(--akg-accent-400)',
      500: 'var(--akg-accent-500)',
      600: 'var(--akg-accent-600)',
      700: 'var(--akg-accent-fg)',
      800: 'var(--akg-accent-hover)',
      900: 'var(--akg-accent-900)',
      950: 'var(--akg-accent-950)',
    },
    colorScheme: {
      light: {
        // These name STOPS in the ramp above, so they follow the accent
        // automatically. Left pointing at `{sky.*}` they would have resolved
        // against Aura's palette and reintroduced blue underneath the new ramp.
        primary: {
          color: '{primary.700}',
          inverseColor: '{primary.50}',
          hoverColor: '{primary.800}',
          activeColor: '{primary.900}',
        },
        // A selected row is a SELECTION, not an announcement. Pointing this at
        // primary.700 painted the whole row in the darkest green in the ramp
        // and reversed its text — louder than anything else on the screen, for
        // the least important reason.
        highlight: {
          background: '{primary.50}',
          focusBackground: '{primary.100}',
          color: '{primary.800}',
          focusColor: '{primary.900}',
        },
      },
    },
  },
});

export default MyPreset;
