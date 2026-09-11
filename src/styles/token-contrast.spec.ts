/**
 * Every token declared as a TEXT colour clears WCAG 2.1 AA (1.4.3) on every
 * ground this palette declares — and every token declared as a non-text mark
 * clears 1.4.11's 3:1.
 *
 * WHY THIS EXISTS. The console's first palette carried a four-step light ramp
 * (`--akg-text-soft` / `-meta` / `-faint` / `-hint`) lifted straight off the
 * design mock. All four failed AA on both console grounds — 3.13, 2.75, 2.46
 * and 1.96 to one against `--akg-panel-bg`, where the bar is 4.5 — and they
 * were carrying 36 real translated strings. Nothing caught it, because nothing
 * was looking: contrast had been reasoned about twice, in two stylesheet
 * comments, and never measured. A palette refresh is exactly the kind of change
 * that looks harmless in review, so the measurement belongs in the suite rather
 * than in a reviewer's head.
 *
 * IT READS THE COMPUTED VALUES, NOT THE SOURCE. `src/styles.scss` is in the
 * Karma bundle (see the `test` target's `styles`), so these are the values a
 * browser actually resolves — through `var()` indirection, through whatever the
 * cascade did to them, and including any deployment override that reaches
 * `:root`. Parsing the SCSS would test the file instead of the product.
 *
 * THE TWO LISTS BELOW ARE THE CONTRACT. A new colour token is not covered until
 * it is named in one of them, and `declares no text or glyph token this spec
 * does not measure` is what stops one being added quietly.
 */

/** A colour token, and the bar it has to clear. */
interface Foreground {
  readonly token: string;
  /** 4.5 for text (1.4.3), 3 for a meaningful non-text mark (1.4.11). */
  readonly ratio: number;
}

/** A foreground with ONE designated ground, rather than "anywhere". */
interface Pairing extends Foreground {
  readonly ground: string;
}

/**
 * Everything a STRING may be painted in, measured against every ground.
 *
 * The quiet end is two entries long, and the shortness is the finding: there is
 * no room below `--akg-text-muted` for a legible third step on these grounds,
 * so hierarchy under a heading is carried by size and weight instead.
 */
const TEXT: readonly Foreground[] = [
  { token: '--akg-text', ratio: 4.5 },
  { token: '--akg-text-muted', ratio: 4.5 },
  { token: '--akg-turn-fg', ratio: 4.5 },
  { token: '--akg-control-fg', ratio: 4.5 },
  { token: '--akg-accent-fg', ratio: 4.5 },
  { token: '--akg-danger-fg', ratio: 4.5 },
];

/**
 * Marks that are not text: an icon with an accessible name beside it, a caret
 * that repeats a state already written out, the rail's busy spinner, a disabled
 * control. 3:1, per 1.4.11. Purely decorative marks are exempt from the
 * guideline outright and are held to it anyway — a decoration that clears the
 * meaningful bar cannot become a bug by being reused for something meaningful.
 */
const GLYPH: readonly Foreground[] = [{ token: '--akg-glyph-quiet', ratio: 3 }];

/**
 * Foregrounds that are only ever drawn on ONE ground, and are therefore
 * measured against it alone.
 *
 * Measuring these against the whole ground list would be theatre: a white
 * avatar initial has no business on a white overlay and nothing draws it there.
 * What they need is the pairing they actually ship as — which is also where the
 * white-on-warm avatar initial was found at 2.24:1.
 */
const PAIRED: readonly Pairing[] = [
  { token: '--akg-status-neutral-fg', ground: '--akg-status-neutral-bg', ratio: 4.5 },
  { token: '--akg-status-live-fg', ground: '--akg-status-live-bg', ratio: 4.5 },
  { token: '--akg-avatar-human-fg', ground: '--akg-avatar-human-bg', ratio: 4.5 },
  { token: '--akg-avatar-worker-fg', ground: '--akg-avatar-worker-bg', ratio: 4.5 },
];

/**
 * Foreground-named tokens this spec deliberately does NOT measure, each with
 * the reason.
 *
 * An exclusion list rather than a narrower regex: a regex that quietly failed
 * to match a token would look identical to a token that had been considered and
 * cleared, and this file exists because a contrast question went unasked.
 */
const NOT_MEASURED = new Map([
  [
    '--akg-notify-fg',
    'an alias of --akg-accent-bright, which the palette reserves for SIGNALS ' +
      '(a live dot, an avatar glyph) and forbids for text. Its adjacent-contrast ' +
      'treatment under 1.4.11 is a separate open question about the signal hue ' +
      'itself, not about this alias.',
  ],
]);

/**
 * Every ground the two "anywhere" lists may be drawn on.
 *
 * INCLUDING THE HOVER AND ACTIVE STEPS, which is where the old ramp's worst
 * case lived: the rail draws its rows on `--akg-panel-hover` and, for the team
 * you are in, on `--akg-panel-active-hover`. Measuring only against the resting
 * panel would have passed a value that failed on the one row the user is most
 * often looking at.
 */
const GROUNDS: readonly string[] = [
  '--akg-page-bg',
  '--akg-panel-bg',
  '--akg-panel-hover',
  '--akg-panel-active',
  '--akg-panel-active-hover',
  '--akg-surface',
  '--akg-surface-border',
  '--akg-surface-muted',
  '--akg-hairline',
  '--akg-overlay-bg',
  '--akg-user-bubble-bg',
  '--akg-marker-bg',
  '--akg-well-bg',
  '--akg-accent-bg',
  '--akg-danger-bg',
];

/** The resolved value of a custom property on `:root`. */
function tokenValue(name: string): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name);
  return raw.trim();
}

/**
 * Any CSS colour → sRGB channels, via the browser's own parser.
 *
 * Deliberately not a hex regex. The tokens are hexes today and a deployment
 * override could make one of them `rgb()`, `hsl()` or a named colour, and a
 * parser that only understood hex would silently skip exactly the value nobody
 * had reviewed. Painting it and reading `getComputedStyle` back makes the
 * browser do the conversion.
 */
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

/** Relative luminance, per WCAG 2.1 §Relative luminance. */
function luminance(color: string): number {
  const [r, g, b] = channels(color).map((channel) => {
    const s = channel / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Contrast ratio, per WCAG 2.1 §Contrast ratio, to two decimals. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

describe('the console palette', () => {
  it('resolves every token it is about to measure', () => {
    // A typo in a token name would otherwise read as an empty string, which
    // `channels` would resolve to the inherited colour — and the spec would
    // measure something real and pass while testing nothing.
    const named = [
      ...TEXT.map((entry) => entry.token),
      ...GLYPH.map((entry) => entry.token),
      ...PAIRED.flatMap((entry) => [entry.token, entry.ground]),
      ...GROUNDS,
    ];
    for (const token of named) {
      expect(tokenValue(token)).withContext(token).not.toBe('');
    }
  });

  for (const { token, ratio } of TEXT) {
    for (const ground of GROUNDS) {
      it(`${token} is readable on ${ground} (AA, ${ratio}:1)`, () => {
        expect(contrast(tokenValue(token), tokenValue(ground)))
          .withContext(`${token} on ${ground}`)
          .toBeGreaterThanOrEqual(ratio);
      });
    }
  }

  for (const { token, ratio } of GLYPH) {
    for (const ground of GROUNDS) {
      it(`${token} is distinguishable on ${ground} (${ratio}:1)`, () => {
        expect(contrast(tokenValue(token), tokenValue(ground)))
          .withContext(`${token} on ${ground}`)
          .toBeGreaterThanOrEqual(ratio);
      });
    }
  }

  for (const { token, ground, ratio } of PAIRED) {
    it(`${token} clears ${ratio}:1 on the ground it ships against`, () => {
      expect(contrast(tokenValue(token), tokenValue(ground)))
        .withContext(`${token} on ${ground}`)
        .toBeGreaterThanOrEqual(ratio);
    });
  }

  /**
   * The guard on the lists above.
   *
   * A spec that measures a fixed list is only as good as the list, and the way
   * this class of bug returns is a NEW light token nobody added here. Every
   * declared token whose name marks it as a foreground has to appear in one of
   * the lists — or in `NOT_MEASURED` with a reason — so adding
   * `--akg-text-whisper` fails this spec until somebody has stated which bar it
   * is meant to clear, or why it has none.
   */
  it('declares no foreground token this spec neither measures nor excuses', () => {
    const measured = new Set([
      ...[...TEXT, ...GLYPH, ...PAIRED].map((entry) => entry.token),
      ...NOT_MEASURED.keys(),
    ]);
    // Foregrounds by naming convention; `-bg`, `-border` and the rest are
    // grounds and are covered by being grounds.
    const foregroundish = /^--akg-(.*-)?(text|fg|glyph)(-|$)/;
    const declared = Array.from(document.styleSheets)
      .flatMap((sheet) => {
        try {
          return Array.from(sheet.cssRules);
        } catch {
          // A cross-origin sheet cannot be read, and none of ours are.
          return [];
        }
      })
      .filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule)
      .filter((rule) => rule.selectorText === ':root')
      .flatMap((rule) => Array.from(rule.style))
      .filter((name) => foregroundish.test(name));

    expect(declared.length)
      .withContext('no :root custom properties found — is styles.scss bundled?')
      .toBeGreaterThan(0);
    expect(declared.filter((name) => !measured.has(name))).toEqual([]);
  });
});
