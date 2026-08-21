import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';

import {
  MetadataFieldDescriptor,
  TeamMetadataContract,
} from '../../../protocol/catalog.interface';
import { TeamMetadataModalComponent } from './team-metadata-modal.component';

/**
 * One declared field. Every property is always present on the wire, so the
 * factory fills all four and the caller overrides only what the spec is about.
 */
function field(
  key: string,
  overrides: Partial<MetadataFieldDescriptor> = {},
): MetadataFieldDescriptor {
  return { key, description: '', index: false, mandatory: false, ...overrides };
}

function contract(fields: MetadataFieldDescriptor[]): TeamMetadataContract {
  return { type: 'acme.contracts.CaseMetadata', fields };
}

describe('TeamMetadataModalComponent', () => {
  let fixture: ComponentFixture<TeamMetadataModalComponent>;
  let component: TeamMetadataModalComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TeamMetadataModalComponent, NoopAnimationsModule],
    }).compileComponents();

    fixture = TestBed.createComponent(TeamMetadataModalComponent);
    component = fixture.componentInstance;
  });

  /**
   * Set one declared `@Input()` the way the host's template does.
   *
   * Deliberately NOT a field assignment plus a hand-built `SimpleChanges`:
   * that harness verifies the reset-on-open contract against an object the
   * SPEC wrote, so a renamed input or a `changes[...]` key that no longer
   * matches would leave every spec here green. `setInput` goes through
   * Angular's own input pipeline — it throws on a property that is not an
   * `@Input()`, and Angular builds the `SimpleChanges` that `ngOnChanges`
   * receives.
   */
  function setInput(name: string, value: unknown): void {
    fixture.componentRef.setInput(name, value);
  }

  /** Open the dialog on `c` and flush a render. */
  async function open(c: TeamMetadataContract, label = 'Acme Cases'): Promise<void> {
    setInput('contract', c);
    setInput('namespaceLabel', label);
    setInput('visible', true);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  /**
   * PrimeNG teleports the dialog body out of the component host, so every
   * query runs against the whole document. The data-test names are unique to
   * this modal, so nothing else in the page can answer them.
   */
  function el(dataTest: string): HTMLElement | null {
    return document.querySelector(`[data-test="${dataTest}"]`) as HTMLElement | null;
  }

  function input(key: string): HTMLInputElement {
    return el(`metadata-field-${key}`) as unknown as HTMLInputElement;
  }

  function type(key: string, value: string): void {
    const control = input(key);
    control.value = value;
    control.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  // -------------------------------------------------------------------------
  // AC2 — one input per descriptor, in contract order, never a blank label
  // -------------------------------------------------------------------------

  it('(AC2) labels a field with its description when it has one', async () => {
    await open(contract([field('tenant', { description: 'Tenant code' })]));

    expect(el('metadata-label-tenant')?.textContent).toContain('Tenant code');
  });

  it('(AC2) falls back to the key when the description is empty', async () => {
    await open(contract([field('tenant', { description: '' })]));

    const label = el('metadata-label-tenant');
    expect(label?.textContent?.trim()).toContain('tenant');
    expect(label?.textContent?.trim()).not.toBe('');
  });

  it('(AC2) renders one input per descriptor, in contract order', async () => {
    await open(
      contract([field('tenant'), field('case'), field('owner')]),
    );

    const keys = Array.from(
      document.querySelectorAll('[data-test^="metadata-field-"]'),
    ).map((node) => node.getAttribute('data-test'));
    expect(keys).toEqual([
      'metadata-field-tenant',
      'metadata-field-case',
      'metadata-field-owner',
    ]);
  });

  // -------------------------------------------------------------------------
  // AC15 — every control is a free-text input, whatever the key is called
  // -------------------------------------------------------------------------

  it('(AC15) renders a free-text input even for keys named vip / date', async () => {
    await open(contract([field('vip'), field('date')]));

    for (const key of ['vip', 'date']) {
      const control = input(key);
      expect(control.tagName).toBe('INPUT');
      expect(control.type).toBe('text');
    }
  });

  // -------------------------------------------------------------------------
  // AC3 — mandatory fields are marked and block confirmation while blank
  // -------------------------------------------------------------------------

  it('(AC3) marks a mandatory field and disables confirm while it is blank', async () => {
    await open(contract([field('tenant', { mandatory: true })]));

    expect(el('metadata-required-tenant')).not.toBeNull();
    expect((el('metadata-confirm') as HTMLButtonElement).disabled).toBeTrue();
    expect(el('metadata-blocked-hint')).not.toBeNull();
  });

  it('(AC3) enables confirm once every mandatory field is filled, and disables it again when cleared', async () => {
    await open(contract([field('tenant', { mandatory: true })]));

    type('tenant', 'acme');
    expect((el('metadata-confirm') as HTMLButtonElement).disabled).toBeFalse();
    expect(el('metadata-blocked-hint')).toBeNull();

    type('tenant', '');
    expect((el('metadata-confirm') as HTMLButtonElement).disabled).toBeTrue();
    expect(el('metadata-blocked-hint')).not.toBeNull();
  });

  it('(AC3) treats a whitespace-only mandatory value as blank', async () => {
    await open(contract([field('tenant', { mandatory: true })]));

    type('tenant', '   ');
    expect(component.canConfirm).toBeFalse();
    expect((el('metadata-confirm') as HTMLButtonElement).disabled).toBeTrue();
  });

  it('(AC3) the blocked hint names the missing field so the reason is discoverable', async () => {
    await open(
      contract([field('tenant', { description: 'Tenant code', mandatory: true })]),
    );

    expect(el('metadata-blocked-hint')?.textContent).toContain('Tenant code');
  });

  // -------------------------------------------------------------------------
  // AC4 — index is a quiet affordance and gates nothing
  // -------------------------------------------------------------------------

  it('(AC4) renders a filterable affordance for an indexed field', async () => {
    await open(contract([field('tenant', { index: true })]));

    expect(el('metadata-index-tenant')).not.toBeNull();
  });

  it('(AC4) an indexed, non-mandatory field left blank does not block confirm', async () => {
    await open(contract([field('tenant', { index: true })]));

    expect(component.canConfirm).toBeTrue();
    expect((el('metadata-confirm') as HTMLButtonElement).disabled).toBeFalse();
  });

  // -------------------------------------------------------------------------
  // AC5 — confirm emits ONLY the non-blank, trimmed values
  // -------------------------------------------------------------------------

  it('(AC5) omits a blank optional key entirely — the key is absent, not undefined', async () => {
    await open(contract([field('tenant'), field('case')]));
    const emissions: Record<string, string>[] = [];
    component.confirmed.subscribe((value) => emissions.push(value));

    type('tenant', 'acme');
    component.onConfirm();

    const out = emissions[0];
    expect(out).toEqual({ tenant: 'acme' });
    expect('case' in out).toBeFalse();
  });

  it('(AC5) treats a whitespace-only optional value as blank and omits its key', async () => {
    await open(contract([field('tenant'), field('case')]));
    const emissions: Record<string, string>[] = [];
    component.confirmed.subscribe((value) => emissions.push(value));

    type('tenant', 'acme');
    type('case', '   ');
    component.onConfirm();

    expect('case' in emissions[0]).toBeFalse();
  });

  it('(AC5) trims the emitted value', async () => {
    await open(contract([field('tenant')]));
    const emissions: Record<string, string>[] = [];
    component.confirmed.subscribe((value) => emissions.push(value));

    type('tenant', '  acme  ');
    component.onConfirm();

    expect(emissions[0]).toEqual({ tenant: 'acme' });
  });

  it('(AC5) emits keys in contract order', async () => {
    await open(contract([field('tenant'), field('case'), field('owner')]));
    const emissions: Record<string, string>[] = [];
    component.confirmed.subscribe((value) => emissions.push(value));

    type('owner', 'o');
    type('tenant', 't');
    type('case', 'c');
    component.onConfirm();

    expect(Object.keys(emissions[0])).toEqual([
      'tenant',
      'case',
      'owner',
    ]);
  });

  it('(AC5) an all-optional contract left entirely blank still confirms, emitting {}', async () => {
    await open(contract([field('tenant'), field('case')]));
    const emissions: Record<string, string>[] = [];
    component.confirmed.subscribe((value) => emissions.push(value));

    expect(component.canConfirm).toBeTrue();
    component.onConfirm();

    expect(emissions[0]).toEqual({});
  });

  it('(AC5) confirming does not close the dialog — the host owns visibility', async () => {
    await open(contract([field('tenant')]));

    component.onConfirm();

    expect(component.visible).toBeTrue();
  });

  // -------------------------------------------------------------------------
  // AC6 — cancel emits `cancelled` and never `confirmed`
  // -------------------------------------------------------------------------

  it('(AC6) the Cancel button emits cancelled and never confirmed', async () => {
    await open(contract([field('tenant')]));
    let cancelled = 0;
    let confirmed = 0;
    component.cancelled.subscribe(() => (cancelled += 1));
    component.confirmed.subscribe(() => (confirmed += 1));

    (el('metadata-cancel') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(cancelled).toBe(1);
    expect(confirmed).toBe(0);
  });

  it('(AC6) a (visibleChange) false dismissal routes to cancelled', async () => {
    await open(contract([field('tenant')]));
    let cancelled = 0;
    let confirmed = 0;
    component.cancelled.subscribe(() => (cancelled += 1));
    component.confirmed.subscribe(() => (confirmed += 1));

    component.onVisibleChange(false);

    expect(cancelled).toBe(1);
    expect(confirmed).toBe(0);
  });

  it('(AC1) the component never flips its own visible input on dismissal', async () => {
    await open(contract([field('tenant')]));

    component.onVisibleChange(false);

    expect(component.visible).toBeTrue();
  });

  it('(AC1) a (visibleChange) true is a no-op — it does not emit cancelled', async () => {
    await open(contract([field('tenant')]));
    let cancelled = 0;
    component.cancelled.subscribe(() => (cancelled += 1));

    component.onVisibleChange(true);

    expect(cancelled).toBe(0);
  });

  // -------------------------------------------------------------------------
  // AC7 — the header names the namespace
  // -------------------------------------------------------------------------

  it('(AC7) the header renders the namespace label', async () => {
    await open(contract([field('tenant')]), 'Acme Cases');

    expect(el('metadata-dialog-header')?.textContent).toContain('Acme Cases');
  });

  // -------------------------------------------------------------------------
  // AC14 — the server's message renders inside the modal
  // -------------------------------------------------------------------------

  it('(AC14) renders the error message when one is supplied, and nothing when it is null', async () => {
    await open(contract([field('tenant')]));

    expect(el('metadata-error')).toBeNull();

    setInput('errorMessage', 'case: field required');
    fixture.detectChanges();

    expect(el('metadata-error')?.textContent).toContain('case: field required');
  });

  // -------------------------------------------------------------------------
  // AC13 — `pending` locks the controls
  // -------------------------------------------------------------------------

  it('(AC13) pending locks the inputs and the confirm control', async () => {
    await open(contract([field('tenant')]));
    type('tenant', 'acme');

    setInput('pending', true);
    fixture.detectChanges();
    // NgModel applies a `[disabled]` binding through the form control in a
    // microtask, so the DOM property lands only after the queue drains.
    await fixture.whenStable();
    fixture.detectChanges();

    expect(input('tenant').disabled).toBeTrue();
    expect((el('metadata-confirm') as HTMLButtonElement).disabled).toBeTrue();
  });

  // -------------------------------------------------------------------------
  // Trap 9 — the draft resets on every open, and carries no stale key
  // -------------------------------------------------------------------------

  it('(Trap 9) reopening after a cancel shows empty inputs', async () => {
    const c = contract([field('tenant')]);
    await open(c);
    type('tenant', 'acme');

    component.onCancel();
    setInput('visible', false);
    fixture.detectChanges();

    // The SAME contract object comes back, so nothing but `visible` changes —
    // which is exactly why the reset has to key off the open, not only off the
    // contract.
    setInput('visible', true);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(input('tenant').value).toBe('');
    expect(component.values['tenant']).toBe('');
  });

  it('(Trap 9) switching to a different contract carries no stale key', async () => {
    await open(contract([field('tenant')]));
    type('tenant', 'acme');

    await open(contract([field('case')]));

    expect('tenant' in component.values).toBeFalse();
    expect(component.values['case']).toBe('');
  });

  it('(Trap 1) a null contract seeds no keys and confirms an empty map', () => {
    setInput('contract', null);
    fixture.detectChanges();

    const emissions: Record<string, string>[] = [];
    component.confirmed.subscribe((value) => emissions.push(value));
    component.onConfirm();

    expect(component.values).toEqual({});
    expect(emissions[0]).toEqual({});
  });

  it('(AC3) onConfirm is inert while a mandatory field is blank', async () => {
    await open(contract([field('tenant', { mandatory: true })]));
    let confirmed = 0;
    component.confirmed.subscribe(() => (confirmed += 1));

    component.onConfirm();

    expect(confirmed).toBe(0);
  });
});
