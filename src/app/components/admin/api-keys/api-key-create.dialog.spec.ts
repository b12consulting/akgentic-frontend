import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { BehaviorSubject } from 'rxjs';

import { AuthService } from '../../../core/auth/auth.service';
import { CreateApiKeyRequest } from '../../../protocol/api-key.interface';
import { ApiKeyCreateDialogComponent } from './api-key-create.dialog';

/**
 * Story 36-6 Task 4 — the create form.
 *
 * The load-bearing spec here is the LATE `currentUser$` emission: `/auth/me`
 * resolves after first render, so an implementation that snapshots the user in
 * its constructor leaves a genuine admin with two blank fields. That spec
 * reddens for exactly that mistake and for nothing else.
 *
 * Fixtures use `acme` / `contoso` placeholders throughout.
 */

const ANONYMOUS = { user_id: 'anonymous', email: '', name: 'Anonymous' };
const ADMIN = {
  user_id: 'u-acme',
  email: 'operator@acme.test',
  name: 'Acme Operator',
  roles: ['admin'],
};

describe('ApiKeyCreateDialogComponent (Story 36-6)', () => {
  let fixture: ComponentFixture<ApiKeyCreateDialogComponent>;
  let component: ApiKeyCreateDialogComponent;
  let currentUser$: BehaviorSubject<unknown>;

  beforeEach(async () => {
    currentUser$ = new BehaviorSubject<unknown>(ANONYMOUS);

    await TestBed.configureTestingModule({
      imports: [ApiKeyCreateDialogComponent, NoopAnimationsModule],
      providers: [
        {
          provide: AuthService,
          useValue: { currentUser$: currentUser$.asObservable() },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(ApiKeyCreateDialogComponent);
    component = fixture.componentInstance;
  });

  function byTest(value: string): HTMLElement | null {
    return fixture.nativeElement.querySelector(`[data-test="${value}"]`);
  }

  function submitBtn(): HTMLButtonElement {
    return byTest('api-key-create-submit-btn') as HTMLButtonElement;
  }

  /**
   * `ngModel` writes to the DOM on a microtask, not inside `detectChanges` —
   * so every assertion on an input's rendered `value` has to let that settle
   * first, or it reads the value from before the model changed.
   */
  async function settle(): Promise<void> {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function typeInto(hook: string, value: string): void {
    const input = byTest(hook) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  it('fills the owner fields from a LATE currentUser$ emission, after first render', async () => {
    // First render happens while `/auth/me` is still in flight — exactly the
    // moment a constructor snapshot would capture the anonymous user and stop.
    await settle();
    expect((byTest('api-key-create-owner-id') as HTMLInputElement).value).toBe(
      'anonymous',
    );

    currentUser$.next(ADMIN);
    await settle();

    expect((byTest('api-key-create-owner-id') as HTMLInputElement).value).toBe(
      'u-acme',
    );
    expect(
      (byTest('api-key-create-owner-email') as HTMLInputElement).value,
    ).toBe('operator@acme.test');
  });

  it('does NOT overwrite an owner the operator has already typed', async () => {
    await settle();
    typeInto('api-key-create-owner-id', 'contoso-svc');

    currentUser$.next(ADMIN);
    await settle();

    // Minting for another identity is the capability the editable field
    // exists for; a late emission reverting it silently is worse than never
    // pre-filling.
    expect((byTest('api-key-create-owner-id') as HTMLInputElement).value).toBe(
      'contoso-svc',
    );
  });

  it('shows the helper text naming whose key this will be', () => {
    fixture.detectChanges();

    expect(byTest('api-key-create-owner-helper')?.textContent).toContain(
      'issued in this owner',
    );
  });

  it('keeps Submit disabled for a blank owner', () => {
    fixture.detectChanges();
    typeInto('api-key-create-roles', 'admin');
    typeInto('api-key-create-owner-id', '   ');

    expect(component.canSubmit).toBeFalse();
    expect(submitBtn().disabled).toBeTrue();
  });

  it('keeps Submit disabled with no roles, and enables it once one is given', () => {
    fixture.detectChanges();
    currentUser$.next(ADMIN);
    fixture.detectChanges();

    // A key with no role can authenticate and do nothing.
    expect(component.canSubmit).toBeFalse();
    expect(submitBtn().disabled).toBeTrue();

    typeInto('api-key-create-roles', ' , ');
    expect(component.canSubmit).toBeFalse();

    typeInto('api-key-create-roles', 'admin');
    expect(component.canSubmit).toBeTrue();
    expect(submitBtn().disabled).toBeFalse();
  });

  it('stays disabled while a create is in flight', () => {
    fixture.detectChanges();
    currentUser$.next(ADMIN);
    typeInto('api-key-create-roles', 'admin');
    component.submitting = true;
    fixture.detectChanges();

    expect(component.canSubmit).toBeFalse();
    expect(submitBtn().disabled).toBeTrue();
  });

  it('emits the exact CreateApiKeyRequest: trimmed owner, split roles, null expiration', () => {
    const emitted: CreateApiKeyRequest[] = [];
    component.submitted.subscribe((body) => emitted.push(body));

    fixture.detectChanges();
    currentUser$.next(ADMIN);
    fixture.detectChanges();
    typeInto('api-key-create-roles', ' admin , operator ,, ');

    submitBtn().click();

    expect(emitted[0]).toEqual({
      owner_id: 'u-acme',
      owner_email: 'operator@acme.test',
      roles: ['admin', 'operator'],
      expiration: null,
    });
  });

  it('serialises a chosen expiration with toISOString(), never a local format', () => {
    const emitted: CreateApiKeyRequest[] = [];
    component.submitted.subscribe((body) => emitted.push(body));

    fixture.detectChanges();
    currentUser$.next(ADMIN);
    typeInto('api-key-create-roles', 'admin');
    const chosen = new Date(Date.UTC(2027, 0, 15, 10, 30, 0));
    component.expiration = chosen;
    fixture.detectChanges();

    submitBtn().click();

    expect(emitted[0].expiration).toBe('2027-01-15T10:30:00.000Z');
  });

  it('emits a blank owner_email rather than refusing — a machine identity has none', () => {
    const emitted: CreateApiKeyRequest[] = [];
    component.submitted.subscribe((body) => emitted.push(body));

    fixture.detectChanges();
    typeInto('api-key-create-owner-id', 'contoso-svc');
    typeInto('api-key-create-owner-email', '   ');
    typeInto('api-key-create-roles', 'operator');

    expect(component.canSubmit).toBeTrue();
    submitBtn().click();

    expect(emitted[0].owner_email).toBe('');
  });

  it('emits nothing when the TS guard refuses, even if the click gets through', () => {
    let emissions = 0;
    component.submitted.subscribe(() => (emissions += 1));

    fixture.detectChanges();
    typeInto('api-key-create-owner-id', 'contoso-svc');
    // No roles: the disabled attribute is not the gate — the guard is, because
    // a keyboard-driven submit never consults it (epic 33's lesson).
    component.onSubmit();

    expect(emissions).toBe(0);
  });

  it('emits cancelled when Cancel is pressed', () => {
    let emissions = 0;
    component.cancelled.subscribe(() => (emissions += 1));
    fixture.detectChanges();

    (byTest('api-key-create-cancel-btn') as HTMLButtonElement).click();

    expect(emissions).toBe(1);
  });
});
