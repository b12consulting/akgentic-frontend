import { TestBed } from '@angular/core/testing';

import {
  CategoryService,
  GRAPH_CATEGORY_COUNT,
  graphCategoryColors,
  readToken,
} from './category.service';

/**
 * THE GRAPH'S CATEGORICAL RAMP, MEASURED.
 *
 * The hierarchy tab colours one squad per stop, and the ramp used to be ten
 * literal hexes in this file — an echarts sample palette, cool blue-grey
 * against a warm neutral console, and the one part of the graph's appearance
 * no deployment could re-point. It now resolves from
 * `--akg-graph-category-<n>` in `_conversation-tokens.scss`.
 *
 * WHY THE MEASUREMENTS ARE HERE AND NOT IN `token-contrast.spec.ts`. That file
 * measures a FOREGROUND against every GROUND — one value against many. A
 * categorical ramp has a second obligation that shape cannot express: the stops
 * must differ from EACH OTHER, or the legend is decorative. "Distinguishable"
 * is the entire purpose of a categorical palette and the entire thing a
 * well-meaning rebrand destroys, so it is measured, not asserted in a comment.
 *
 * Like `token-contrast.spec.ts`, this reads COMPUTED values — `styles.scss` is
 * in the Karma bundle — so it measures what a browser resolves, including any
 * deployment override that reaches `:root`, rather than what the SCSS says.
 */

/** Any CSS colour → sRGB channels, via the browser's own parser. */
function channels(color: string): [number, number, number] {
  const probe = document.createElement('span');
  probe.style.color = color;
  document.body.appendChild(probe);
  const computed = getComputedStyle(probe).color;
  probe.remove();
  const parts = computed.match(/[\d.]+/g);
  if (parts === null || parts.length < 3) {
    throw new Error(`unparseable colour: "${color}" resolved to "${computed}"`);
  }
  return [Number(parts[0]), Number(parts[1]), Number(parts[2])];
}

/** Linear-light sRGB, the shared first step of luminance and of CIE Lab. */
function linear(color: string): [number, number, number] {
  const [r, g, b] = channels(color).map((channel) => {
    const s = channel / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return [r, g, b];
}

/** Relative luminance, per WCAG 2.1 §Relative luminance. */
function luminance(color: string): number {
  const [r, g, b] = linear(color);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Contrast ratio, per WCAG 2.1 §Contrast ratio, to two decimals. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

/** CIE L*a*b* under D65, the space perceptual distance is defined in. */
function lab(color: string): [number, number, number] {
  const [r, g, b] = linear(color);
  const x = r * 0.4124 + g * 0.3576 + b * 0.1805;
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const z = r * 0.0193 + g * 0.1192 + b * 0.9505;
  const white: [number, number, number] = [0.95047, 1, 1.08883];
  const f = (t: number): number =>
    t > Math.pow(6 / 29, 3)
      ? Math.cbrt(t)
      : t / (3 * Math.pow(6 / 29, 2)) + 4 / 29;
  const [fx, fy, fz] = [f(x / white[0]), f(y / white[1]), f(z / white[2])];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/**
 * CIE76 ΔE. The crudest of the perceptual metrics and the right one here: the
 * question is "could a user mistake these two squads for one", not "is this a
 * colour-managed print match", and CIE76 is the one a reader can follow.
 */
function deltaE(a: string, b: string): number {
  const [la, aa, ba] = lab(a);
  const [lb, ab, bb] = lab(b);
  return Math.sqrt((la - lb) ** 2 + (aa - ab) ** 2 + (ba - bb) ** 2);
}

/**
 * The bar for "two squads do not read as one squad".
 *
 * 25 is well above the ~2.3 of a just-noticeable difference, and deliberately
 * so: these are 15px squares seen at a glance, several pane-widths apart, with
 * a legend between them. The measured minimum of the shipped ramp is 25.1
 * (stop 6 against stop 8); the bar is set just under it so a refresh that
 * merely nudges a value passes and one that collapses two stops does not.
 */
const MIN_SEPARATION = 25;

/** The ground the hierarchy tab is painted on: the inspector's panel. */
const GROUND = '--akg-graph-ground';

describe('the hierarchy graph palette', () => {
  it('resolves every stop the ramp says it has', () => {
    // An undeclared token resolves to `''`, which handed to echarts is a parse
    // failure rather than "no colour" — so `graphCategoryColors` drops empties
    // and this is the assertion that notices they were dropped.
    expect(graphCategoryColors().length).toBe(GRAPH_CATEGORY_COUNT);
  });

  it('declares exactly as many stops in CSS as the constant claims', () => {
    // The ramp is read BY NAME, so a stylesheet that grew an eleventh stop
    // would simply never have it read. Counting the declarations is the only
    // way that disagreement can be noticed at all.
    const declared = Array.from(document.styleSheets)
      .flatMap((sheet) => {
        try {
          return Array.from(sheet.cssRules);
        } catch {
          return [];
        }
      })
      .filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule)
      .filter((rule) => rule.selectorText === ':root')
      .flatMap((rule) => Array.from(rule.style))
      .filter((name) => /^--akg-graph-category-\d+$/.test(name));

    expect(new Set(declared).size).toBe(GRAPH_CATEGORY_COUNT);
  });

  for (let stop = 1; stop <= GRAPH_CATEGORY_COUNT; stop++) {
    it(`stop ${stop} is distinguishable from the ground it is drawn on`, () => {
      // 3:1, per WCAG 2.1 1.4.11: a node's fill is a non-text mark that
      // carries meaning — it is what ties the node to its legend entry.
      expect(
        contrast(readToken(`--akg-graph-category-${stop}`), readToken(GROUND)),
      )
        .withContext(`--akg-graph-category-${stop} on ${GROUND}`)
        .toBeGreaterThanOrEqual(3);
    });
  }

  it('keeps every PAIR of stops apart', () => {
    // The obligation a "foreground on a ground" spec cannot express, and the
    // one that a rebrand quietly breaks: ten colours that each pass on the
    // ground but read as three.
    const ramp = graphCategoryColors();
    const tooClose: string[] = [];
    for (let i = 0; i < ramp.length; i++) {
      for (let j = i + 1; j < ramp.length; j++) {
        const separation = deltaE(ramp[i], ramp[j]);
        if (separation < MIN_SEPARATION) {
          tooClose.push(
            `${i + 1} (${ramp[i]}) vs ${j + 1} (${ramp[j]}): ΔE ${separation.toFixed(1)}`,
          );
        }
      }
    }
    expect(tooClose).toEqual([]);
  });

  it('keeps red out of the ramp, because red already means ERROR', () => {
    // `graph.selector.ts` repaints a node that has errored red. A squad that
    // drew a red stop would be indistinguishable from a failure, and that is
    // the one reading on this canvas that must never be ambiguous. Measured as
    // a DISTANCE rather than as an inequality of hexes: aliasing the danger
    // tone is not the only way to collide with it.
    const danger = readToken('--akg-danger-fg');
    const collisions = graphCategoryColors()
      .map((stop, index) => ({ stop, index, separation: deltaE(stop, danger) }))
      .filter((entry) => entry.separation < MIN_SEPARATION)
      .map((entry) => `stop ${entry.index + 1} (${entry.stop})`);
    expect(collisions).toEqual([]);
  });

  it('gives the edges and the labels tones that carry on the canvas', () => {
    const ground = readToken(GROUND);
    // An edge is the only thing on this canvas that says who talked to whom,
    // so it is a meaningful mark and owes 1.4.11's 3:1 — not decoration.
    expect(contrast(readToken('--akg-graph-edge'), ground))
      .withContext('--akg-graph-edge on the graph ground')
      .toBeGreaterThanOrEqual(3);
    // An agent's name is text and owes 1.4.3's 4.5:1. It is NOT covered by
    // `token-contrast.spec.ts`, whose guard matches `text` / `fg` / `glyph`
    // and not `label`; measuring it here is what stops it being unmeasured.
    expect(contrast(readToken('--akg-graph-label'), ground))
      .withContext('--akg-graph-label on the graph ground')
      .toBeGreaterThanOrEqual(4.5);
  });
});

describe('CategoryService', () => {
  let service: CategoryService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(CategoryService);
  });

  it('serves the ramp from the tokens rather than from a literal', () => {
    expect(service.COLORS).toEqual(graphCategoryColors());
    expect(service.COLORS.length).toBe(GRAPH_CATEGORY_COUNT);
  });

  it('resolves the ramp ONCE', () => {
    // `message-list` reads this per node per render and `getComputedStyle`
    // flushes layout, so a getter that re-resolved on every read would put a
    // forced reflow in a render loop.
    const first = service.COLORS;
    expect(service.COLORS).toBe(first);
  });

  it('re-resolves after reloadPalette(), so a theme can still move it', () => {
    const first = service.COLORS;
    service.reloadPalette();
    expect(service.COLORS).not.toBe(first);
    expect(service.COLORS).toEqual(first);
  });
});
