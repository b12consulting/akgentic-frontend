import {
  INSPECTOR_NARROW_MAX_PX,
  INSPECTOR_TABS,
  inspectorTabNeedsRoom,
  resolveInspectorTab,
  visibleInspectorTabs,
} from './inspector-tabs.registry';
import {
  INSPECTOR_DEFAULT_PERCENT,
  INSPECTOR_MIN_WIDTH_PX,
  RAIL_DEFAULT_WIDTH_PX,
} from '../../../ui/console/pane-layout';

/**
 * The registry is the answer to "why is that tab there / not there", so what it
 * is worth asserting is the RULES, not the current contents: a spec that listed
 * six values would fail the day somebody adds a seventh tab, which is the one
 * thing this file exists to make easy.
 *
 * The two exceptions are pinned deliberately below — the identity of the three
 * panels that need room, and the fact that `team` is first — because each of
 * those is a promise something else depends on.
 */
describe('inspector tab registry', () => {
  /** Everything present, i.e. a team that started both optional tools. */
  const all = { knowledgeGraph: true, workspace: true };
  /** Neither optional tool: the shape most teams actually run in. */
  const none = { knowledgeGraph: false, workspace: false };

  const values = (
    tabs: readonly { value: string }[],
  ): string[] => tabs.map((tab) => tab.value);

  describe('capability filtering — the team in front of the user', () => {
    it('offers a tab with no requirement whatever the team has', () => {
      const bare = values(visibleInspectorTabs(none));

      expect(bare).toContain('team');
      expect(bare).toContain('member');
      expect(bare).toContain('messages');
    });

    it('withholds the knowledge graph and workspaces until their tool is there', () => {
      expect(values(visibleInspectorTabs(none))).not.toContain('knowledge-graph');
      expect(values(visibleInspectorTabs(none))).not.toContain('workspace');

      expect(values(visibleInspectorTabs(all))).toContain('knowledge-graph');
      expect(values(visibleInspectorTabs(all))).toContain('workspace');
    });

    it('gates each capability on its own, not on both', () => {
      const kgOnly = values(
        visibleInspectorTabs({ knowledgeGraph: true, workspace: false }),
      );

      expect(kgOnly).toContain('knowledge-graph');
      expect(kgOnly).not.toContain('workspace');
    });

    /**
     * Order is the strip's order, and it is the registry's array order — not
     * something the filter is free to rearrange. Two tabs that swap places
     * between one emission and the next move under the user's pointer.
     */
    it('keeps the declared order when entries drop out', () => {
      expect(values(visibleInspectorTabs(all))).toEqual(values(INSPECTOR_TABS));
      expect(values(visibleInspectorTabs(none))).toEqual(
        values(INSPECTOR_TABS.filter((tab) => tab.requires === undefined)),
      );
    });
  });

  describe('deployment filtering — config.json', () => {
    it('drops the tabs a deployment named', () => {
      const kept = values(visibleInspectorTabs(all, ['messages', 'member']));

      expect(kept).not.toContain('messages');
      expect(kept).not.toContain('member');
      expect(kept).toContain('team');
    });

    /**
     * A hand-written JSON file can name a tab that was renamed or never
     * existed. The console must not fall over for a typo in a config file —
     * "hide something that is not there" is a request that is already granted.
     */
    it('ignores an id nobody recognises rather than throwing', () => {
      expect(() => visibleInspectorTabs(all, ['does-not-exist'])).not.toThrow();
      expect(values(visibleInspectorTabs(all, ['does-not-exist']))).toEqual(
        values(visibleInspectorTabs(all)),
      );
    });

    it('does not resurrect a tab whose tool is absent just because it is not hidden', () => {
      // The two filters COMPOSE. A deployment hiding `messages` on a team with
      // no workspace tool must not be handed a Workspaces tab with no panel.
      const kept = values(visibleInspectorTabs(none, ['messages']));

      expect(kept).not.toContain('workspace');
      expect(kept).not.toContain('messages');
    });

    /**
     * HIDING IS A FILTER, NOT A WAY TO DELETE THE INSPECTOR. A list that names
     * every tab leaves a pane with no strip and no panel — a blank rectangle
     * whose only escape routes are the tabs that were just hidden. The list is
     * ignored wholesale rather than obeyed into that state.
     */
    it('ignores a list that would empty the strip', () => {
      const everything = values(INSPECTOR_TABS);

      expect(values(visibleInspectorTabs(all, everything))).toEqual(everything);
    });

    it('applies that rule against what is VISIBLE, not against the whole registry', () => {
      // `none` leaves team / hierarchy / member / messages; hiding exactly
      // those is a full hide of what is visible, so the same rule applies.
      const visibleNow = values(visibleInspectorTabs(none));

      expect(values(visibleInspectorTabs(none, visibleNow))).toEqual(visibleNow);
    });
  });

  describe('resolveInspectorTab — the active tab cannot be a blank pane', () => {
    it('leaves a tab that is still on the strip alone', () => {
      const visible = visibleInspectorTabs(all);

      expect(resolveInspectorTab('messages', visible)).toBe('messages');
    });

    it('falls back to a VISIBLE tab when the active one is hidden', () => {
      // The deployment hid `team`, and the user is on it. Falling back to a
      // hard-coded 'team' — which is what the two hand-written guards this
      // replaced both did — would leave them on the tab that was just removed.
      const visible = visibleInspectorTabs(all, ['team']);

      const resolved = resolveInspectorTab('team', visible);

      expect(values(visible)).not.toContain('team');
      expect(values(visible)).toContain(resolved);
    });

    it('falls back when the tool behind the active tab stops', () => {
      const resolved = resolveInspectorTab(
        'knowledge-graph',
        visibleInspectorTabs(none),
      );

      expect(values(visibleInspectorTabs(none))).toContain(resolved);
    });

    it('picks the first of what is left, so the fallback is predictable', () => {
      const visible = visibleInspectorTabs(all, ['team']);

      expect(resolveInspectorTab('team', visible)).toBe(visible[0].value);
    });

    it('has an answer for a strip a caller built empty', () => {
      expect(resolveInspectorTab('team', [])).toBe('');
    });
  });

  describe('needsRoom — which panels W17 replaces in a narrow pane', () => {
    /**
     * Pinned by name, unlike the rest of this file. These three draw in two
     * dimensions and the other three are lists; getting the set wrong is either
     * a panel nobody can read or a message nobody needed, and neither shows up
     * as a failure anywhere else.
     */
    it('names the two-dimensional panels', () => {
      expect(inspectorTabNeedsRoom('hierarchy')).toBeTrue();
      expect(inspectorTabNeedsRoom('knowledge-graph')).toBeTrue();
      expect(inspectorTabNeedsRoom('workspace')).toBeTrue();
    });

    it('leaves the panels that read fine narrow alone', () => {
      expect(inspectorTabNeedsRoom('team')).toBeFalse();
      expect(inspectorTabNeedsRoom('member')).toBeFalse();
      expect(inspectorTabNeedsRoom('messages')).toBeFalse();
    });

    it('gives an undeclared tab the permissive answer', () => {
      expect(inspectorTabNeedsRoom('a-tab-from-the-future')).toBeFalse();
    });
  });

  /**
   * THE BAND MUST BE REACHABLE ONLY BY DRAGGING, and this is asserted against
   * the arithmetic rather than against one remembered number.
   *
   * The first version of this spec compared the threshold with "~310", the
   * width the default 26% resolves to on the 1440px window the design was drawn
   * against. That is the widest of the common laptops, so it is the most
   * forgiving possible case to check, and checking only it let a threshold ship
   * that fires at the DEFAULT layout on a 1280px screen — where 26% of
   * (1280 - 268) is 263px. Three panels replaced themselves with "widen this
   * pane" out of the box, at a layout the user never chose.
   *
   * So the rule is restated as what it actually has to be true of: the width an
   * untouched pane resolves to at each viewport anybody runs this on.
   */
  /** What a user who has never touched a divider is looking at, at `viewport`.
   *  `min-width` beats `flex-basis`, so the pixel floor wins when the
   *  percentage falls below it — see `pane-layout.ts`. */
  function untouchedPaneWidth(viewport: number): number {
    const row = viewport - RAIL_DEFAULT_WIDTH_PX;
    return Math.max(
      INSPECTOR_MIN_WIDTH_PX,
      (row * INSPECTOR_DEFAULT_PERCENT) / 100,
    );
  }

  it('leaves the band below the width an untouched pane opens at', () => {
    // 1280 is an ordinary laptop, not an edge case, and is the one that broke.
    for (const viewport of [1280, 1366, 1440, 1536, 1920]) {
      expect(untouchedPaneWidth(viewport))
        .withContext(`the default pane at ${viewport}px must not be "narrow"`)
        .toBeGreaterThan(INSPECTOR_NARROW_MAX_PX);
    }
  });

  it('keeps the band above the floor the divider clamps to, or it is empty', () => {
    // Below the floor there is no pane to be narrow: the drag cannot get there.
    expect(INSPECTOR_NARROW_MAX_PX).toBeGreaterThan(INSPECTOR_MIN_WIDTH_PX);
  });
});
