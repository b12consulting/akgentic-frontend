import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

/**
 * How many categorical stops `_conversation-tokens.scss` declares.
 *
 * Stated here as well as there because the ramp is read by NAME
 * (`--akg-graph-category-<n>`) and there is no way to enumerate a custom
 * property series from CSS. `category.service.spec.ts` asserts the two agree,
 * so adding an eleventh token without moving this number fails rather than
 * being quietly ignored.
 */
export const GRAPH_CATEGORY_COUNT = 10;

/**
 * The resolved value of a custom property on `:root`, or `''` if it is not
 * declared.
 *
 * THE CANVAS CANNOT READ CSS. This exists because echarts draws the hierarchy
 * tab with the canvas renderer, and a canvas has no cascade: handing it
 * `"var(--akg-graph-category-1)"` does not produce a green node, it produces an
 * unparseable fill. Everything the chart paints therefore has to be resolved to
 * a literal in JavaScript first. (The one exception is echarts' TOOLTIP, which
 * is real DOM — `team-graph.component.ts` uses `var()` directly there.)
 */
export function readToken(name: string): string {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
}

/**
 * The categorical ramp, resolved.
 *
 * Empty stops are DROPPED rather than passed through. An undeclared token
 * resolves to `''`, and `''` handed to echarts as a fill is not "no colour" —
 * it is a parse failure. Dropping leaves a shorter ramp that still works;
 * consumers index it modulo its length.
 */
export function graphCategoryColors(): string[] {
  return Array.from({ length: GRAPH_CATEGORY_COUNT }, (_, i) =>
    readToken(`--akg-graph-category-${i + 1}`),
  ).filter((value) => value !== '');
}

@Injectable({
  providedIn: 'root',
})
export class CategoryService {
  private selectedSquadSource = new BehaviorSubject<boolean[] | null>(null);
  selectedSquad$ = this.selectedSquadSource.asObservable();

  nodes: any[] = [];
  squadDict: { [key: string]: number } = {};

  private paletteCache: string[] | null = null;

  /**
   * One colour per squad, in discovery order.
   *
   * A GETTER OVER TOKENS, where this used to be ten literal hexes. The literals
   * were an echarts sample palette — cool blue-grey against a warm neutral
   * console — and, being in a `.ts` file, they were the one part of the graph's
   * appearance that no deployment could re-point. The values now live in
   * `_conversation-tokens.scss` with the rest of the palette.
   *
   * MEMOISED, because this is read per node per render by
   * `message-list.component.ts` and `getComputedStyle` is a layout-flushing
   * call. Call `reloadPalette()` after re-declaring the tokens at runtime —
   * nothing in the product does that today, and a theme switcher would.
   */
  get COLORS(): string[] {
    return (this.paletteCache ??= graphCategoryColors());
  }

  /** Drop the memoised ramp so the next read re-resolves it from the DOM. */
  reloadPalette(): void {
    this.paletteCache = null;
  }

  setSelectedCategory(selectedCategories: boolean[]): void {
    this.selectedSquadSource.next(selectedCategories);
  }
  getSelectedCategory() {
    return this.selectedSquadSource.value;
  }
}
