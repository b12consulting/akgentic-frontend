import { CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';

import { NO_TEAM_FILTER, TeamFilter } from '../../../core/context/team.interface';
import {
  MetadataFieldDescriptor,
  NamespaceSummary,
  TeamMetadataContract,
} from '../../../protocol/catalog.interface';
import { TeamFilterComponent } from './team-filter.component';

function field(
  key: string,
  overrides: Partial<MetadataFieldDescriptor> = {},
): MetadataFieldDescriptor {
  return { key, description: '', index: false, mandatory: false, ...overrides };
}

function contract(fields: MetadataFieldDescriptor[]): TeamMetadataContract {
  return { type: 'acme.contracts.CaseMetadata', fields };
}

function ns(
  namespace: string,
  team_metadata: TeamMetadataContract | null = null,
): NamespaceSummary {
  return {
    namespace,
    name: namespace,
    description: 'd',
    team: true,
    shareable: false,
    public: false,
    owner: null,
    counts: {},
    team_metadata,
  };
}

describe('TeamFilterComponent', () => {
  let fixture: ComponentFixture<TeamFilterComponent>;
  let component: TeamFilterComponent;
  let emitted: TeamFilter[];

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TeamFilterComponent, FormsModule, NoopAnimationsModule],
      schemas: [CUSTOM_ELEMENTS_SCHEMA],
    }).compileComponents();

    fixture = TestBed.createComponent(TeamFilterComponent);
    component = fixture.componentInstance;
    emitted = [];
    component.changed.subscribe((f) => emitted.push(f));
    component.visible = true;
  });

  /** Bind a namespace the way the host does, and render. */
  function selectNamespace(namespace: NamespaceSummary | null): void {
    const previousValue = component.namespace;
    component.namespace = namespace;
    component.ngOnChanges({
      namespace: {
        previousValue,
        currentValue: namespace,
        firstChange: previousValue === null,
        isFirstChange: () => previousValue === null,
      },
    });
    fixture.detectChanges();
  }

  /** Bind a filter to adopt, the way the host does on restore. */
  function adopt(value: TeamFilter, namespace: NamespaceSummary | null): void {
    component.value = value;
    component.namespace = namespace;
    component.ngOnChanges({
      value: {
        previousValue: NO_TEAM_FILTER,
        currentValue: value,
        firstChange: false,
        isFirstChange: () => false,
      },
      namespace: {
        previousValue: null,
        currentValue: namespace,
        firstChange: true,
        isFirstChange: () => true,
      },
    });
    fixture.detectChanges();
  }

  function inputs(): HTMLInputElement[] {
    return Array.from(
      fixture.nativeElement.querySelectorAll('[data-test^="filter-meta-"]'),
    );
  }

  function labels(): HTMLLabelElement[] {
    return Array.from(
      fixture.nativeElement.querySelectorAll('.team-filter__field label'),
    );
  }

  // --- Which fields are offered ------------------------------------------

  it('renders one input per INDEXED field, in declaration order', () => {
    selectNamespace(
      ns(
        'acme',
        contract([
          field('case_id', { index: true }),
          field('tenant', { index: true }),
        ]),
      ),
    );

    expect(inputs().map((i) => i.getAttribute('data-test'))).toEqual([
      'filter-meta-case_id',
      'filter-meta-tenant',
    ]);
  });

  it('gates on `index` ALONE — a mandatory unindexed field gets no input', () => {
    // The two flags are independent. Reusing the creation form's `mandatory`
    // rule would offer a set that is neither a subset nor a superset of the
    // right one, and would look plausible wherever fields happen to be both.
    selectNamespace(
      ns(
        'acme',
        contract([
          field('required_but_unindexed', { mandatory: true }),
          field('case_id', { index: true }),
        ]),
      ),
    );

    expect(inputs().map((i) => i.getAttribute('data-test'))).toEqual([
      'filter-meta-case_id',
    ]);
  });

  it('offers nothing for each of the THREE no-ask states', () => {
    // Absent key, explicit null, and a declared contract with no fields. The
    // first two mean the same thing; the third is distinct and collapses here.
    for (const summary of [
      ns('acme'),
      ns('acme', null),
      ns('acme', contract([])),
      ns('acme', contract([field('plain')])),
    ]) {
      selectNamespace(null);
      selectNamespace(summary);
      expect(inputs().length).toBe(0);
      expect(fixture.nativeElement.querySelector('.team-filter__field')).toBeNull();
    }
  });

  // --- How they are labelled ---------------------------------------------

  it('labels an input by its humanised KEY, with the description in a title', () => {
    // The key, humanised the same way the table's metadata chips humanise it,
    // so a chip and the input that filters on it read the same word. The
    // declared description is a sentence meant for the creation form.
    selectNamespace(
      ns(
        'acme',
        contract([
          field('case_id', { index: true, description: 'Case reference.' }),
          field('tenant', { index: true }),
        ]),
      ),
    );

    expect(labels().map((l) => l.textContent?.trim())).toEqual([
      'Case id',
      'Tenant',
    ]);
    expect(labels()[0].getAttribute('title')).toBe('Case reference.');
    expect(labels()[1].getAttribute('title')).toBeNull();
  });

  it('names the floor in every placeholder', () => {
    selectNamespace(ns('acme', contract([field('case_id', { index: true })])));

    expect(inputs()[0].getAttribute('placeholder')).toBe(
      `${component.minTermLength}+ characters to filter`,
    );
  });

  it('renders a plain text input even when the field declares a pattern', () => {
    // No date picker, no select, no client-side pattern check: the term travels
    // verbatim and the store owns matching.
    selectNamespace(
      ns('acme', contract([field('case_id', { index: true, pattern: '^C-\\d+$' })])),
    );

    expect(inputs()[0].getAttribute('type')).toBe('text');
    expect(inputs()[0].hasAttribute('pattern')).toBeFalse();
  });

  // --- What it composes ---------------------------------------------------

  it('emits a term only once it reaches the floor', () => {
    // The floor lives here, so a term too short to narrow anything never
    // reaches the filter — and every consumer downstream agrees by
    // construction rather than each applying the rule.
    selectNamespace(ns('acme', contract([field('case_id', { index: true })])));

    component.onTermChanged('case_id', 'C');
    expect(emitted.pop()).toEqual({ meta: {}, catalogNamespace: null });

    component.onTermChanged('case_id', 'C-1');
    expect(emitted.pop()).toEqual({
      meta: { case_id: 'C-1' },
      catalogNamespace: null,
    });
  });

  it('keeps showing a below-floor term even though it emits none', async () => {
    // The user typed it; the input must go on displaying it.
    selectNamespace(ns('acme', contract([field('case_id', { index: true })])));

    component.onTermChanged('case_id', 'C');
    fixture.detectChanges();
    // `ngModel` writes to the DOM asynchronously, so the value is not on the
    // element until the microtask queue drains.
    await fixture.whenStable();

    expect(component.terms['case_id']).toBe('C');
    expect(inputs()[0].value).toBe('C');
  });

  it('emits a term trimmed', () => {
    selectNamespace(ns('acme', contract([field('case_id', { index: true })])));

    component.onTermChanged('case_id', '  C-1234  ');

    expect(emitted.pop()?.meta).toEqual({ case_id: 'C-1234' });
  });

  it('never emits a term for a field the contract does not offer', () => {
    // Composing walks the OFFERED fields, so a term left over from another
    // contract cannot leak into the filter.
    selectNamespace(ns('acme', contract([field('case_id', { index: true })])));
    component.terms['gone'] = 'value';

    component.onTermChanged('case_id', 'C-1234');

    expect(emitted.pop()?.meta).toEqual({ case_id: 'C-1234' });
  });

  // --- The narrowing toggle ------------------------------------------------

  it('defaults OFF and emits the namespace only when ON', () => {
    selectNamespace(ns('acme', contract([])));
    expect(component.narrowToNamespace).toBeFalse();

    component.onNarrowToggle(true);
    expect(emitted.pop()?.catalogNamespace).toBe('acme');

    component.onNarrowToggle(false);
    // NULL, not the namespace and not an empty string: absent is not a filter
    // on the empty string.
    expect(emitted.pop()?.catalogNamespace).toBeNull();
  });

  it('honours a toggle flipped ON before any selection, once one arrives', () => {
    component.onNarrowToggle(true);
    expect(emitted.pop()?.catalogNamespace).toBeNull();

    selectNamespace(ns('acme', contract([])));

    // Answered again, now that there is a type to narrow to. Without this the
    // switch would read ON above a list nothing had narrowed.
    expect(emitted.pop()?.catalogNamespace).toBe('acme');
  });

  it('the narrowing toggle carries its data-test and its full meaning in a title', () => {
    // The visible caption is deliberately short — the control sits inside the
    // panel, under the team-type select it refers to. The title is where the
    // unabbreviated sentence lives, so the control never depends on that
    // context being noticed. Asserted EXACTLY: a `toContain` here would still
    // pass if the caption degraded to "Team type", which is the SELECT's label
    // and the one wording this control must never collapse to.
    selectNamespace(ns('acme', contract([])));

    expect(
      fixture.nativeElement.querySelector('[data-test="filter-namespace-toggle"]'),
    ).not.toBeNull();
    const label = fixture.nativeElement.querySelector(
      'label[for="filter-namespace-toggle"]',
    ) as HTMLLabelElement;
    expect(label.textContent?.trim()).toBe('This team type only');
    expect(label.getAttribute('title')).toContain('selected team type');
  });

  it('re-renders the input set from the NEW contract on a type change', () => {
    // Not merely clearing the terms: the offered inputs themselves belong to
    // the contract, so the previous type's fields must go.
    selectNamespace(ns('acme', contract([field('case_id', { index: true })])));
    expect(inputs().map((i) => i.getAttribute('data-test'))).toEqual([
      'filter-meta-case_id',
    ]);

    selectNamespace(ns('other', contract([field('tenant', { index: true })])));

    expect(inputs().map((i) => i.getAttribute('data-test'))).toEqual([
      'filter-meta-tenant',
    ]);
  });

  // --- Adopting versus reacting -------------------------------------------

  it('adopts a value without answering back', () => {
    // The value came from outside; echoing it would be this form answering its
    // own question, and the host would treat that as a user change.
    adopt(
      { meta: { case_id: 'C-1234' }, catalogNamespace: 'acme' },
      ns('acme', contract([field('case_id', { index: true })])),
    );

    expect(component.terms['case_id']).toBe('C-1234');
    expect(component.narrowToNamespace).toBeTrue();
    expect(emitted).toEqual([]);
  });

  it('an adopted value OUTRANKS a namespace arriving in the same cycle', async () => {
    // The restore path: both land together, and the terms belong to the type
    // that came with them. Clearing here is what wiped a restored filter the
    // moment the namespace list resolved.
    adopt(
      { meta: { case_id: 'C-1234' }, catalogNamespace: null },
      ns('acme', contract([field('case_id', { index: true })])),
    );
    await fixture.whenStable();

    expect(component.terms['case_id']).toBe('C-1234');
    expect(inputs()[0].value).toBe('C-1234');
  });

  it('clears the terms and answers when the namespace CHANGES', () => {
    // They belong to the contract being left.
    selectNamespace(ns('acme', contract([field('case_id', { index: true })])));
    component.onTermChanged('case_id', 'C-1234');
    emitted.length = 0;

    selectNamespace(ns('other', contract([field('tenant', { index: true })])));

    expect(component.terms).toEqual({});
    expect(emitted.pop()).toEqual({ meta: {}, catalogNamespace: null });
  });

  it('does NOT clear when the FIRST namespace arrives', () => {
    // Arriving at the first real selection is not a change of mind. Terms
    // present at that point were restored and belong to it.
    component.terms = { case_id: 'C-1234' };

    selectNamespace(ns('acme', contract([field('case_id', { index: true })])));

    expect(component.terms['case_id']).toBe('C-1234');
    expect(emitted).toEqual([]);
  });

  // --- Reset ---------------------------------------------------------------

  it('reset clears every term and the toggle, and answers once', () => {
    selectNamespace(
      ns(
        'acme',
        contract([
          field('case_id', { index: true }),
          field('tenant', { index: true }),
        ]),
      ),
    );
    component.onTermChanged('case_id', 'C-1234');
    component.onNarrowToggle(true);
    emitted.length = 0;

    component.reset();

    expect(component.terms).toEqual({});
    expect(component.narrowToNamespace).toBeFalse();
    expect(emitted).toEqual([{ meta: {}, catalogNamespace: null }]);
  });

  it('reset is a no-op when nothing narrows — it does not answer', () => {
    selectNamespace(ns('acme', contract([field('case_id', { index: true })])));
    // Below the floor, so nothing is actually narrowed.
    component.onTermChanged('case_id', 'C');
    emitted.length = 0;

    component.reset();

    expect(emitted).toEqual([]);
  });

  it('renders the reset control only while something narrows, and LAST', () => {
    // Last, so it sits at the far right: a destructive action between two
    // inputs is one mis-aimed click from the term being typed.
    selectNamespace(ns('acme', contract([field('case_id', { index: true })])));
    expect(
      fixture.nativeElement.querySelector('[data-test="reset-filter-btn"]'),
    ).toBeNull();

    component.onTermChanged('case_id', 'C-1234');
    fixture.detectChanges();

    const row = fixture.nativeElement.querySelector('.team-filter');
    const children = Array.from(row.children) as HTMLElement[];
    expect(
      children[children.length - 1].classList.contains('team-filter__reset'),
    ).toBeTrue();
  });

  // --- Layout --------------------------------------------------------------

  it('renders the narrowing toggle BEFORE the metadata inputs', () => {
    // It narrows to the team type while the inputs narrow within it, so
    // reading left to right matches how the terms compose.
    selectNamespace(ns('acme', contract([field('case_id', { index: true })])));

    const row = fixture.nativeElement.querySelector('.team-filter');
    const children = Array.from(row.children) as HTMLElement[];
    const toggle = children.findIndex((c) =>
      c.classList.contains('team-filter__namespace'),
    );
    const firstField = children.findIndex((c) =>
      c.classList.contains('team-filter__field'),
    );
    expect(toggle).toBeLessThan(firstField);
  });

  it('stacks a field label above its input, and keeps the toggle caption beside it', () => {
    // Two deliberate and different layouts, pinned together so neither drifts.
    // A field's label wraps in a bounded column; a switch alone shows nothing,
    // so its caption has to stay next to it.
    selectNamespace(ns('acme', contract([field('case_id', { index: true })])));

    const fieldChildren = Array.from(
      (fixture.nativeElement.querySelector('.team-filter__field') as HTMLElement)
        .children,
    ) as HTMLElement[];
    expect(fieldChildren[0].tagName).toBe('LABEL');

    const toggleChildren = Array.from(
      (
        fixture.nativeElement.querySelector(
          '.team-filter__namespace',
        ) as HTMLElement
      ).children,
    ) as HTMLElement[];
    const labelIndex = toggleChildren.findIndex((c) => c.tagName === 'LABEL');
    const switchIndex = toggleChildren.findIndex((c) => c.tagName !== 'LABEL');
    expect(labelIndex).toBeGreaterThan(switchIndex);
  });

  it('renders nothing at all while not visible', () => {
    selectNamespace(ns('acme', contract([field('case_id', { index: true })])));
    component.visible = false;
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.team-filter')).toBeNull();
  });
});
