/**
 * One entry in the inspector's tab strip.
 *
 * IT LIVES HERE, beside the tab SET it describes, rather than in
 * `ProcessComponent` (which builds the list) or in `InspectorComponent`
 * (which passes it through). Both of those would make the import graph a
 * cycle — `ProcessComponent` imports the inspector, the inspector imports the
 * tabs — and a cycle between files that carry Angular decorators is the kind of
 * thing that works until a bundler changes evaluation order.
 *
 * It used to live in `inspector-tabs.component.ts`, the leaf that renders it,
 * on the same no-outgoing-edges argument. This module satisfies that argument
 * more strictly: it is pure data with no decorator and no template, and it has
 * no outgoing edge into `components/` at all. The old arrangement had this
 * registry importing a type out of the component that renders it — the logic
 * tier depending on the view tier, legal only because both sat inside one
 * `boundaries` element and the edge was therefore invisible.
 *
 * `inspector-tabs.component.ts` re-exports it, so nothing that imported it from
 * there had to change.
 */
export interface VisualizationOption {
  /**
   * A translation KEY, not a caption.
   *
   * This component's template resolves it. Held as copy it would be an English
   * string travelling through an `[options]` binding from a component that
   * knows nothing about a translation layer — and `value` below is the identity
   * every rule keys off, so the caption never has to be matched on.
   */
  labelKey: string;
  value: string;

  /**
   * The tab's visible content wherever it is NOT the selected one — which is
   * five of the six at any moment.
   *
   * It stopped being an ornament beside a caption when the strip stopped
   * drawing six of them (see `inspector-tabs.component.scss` for why six
   * labelled tabs cannot fit the pane). So the host's obligation changed with
   * it: two entries sharing a glyph are two tabs a sighted user cannot tell
   * apart until they select one, where before the caption disambiguated them
   * at rest. Pick glyphs that differ in OUTLINE, not in count — `pi-user`
   * against `pi-users` is one head against two and reads as the same mark at
   * 13px.
   */
  icon: string;
}


/**
 * THE INSPECTOR'S TAB SET, AS DATA.
 *
 * Before this file the set was a literal array on `ProcessComponent`, and three
 * facts about a tab were stated in three different places: its caption and
 * glyph in that array, whether a tool has to be present for it in a `filter`
 * beside it, and whether it needs a wide pane nowhere at all. Three places is
 * how a deployment ends up with a tab that has no panel, or a panel with no
 * tab, and nothing fails.
 *
 * ADDING A TAB — everything its author must touch, and there are two things:
 *
 *   1. AN ENTRY IN `INSPECTOR_TABS` BELOW. Caption key, value, glyph, and
 *      optionally `requires` (a capability that must be present) and
 *      `needsRoom` (the panel is unusable in a narrow pane). Nothing else in
 *      this folder needs to know: the strip renders whatever it is handed, the
 *      narrow-pane state reads `needsRoom` off the value it is already given,
 *      and the deployment filter works on `value`.
 *
 *   2. THE PANEL ITSELF, in `process.component.html`, as one more child of
 *      `.inspector-panels` carrying the same five attributes the others do:
 *      `id="inspector-panel-<value>"`, `role="tabpanel"`,
 *      `aria-labelledby="inspector-tab-<value>"`,
 *      `[attr.inert]="isHidden('<value>') ? '' : null"` and
 *      `[class.moved-offscreen]="isHidden('<value>')"`.
 *
 * The second one cannot be collapsed into the first from here, and it is worth
 * saying WHY rather than leaving the next reader to re-discover it: the panels
 * live in `ui/` and this registry is in `services/`, which the boundary rules
 * give no edge to `ui`. So a registry that also owned the components could not
 * import them, and the panels are PROJECTED from the host's template instead.
 * `isHidden()` is already generic over the value, so there is no per-tab case
 * to add there.
 *
 * (Not an injector constraint. An earlier version of this note blamed
 * the `process/:id` route's providers; the team's services moved to the `process/:id`
 * route and resolve anywhere under it.)
 *
 * What is NOT a touch point any more: the capability filter (declare
 * `requires`), the tab ORDER (it is this array's order), and the narrow-pane
 * list (declare `needsRoom`).
 */

/**
 * A capability a tab can depend on — a tool the running team either has or has
 * not. Named rather than a free predicate so the registry stays serialisable
 * data: a function here could read anything, and "what makes this tab appear"
 * would stop being answerable by reading this file.
 */
export type InspectorCapability = 'knowledgeGraph' | 'workspace';

/** What the host knows about the open team, as the registry needs it. */
export interface InspectorCapabilities {
  knowledgeGraph: boolean;
  workspace: boolean;
}

export interface InspectorTabDefinition extends VisualizationOption {
  /**
   * The tab exists only while this capability is present. Absent means
   * unconditional — `team`, `member` and `messages` are always meaningful, even
   * when there is nothing yet to show in them.
   */
  requires?: InspectorCapability;

  /**
   * This panel is UNUSABLE below `INSPECTOR_NARROW_MAX_PX`, not merely cramped.
   *
   * The distinction is the whole of W17: a roster, a member card and a message
   * log are lists, and a list reads fine at 240px — it just wraps. A
   * force-directed graph, a knowledge graph and a file tree are
   * two-dimensional; at that width they draw a picture with no legible labels,
   * which is worse than not drawing it, because the user cannot tell whether
   * they are looking at their team or at a rendering bug.
   */
  needsRoom?: boolean;
}

/**
 * The narrow band, in CSS pixels of the PANE (not of the window).
 *
 * DERIVED FROM THE FLOOR, NOT FROM THE REFERENCE WINDOW — and that is the whole
 * correction. The first version of this number reasoned from the 1440px window
 * the design was drawn against: 26% of (1440 - 268) is ~305px, so 280 looked
 * like a comfortable midpoint of 240..305 that only a deliberate drag could
 * reach. But the default is a PERCENTAGE, so it shrinks with the window, and
 * 1440 is the widest of the common laptops rather than a typical one:
 *
 *   1440px viewport → 1172px row → 26% = 305px
 *   1366px viewport → 1098px row → 26% = 285px
 *   1280px viewport → 1012px row → 26% = 263px   ← below 280
 *
 * At 1280 — an ordinary laptop — every panel that needs room replaced itself
 * with "widen this pane" at a layout the user had never touched. A message
 * whose entire premise is "you chose a width that does not fit this" must never
 * fire on a width nobody chose.
 *
 * So the band is anchored to the other end instead: `INSPECTOR_MIN_WIDTH_PX`
 * (240) is the floor the divider clamps to, and the band is the last 16px above
 * it. That says something defensible on its own terms — "you have dragged this
 * pane essentially all the way in" — and it holds at every viewport, because
 * the floor is a pixel value rather than a share of one.
 *
 * The invariant is asserted from the arithmetic, at each viewport, in
 * `inspector-tabs.registry.spec.ts`, so the next person to move this number is
 * told which screens they broke rather than trusting the sums above.
 */
export const INSPECTOR_NARROW_MAX_PX = 256;

/**
 * The tabs, in strip order.
 *
 * A NOTE ON TAB COUNT, carried forward from `ProcessComponent` because it is
 * still true and still load-bearing: the strip is icon-only plus the selected
 * tab's caption, and that is what makes six fit in one row at any width the
 * divider can reach. Six captions need twice the pane in English and more in
 * French. A SEVENTH entry is a decision to take against the arithmetic in
 * `inspector-tabs.component.scss`, not a free one.
 */
export const INSPECTOR_TABS: readonly InspectorTabDefinition[] = [
  { labelKey: 'visualization.team', value: 'team', icon: 'pi pi-users' },
  // Epic 56 / H2. The redesign gave `team` a new panel — roster, tools, spend —
  // and that panel deliberately does NOT carry the team tree or the echarts
  // graph. Those two are a real capability, so they get a tab of their own
  // rather than being folded in behind Member: `member` is "one agent, in
  // detail", and hiding a team-wide tree under it would make the strip lie
  // about what each entry shows.
  {
    labelKey: 'visualization.hierarchy',
    value: 'hierarchy',
    icon: 'pi pi-share-alt',
    needsRoom: true,
  },
  // `pi-id-card`, NOT `pi-user`. Beside `pi-users` on the Team tab the two were
  // one head against two at 13px — a difference a reader has to hunt for, on a
  // strip where the glyph is the primary way five of the six tabs are told
  // apart. A card silhouette differs in OUTLINE rather than in count, which is
  // what survives at this size.
  { labelKey: 'visualization.member', value: 'member', icon: 'pi pi-id-card' },
  {
    labelKey: 'visualization.knowledgeGraph',
    value: 'knowledge-graph',
    icon: 'pi pi-sitemap',
    requires: 'knowledgeGraph',
    needsRoom: true,
  },
  {
    labelKey: 'visualization.workspaces',
    value: 'workspace',
    icon: 'pi pi-folder-open',
    requires: 'workspace',
    needsRoom: true,
  },
  {
    labelKey: 'visualization.messages',
    value: 'messages',
    icon: 'pi pi-envelope',
  },
];

/**
 * The tabs this deployment, for this team, should offer.
 *
 * TWO FILTERS, AND THEY ARE NOT THE SAME KIND OF THING. `capabilities` is about
 * the team in front of the user and changes while they watch — a knowledge
 * graph tool starts, the tab appears. `hiddenTabIds` is a deployment's
 * `config.json` and is fixed for the life of the page. They compose here rather
 * than in two places so there is one answer to "why is that tab not there".
 *
 * AN UNKNOWN ID IS IGNORED, not an error: `hiddenTabIds` is hand-written JSON
 * in a file this code has never seen, it can name a tab that was renamed or
 * never existed, and the correct response to "hide something that is not there"
 * is that it is already not there. Throwing would take down the console over a
 * typo in a config file.
 *
 * AND HIDING IS A FILTER, NOT A WAY TO DELETE THE INSPECTOR. A list that would
 * empty the strip is ignored WHOLESALE and the capability-filtered set is
 * returned instead. Without that rule, `"hiddenInspectorTabs": ["team",
 * "hierarchy", "member", "messages"]` produces a pane with no tabs and no
 * panel — a blank rectangle the user cannot act on and cannot get out of,
 * because every control that would restore a tab is one of the tabs. A
 * deployment that genuinely wants no inspector has `initRightPanelCollapsed`.
 */
export function visibleInspectorTabs(
  capabilities: InspectorCapabilities,
  hiddenTabIds: readonly string[] = [],
): VisualizationOption[] {
  const available = INSPECTOR_TABS.filter(
    (tab) => tab.requires === undefined || capabilities[tab.requires],
  );
  const hidden = new Set(hiddenTabIds);
  const kept = available.filter((tab) => !hidden.has(tab.value));
  return kept.length > 0 ? kept : available;
}

/**
 * Which tab should actually be showing, given the one that was asked for.
 *
 * The requested tab wins whenever it is still on the strip; otherwise the first
 * visible one does. This is the answer to "the deployment hid the tab the user
 * is on" AND to "the tool behind the active tab just stopped" — one rule, so
 * the two cannot drift, where before there were two hand-written guards that
 * both happened to snap back to `team` and would both have been wrong on a
 * deployment that hid `team`.
 *
 * `''` for an empty strip is unreachable through `visibleInspectorTabs` (see
 * its last paragraph) and is here so the signature has no undefined case for a
 * caller that builds its own list.
 */
export function resolveInspectorTab(
  requested: string,
  visible: readonly VisualizationOption[],
): string {
  if (visible.some((option) => option.value === requested)) {
    return requested;
  }
  return visible[0]?.value ?? '';
}

/**
 * Does the panel behind this tab need a wide pane? See `needsRoom`.
 *
 * By VALUE rather than by definition object, because the only thing the
 * inspector shell has is the `mode` string its host binds. An unknown value is
 * `false`: a tab nobody declared gets the permissive answer, since replacing a
 * panel we know nothing about with "widen the pane" would be a guess at the
 * user's expense.
 */
export function inspectorTabNeedsRoom(value: string): boolean {
  return INSPECTOR_TABS.some((tab) => tab.value === value && tab.needsRoom === true);
}
