// Minimal, boundary-only ESLint flat config (ESLint 9).
//
// SCOPE: this config enforces the one-way import DAG between the frontend's
// seven architectural tiers, in both directions it has — between tiers, and
// between a tier and the outside packages it may draw on. It deliberately does
// NOT adopt @angular-eslint, @typescript-eslint recommended, stylistic,
// formatting, or type-aware rules; those would flag a large body of
// pre-existing, untouched code and would turn a structural gate into a style
// gate.
//
// Mechanism: eslint-plugin-boundaries tags each file by its folder ("element
// type") and enforces allow/deny edges BETWEEN element types regardless of the
// relative-import depth. This is the robust encoding for this codebase, which
// uses relative imports with no tsconfig path aliases.
//
// THE ALLOW LIST IS BELOW, not here. It used to be transcribed into this header
// as well, and the copy went stale the moment the layers were reorganised: it
// named eleven element types that no longer exist and asserted two rules the
// live config contradicts. A linter never warns about a permission it grants,
// so a false RESTRICTION written in a comment is the one class of belief this
// gate structurally cannot correct — which is why the transcription is gone
// rather than updated.
//
// For the tiers and what each may import, read `README.md` "## Layout"; for
// what is enforced, read `boundaries/elements` and `boundaries/dependencies`
// below, which are the only authority.
//
// Verification is behavioural: `npm run lint` exits 0 on this tree and non-zero
// on a planted edge — a cross-tier import, or an outside package a tier is not
// granted. Both directions are checked by mutation rather than assumed, because
// a gate that has only ever been observed passing has not been observed working.
// There are NO string-presence assertions on ADR numbers, file paths, or folder
// names (CLAUDE.md Golden Rule #8).

const tseslint = require('typescript-eslint');
const boundaries = require('eslint-plugin-boundaries');

module.exports = tseslint.config(
  // Only application source is gated; spec files and everything outside src/ are
  // exempt (tests routinely reach across layers to construct fixtures).
  {
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.spec.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        // Boundaries works off the module graph only; no type-aware program needed.
        project: false,
      },
    },
    plugins: {
      boundaries,
    },
    settings: {
      // Resolve extension-less relative imports (e.g. '../selectors/chat.selector')
      // to their .ts files so the boundaries plugin can tag each dependency by
      // element type. Without .ts in the resolver extensions, every cross-layer
      // import resolves to "unknown" and the DAG rule silently never fires.
      'import/resolver': {
        node: { extensions: ['.ts', '.js', '.json'] },
      },
      // Order matters: the most specific process/* patterns MUST precede the
      // generic page pattern so a process leaf is not mis-tagged as a page.
      // Files matching no pattern (e.g. the app.*.ts composition root) are
      // "unknown" and intentionally unrestricted — app.routes.ts is the router
      // that legitimately wires every page together.
      'boundaries/elements': [
        // --- The lower tiers -------------------------------------------------
        //
        // `ui/` assembles pages, `core/components/` holds the library it
        // assembles them from, and everything under it supplies. The split is by
        // DIRECTORY rather than by naming convention so it cannot erode quietly,
        // and the types below are what stop it eroding loudly: a shared type
        // between two folders would make every edge between them legal in both
        // directions, because `boundaries` cannot express direction within a
        // type.
        //
        // Order matters — the most specific pattern must precede the generic
        // one, or a leaf is tagged as its own parent.
        // There is deliberately NO generic `src/app/core` entry. `core/` is a
        // namespace holding four separate tiers, not a tier; a pattern matching
        // the namespace would match every file under it, and since `boundaries`
        // takes the FIRST match it would collapse all of them into one element
        // type — where every edge inside `core/` is legal in both directions and
        // `npm run lint` still exits 0. Every tier names itself or does not exist.
        { type: 'protocol', pattern: 'src/app/core/protocol' },
        { type: 'shared', pattern: 'src/app/core/shared' },
        { type: 'platform', pattern: 'src/app/core/platform' },

        // --- The data layer --------------------------------------------------
        // The process feature's internal tiers keep their own types. That DAG
        // (models <- event <- selectors <- ui-state) predates this split, is
        // the one part of the tree with a real layering argument behind it, and
        // collapsing it into one `services` type would have thrown it away as a
        // side effect of a folder rename.
        { type: 'svc-models', pattern: 'src/app/core/services/process/models' },
        { type: 'svc-event', pattern: 'src/app/core/services/process/event' },
        { type: 'svc-selectors', pattern: 'src/app/core/services/process/selectors' },
        { type: 'svc-ui-state', pattern: 'src/app/core/services/process/ui-state' },
        { type: 'svc-workspace', pattern: 'src/app/core/services/process/workspace' },
        // The team's open/close ritual. Its own type because it is the one unit
        // in the data layer that composes the others — it drives the ingestion
        // pipeline — and folding it into the generic `services` type would
        // either deny it that edge or hand it to every other feature's services.
        { type: 'svc-session', pattern: 'src/app/core/services/process/session' },
        { type: 'services', pattern: 'src/app/core/services' },

        // --- The primitives tier ---------------------------------------------
        // Domain-free controls: an icon and a click, a string copied, a
        // percentage dragged. The tier's rule is that it may NOT import
        // `services` — type imports included, since `boundaries` cannot tell a
        // type import from an injection. That blindness is what makes the rule
        // enforceable HERE, where the answer is "no edge at all", and leaves it
        // a review rule for `features`, which may hold that edge legitimately.
        { type: 'primitives', pattern: 'src/app/core/components/primitives' },

        // --- The features tier -----------------------------------------------
        // The library the framework maintains: twenty-seven domain widgets in
        // ten capability folders. This pattern MUST precede `ui`, which is the
        // tier it may not reach — `boundaries` takes the FIRST match, so a
        // pattern ordered after one that also matches never fires.
        { type: 'features', pattern: 'src/app/core/components/features' },

        // --- The view tier ----------------------------------------------------
        { type: 'ui', pattern: 'src/app/ui' },
      ],
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          // Without this, the rule inspects LOCAL dependencies only and every
          // `import … from 'primeng/table'` is invisible to it — which is why
          // `default: 'disallow'` above coexisted with a tree full of legal
          // package imports. Turning it on brings external packages under the
          // same default-deny, and the external allow lists at the bottom of
          // this array are what that default then needs.
          checkAllOrigins: true,
          rules: [
            // protocol imports nothing app-internal.
            { from: { type: 'protocol' }, disallow: { to: { type: '*' } } },

            { from: { type: 'shared' }, allow: { to: { type: ['protocol'] } } },

            {
              from: { type: 'platform' },
              allow: { to: { type: ['protocol', 'shared'] } },
            },

            // --- the data layer's own DAG, unchanged by the move -------------
            { from: { type: 'svc-models' }, allow: { to: { type: ['protocol'] } } },
            {
              from: { type: 'svc-event' },
              allow: { to: { type: ['svc-models', 'platform', 'protocol'] } },
            },
            {
              // MUST NOT reach ui-state: a selector that read the selection
              // would make "what is derived" depend on "what is open".
              from: { type: 'svc-selectors' },
              allow: {
                to: {
                  type: ['svc-event', 'svc-models', 'platform', 'shared', 'protocol', 'services'],
                },
              },
            },
            {
              from: { type: 'svc-ui-state' },
              allow: {
                to: {
                  type: ['svc-selectors', 'svc-event', 'svc-models', 'platform', 'protocol', 'services'],
                },
              },
            },
            {
              // It composes the pipeline and reads the app's team context; it
              // must NOT reach a view, which is what keeps `open a team` a
              // mechanism rather than one console's behaviour.
              //
              // `svc-ui-state` is in this list and in no other tier's that is
              // below it. The data layer's order is models <- event <-
              // selectors <- ui-state, and `svc-session` composes ALL of them —
              // that is the whole reason it has an element type of its own
              // rather than folding into `services`. Reaching the tier directly
              // above the ones it already reaches is that rule applied, not a
              // new direction: the DAG is not inverted, because nothing in
              // `svc-ui-state` reaches back. The two real edges are
              // `SelectionService` and `FeedbackService`, both required by
              // `process.providers.ts`, which declares the composed stack.
              from: { type: 'svc-session' },
              allow: {
                to: {
                  type: [
                    'svc-event',
                    'svc-selectors',
                    'svc-ui-state',
                    'svc-models',
                    'platform',
                    'shared',
                    'protocol',
                    'services',
                  ],
                },
              },
            },
            {
              from: { type: 'svc-workspace' },
              allow: { to: { type: ['platform', 'protocol'] } },
            },
            {
              // The other features' services. They may read the process feature's
              // selectors and node type — the inspector's member selector does,
              // and that is the whole reason the inspector is mounted from inside
              // the process view rather than beside it.
              from: { type: 'services' },
              allow: {
                to: {
                  type: [
                    'platform',
                    'shared',
                    'protocol',
                    'svc-selectors',
                    'svc-models',
                    'services',
                  ],
                },
              },
            },

            // --- primitives: may reach platform, shared, protocol and each
            // other. NOT services, and not a view layer.
            {
              from: { type: 'primitives' },
              allow: { to: { type: ['primitives', 'platform', 'shared', 'protocol'] } },
            },

            // --- features: the library ---------------------------------------
            //
            // May reach primitives, the whole data tier, platform, shared,
            // protocol, and each other. It may NOT reach `ui`, which is the
            // edge that would turn the layer inside out and the one this tier
            // exists to forbid.
            //
            // The six `svc-*` sub-types are listed explicitly because they are
            // distinct element types from `services`, and features inject them
            // directly — `pending-request` alone takes `SelectionService` from
            // `svc-ui-state` and `GraphDataService` from `svc-selectors`.
            //
            // WHAT THIS RULE DOES AND DOES NOT CATCH, because the difference
            // matters. It forbids a feature from importing `ui/`. It does NOT
            // forbid importing `services`, and cannot: a component's `@Input`
            // is typed by the selector that produces it — `member-card` takes an
            // `InspectorMember` — and `boundaries` sees a type import and a
            // service injection as the same edge.
            //
            // The rule that actually keeps a feature a feature is the one used
            // to populate it. That is a review rule, not a lint rule, and
            // saying so here is better than implying the linter checks it.
            {
              from: { type: 'features' },
              allow: {
                to: {
                  type: [
                    'features',
                    'primitives',
                    'services',
                    'svc-models',
                    'svc-event',
                    'svc-selectors',
                    'svc-ui-state',
                    'svc-workspace',
                    'svc-session',
                    'platform',
                    'shared',
                    'protocol',
                  ],
                },
              },
            },

            // --- ui: the only tier allowed to assemble -----------------------
            // It may reach everything below it, including other assemblies —
            // the console shell mounts the inspector, the process view mounts
            // the header. Nothing may reach BACK into it, which is what makes a
            // second UI possible: `ui/` is the tier you replace.
            {
              from: { type: 'ui' },
              allow: {
                to: {
                  type: [
                    'ui',
                    'features',
                    'primitives',
                    'services',
                    'svc-models',
                    'svc-event',
                    'svc-selectors',
                    'svc-session',
                    'svc-ui-state',
                    'svc-workspace',
                    'platform',
                    'shared',
                    'protocol',
                  ],
                },
              },
            },
            // --- WHICH OUTSIDE PACKAGES EACH TIER MAY DRAW ON --------------
            //
            // Everything above gates edges between INTERNAL element types and
            // nothing else. An import of `ngx-markdown` is invisible to it.
            // That is not a hypothetical gap: `ngx-markdown` was removed from
            // `shared/` earlier in this epic, and re-adding it afterwards was
            // checked and left the lint GREEN. Every "this tier imports no UI
            // framework" claim in `README.md` was, until these rules, an
            // assertion about the tree on the day someone last read it.
            //
            // THE DEFAULT IS `disallow` AND THE TRADE-OFF IS DELIBERATE. The
            // cheap alternative — default `allow` plus a `disallow` list on the
            // pure tiers — reads better and costs nothing to maintain, but it
            // only ever forbids packages somebody thought to name. A UI package
            // nobody anticipated lands in `shared/` silently, which is the
            // exact hole these rules exist to close, reintroduced one level up.
            // Denying by default costs a config edit per new dependency in the
            // lower tiers; that edit IS the point, because it is where a
            // reviewer gets to ask whether the tier should have grown a
            // dependency at all.
            //
            // THEY MATCH ON `source`, THE WHOLE SPECIFIER, NOT ON THE PACKAGE
            // NAME. That distinction is load-bearing twice below — see
            // `primeng/button` and `@angular/cdk/clipboard` — because matching
            // by package would have to admit the entire component library in
            // both places to admit the one entry point each tier actually uses.
            //
            // The lists are EXHAUSTIVE and MEASURED, not aspirational: each is
            // every non-relative specifier that tier's non-spec files import
            // today.
            //
            // `protocol` appears in no rule at all: it imports nothing external,
            // and under `default: 'disallow'` the absence of a rule IS the
            // strongest statement available.

            // Wire types and Angular's DI decorator. Nothing else — in
            // particular no rendering library, which is what makes `shared`
            // safe for every tier above it to depend on.
            {
              from: { type: 'shared' },
              to: { origin: 'external' },
              allow: {
                dependency: [
                  { source: '@angular/core' },
                  { source: 'lodash' },
                  { source: 'js-yaml' },
                ],
              },
            },

            // Routing, HTTP, translation, reactivity: the framework services
            // the app is built on. No component library.
            {
              from: { type: 'platform' },
              to: { origin: 'external' },
              allow: {
                dependency: [
                  { source: '@angular/core' },
                  { source: '@angular/core/rxjs-interop' },
                  { source: '@angular/common' },
                  { source: '@angular/common/http' },
                  { source: '@angular/router' },
                  { source: '@angular/platform-browser' },
                  { source: '@ngx-translate/core' },
                  { source: 'rxjs' },
                  { source: 'rxjs/operators' },
                ],
              },
            },

            // THE DATA LAYER'S EXTERNAL SURFACE, and the claim these rules are
            // really here to hold: zero UI-component imports across every
            // `svc-*` tier and the generic `services` type. That is currently
            // true, and until now was true only by inspection.
            //
            // Two entries need saying out loud, because both look like
            // exceptions and neither is:
            //
            // `@angular/cdk/clipboard` is a UI toolkit's entry point that ships
            // no component — it is a clipboard call. Allowed as measured, and
            // allowed AS THAT ENTRY POINT: `@angular/cdk/dialog` would still be
            // refused here. Whether the data tier should name `@angular/cdk` at
            // all is a separate decision, not one made silently here.
            //
            // `@angular/common` is `AsyncPipe`, which `process.providers.ts`
            // lists among the route's providers.
            {
              from: {
                type: [
                  'svc-models',
                  'svc-event',
                  'svc-selectors',
                  'svc-ui-state',
                  'svc-workspace',
                  'svc-session',
                  'services',
                ],
              },
              to: { origin: 'external' },
              allow: {
                dependency: [
                  { source: '@angular/core' },
                  { source: '@angular/common' },
                  { source: '@angular/cdk/clipboard' },
                  { source: '@ngx-translate/core' },
                  { source: 'rxjs' },
                  { source: 'rxjs/operators' },
                  { source: 'rxjs/webSocket' },
                  { source: 'js-yaml' },
                ],
              },
            },

            // Domain-free, NOT framework-free: the tier's rule is that it names
            // no domain concept, not that it declines to draw its own controls.
            // `primeng/button` is imported here today and must stay legal —
            // and only it, which is why this matches the specifier rather than
            // the package.
            {
              from: { type: 'primitives' },
              to: { origin: 'external' },
              allow: {
                dependency: [
                  { source: '@angular/core' },
                  { source: '@ngx-translate/core' },
                  { source: 'primeng/button' },
                ],
              },
            },

            // The library and the pages: whatever they need. These two are
            // SUPPOSED to draw on the outside world — 42 distinct packages
            // between PrimeNG, echarts, Monaco, markdown and the rest — and an
            // allow list here would be maintenance with no invariant behind it.
            {
              from: { type: ['features', 'ui'] },
              to: { origin: 'external' },
              allow: { dependency: [{ source: '**' }] },
            },
          ],
        },
      ],
    },
  },
);
