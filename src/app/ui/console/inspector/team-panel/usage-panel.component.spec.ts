import { ComponentFixture, TestBed } from '@angular/core/testing';
import { BehaviorSubject, of } from 'rxjs';

import { UsagePanelComponent } from './usage-panel.component';
import {
  ModelTokenTotals,
  TeamTokenTotals,
  TokenUsageSelector,
} from '../../../../core/services/process/selectors/token-usage.selector';
import { provideTranslateTesting } from '../../../../../testing/i18n-testing';

function totals(overrides: Partial<TeamTokenTotals> = {}): TeamTokenTotals {
  return {
    totalSent: 0,
    totalReceived: 0,
    totalCacheRead: 0,
    totalCacheWrite: 0,
    ...overrides,
  };
}

/**
 * The usage card.
 *
 * The fake selector is provided at the TestBed root, which is what the
 * component's bare `inject` resolves — the same arrangement production uses,
 * where the real selector lives on `ProcessComponent`. A spec that re-provided
 * it locally would pass while the shipped component read an empty second store.
 */
describe('UsagePanelComponent', () => {
  let fixture: ComponentFixture<UsagePanelComponent>;
  let totals$: BehaviorSubject<TeamTokenTotals>;
  let byModel$: BehaviorSubject<ModelTokenTotals[]>;
  let selector: unknown;

  async function setup(
    initial: TeamTokenTotals = totals(),
    initialByModel: ModelTokenTotals[] = [],
  ): Promise<void> {
    totals$ = new BehaviorSubject<TeamTokenTotals>(initial);
    byModel$ = new BehaviorSubject<ModelTokenTotals[]>(initialByModel);
    selector = {
      teamTotals$: totals$.asObservable(),
      teamByModel$: byModel$.asObservable(),
      perAgent$: (_id: string) => of(undefined),
    };

    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [UsagePanelComponent],
      providers: [
        { provide: TokenUsageSelector, useValue: selector },
        provideTranslateTesting(),
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(UsagePanelComponent);
    fixture.detectChanges();
  }

  function rows(): { name: string; value: string }[] {
    return Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('.usage-row'),
    ).map((row) => ({
      name: (row.querySelector('.usage-name')?.textContent ?? '').trim(),
      value: (row.querySelector('.usage-value')?.textContent ?? '').trim(),
    }));
  }

  it('renders exactly three rows, keyed to in / cached / out', async () => {
    await setup();

    expect(rows().map((r) => r.name)).toEqual([
      'inspector.tokensIn',
      'inspector.cached',
      'inspector.tokensOut',
    ]);
  });

  it('binds each row to its own total rather than repeating one figure', async () => {
    await setup(
      totals({ totalSent: 24_900, totalCacheRead: 1200, totalReceived: 412 }),
    );

    expect(rows().map((r) => r.value)).toEqual(['24.9k', '1.2k', '412']);
  });

  it('renders an untouched team as zeros, because all-zero IS the empty state', async () => {
    // Not a "no data" branch: `teamTotals$` sums an empty map to zeros and is
    // never undefined, so a null guard would be a second way of saying nothing
    // has happened yet.
    await setup();

    expect(rows().map((r) => r.value)).toEqual(['0', '0', '0']);
  });

  it('does not surface cache WRITES, which the provider never reports', async () => {
    // A structurally-zero fourth row reads as a broken meter, not as an absence
    // in the data. If the write figure is ever real, it is a deliberate
    // addition rather than an oversight being corrected.
    await setup(totals({ totalCacheWrite: 9999 }));

    expect(rows().length).toBe(3);
    expect(
      (fixture.nativeElement as HTMLElement).textContent ?? '',
    ).not.toContain('9999');
  });

  it('repaints when the totals change, despite OnPush', async () => {
    await setup();

    totals$.next(totals({ totalSent: 1_500_000 }));
    fixture.detectChanges();

    expect(rows()[0].value).toBe('1.5M');
  });

  it('renders the section header through the translation layer', async () => {
    // No translations registered, so the no-op loader echoes the key back —
    // which is the assertion worth making: the header is a key, not a literal.
    await setup();

    expect(
      (fixture.nativeElement as HTMLElement)
        .querySelector('.usage-label')
        ?.textContent?.trim(),
    ).toBe('inspector.usage');
  });

  // =========================================================================
  // W6 — the per-model breakdown, rehoused.
  //
  // It used to be a popover on the team tree's footer, and the tree has been
  // removed from the hierarchy tab. These are the assertions that made the
  // removal safe rather than lossy: if they go red, "which model is this team's
  // spend going to" has become unanswerable in the UI again.
  // =========================================================================

  /**
   * Each `.usage-model-row` as `name | figure figure …`.
   *
   * The figures are joined explicitly rather than read off the cell's
   * `textContent`, because whether there is whitespace BETWEEN two adjacent
   * spans is a fact about how the template is line-wrapped, not about what the
   * card says — and a spec that asserted it would break on a reformat.
   */
  function modelRows(): string[] {
    return Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll(
        '.usage-model-row',
      ),
    ).map((row) => {
      const name = (
        row.querySelector('.usage-model-name')?.textContent ?? ''
      ).trim();
      const figures = Array.from(
        row.querySelectorAll('.usage-model-figure'),
      ).map((f) => (f.textContent ?? '').replace(/\s+/g, '').trim());
      return `${name} | ${figures.join(' ')}`;
    });
  }

  const GPT: ModelTokenTotals = {
    modelName: 'gpt-5.4-2026-03-05',
    totalSent: 12_000,
    totalReceived: 100,
    totalCacheRead: 10_000,
    totalCacheWrite: 0,
  };
  const LLAMA: ModelTokenTotals = {
    modelName: 'local-llama',
    totalSent: 1_000,
    totalReceived: 50,
    totalCacheRead: 0,
    totalCacheWrite: 0,
  };

  it('breaks the spend down by model, one row per model, in the order given', async () => {
    await setup(
      totals({ totalSent: 13_000, totalReceived: 150, totalCacheRead: 10_000 }),
      [GPT, LLAMA],
    );

    expect(modelRows()).toEqual([
      'gpt-5.4-2026-03-05 | ↑12.0k ⚡10.0k ↓100',
      // A model that read no cache shows no ⚡ figure at all: a permanent zero
      // reads as a broken meter, exactly as the cache-WRITE row would.
      'local-llama | ↑1.0k ↓50',
    ]);
  });

  /**
   * THE FIGURES ARE A COLUMN, and a column only lines up if every row puts a
   * cell in it.
   *
   * The breakdown is one grid spanning all the model rows, so the three figure
   * columns are as wide as their widest entry and the numbers line up down the
   * card — `in` under `in`, the way the three totals above are read. A model
   * that read no cache still shows no ⚡ figure, but it contributes a BLANK
   * cell in that column; drop the blank and its `↓` slides left into the cache
   * column and takes the column out of line for every row.
   */
  it('gives every model row the same cells, so the figures stay in column', async () => {
    await setup(
      totals({ totalSent: 13_000, totalReceived: 150, totalCacheRead: 10_000 }),
      [GPT, LLAMA],
    );

    const cellsPerRow = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll(
        '.usage-model-row',
      ),
    ).map(
      (row) =>
        row.querySelectorAll(
          '.usage-model-name, .usage-model-figure, .usage-model-blank',
        ).length,
    );

    expect(cellsPerRow).toEqual([4, 4]);

    // And the blank is on the row that earned it — the one with no cache read
    // — not on both, which would mean the ⚡ figure had stopped rendering.
    const rows = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll(
        '.usage-model-row',
      ),
    );
    expect(rows[0].querySelector('.usage-model-blank')).toBeNull();
    expect(rows[1].querySelector('.usage-model-blank')).not.toBeNull();
  });

  it('omits the whole block — rule included — for a team that has run no model', async () => {
    // `teamByModel$` drops agents with no `lastModelName`, so an untouched team
    // yields []. Drawing the separator over an empty list would announce a
    // section that is not there.
    await setup(totals({ totalSent: 400 }), []);

    expect(modelRows()).toEqual([]);
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('.usage-models'),
    ).toBeNull();
  });

  it('repaints the breakdown when teamByModel$ re-emits, despite OnPush', async () => {
    await setup(totals({ totalSent: 12_000 }), [GPT]);
    expect(modelRows().length).toBe(1);

    byModel$.next([GPT, LLAMA]);
    fixture.detectChanges();

    expect(modelRows().length).toBe(2);
  });

  it('leaves the three headline rows alone — the breakdown is an addition, not a replacement', async () => {
    await setup(
      totals({ totalSent: 12_000, totalCacheRead: 10_000, totalReceived: 100 }),
      [GPT],
    );

    // `.usage-row` and `.usage-model-row` are separate classes on purpose: the
    // totals are the headline and must not be diluted into the list below them.
    expect(rows().map((r) => r.name)).toEqual([
      'inspector.tokensIn',
      'inspector.cached',
      'inspector.tokensOut',
    ]);
  });

  it('keeps the model name on `title`, because the visible label truncates', async () => {
    // A 310px pane cannot show `gpt-5.4-2026-03-05` and three figures, so the
    // name ellipsises — and an elided identifier with no tooltip is unusable.
    await setup(totals(), [GPT]);

    expect(
      (fixture.nativeElement as HTMLElement)
        .querySelector('.usage-model-name')
        ?.getAttribute('title'),
    ).toBe('gpt-5.4-2026-03-05');
  });

  it('resolves the SHARED selector instance rather than re-providing its own', async () => {
    // Carried over from `tree.component.spec.ts`, which pinned this and has been
    // deleted with the tree. A self-provider here would read an empty second
    // store and the card would sit at zero while the transcript ran.
    await setup();

    expect(TestBed.inject(TokenUsageSelector)).toBe(
      selector as TokenUsageSelector,
    );
    const def = (
      UsagePanelComponent as unknown as { ɵcmp?: { providers?: unknown } }
    ).ɵcmp;
    expect(def?.providers ?? null).toBeNull();
  });
});
