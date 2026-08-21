import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';

import {
  MetadataFieldDescriptor,
  TeamMetadataContract,
} from '../../../protocol/catalog.interface';
import { TeamMetadataModalComponent } from './team-metadata-modal.component';

/**
 * One declared field. The first four properties are always present on the
 * wire, so the factory fills all four and the caller overrides only what the
 * spec is about.
 *
 * `pattern` is deliberately NOT defaulted here. It is optional on the wire and
 * no deployed server sends it yet, so leaving it out keeps every other spec in
 * this file exercising the no-pattern branch — which is the branch production
 * takes today. A spec that wants one passes it through `overrides`.
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

  /**
   * Leave a field. The pattern check runs here and nowhere on the typing path,
   * so a spec that only ever calls `type()` sees no message by design.
   */
  function blur(key: string): void {
    input(key).dispatchEvent(new Event('blur'));
    fixture.detectChanges();
  }

  /** The rendered pattern complaint for a field, or `null` when there is none. */
  function patternError(key: string): HTMLElement | null {
    return el(`metadata-pattern-error-${key}`);
  }

  // -------------------------------------------------------------------------
  // AC2 — one input per descriptor, in contract order, never a blank label
  // -------------------------------------------------------------------------

  it('(AC2) labels a field with its description when it has one', async () => {
    await open(contract([field('tenant', { description: 'Tenant code' })]));

    expect(el('metadata-label-tenant')?.textContent).toContain('Tenant code');
    // The label the user reads is the label the input is NAMED by. Pinned in
    // both directions: dropping `for` reads null, dropping the input's `id`
    // leaves the right-hand side empty while `for` still names the input.
    expect(el('metadata-label-tenant')!.getAttribute('for')).toBe(input('tenant').id);
  });

  it('(AC2) falls back to the key, capitalised, when the description is empty', async () => {
    await open(contract([field('tenant', { description: '' })]));

    const label = el('metadata-label-tenant');
    // Capitalised, not verbatim: an identifier rendered as-is beside real
    // sentences reads as a rendering bug rather than an absent description.
    expect(label?.textContent?.trim()).toContain('Tenant');
    expect(label?.textContent?.trim()).not.toBe('');
  });

  it('(AC2) capitalises only the first character of the key fallback', async () => {
    // The rest of the key is left alone, so a deliberately-cased name survives.
    await open(contract([field('caseRef', { description: '' })]));

    expect(el('metadata-label-caseRef')?.textContent?.trim()).toBe('CaseRef');
  });

  it('(AC2) renders a description verbatim and never recases it', async () => {
    // The author wrote it as a sentence; its casing is theirs. A lower-case
    // first character in a description is a choice, not a defect to repair.
    await open(contract([field('tenant', { description: 'iOS device identifier' })]));

    expect(el('metadata-label-tenant')?.textContent?.trim()).toBe('iOS device identifier');
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
    // The asterisk above is `aria-hidden`, so it carries mandatory-ness to
    // sighted users only. `required` is what a screen reader announces —
    // reflected onto the element by Angular's RequiredValidator, whose value
    // is the empty string, so the check is "present", not "true".
    expect(input('tenant').getAttribute('required')).not.toBeNull();
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

  it('(AC3) the Create button names the blocked hint, and the name resolves', async () => {
    await open(
      contract([field('tenant', { description: 'Tenant code', mandatory: true })]),
    );

    const describedBy = el('metadata-confirm')!.getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();

    // Follow the reference through to an element. A presence check on the
    // attribute passes against a typo, a stale id, and a hint that was
    // deleted — none of which reach a screen reader.
    const hint = document.getElementById(describedBy!);
    expect(hint).not.toBeNull();
    expect(hint).toBe(el('metadata-blocked-hint'));
    expect(hint?.textContent).toContain('Tenant code');
  });

  // -------------------------------------------------------------------------
  // AC4 — index is a quiet affordance and gates nothing
  // -------------------------------------------------------------------------

  it('(AC4) renders a filterable affordance for an indexed field', async () => {
    await open(contract([field('tenant', { index: true })]));

    expect(el('metadata-index-tenant')).not.toBeNull();
  });

  it('(AC4) the input names the filterable hint, and the name resolves', async () => {
    await open(contract([field('tenant', { index: true })]));

    const describedBy = input('tenant').getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();

    const hint = document.getElementById(describedBy!);
    expect(hint).not.toBeNull();
    expect(hint).toBe(el('metadata-index-tenant'));
    expect(hint?.textContent).toContain('filterable');

    // The null branch. A non-indexed field renders no hint, so it must name
    // none: an aria-describedby pointing at an element that is not in the
    // document is worse than no association at all.
    await open(contract([field('case')]));
    expect(input('case').getAttribute('aria-describedby')).toBeNull();
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

  it('(AC14) a rejected create leaves the typed draft in the input', async () => {
    await open(contract([field('tenant')]));
    type('tenant', 'acme');

    // `setInput` so ANGULAR builds the SimpleChanges `ngOnChanges` receives:
    // a hand-written one would test the reset condition against an object
    // this spec wrote. An `errorMessage` change matches neither reset
    // trigger, so the draft survives — the half a "clear the form on error"
    // edit would silently destroy on every 422.
    setInput('errorMessage', 'tenant: field required');
    fixture.detectChanges();
    // NgModel writes a CHANGED model back to the view in a microtask, so a
    // draft wiped by ngOnChanges would still read 'acme' in the DOM on a
    // synchronous check. Drain the queue first, or this assertion cannot see
    // the very edit it exists to catch.
    await fixture.whenStable();
    fixture.detectChanges();

    expect(input('tenant').value).toBe('acme');
    expect(component.visible).toBeTrue();
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
    expect(component.form.getRawValue()['tenant']).toBe('');
  });

  it('(Trap 9) switching to a different contract carries no stale key', async () => {
    await open(contract([field('tenant')]));
    type('tenant', 'acme');

    await open(contract([field('case')]));

    expect('tenant' in component.form.getRawValue()).toBeFalse();
    expect(component.form.getRawValue()['case']).toBe('');
  });

  it('(Trap 1) a null contract seeds no keys and confirms an empty map', () => {
    setInput('contract', null);
    fixture.detectChanges();

    const emissions: Record<string, string>[] = [];
    component.confirmed.subscribe((value) => emissions.push(value));
    component.onConfirm();

    expect(component.form.getRawValue()).toEqual({});
    expect(emissions[0]).toEqual({});
  });

  it('(AC3) onConfirm is inert while a mandatory field is blank', async () => {
    await open(contract([field('tenant', { mandatory: true })]));
    let confirmed = 0;
    component.confirmed.subscribe(() => (confirmed += 1));

    component.onConfirm();

    expect(confirmed).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 43.4 — a value that is PRESENT is checked against its field's pattern
  //
  // Every spec below passes `pattern` through `overrides`; the factory does not
  // default it, so nothing above this line is affected.
  // -------------------------------------------------------------------------

  it('(43.4 AC2) a non-matching value blocks confirm and renders the field message', async () => {
    await open(
      contract([field('tenant', { description: 'Tenant code', pattern: '^[a-z]+$' })]),
    );
    const emissions: Record<string, string>[] = [];
    component.confirmed.subscribe((value) => emissions.push(value));

    type('tenant', 'ACME!');
    component.onConfirm();
    fixture.detectChanges();

    expect(emissions.length).toBe(0);
    expect(patternError('tenant')).not.toBeNull();
    expect((el('metadata-confirm') as HTMLButtonElement).disabled).toBeTrue();

    // AC17. Blocked no longer means "a mandatory field is blank": there is no
    // mandatory field here, so the blocked hint must stay out of the document
    // rather than render `Required: ` with nothing after it — and the Create
    // button must not name a hint that is not there.
    expect(el('metadata-blocked-hint')).toBeNull();
    expect(el('metadata-confirm')!.getAttribute('aria-describedby')).toBeNull();
  });

  it('(43.4 AC3) a matching value confirms and emits, unchanged', async () => {
    await open(contract([field('tenant', { pattern: '^[a-z]+$' })]));
    const emissions: Record<string, string>[] = [];
    component.confirmed.subscribe((value) => emissions.push(value));

    type('tenant', 'acme');
    blur('tenant');
    component.onConfirm();
    fixture.detectChanges();

    expect(emissions[0]).toEqual({ tenant: 'acme' });
    expect(patternError('tenant')).toBeNull();
  });

  it('(43.4 AC4) a blank optional field carrying a pattern still confirms, and its key is absent', async () => {
    await open(
      contract([field('tenant'), field('case', { pattern: '^[a-z]+$' })]),
    );
    const emissions: Record<string, string>[] = [];
    component.confirmed.subscribe((value) => emissions.push(value));

    type('tenant', 'acme');
    // Focus lands on the patterned field and leaves it empty. `pattern`
    // constrains a value that is PRESENT; it never makes a field mandatory.
    blur('case');
    component.onConfirm();
    fixture.detectChanges();

    expect(patternError('case')).toBeNull();
    expect(emissions[0]).toEqual({ tenant: 'acme' });
    expect('case' in emissions[0]).toBeFalse();
  });

  it('(43.4 AC5) checks the TRIMMED value — the same string that would be posted', async () => {
    // The padded string fails this pattern; the trimmed one passes. Checking
    // the raw value would reject exactly the input the server accepts.
    await open(contract([field('tenant', { pattern: '^[a-z]+$' })]));
    const emissions: Record<string, string>[] = [];
    component.confirmed.subscribe((value) => emissions.push(value));

    type('tenant', '  acme  ');
    blur('tenant');
    component.onConfirm();
    fixture.detectChanges();

    expect(patternError('tenant')).toBeNull();
    expect(emissions[0]).toEqual({ tenant: 'acme' });
  });

  it('(43.4 AC7) the pattern is NOT anchored here — a value that only contains a match is accepted', async () => {
    // The one assertion that fails if someone "tidies up" `matches()` by
    // wrapping the pattern in `^…$`. Every other spec in this file declares an
    // already-anchored pattern, so anchoring is invisible to all of them.
    //
    // Pydantic's `pattern` SEARCHES rather than full-matches: a field declared
    // `Field(pattern=r"[a-z]+")` accepts `"123abc456"`. `RegExp.test` searches
    // too, which is why this code adds no anchors — an author who wants an
    // anchored pattern writes the anchors. Anchoring client-side would reject a
    // value the server accepts, and the client being too STRICT is the one
    // direction an advisory check must never fail: it blocks a submission the
    // authority would have taken.
    await open(contract([field('tenant', { pattern: '[a-z]+' })]));
    const emissions: Record<string, string>[] = [];
    component.confirmed.subscribe((value) => emissions.push(value));

    type('tenant', '123abc456');
    blur('tenant');
    component.onConfirm();
    fixture.detectChanges();

    expect(patternError('tenant')).toBeNull();
    expect(emissions[0]).toEqual({ tenant: '123abc456' });
  });

  it('(43.4 AC8) a pattern that will not compile leaves the field unchecked', async () => {
    // Deployment-controlled catalog data: a malformed pattern must degrade to
    // "no client-side check", never to a broken modal or a blocked confirm.
    await open(contract([field('tenant', { pattern: '(' })]));
    const emissions: Record<string, string>[] = [];
    component.confirmed.subscribe((value) => emissions.push(value));

    type('tenant', 'anything at all');
    blur('tenant');
    component.onConfirm();
    fixture.detectChanges();

    expect(patternError('tenant')).toBeNull();
    expect(emissions[0]).toEqual({ tenant: 'anything at all' });
  });

  it('(43.4 AC6) an explicit null pattern behaves exactly as an absent one', async () => {
    await open(contract([field('tenant', { pattern: null })]));
    const emissions: Record<string, string>[] = [];
    component.confirmed.subscribe((value) => emissions.push(value));

    type('tenant', 'Anything Goes 42');
    blur('tenant');
    component.onConfirm();
    fixture.detectChanges();

    expect(patternError('tenant')).toBeNull();
    expect(emissions[0]).toEqual({ tenant: 'Anything Goes 42' });
  });

  it('(43.4 AC12) the message states the pattern, the only source of the required format', async () => {
    const pattern = '^[a-z][a-z0-9-]{2,31}$';
    await open(
      contract([field('tenant', { description: 'Tenant code', pattern })]),
    );

    type('tenant', 'NOPE!');
    blur('tenant');

    // The pattern is the ONLY statement of the required shape anywhere in this
    // form: a description gives a field's MEANING, never its format. Withhold
    // it and a rejected user has nothing to act on.
    expect(patternError('tenant')?.textContent).toContain(pattern);
  });

  it('(43.4 AC12) the message does not repeat the description, which states meaning not shape', async () => {
    // Regression: `expected ${description}` rendered
    // "tenant: expected Slug of the tenant the team belongs to." -- grammatical
    // nonsense that told the user nothing about why the value was rejected.
    await open(
      contract([
        field('tenant', {
          description: 'Slug of the tenant the team belongs to.',
          pattern: '^[a-z]+$',
        }),
      ]),
    );

    type('tenant', 'NOPE!');
    blur('tenant');

    const text = patternError('tenant')?.textContent ?? '';
    expect(text).not.toContain('Slug of the tenant');
    expect(text).not.toContain('expected Slug');
  });

  it('(43.4 AC12) the message does not repeat the field key, which the label already carries', async () => {
    // The message renders directly beneath its own labelled input, so a `key:`
    // prefix repeated the identification the label carries -- in the raw
    // identifier form the label deliberately avoids.
    await open(
      contract([field('tenant', { description: 'Tenant code', pattern: '^[a-z]+$' })]),
    );

    type('tenant', 'NOPE!');
    blur('tenant');

    expect(patternError('tenant')?.textContent).not.toContain('tenant:');
  });

  it('(43.4 AC12) falls back to a generic phrasing when there is somehow no pattern', async () => {
    await open(
      contract([field('tenant', { description: '', pattern: '^[a-z]+$' })]),
    );

    type('tenant', 'NOPE!');
    blur('tenant');

    // Defensive: this path is unreachable while a recorded failure implies a
    // compiled pattern, so it is pinned on the method rather than the DOM.
    const component = fixture.componentInstance;
    expect(component.patternMessageFor({
      key: 'tenant', description: '', index: false, mandatory: false, pattern: null,
    })).toContain('not in the expected format');
  });

  it('(43.4 AC13) the input names the message among its describedby tokens, and the name resolves', async () => {
    // Both hints at once: an indexed field carrying a failure is described by
    // TWO elements, so the attribute is a token list and must be read as one.
    await open(contract([field('tenant', { index: true, pattern: '^[a-z]+$' })]));

    type('tenant', 'NOPE!');
    blur('tenant');

    const tokens = (input('tenant').getAttribute('aria-describedby') ?? '')
      .split(/\s+/)
      .filter((token) => token !== '');
    expect(tokens.length).toBe(2);
    expect(tokens).toContain('metadata-index-tenant');

    // Follow the REFERENCE through to a real element. Asserting the attribute
    // is present passes against a typo, a stale id and a deleted target.
    const messageId = tokens.find((token) => token !== 'metadata-index-tenant');
    expect(messageId).toBeDefined();
    const message = document.getElementById(messageId as string);
    expect(message).not.toBeNull();
    expect(message).toBe(patternError('tenant'));
    // The resolved element carries the CONSTRAINT, not merely some text: this
    // is what a screen reader announces when the input takes focus.
    expect(message?.textContent).toContain('^[a-z]+$');
  });

  it('(43.4 AC10) typing a non-matching value shows no message until the field is blurred', async () => {
    await open(contract([field('tenant', { pattern: '^[a-z]+$' })]));

    type('tenant', 'NOPE!');

    // The absence is the assertion. A check wired to every keystroke would
    // render here, and a spec that only looked after the blur could not see it.
    expect(patternError('tenant')).toBeNull();

    blur('tenant');

    expect(patternError('tenant')).not.toBeNull();
  });

  it('(live) once blurred, the message tracks every keystroke and clears mid-word', async () => {
    await open(contract([field('tenant', { pattern: '^[a-z][a-z0-9-]{2,31}$' })]));

    type('tenant', '123');
    blur('tenant');
    expect(patternError('tenant')).not.toBeNull();

    // Still wrong: the message stays, WITHOUT a second blur.
    type('tenant', '1234');
    expect(patternError('tenant')).not.toBeNull();

    // Now right: it clears on the keystroke that fixes it, not on the blur.
    type('tenant', 'acme');
    expect(patternError('tenant')).toBeNull();
  });

  it('(live) an untouched field is never called wrong on the way to a good value', async () => {
    // `acme` is invalid at `a` and at `ac` against a 3-character minimum. An
    // unconditional live check flashes an error twice while the user types a
    // perfectly acceptable value; the touched gate is what prevents that.
    await open(contract([field('tenant', { pattern: '^[a-z][a-z0-9-]{2,31}$' })]));

    type('tenant', 'a');
    expect(patternError('tenant')).toBeNull();
    type('tenant', 'ac');
    expect(patternError('tenant')).toBeNull();
    type('tenant', 'acme');
    expect(patternError('tenant')).toBeNull();
  });

  it('(live) the touched mark resets with the draft, so a reopened field is quiet again', async () => {
    const c = contract([field('tenant', { pattern: '^[a-z]+$' })]);
    await open(c);
    type('tenant', '123');
    blur('tenant');
    expect(patternError('tenant')).not.toBeNull();

    // The SAME contract object comes back, so only `visible` changes.
    component.onCancel();
    setInput('visible', false);
    fixture.detectChanges();
    setInput('visible', true);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    // Typing badly into the reopened dialog must be silent: nobody has left
    // this field yet. A leaked mark would make it shout from keystroke one.
    type('tenant', '123');
    expect(patternError('tenant')).toBeNull();
  });

  it('(43.4 AC15) a recorded pattern error survives neither a reopen nor a contract switch', async () => {
    const c = contract([field('tenant', { pattern: '^[a-z]+$' })]);
    await open(c);
    type('tenant', 'NOPE!');
    blur('tenant');
    expect(patternError('tenant')).not.toBeNull();

    // The SAME contract object comes back, so only `visible` changes.
    component.onCancel();
    setInput('visible', false);
    fixture.detectChanges();
    setInput('visible', true);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(patternError('tenant')).toBeNull();
    expect((el('metadata-confirm') as HTMLButtonElement).disabled).toBeFalse();

    // And a switch to a DIFFERENT contract that happens to declare the key.
    type('tenant', 'NOPE!');
    blur('tenant');
    expect(patternError('tenant')).not.toBeNull();

    await open(contract([field('tenant', { pattern: '^[a-z]+$' })]));

    expect(patternError('tenant')).toBeNull();
  });

  it('(43.4 AC16) a 422 with a pattern present keeps the modal open with the draft intact', async () => {
    // The server stays the authority: Python `re` and ECMA-262 are different
    // languages, so a value this client accepts can still be rejected. No new
    // contract for it — the one 43.2 established still applies.
    await open(contract([field('tenant', { pattern: '^[a-z]+$' })]));
    type('tenant', 'acme');
    blur('tenant');

    setInput('errorMessage', 'tenant: string does not match the declared format');
    fixture.detectChanges();
    // NgModel writes a CHANGED model back to the view in a microtask, so a
    // draft wiped by ngOnChanges would still read 'acme' on a synchronous
    // check. Drain the queue, or this cannot see the edit it exists to catch.
    await fixture.whenStable();
    fixture.detectChanges();

    expect(input('tenant').value).toBe('acme');
    expect(component.visible).toBeTrue();
    expect(el('metadata-error')?.textContent).toContain(
      'tenant: string does not match the declared format',
    );
    expect(patternError('tenant')).toBeNull();
  });
});
