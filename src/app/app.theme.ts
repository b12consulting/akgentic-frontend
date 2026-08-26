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
    primary: {
      50: '{sky.50}',
      100: '{sky.100}',
      200: '{sky.200}',
      300: '{sky.300}',
      400: '{sky.400}',
      500: '{sky.500}',
      600: '{sky.600}',
      700: '{sky.700}',
      800: '{sky.800}',
      900: '{sky.900}',
      950: '{sky.950}',
    },
    colorScheme: {
      light: {
        primary: {
          color: '{sky.800}',
          inverseColor: '{sky.100}',
          hoverColor: '{sky.600}',
          activeColor: '{sky.500}',
        },
        highlight: {
          background: '{sky.900}',
          focusBackground: '{sky.600}',
          color: '{sky.100}',
          focusColor: '{sky.200}',
        },
      },
    },
  },
});

export default MyPreset;
