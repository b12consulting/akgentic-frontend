import { CommonModule } from '@angular/common';
import { Component, ElementRef, forwardRef, Input } from '@angular/core';
import {
  ComponentFixture,
  fakeAsync,
  TestBed,
  tick,
} from '@angular/core/testing';
import {
  ControlValueAccessor,
  FormsModule,
  NG_VALUE_ACCESSOR,
} from '@angular/forms';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import yaml from 'js-yaml';
import { ConfirmationService, MessageService } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { TooltipModule } from 'primeng/tooltip';

import { NamespaceValidationReport } from '../../../protocol/catalog.interface';
import { ApiService } from '../../../core/http/api.service';
import { AuthService } from '../../../core/auth/auth.service';
import { HttpError } from '../../../core/http/fetch.service';
import { NamespacePanelComponent } from './namespace-panel.component';
import { ValidationReportComponent } from './validation-report/validation-report.component';

/**
 * Stand-in for <nu-monaco-editor> used in component tests. Implements
 * ControlValueAccessor so Angular's NgModel binding resolves cleanly,
 * and accepts the same input shape (`options`, `height`) so the template
 * does not need to change.
 *
 * Keeping the real NuMonacoEditor out of the test graph eliminates the
 * AMD-based script loader it kicks off during `ngAfterViewInit`. That
 * loader's async subscription was registering an `onDestroy` hook on
 * already-destroyed DestroyRefs when fixtures tore down before the load
 * completed (NG0911), bleeding into unrelated specs.
 */
@Component({
  selector: 'nu-monaco-editor',
  standalone: true,
  template: '<textarea data-test="stub-monaco"></textarea>',
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => StubMonacoEditorComponent),
      multi: true,
    },
  ],
})
class StubMonacoEditorComponent implements ControlValueAccessor {
  @Input() options?: Record<string, unknown>;
  @Input() height?: string;
  writeValue(_value: string): void {}
  registerOnChange(_fn: (value: string) => void): void {}
  registerOnTouched(_fn: () => void): void {}
  setDisabledState?(_isDisabled: boolean): void {}
}

function makeHttpError(status: number, body: unknown = ''): HttpError {
  return new HttpError('boom', status, body);
}

/**
 * Drain the microtask queue a few times so an awaited async chain (e.g. the
 * Save drift re-export resolving before `confirmationService.confirm` fires)
 * settles before assertions read its side effects.
 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

describe('NamespacePanelComponent', () => {
  let fixture: ComponentFixture<NamespacePanelComponent>;
  let component: NamespacePanelComponent;
  let apiSpy: jasmine.SpyObj<ApiService>;
  let messageSpy: jasmine.SpyObj<MessageService>;
  let confirmationSpy: jasmine.SpyObj<ConfirmationService>;
  // Minimal AuthService stub exposing only a settable `currentUserValue`
  // (the sole surface the panel's advisory owner pre-check reads). Defaults
  // to the anonymous user so pre-existing Save tests — whose buffers carry
  // `user_id: null` (unresolvable owner → defer to server) — are unaffected.
  let authStub: { currentUserValue: { user_id: string; roles?: string[] } };

  async function buildFixture(namespace: string) {
    fixture = TestBed.createComponent(NamespacePanelComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('namespace', namespace);
  }

  beforeEach(async () => {
    apiSpy = jasmine.createSpyObj('ApiService', [
      'exportNamespace',
      'importNamespace',
      'validateNamespaceBuffer',
      'validatePersistedNamespace',
      'deleteNamespace',
    ]);
    messageSpy = jasmine.createSpyObj('MessageService', ['add']);
    // Use a REAL ConfirmationService instance (its `requireConfirmation$`
    // Subject is wired) and spy on `.confirm` — PrimeNG's `<p-confirmDialog>`
    // subscribes to `requireConfirmation$` on instantiation, so a bare
    // `jasmine.createSpyObj` breaks the constructor.
    confirmationSpy =
      new ConfirmationService() as jasmine.SpyObj<ConfirmationService>;
    spyOn(confirmationSpy, 'confirm').and.callThrough();
    authStub = { currentUserValue: { user_id: 'anonymous' } };

    await TestBed.configureTestingModule({
      imports: [NamespacePanelComponent, NoopAnimationsModule],
      providers: [
        { provide: ApiService, useValue: apiSpy },
        { provide: MessageService, useValue: messageSpy },
        { provide: AuthService, useValue: authStub },
      ],
    })
      // Swap the real NuMonacoEditor for a lightweight stub that honours
      // the same template surface (selector + `options` + `ControlValueAccessor`)
      // but does not kick off Monaco's AMD loader — which previously leaked
      // late `onDestroy` registrations across tests (NG0911).
      .overrideComponent(NamespacePanelComponent, {
        set: {
          imports: [
            CommonModule,
            FormsModule,
            ButtonModule,
            ConfirmDialogModule,
            DialogModule,
            InputTextModule,
            ToggleSwitchModule,
            TooltipModule,
            StubMonacoEditorComponent,
            ValidationReportComponent,
          ],
          // Swap the locally-provided real ConfirmationService for a spy so
          // the Reset + drift + confirm-dialog flows are testable
          // deterministically.
          providers: [
            { provide: ConfirmationService, useValue: confirmationSpy },
          ],
        },
      })
      .compileComponents();
  });

  // ---------------------------------------------------------------------
  // Shared load helper — drives ngOnInit → loadNamespace → stable view.
  // The panel lands clean (buffer === serverYaml) and always editable.
  // ---------------------------------------------------------------------

  async function loaded(yaml = 'foo: 1\n'): Promise<void> {
    apiSpy.exportNamespace.and.returnValue(Promise.resolve(yaml));
    await buildFixture('foo');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  // ---------------------------------------------------------------------
  // Load / view tests carried forward (no `mode` axis).
  // ---------------------------------------------------------------------

  it('(AC13) load flow (happy path) — populates serverYaml/buffer and clears loading', async () => {
    apiSpy.exportNamespace.and.returnValue(Promise.resolve('key: value\n'));

    await buildFixture('foo');
    fixture.detectChanges(); // triggers ngOnInit
    await fixture.whenStable();
    fixture.detectChanges();

    // Story 14.4 — exportNamespace now carries the admin "show all" flag
    // ({ all: showAll }); default showAll=false ⇒ owner-scoped read.
    expect(apiSpy.exportNamespace).toHaveBeenCalledOnceWith('foo', {
      all: false,
    });
    expect(component.serverYaml).toBe('key: value\n');
    expect(component.buffer).toBe('key: value\n');
    expect(component.lastValidation).toBeNull();
    expect(component.loading).toBe(false);
    // Lands clean — Save/Reset disabled, Clone enabled.
    expect(component.hasUnsavedChanges()).toBe(false);
  });

  it('(14.4 AC8, AC17) admin foreign-open — showAll=true threads all:true into the entry read', async () => {
    apiSpy.exportNamespace.and.returnValue(Promise.resolve('key: value\n'));

    await buildFixture('foreign-ns');
    fixture.componentRef.setInput('showAll', true);
    fixture.detectChanges(); // triggers ngOnInit / loadNamespace
    await fixture.whenStable();
    fixture.detectChanges();

    expect(apiSpy.exportNamespace).toHaveBeenCalledOnceWith('foreign-ns', {
      all: true,
    });
    expect(component.serverYaml).toBe('key: value\n');
  });

  it('(14.4 AC8) toggle off — showAll=false keeps the normal owner-scoped entry read', async () => {
    apiSpy.exportNamespace.and.returnValue(Promise.resolve('key: value\n'));

    await buildFixture('owned-ns');
    fixture.componentRef.setInput('showAll', false);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(apiSpy.exportNamespace).toHaveBeenCalledOnceWith('owned-ns', {
      all: false,
    });
  });

  it('(AC13) load flow (error) — leaves buffers empty, toasts, and renders empty state', async () => {
    apiSpy.exportNamespace.and.returnValue(Promise.reject(new Error('boom')));

    await buildFixture('foo');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(component.serverYaml).toBe('');
    expect(component.buffer).toBe('');
    expect(component.loading).toBe(false);
    expect(messageSpy.add).toHaveBeenCalledTimes(1);

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Unable to load');
  });

  it('(AC13) input change — re-fetches and resets state for the new namespace', async () => {
    let resolveFirst!: (value: string) => void;
    let resolveSecond!: (value: string) => void;

    apiSpy.exportNamespace.and.callFake((ns: string) => {
      if (ns === 'foo') {
        return new Promise<string>((r) => {
          resolveFirst = r;
        });
      }
      return new Promise<string>((r) => {
        resolveSecond = r;
      });
    });

    await buildFixture('foo');
    fixture.detectChanges();
    resolveFirst('foo: yaml\n');
    await fixture.whenStable();
    fixture.detectChanges();

    expect(component.serverYaml).toBe('foo: yaml\n');

    fixture.componentRef.setInput('namespace', 'bar');
    fixture.detectChanges();

    expect(apiSpy.exportNamespace).toHaveBeenCalledTimes(2);
    expect(apiSpy.exportNamespace.calls.mostRecent().args).toEqual([
      'bar',
      { all: false },
    ]);
    expect(component.loading).toBe(true);
    expect(component.serverYaml).toBe('');
    expect(component.buffer).toBe('');

    resolveSecond('bar: yaml\n');
    await fixture.whenStable();
    fixture.detectChanges();

    expect(component.serverYaml).toBe('bar: yaml\n');
    expect(component.buffer).toBe('bar: yaml\n');
    expect(component.loading).toBe(false);
  });

  // ---------------------------------------------------------------------
  // ADR-017 §1 — Monaco always writable; editorOptions stable constant.
  // ---------------------------------------------------------------------

  it('(22.1 AC1/AC2) editorOptions.readOnly === false and the object preserves theme/language/automaticLayout', async () => {
    await loaded('foo: 1\n');

    const options = component.editorOptions;
    expect(options['readOnly']).toBe(false);
    expect(options['language']).toBe('yaml');
    expect(options['automaticLayout']).toBe(true);
    expect(options['theme']).toBe('vs');
  });

  it('(22.1 AC1) editorOptions is a single stable object reference — never reassigned', async () => {
    await loaded('foo: 1\n');
    const first = component.editorOptions;

    // Dirtying the buffer (no Edit click exists) does not churn the reference.
    component.buffer = 'foo: 2\n';
    fixture.detectChanges();
    expect(component.editorOptions).toBe(first);

    // Saving and resetting also leave the reference untouched.
    component.onResetClick();
    fixture.detectChanges();
    expect(component.editorOptions).toBe(first);
  });

  it('(AC13) public surface — namespace @Input, closed/saved @Output, hasUnsavedChanges', async () => {
    apiSpy.exportNamespace.and.returnValue(Promise.resolve(''));
    await buildFixture('foo');
    fixture.detectChanges();
    await fixture.whenStable();

    expect(component.namespace).toBe('foo');
    expect(typeof component.closed.emit).toBe('function');
    expect(typeof component.saved.emit).toBe('function');
    expect(typeof component.hasUnsavedChanges).toBe('function');
  });

  it('(AC12) destroy safety (load) — late-resolving export does not write to state', async () => {
    let resolveLate!: (value: string) => void;
    apiSpy.exportNamespace.and.returnValue(
      new Promise<string>((r) => {
        resolveLate = r;
      }),
    );

    await buildFixture('foo');
    fixture.detectChanges();
    expect(component.loading).toBe(true);

    const consoleErrorSpy = spyOn(console, 'error');
    fixture.destroy();

    resolveLate('late: yaml\n');
    await Promise.resolve();
    await Promise.resolve();

    expect(component.serverYaml).toBe('');
    expect(component.buffer).toBe('');
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('(AC7 NFR6) no host-specific types referenced on the component instance', async () => {
    apiSpy.exportNamespace.and.returnValue(Promise.resolve(''));
    await buildFixture('foo');
    fixture.detectChanges();
    await fixture.whenStable();

    expect((component as unknown as { router?: unknown })?.router).toBeUndefined();
    expect(
      (component as unknown as { activatedRoute?: unknown })?.activatedRoute,
    ).toBeUndefined();
  });

  // ---------------------------------------------------------------------
  // ADR-017 §1 — hasUnsavedChanges() collapse (AC4, AC5).
  // ---------------------------------------------------------------------

  it('(22.1 AC4/AC5) hasUnsavedChanges() === (buffer !== serverYaml) — no mode axis', async () => {
    await loaded('foo: 1\n');

    // Clean buffer.
    expect(component.buffer).toBe(component.serverYaml);
    expect(component.hasUnsavedChanges()).toBe(false);

    // Dirty buffer — true with no Edit click (the editor is always writable).
    component.buffer = 'foo: 2\n';
    expect(component.hasUnsavedChanges()).toBe(true);

    // Back to clean.
    component.buffer = component.serverYaml;
    expect(component.hasUnsavedChanges()).toBe(false);
  });

  // ---------------------------------------------------------------------
  // ADR-017 §2 — action row renders five buttons whenever there is content.
  // ---------------------------------------------------------------------

  it('(22.1 AC3/AC6) all five action buttons render whenever the panel has content (no per-mode *ngIf)', async () => {
    await loaded('foo: 1\n');

    const row = fixture.nativeElement as HTMLElement;
    expect(row.querySelector('button[data-test="validate-btn"]')).not.toBeNull();
    expect(row.querySelector('button[data-test="save-btn"]')).not.toBeNull();
    expect(row.querySelector('button[data-test="reset-btn"]')).not.toBeNull();
    expect(row.querySelector('button[data-test="clone-btn"]')).not.toBeNull();
    expect(
      row.querySelector('button[data-test="delete-ns-btn"]'),
    ).not.toBeNull();

    // The retired buttons are gone.
    expect(row.querySelector('button[data-test="edit-btn"]')).toBeNull();
    expect(row.querySelector('button[data-test="cancel-btn"]')).toBeNull();
    expect(
      row.querySelector('button[data-test="validate-persisted-btn"]'),
    ).toBeNull();
    expect(
      row.querySelector('button[data-test="validate-buffer-btn"]'),
    ).toBeNull();
  });

  it('(22.1 AC3) action row + editor are hidden while loading and in the empty state', async () => {
    // Loading: pending export keeps loading true.
    apiSpy.exportNamespace.and.returnValue(new Promise<string>(() => {}));
    await buildFixture('foo');
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('button[data-test="save-btn"]'),
    ).toBeNull();
    fixture.destroy();

    // Empty / error state: serverYaml === ''.
    apiSpy.exportNamespace.and.returnValue(Promise.reject(new Error('boom')));
    await buildFixture('foo');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('button[data-test="save-btn"]'),
    ).toBeNull();
  });

  // ----- Save enablement (AC7) -----

  it('(22.1 AC7) Save disabled when clean, enabled when dirty', async () => {
    await loaded('foo: 1\n');

    let saveBtn = fixture.nativeElement.querySelector(
      'button[data-test="save-btn"]',
    ) as HTMLButtonElement;
    expect(saveBtn.disabled).toBeTrue();

    component.buffer = 'foo: 2\n';
    fixture.detectChanges();
    saveBtn = fixture.nativeElement.querySelector(
      'button[data-test="save-btn"]',
    ) as HTMLButtonElement;
    expect(saveBtn.disabled).toBeFalse();
  });

  it('(22.1 AC7) Save disabled while saving and while FR14-gated even when dirty', async () => {
    await loaded('foo: 1\n');
    component.buffer = 'foo: 2\n';

    component.saving = true;
    fixture.detectChanges();
    let saveBtn = fixture.nativeElement.querySelector(
      'button[data-test="save-btn"]',
    ) as HTMLButtonElement;
    expect(saveBtn.disabled).toBeTrue();

    component.saving = false;
    component.lastValidation = failingReport(1);
    fixture.detectChanges();
    saveBtn = fixture.nativeElement.querySelector(
      'button[data-test="save-btn"]',
    ) as HTMLButtonElement;
    expect(saveBtn.disabled).toBeTrue();
  });

  // ----- Validate enablement (AC8) -----

  it('(22.1 AC8) Validate enabled in both clean and dirty states, and never gated by FR14', async () => {
    await loaded('foo: 1\n');

    // Clean — enabled.
    let validateBtn = fixture.nativeElement.querySelector(
      'button[data-test="validate-btn"]',
    ) as HTMLButtonElement;
    expect(validateBtn.disabled).toBeFalse();

    // Dirty AND FR14-gated (a known-bad report is pending) — STILL enabled.
    component.buffer = 'foo: 2\n';
    component.lastValidation = failingReport(2);
    component.rawSaveError = 'raw';
    expect(component.isSaveGated).toBeTrue();
    fixture.detectChanges();

    validateBtn = fixture.nativeElement.querySelector(
      'button[data-test="validate-btn"]',
    ) as HTMLButtonElement;
    expect(validateBtn.disabled).toBeFalse();

    // Only an in-flight validating / saving disables it.
    component.validating = true;
    fixture.detectChanges();
    validateBtn = fixture.nativeElement.querySelector(
      'button[data-test="validate-btn"]',
    ) as HTMLButtonElement;
    expect(validateBtn.disabled).toBeTrue();
  });

  // ----- Reset enablement (AC9) -----

  it('(22.1 AC9) Reset disabled when clean, enabled when dirty, disabled while saving', async () => {
    await loaded('foo: 1\n');

    let resetBtn = fixture.nativeElement.querySelector(
      'button[data-test="reset-btn"]',
    ) as HTMLButtonElement;
    expect(resetBtn.disabled).toBeTrue();

    component.buffer = 'foo: 2\n';
    fixture.detectChanges();
    resetBtn = fixture.nativeElement.querySelector(
      'button[data-test="reset-btn"]',
    ) as HTMLButtonElement;
    expect(resetBtn.disabled).toBeFalse();

    component.saving = true;
    fixture.detectChanges();
    resetBtn = fixture.nativeElement.querySelector(
      'button[data-test="reset-btn"]',
    ) as HTMLButtonElement;
    expect(resetBtn.disabled).toBeTrue();
  });

  // ----- Clone enablement (AC10) -----

  it('(22.1 AC10) Clone enabled when clean, disabled when dirty', async () => {
    await loaded('foo: 1\n');

    let cloneBtn = fixture.nativeElement.querySelector(
      'button[data-test="clone-btn"]',
    ) as HTMLButtonElement;
    expect(cloneBtn.disabled).toBeFalse();

    component.buffer = 'foo: 2\n';
    fixture.detectChanges();
    cloneBtn = fixture.nativeElement.querySelector(
      'button[data-test="clone-btn"]',
    ) as HTMLButtonElement;
    expect(cloneBtn.disabled).toBeTrue();
  });

  it('(22.1 AC10) Clone disabled while cloning and while FR14-gated (clean state)', async () => {
    await loaded('foo: 1\n');

    component.cloning = true;
    fixture.detectChanges();
    let cloneBtn = fixture.nativeElement.querySelector(
      'button[data-test="clone-btn"]',
    ) as HTMLButtonElement;
    expect(cloneBtn.disabled).toBeTrue();

    component.cloning = false;
    component.lastValidation = failingReport(1);
    fixture.detectChanges();
    cloneBtn = fixture.nativeElement.querySelector(
      'button[data-test="clone-btn"]',
    ) as HTMLButtonElement;
    expect(cloneBtn.disabled).toBeTrue();
  });

  // ----- Delete enablement (AC11) -----

  it('(22.1 AC11) Delete enabled by default, disabled only while deleting', async () => {
    await loaded('foo: 1\n');

    let deleteBtn = fixture.nativeElement.querySelector(
      'button[data-test="delete-ns-btn"]',
    ) as HTMLButtonElement;
    expect(deleteBtn.disabled).toBeFalse();

    component.deleting = true;
    fixture.detectChanges();
    deleteBtn = fixture.nativeElement.querySelector(
      'button[data-test="delete-ns-btn"]',
    ) as HTMLButtonElement;
    expect(deleteBtn.disabled).toBeTrue();
  });

  // ---------------------------------------------------------------------
  // ADR-017 §2/§6 — Save flow (gate, drift check, success, errors).
  // ---------------------------------------------------------------------

  it('(22.1 AC12) onSaveClick is a no-op when clean (gated on hasUnsavedChanges)', async () => {
    await loaded('foo: 1\n');
    apiSpy.importNamespace.and.returnValue(Promise.resolve([]));

    await component.onSaveClick();

    expect(apiSpy.importNamespace).not.toHaveBeenCalled();
  });

  it('(22.1 AC12) Save posts buffer directly to importNamespace — validateNamespaceBuffer NOT called', async () => {
    await loaded('foo: 1\n');
    component.buffer = 'foo: 2\n';
    apiSpy.importNamespace.and.returnValue(Promise.resolve([]));
    // Drift re-export returns the same server YAML → no prompt.
    apiSpy.exportNamespace.and.returnValue(Promise.resolve('foo: 1\n'));

    await component.onSaveClick();

    expect(apiSpy.validateNamespaceBuffer).not.toHaveBeenCalled();
    expect(apiSpy.importNamespace).toHaveBeenCalledOnceWith('foo: 2\n');
  });

  it('(22.1 AC13) Save 2xx — serverYaml updates, saved.emit + success toast + a11y, panel becomes clean', async () => {
    await loaded('foo: 1\n');
    component.buffer = 'foo: 2\n';
    apiSpy.importNamespace.and.returnValue(Promise.resolve([]));
    apiSpy.exportNamespace.and.returnValue(Promise.resolve('foo: 1\n'));
    const savedEmit = spyOn(component.saved, 'emit');

    await component.onSaveClick();

    expect(component.serverYaml).toBe('foo: 2\n');
    expect(component.saving).toBe(false);
    expect(component.hasUnsavedChanges()).toBe(false);
    expect(component.a11yAnnouncement).toBe('Namespace saved');
    expect(savedEmit).toHaveBeenCalledTimes(1);
    const toast = messageSpy.add.calls.mostRecent().args[0];
    expect(toast.severity).toBe('success');

    // Now clean → Save/Reset disabled, Clone enabled.
    fixture.detectChanges();
    const saveBtn = fixture.nativeElement.querySelector(
      'button[data-test="save-btn"]',
    ) as HTMLButtonElement;
    const cloneBtn = fixture.nativeElement.querySelector(
      'button[data-test="clone-btn"]',
    ) as HTMLButtonElement;
    expect(saveBtn.disabled).toBeTrue();
    expect(cloneBtn.disabled).toBeFalse();
  });

  it('(22.1 AC13) Save 422 structured — lastValidation populated, buffer preserved', async () => {
    await loaded('foo: 1\n');
    component.buffer = 'foo: 2\n';
    apiSpy.exportNamespace.and.returnValue(Promise.resolve('foo: 1\n'));
    const report: NamespaceValidationReport = {
      namespace: 'foo',
      ok: false,
      global_errors: ['bad: missing field'],
      entry_issues: [],
    };
    apiSpy.importNamespace.and.returnValue(
      Promise.reject(makeHttpError(422, report)),
    );

    await component.onSaveClick();

    expect(component.buffer).toBe('foo: 2\n');
    expect(component.saving).toBe(false);
    expect(component.lastValidation).toEqual(report);
    expect(component.rawSaveError).toBeNull();
  });

  it('(22.1 AC13) Save 422 unstructured — rawSaveError populated, lastValidation null', async () => {
    await loaded('foo: 1\n');
    component.buffer = 'foo: 2\n';
    apiSpy.exportNamespace.and.returnValue(Promise.resolve('foo: 1\n'));
    const rawBody = { detail: [{ msg: 'field required', loc: ['body'] }] };
    apiSpy.importNamespace.and.returnValue(
      Promise.reject(makeHttpError(422, rawBody)),
    );

    await component.onSaveClick();

    expect(component.lastValidation).toBeNull();
    expect(component.rawSaveError).toContain('field required');
    expect(component.buffer).toBe('foo: 2\n');
  });

  it('(22.1 AC12) Save 5xx — sticky toast; re-clicking Save retries with the same buffer', async () => {
    await loaded('foo: 1\n');
    component.buffer = 'foo: 2\n';
    apiSpy.exportNamespace.and.returnValue(Promise.resolve('foo: 1\n'));
    apiSpy.importNamespace.and.returnValue(Promise.reject(makeHttpError(500)));

    await component.onSaveClick();

    expect(component.buffer).toBe('foo: 2\n');
    expect(component.saving).toBe(false);
    const errorToast = messageSpy.add.calls.mostRecent().args[0];
    expect(errorToast.severity).toBe('error');
    expect(errorToast.sticky).toBeTrue();

    // No dedicated Retry button renders.
    fixture.detectChanges();
    const retryBtn = fixture.nativeElement.querySelector(
      'button[data-test="retry-save-btn"]',
    ) as HTMLButtonElement | null;
    expect(retryBtn).toBeNull();

    // Save still enabled (dirty, not saving).
    const saveBtn = fixture.nativeElement.querySelector(
      'button[data-test="save-btn"]',
    ) as HTMLButtonElement;
    expect(saveBtn.disabled).toBeFalse();

    // Second click — 2xx — retries with the same buffer.
    apiSpy.importNamespace.calls.reset();
    apiSpy.importNamespace.and.returnValue(Promise.resolve([]));
    await component.onSaveClick();
    expect(apiSpy.importNamespace).toHaveBeenCalledOnceWith('foo: 2\n');
  });

  it('(22.1 AC12) Save 500 does NOT auto-invoke importNamespace a second time', async () => {
    await loaded('foo: 1\n');
    component.buffer = 'foo: 2\n';
    apiSpy.exportNamespace.and.returnValue(Promise.resolve('foo: 1\n'));
    apiSpy.importNamespace.and.returnValue(Promise.reject(makeHttpError(500)));

    await component.onSaveClick();
    expect(apiSpy.importNamespace).toHaveBeenCalledTimes(1);
  });

  it('(22.1 AC9) Save 401 — no panel toast, buffer preserved, saving resets', async () => {
    await loaded('foo: 1\n');
    component.buffer = 'foo: 2\n';
    apiSpy.exportNamespace.and.returnValue(Promise.resolve('foo: 1\n'));
    apiSpy.importNamespace.and.returnValue(Promise.reject(makeHttpError(401)));

    await component.onSaveClick();

    expect(component.buffer).toBe('foo: 2\n');
    expect(component.saving).toBe(false);
    expect(messageSpy.add).not.toHaveBeenCalled();
  });

  // ----- Save buffer-namespace guard preserved (AC12) -----

  it('(22.1 AC12) Save refuses when buffer namespace has been edited — error toast, no import, no drift export', async () => {
    await loaded('namespace: foo\nuser_id: null\nentries: {}\n');
    component.buffer = 'namespace: bar\nuser_id: null\nentries: {}\n';
    apiSpy.exportNamespace.calls.reset();

    await component.onSaveClick();

    expect(apiSpy.importNamespace).not.toHaveBeenCalled();
    // The guard fires before the drift re-export.
    expect(apiSpy.exportNamespace).not.toHaveBeenCalled();
    const toast = messageSpy.add.calls.mostRecent().args[0];
    expect(toast.severity).toBe('error');
    expect(toast.sticky).toBeTrue();
    expect(toast.detail).toContain('Clone');
  });

  it('(22.1 AC12) Save proceeds when the buffer namespace matches (guard is a no-op)', async () => {
    await loaded('namespace: foo\nuser_id: null\nentries: {}\n');
    component.buffer = 'namespace: foo\nuser_id: null\nentries:\n  x: 1\n';
    apiSpy.exportNamespace.and.returnValue(
      Promise.resolve('namespace: foo\nuser_id: null\nentries: {}\n'),
    );
    apiSpy.importNamespace.and.returnValue(Promise.resolve([]));

    await component.onSaveClick();

    expect(apiSpy.importNamespace).toHaveBeenCalledTimes(1);
  });

  it('(22.1 AC12) Save falls through the guard when the buffer is unparseable — server decides', async () => {
    await loaded('namespace: foo\nuser_id: null\nentries: {}\n');
    component.buffer = 'namespace: foo\nentries: [\n  unclosed\n';
    apiSpy.exportNamespace.and.returnValue(
      Promise.resolve('namespace: foo\nuser_id: null\nentries: {}\n'),
    );
    apiSpy.importNamespace.and.returnValue(Promise.resolve([]));

    await component.onSaveClick();

    expect(apiSpy.importNamespace).toHaveBeenCalledTimes(1);
  });

  // ----- Advisory owner-or-admin pre-flight preserved (AC12) -----

  it('(22.1 AC12 / 14.3) owner can Save — import fires, no owner-block toast', async () => {
    authStub.currentUserValue = { user_id: 'alice', roles: [] };
    await loaded('namespace: foo\nuser_id: alice\nentries: {}\n');
    component.buffer = 'namespace: foo\nuser_id: alice\nentries:\n  x: 1\n';
    apiSpy.exportNamespace.and.returnValue(
      Promise.resolve('namespace: foo\nuser_id: alice\nentries: {}\n'),
    );
    apiSpy.importNamespace.and.returnValue(Promise.resolve([]));

    await component.onSaveClick();

    expect(apiSpy.importNamespace).toHaveBeenCalledTimes(1);
    const ownerBlocked = messageSpy.add.calls
      .allArgs()
      .some((args) => args[0]?.summary === 'Cannot save changes to this namespace');
    expect(ownerBlocked).toBeFalse();
  });

  it('(22.1 AC12 / 14.3) non-owner non-admin is blocked — no import, sticky toast', async () => {
    authStub.currentUserValue = { user_id: 'bob', roles: [] };
    await loaded('namespace: foo\nuser_id: alice\nentries: {}\n');
    component.buffer = 'namespace: foo\nuser_id: alice\nentries:\n  x: 1\n';
    apiSpy.importNamespace.and.returnValue(Promise.resolve([]));

    await component.onSaveClick();

    expect(apiSpy.importNamespace).not.toHaveBeenCalled();
    const toast = messageSpy.add.calls.mostRecent().args[0];
    expect(toast.severity).toBe('error');
    expect(toast.sticky).toBeTrue();
    expect(toast.summary).toBe('Cannot save changes to this namespace');
    expect(component.saving).toBeFalse();
  });

  it('(22.1 AC12 / 14.3) admin can Save another user\'s namespace — import fires', async () => {
    authStub.currentUserValue = { user_id: 'bob', roles: ['admin'] };
    await loaded('namespace: foo\nuser_id: alice\nentries: {}\n');
    component.buffer = 'namespace: foo\nuser_id: alice\nentries:\n  x: 1\n';
    apiSpy.exportNamespace.and.returnValue(
      Promise.resolve('namespace: foo\nuser_id: alice\nentries: {}\n'),
    );
    apiSpy.importNamespace.and.returnValue(Promise.resolve([]));

    await component.onSaveClick();

    expect(apiSpy.importNamespace).toHaveBeenCalledTimes(1);
  });

  it('(22.1 AC12 / 14.3) namespace-change guard still wins over ownership guard', async () => {
    authStub.currentUserValue = { user_id: 'bob', roles: [] };
    await loaded('namespace: foo\nuser_id: alice\nentries: {}\n');
    component.buffer = 'namespace: bar\nuser_id: alice\nentries: {}\n';

    await component.onSaveClick();

    expect(apiSpy.importNamespace).not.toHaveBeenCalled();
    const toast = messageSpy.add.calls.mostRecent().args[0];
    expect(toast.summary).toBe('Cannot change namespace on Save');
  });

  // ----- Save drift check (AC20, AC21) -----

  it('(22.1 AC20/AC21) Save with a matching server export imports without a drift prompt', async () => {
    await loaded('foo: 1\n');
    component.buffer = 'foo: 2\n';
    apiSpy.exportNamespace.and.returnValue(Promise.resolve('foo: 1\n'));
    apiSpy.importNamespace.and.returnValue(Promise.resolve([]));

    await component.onSaveClick();

    // Drift re-export ran (one extra export beyond the mount load) but no
    // confirm was shown.
    expect(apiSpy.exportNamespace).toHaveBeenCalledTimes(2);
    expect(confirmationSpy.confirm).not.toHaveBeenCalled();
    expect(apiSpy.importNamespace).toHaveBeenCalledOnceWith('foo: 2\n');
  });

  it('(22.1 AC20/AC21) Save with diverged server export prompts; reload-and-rebase skips the import and rebases', async () => {
    await loaded('foo: 1\n');
    component.buffer = 'foo: 2\n';
    // Server has drifted since load.
    apiSpy.exportNamespace.and.returnValue(Promise.resolve('foo: server\n'));
    apiSpy.importNamespace.and.returnValue(Promise.resolve([]));

    const savePromise = component.onSaveClick();
    // Let the drift re-export resolve so the confirm fires.
    await flushMicrotasks();
    expect(confirmationSpy.confirm).toHaveBeenCalledTimes(1);
    const args = confirmationSpy.confirm.calls.mostRecent().args[0];
    expect(args.header).toBe('Namespace modified');

    // accept = reload-and-rebase.
    args.accept!();
    await savePromise;

    // Import was NOT performed this click.
    expect(apiSpy.importNamespace).not.toHaveBeenCalled();
    // serverYaml rebased to the latest; buffer kept the operator's edit
    // (it had diverged from the old serverYaml, so it is preserved).
    expect(component.serverYaml).toBe('foo: server\n');
    expect(component.buffer).toBe('foo: 2\n');
    expect(component.saving).toBeFalse();
  });

  it('(22.1 AC21) drift reload-and-rebase moves the buffer when it still equalled the old serverYaml', async () => {
    await loaded('foo: 1\n');
    // Force a dirty gate so onSaveClick runs, but keep buffer === old
    // serverYaml at the moment the rebase fires by reverting after dirtying.
    component.buffer = 'foo: 2\n';
    apiSpy.exportNamespace.and.returnValue(Promise.resolve('foo: server\n'));

    const savePromise = component.onSaveClick();
    await flushMicrotasks();
    const args = confirmationSpy.confirm.calls.mostRecent().args[0];
    // Simulate buffer back at the old serverYaml right before accept.
    component.buffer = 'foo: 1\n';
    args.accept!();
    await savePromise;

    expect(component.serverYaml).toBe('foo: server\n');
    // buffer equalled the OLD serverYaml → moved to the fresh server YAML.
    expect(component.buffer).toBe('foo: server\n');
  });

  it('(22.1 AC21) Save with diverged server export — overwrite choice proceeds with the operator buffer', async () => {
    await loaded('foo: 1\n');
    component.buffer = 'foo: 2\n';
    apiSpy.exportNamespace.and.returnValue(Promise.resolve('foo: server\n'));
    apiSpy.importNamespace.and.returnValue(Promise.resolve([]));

    const savePromise = component.onSaveClick();
    await flushMicrotasks();
    const args = confirmationSpy.confirm.calls.mostRecent().args[0];
    // reject = overwrite → import proceeds with the operator's buffer.
    args.reject!();
    await savePromise;

    expect(apiSpy.importNamespace).toHaveBeenCalledOnceWith('foo: 2\n');
    expect(component.serverYaml).toBe('foo: 2\n');
  });

  it('(22.1 AC21) drift export network error falls through to import (non-blocking)', async () => {
    await loaded('foo: 1\n');
    component.buffer = 'foo: 2\n';
    apiSpy.exportNamespace.and.returnValue(Promise.reject(new Error('net')));
    apiSpy.importNamespace.and.returnValue(Promise.resolve([]));

    await component.onSaveClick();

    expect(confirmationSpy.confirm).not.toHaveBeenCalled();
    expect(apiSpy.importNamespace).toHaveBeenCalledOnceWith('foo: 2\n');
  });

  // ----- Destroy-during-save (AC13) -----

  it('(22.1) destroy-during-save — late-resolving import does not write state', async () => {
    await loaded('foo: 1\n');
    component.buffer = 'foo: 2\n';
    apiSpy.exportNamespace.and.returnValue(Promise.resolve('foo: 1\n'));
    let resolveLate!: (value: unknown) => void;
    apiSpy.importNamespace.and.returnValue(
      new Promise<unknown>((r) => {
        resolveLate = r;
      }) as unknown as Promise<never>,
    );

    const consoleErrorSpy = spyOn(console, 'error');
    const savePromise = component.onSaveClick();
    // Drain the drift re-export microtask so importNamespace is reached.
    await Promise.resolve();
    await Promise.resolve();
    expect(component.saving).toBe(true);

    fixture.destroy();

    resolveLate([]);
    await savePromise;
    await Promise.resolve();

    expect(component.serverYaml).toBe('foo: 1\n');
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // ADR-017 §2 — Reset is the only undo (AC14, AC15).
  // ---------------------------------------------------------------------

  it('(22.1 AC14) onCancelClick is removed from the component', async () => {
    await loaded('foo: 1\n');
    expect(
      (component as unknown as { onCancelClick?: unknown }).onCancelClick,
    ).toBeUndefined();
  });

  it('(22.1 AC15) onResetClick reverts behind the confirm, clearing validation state', async () => {
    await loaded('foo: 1\n');
    component.buffer = 'foo: 2\n';
    component.lastValidation = failingReport(1);
    component.rawSaveError = 'raw';

    component.onResetClick();
    expect(confirmationSpy.confirm).toHaveBeenCalledTimes(1);
    const args = confirmationSpy.confirm.calls.mostRecent().args[0];
    expect(args.message as string).toContain('Discard unsaved changes');

    args.accept!();
    expect(component.buffer).toBe('foo: 1\n');
    expect(component.lastValidation).toBeNull();
    expect(component.rawSaveError).toBeNull();
    expect(component.hasUnsavedChanges()).toBe(false);
  });

  it('(22.1 AC15) onResetClick is a no-op when clean (no confirm)', async () => {
    await loaded('foo: 1\n');

    component.onResetClick();

    expect(confirmationSpy.confirm).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // ADR-017 §4 — single Validate handler (AC17, AC18).
  // ---------------------------------------------------------------------

  function cleanReport(namespace = 'foo'): NamespaceValidationReport {
    return {
      namespace,
      ok: true,
      global_errors: [],
      entry_issues: [],
    };
  }

  it('(22.1 AC17) onValidatePersistedClick is removed; onValidateBufferClick is the single handler', async () => {
    await loaded('foo: 1\n');
    expect(
      (component as unknown as { onValidatePersistedClick?: unknown })
        .onValidatePersistedClick,
    ).toBeUndefined();
    expect(typeof component.onValidateBufferClick).toBe('function');
  });

  it('(22.1 AC17) Validate validates the buffer via validateNamespaceBuffer; clean state equals persisted', async () => {
    await loaded('foo: 1\n');
    // Clean: buffer === serverYaml, so the buffer-validate equals a
    // persisted-validate.
    apiSpy.validateNamespaceBuffer.and.returnValue(
      Promise.resolve(cleanReport()),
    );

    await component.onValidateBufferClick();

    expect(apiSpy.validateNamespaceBuffer).toHaveBeenCalledOnceWith('foo: 1\n');
    expect(apiSpy.validatePersistedNamespace).not.toHaveBeenCalled();
  });

  it('(22.1 AC17) Validate passes snapshot-at-click buffer; live edits post-click do NOT change args', async () => {
    await loaded('foo: 1\n');
    component.buffer = 'foo: 2\n';

    let resolveValidate!: (v: NamespaceValidationReport) => void;
    apiSpy.validateNamespaceBuffer.and.returnValue(
      new Promise<NamespaceValidationReport>((r) => {
        resolveValidate = r;
      }),
    );

    const validatePromise = component.onValidateBufferClick();
    component.buffer = 'foo: 99\n';
    resolveValidate(cleanReport());
    await validatePromise;

    expect(apiSpy.validateNamespaceBuffer).toHaveBeenCalledOnceWith('foo: 2\n');
    expect(component.lastValidation).toBeNull();
    expect(component.validationFlashBuffer).toBeTrue();
    expect(component.buffer).toBe('foo: 99\n');
  });

  it('(22.1 AC18) clean report flashes the Validate button green and announces; pane stays hidden', async () => {
    await loaded('foo: 1\n');
    apiSpy.validateNamespaceBuffer.and.returnValue(
      Promise.resolve(cleanReport()),
    );

    await component.onValidateBufferClick();
    fixture.detectChanges();

    expect(component.lastValidation).toBeNull();
    expect(component.validationFlashBuffer).toBeTrue();
    expect(component.a11yAnnouncement).toBe('Validation passed');
    const validateBtn = fixture.nativeElement.querySelector(
      'button[data-test="validate-btn"]',
    ) as HTMLButtonElement;
    expect(validateBtn.classList.contains('p-button-success')).toBeTrue();
  });

  it('(22.1 AC18) non-clean report populates lastValidation (findings pane renders)', async () => {
    await loaded('foo: 1\n');
    const report = failingReport(1, 0);
    apiSpy.validateNamespaceBuffer.and.returnValue(Promise.resolve(report));

    await component.onValidateBufferClick();

    expect(component.lastValidation).toEqual(report);
    expect(component.validationFlashBuffer).toBeFalse();
  });

  it('(22.1 AC18) clean-report flash auto-reverts after 2500ms', fakeAsync(() => {
    void buildFixture('foo');
    apiSpy.exportNamespace.and.returnValue(Promise.resolve('foo: 1\n'));
    apiSpy.validateNamespaceBuffer.and.returnValue(
      Promise.resolve(cleanReport()),
    );
    fixture.detectChanges();
    tick();

    void component.onValidateBufferClick();
    tick();
    expect(component.validationFlashBuffer).toBeTrue();
    tick(1000);
    expect(component.validationFlashBuffer).toBeTrue();
    tick(1600);
    expect(component.validationFlashBuffer).toBeFalse();
  }));

  it('(22.1 AC18) editing the buffer after a clean Validate clears the flash immediately', async () => {
    await loaded('foo: 1\n');
    component.buffer = 'foo: 2\n';
    apiSpy.validateNamespaceBuffer.and.returnValue(
      Promise.resolve(cleanReport()),
    );

    await component.onValidateBufferClick();
    expect(component.validationFlashBuffer).toBeTrue();

    component.onBufferChange('foo: 2\n# edited\n');

    expect(component.buffer).toBe('foo: 2\n# edited\n');
    expect(component.validationFlashBuffer).toBeFalse();
  });

  it('(22.1 AC17) Validate does NOT mutate serverYaml/buffer or call importNamespace', async () => {
    await loaded('foo: 1\n');
    component.buffer = 'foo: 2\n';
    apiSpy.validateNamespaceBuffer.and.returnValue(
      Promise.resolve(cleanReport()),
    );

    await component.onValidateBufferClick();

    expect(component.buffer).toBe('foo: 2\n');
    expect(component.serverYaml).toBe('foo: 1\n');
    expect(apiSpy.importNamespace).not.toHaveBeenCalled();
    expect(component.rawSaveError).toBeNull();
  });

  it('(22.1 AC18) Validate 422 structured → findings pane, no toast', async () => {
    await loaded('foo: 1\n');
    const report = failingReport(1, 0);
    apiSpy.validateNamespaceBuffer.and.returnValue(
      Promise.reject(makeHttpError(422, report)),
    );

    await component.onValidateBufferClick();

    expect(component.lastValidation).toEqual(report);
    expect(messageSpy.add).not.toHaveBeenCalled();
  });

  it('(22.1 AC18) Validate 422 non-report → generic toast', async () => {
    await loaded('foo: 1\n');
    component.buffer = 'garbage: [\n';
    apiSpy.validateNamespaceBuffer.and.returnValue(
      Promise.reject(makeHttpError(422, 'yaml parse error at line 5')),
    );

    await component.onValidateBufferClick();

    expect(component.lastValidation).toBeNull();
    expect(messageSpy.add).toHaveBeenCalled();
  });

  it('(22.1 AC18) Validate resolved to undefined → clear toast, not TypeError', async () => {
    await loaded('foo: 1\n');
    apiSpy.validateNamespaceBuffer.and.returnValue(
      Promise.resolve(undefined as unknown as NamespaceValidationReport),
    );

    await component.onValidateBufferClick();

    const call = messageSpy.add.calls.mostRecent().args[0];
    expect(call.summary).toBe('Validation failed');
    expect(call.detail).not.toContain("reading 'ok'");
  });

  it('(22.1 AC18) Validate 5xx — error toast, lastValidation unchanged, validating resets', async () => {
    await loaded('foo: 1\n');
    const prior = cleanReport();
    component.lastValidation = prior;
    apiSpy.validateNamespaceBuffer.and.returnValue(
      Promise.reject(makeHttpError(500)),
    );

    await component.onValidateBufferClick();

    expect(component.lastValidation).toBe(prior);
    expect(component.validating).toBe(false);
    const toast = messageSpy.add.calls.mostRecent().args[0];
    expect(toast.severity).toBe('error');
    expect(toast.summary).toBe('Validation failed');
    expect(toast.sticky).toBeFalsy();
  });

  it('(22.1 AC18) Validate 401 — no panel toast, state unchanged, validating resets', async () => {
    await loaded('foo: 1\n');
    const prior = cleanReport();
    component.lastValidation = prior;
    messageSpy.add.calls.reset();
    apiSpy.validateNamespaceBuffer.and.returnValue(
      Promise.reject(makeHttpError(401)),
    );

    await component.onValidateBufferClick();

    expect(component.lastValidation).toBe(prior);
    expect(component.validating).toBe(false);
    expect(messageSpy.add).not.toHaveBeenCalled();
  });

  it('(22.1) destroy-during-validate — late-resolving validate does not write state', async () => {
    await loaded('foo: 1\n');
    let resolveLate!: (v: NamespaceValidationReport) => void;
    apiSpy.validateNamespaceBuffer.and.returnValue(
      new Promise<NamespaceValidationReport>((r) => {
        resolveLate = r;
      }),
    );

    const consoleErrorSpy = spyOn(console, 'error');
    const validatePromise = component.onValidateBufferClick();
    expect(component.validating).toBe(true);

    fixture.destroy();

    resolveLate(failingReport(1));
    await validatePromise;
    await Promise.resolve();

    expect(component.lastValidation).toBeNull();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  // ----- onClearValidationClick nulls both fields -----

  it('(11.4 AC8) onClearValidationClick nulls lastValidation AND rawSaveError', async () => {
    await loaded('foo: 1\n');
    component.lastValidation = cleanReport();
    component.rawSaveError = 'some raw';

    component.onClearValidationClick();

    expect(component.lastValidation).toBeNull();
    expect(component.rawSaveError).toBeNull();
  });

  it('(11.4 AC8) ValidationReportComponent clearRequested output triggers onClearValidationClick', async () => {
    await loaded('foo: 1\n');
    component.lastValidation = cleanReport();
    component.rawSaveError = null;
    fixture.detectChanges();

    const clearBtn = fixture.nativeElement.querySelector(
      '[data-test="clear-results-btn"]',
    ) as HTMLButtonElement;
    expect(clearBtn).not.toBeNull();
    clearBtn.click();
    fixture.detectChanges();

    expect(component.lastValidation).toBeNull();
    expect(component.rawSaveError).toBeNull();
  });

  // ---------------------------------------------------------------------
  // ADR-017 §5 — FR14 gate retained, orthogonal to Validate (AC19).
  // ---------------------------------------------------------------------

  /** A non-clean validation report with a known finding count. */
  function failingReport(
    globalCount = 1,
    entryCount = 0,
  ): NamespaceValidationReport {
    return {
      namespace: 'foo',
      ok: false,
      global_errors: Array.from(
        { length: globalCount },
        (_, i) => `global error ${i}`,
      ),
      entry_issues: Array.from({ length: entryCount }, (_, i) => ({
        entry_id: `entry-${i}`,
        kind: 'agent',
        errors: ['bad'],
      })),
    };
  }

  it('(22.1 AC19) isSaveGated / isCloneGated retain their bodies (known-bad report or rawSaveError)', async () => {
    await loaded('foo: 1\n');

    expect(component.isSaveGated).toBeFalse();
    expect(component.isCloneGated).toBeFalse();

    component.lastValidation = failingReport(2, 0);
    expect(component.isSaveGated).toBeTrue();
    expect(component.isCloneGated).toBeTrue();

    component.lastValidation = null;
    component.rawSaveError = 'raw';
    expect(component.isSaveGated).toBeTrue();
    expect(component.isCloneGated).toBeTrue();
  });

  it('(22.1 AC19) onBufferChange clears rawSaveError unconditionally (gate auto-lifts)', async () => {
    await loaded('foo: 1\n');
    component.buffer = 'foo: 2\n';
    component.lastValidation = null;
    component.rawSaveError = 'stale raw error';
    expect(component.isSaveGated).toBeTrue();

    component.onBufferChange('foo: 3\n');

    expect(component.rawSaveError).toBeNull();
    expect(component.isSaveGated).toBeFalse();
    expect(component.isCloneGated).toBeFalse();
  });

  it('(22.1 AC19) onClearValidationClick lifts the gate', async () => {
    await loaded('foo: 1\n');
    component.buffer = 'foo: 2\n';
    component.lastValidation = failingReport(1);
    component.rawSaveError = 'raw';
    expect(component.isSaveGated).toBeTrue();

    component.onClearValidationClick();

    expect(component.isSaveGated).toBeFalse();
    expect(component.isCloneGated).toBeFalse();
  });

  it('(22.1 AC19) a successful Save (2xx) lifts the gate', async () => {
    await loaded('foo: 1\n');
    component.buffer = 'foo: 2\n';
    component.lastValidation = failingReport(1);
    apiSpy.exportNamespace.and.returnValue(Promise.resolve('foo: 1\n'));
    apiSpy.importNamespace.and.returnValue(Promise.resolve([]));

    await component.onSaveClick();

    expect(component.lastValidation).toBeNull();
    expect(component.rawSaveError).toBeNull();
    expect(component.serverYaml).toBe('foo: 2\n');
    expect(component.isSaveGated).toBeFalse();
  });

  it('(22.1 AC19) saveTooltip/cloneTooltip describe the gate only when it is the active disable reason', async () => {
    await loaded('foo: 1\n');
    component.buffer = 'foo: 2\n';
    component.lastValidation = failingReport(1);

    expect(component.saveTooltip).toBe('Fix validation issues before saving.');

    // Clone tooltip surfaces in a clean state (Clone enabled only when clean).
    component.buffer = component.serverYaml;
    expect(component.cloneTooltip).toBe('Fix validation issues before cloning.');
  });

  it('(22.1 AC19) saveTooltip returns undefined when the gate is not the active disable reason', async () => {
    await loaded('foo: 1\n');
    component.buffer = component.serverYaml; // clean — disabled by dirtiness
    component.lastValidation = null;
    component.rawSaveError = null;

    expect(component.saveTooltip).toBeUndefined();
  });

  // ---------------------------------------------------------------------
  // Clone flow (ADR-012 modal unchanged; gated on clean — ADR-017 §3).
  // ---------------------------------------------------------------------

  const cloneSrcYaml = `namespace: src
user_id: null
entries:
  team-1:
    kind: team
    model_type: BaseTeamModel
    payload:
      description: "configured for src namespace"
`;

  async function loadedWithCloneSrc(
    existing: string[] = ['src'],
  ): Promise<void> {
    apiSpy.exportNamespace.and.returnValue(Promise.resolve(cloneSrcYaml));
    await buildFixture('src');
    fixture.componentRef.setInput('existingNamespaces', existing);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  it('(11.5 AC1) Clone button is present in the loaded (clean) state', async () => {
    await loadedWithCloneSrc();
    const btn = fixture.nativeElement.querySelector(
      'button[data-test="clone-btn"]',
    ) as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.disabled).toBeFalse();
  });

  it('(22.1 AC16) onCloneClick opens the dialog from a clean state without a network call', async () => {
    await loadedWithCloneSrc();
    const bufferBefore = component.buffer;
    const serverYamlBefore = component.serverYaml;
    apiSpy.importNamespace.calls.reset();

    component.onCloneClick();
    fixture.detectChanges();

    expect(component.cloneDialogVisible).toBeTrue();
    expect(component.buffer).toBe(bufferBefore);
    expect(component.serverYaml).toBe(serverYamlBefore);
    expect(apiSpy.importNamespace).not.toHaveBeenCalled();
  });

  it('(22.1 AC16) the outer Clone button is disabled while dirty', async () => {
    await loadedWithCloneSrc();
    component.buffer = cloneSrcYaml + '# dirty\n';
    fixture.detectChanges();

    const btn = fixture.nativeElement.querySelector(
      'button[data-test="clone-btn"]',
    ) as HTMLButtonElement;
    expect(btn.disabled).toBeTrue();
  });

  it('(11.5 AC2) onCloneClick is a no-op when cloning === true', async () => {
    await loadedWithCloneSrc();
    component.cloning = true;
    component.cloneDialogVisible = false;

    component.onCloneClick();

    expect(component.cloneDialogVisible).toBeFalse();
  });

  // ----- Clone modal pre-flight validation (AC4) -----

  it('(11.5 AC4) Confirm disabled — empty destNs', async () => {
    await loadedWithCloneSrc();
    component.onCloneClick();
    component.cloneDestNs = '';
    fixture.detectChanges();

    expect(component.cloneConfirmDisabled).toBeTrue();
    expect(component.cloneValidationError).toBe(
      'Destination namespace required',
    );
  });

  it('(11.5 AC4) Confirm disabled — destNs equals source namespace', async () => {
    await loadedWithCloneSrc();
    component.onCloneClick();
    component.cloneDestNs = 'src';

    expect(component.cloneConfirmDisabled).toBeTrue();
    expect(component.cloneValidationError).toBe(
      'Destination must differ from source namespace',
    );
  });

  it('(11.5 AC4) Confirm disabled — destNs collides with existingNamespaces', async () => {
    await loadedWithCloneSrc(['src', 'already-there']);
    component.onCloneClick();
    component.cloneDestNs = 'already-there';

    expect(component.cloneConfirmDisabled).toBeTrue();
    expect(component.cloneValidationError).toBe(
      "Namespace 'already-there' already exists",
    );
  });

  it('(11.5 AC4) Confirm disabled while cloning === true', async () => {
    await loadedWithCloneSrc();
    component.onCloneClick();
    component.cloneDestNs = 'dst';
    component.cloning = true;

    expect(component.cloneConfirmDisabled).toBeTrue();
  });

  it('(11.5 AC4) Confirm enabled when all checks pass', async () => {
    await loadedWithCloneSrc();
    component.onCloneClick();
    component.cloneDestNs = 'dst';

    expect(component.cloneConfirmDisabled).toBeFalse();
    expect(component.cloneValidationError).toBeNull();
  });

  // ----- Clone Confirm happy path -----

  it('(11.5 AC8+12+14) Clone Confirm happy path — import then re-export, land on destNs clean', async () => {
    await loadedWithCloneSrc(['src']);
    apiSpy.importNamespace.and.returnValue(Promise.resolve([]));

    const exportedFresh = 'namespace: dst\nuser_id: null\nentries: {}\n';
    apiSpy.exportNamespace.and.callFake((ns: string) =>
      Promise.resolve(ns === 'dst' ? exportedFresh : cloneSrcYaml),
    );
    const savedEmit = spyOn(component.saved, 'emit');

    component.onCloneClick();
    component.cloneDestNs = 'dst';
    await component.onCloneConfirmClick();
    await fixture.whenStable();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(apiSpy.importNamespace).toHaveBeenCalledTimes(1);
    expect(apiSpy.exportNamespace).toHaveBeenCalledTimes(2);
    expect(apiSpy.exportNamespace.calls.mostRecent().args).toEqual([
      'dst',
      { all: false },
    ]);
    expect(component.namespace).toBe('dst');
    expect(component.hasUnsavedChanges()).toBe(false);
    expect(component.cloneDialogVisible).toBeFalse();
    expect(component.cloneDestNs).toBe('');
    expect(component.cloning).toBeFalse();
    expect(savedEmit).toHaveBeenCalledTimes(1);
    const toasts = messageSpy.add.calls.allArgs().map((a) => a[0]);
    const success = toasts.find((t) => t.severity === 'success');
    expect(success).toBeDefined();
    expect(success!.summary).toContain("'dst'");
  });

  it('(11.5 AC5) onCloneConfirmClick captures the buffer (== server bundle when clean) as the clone source', async () => {
    await loadedWithCloneSrc();
    apiSpy.importNamespace.and.returnValue(Promise.resolve([]));
    apiSpy.exportNamespace.and.returnValue(
      Promise.resolve('namespace: dst\nuser_id: null\nentries: {}\n'),
    );

    component.onCloneClick();
    component.cloneDestNs = 'dst';
    await component.onCloneConfirmClick();
    await fixture.whenStable();

    expect(apiSpy.importNamespace).toHaveBeenCalledTimes(1);
    const sent = apiSpy.importNamespace.calls.mostRecent().args[0] as string;
    const parsed = yaml.load(sent) as Record<string, unknown>;
    expect(parsed['namespace']).toBe('dst');
    const entries = parsed['entries'] as Record<string, unknown>;
    expect(entries['team-1']).toBeDefined();
  });

  it('(11.5 AC9 + 11.7 AC20) Clone 422 structured — lastValidation populated, modal closes, source intact', async () => {
    await loadedWithCloneSrc();
    const report = failingReport(1, 0);
    apiSpy.importNamespace.and.returnValue(
      Promise.reject(makeHttpError(422, report)),
    );

    component.onCloneClick();
    component.cloneDestNs = 'dst';
    await component.onCloneConfirmClick();

    expect(component.lastValidation).toEqual(report);
    expect(component.rawSaveError).toBeNull();
    expect(component.cloneDialogVisible).toBeFalse();
    expect(component.cloneDestNs).toBe('');
    expect(component.namespace).toBe('src');
    expect(component.buffer).toBe(cloneSrcYaml);
    expect(component.serverYaml).toBe(cloneSrcYaml);
    expect(component.cloning).toBeFalse();
  });

  it('(11.5 AC9 + 11.7 AC21) Clone 422 unstructured — cloneInlineError populated, modal stays open', async () => {
    await loadedWithCloneSrc();
    apiSpy.importNamespace.and.returnValue(
      Promise.reject(makeHttpError(422, 'FastAPI detail string')),
    );

    component.onCloneClick();
    component.cloneDestNs = 'dst';
    await component.onCloneConfirmClick();

    expect(component.cloneInlineError).toBe('FastAPI detail string');
    expect(component.rawSaveError).toBeNull();
    expect(component.lastValidation).toBeNull();
    expect(component.cloneDialogVisible).toBeTrue();
    expect(component.cloning).toBeFalse();
  });

  it('(11.5 AC9+10) Clone 5xx — sticky toast, lastCloneError populated, source intact', async () => {
    await loadedWithCloneSrc();
    apiSpy.importNamespace.and.returnValue(
      Promise.reject(makeHttpError(500, '')),
    );
    messageSpy.add.calls.reset();

    component.onCloneClick();
    component.cloneDestNs = 'dst';
    await component.onCloneConfirmClick();

    expect(component.lastCloneError).not.toBeNull();
    expect(component.cloning).toBeFalse();
    expect(component.cloneDialogVisible).toBeTrue();
    expect(component.namespace).toBe('src');
    expect(component.serverYaml).toBe(cloneSrcYaml);
    const lastToast = messageSpy.add.calls.mostRecent().args[0];
    expect(lastToast.severity).toBe('error');
    expect(lastToast.sticky).toBeTrue();
  });

  it('(11.5 AC9) Clone 401 — no panel toast, dialog stays open, cloning resets', async () => {
    await loadedWithCloneSrc();
    apiSpy.importNamespace.and.returnValue(Promise.reject(makeHttpError(401)));
    messageSpy.add.calls.reset();

    component.onCloneClick();
    component.cloneDestNs = 'dst';
    await component.onCloneConfirmClick();

    expect(messageSpy.add).not.toHaveBeenCalled();
    expect(component.cloning).toBeFalse();
    expect(component.cloneDialogVisible).toBeTrue();
    expect(component.lastCloneError).toBeNull();
  });

  it('(11.5 AC11) CloneYamlError — no import call, toast fired, cloning resets, lastCloneError NOT set', async () => {
    await loadedWithCloneSrc();
    // A buffer that is not a valid bundle root mapping forces
    // rewriteNamespaceInYaml to throw CloneYamlError before the network call.
    // Set it directly (Clone reads this.buffer); the gate is bypassed by
    // calling onCloneConfirmClick after opening the modal.
    component.onCloneClick();
    component.buffer = '- not a mapping\n';
    component.cloneDestNs = 'dst';
    apiSpy.importNamespace.calls.reset();
    messageSpy.add.calls.reset();

    await component.onCloneConfirmClick();

    expect(apiSpy.importNamespace).not.toHaveBeenCalled();
    expect(component.cloning).toBeFalse();
    expect(component.lastCloneError).toBeNull();
    expect(messageSpy.add).toHaveBeenCalledTimes(1);
    const toast = messageSpy.add.calls.mostRecent().args[0];
    expect(toast.severity).toBe('error');
  });

  it('(11.5 AC14) NFR7 — clone happy path = 1 import + 2 exports total, no validate calls', async () => {
    await loadedWithCloneSrc();
    apiSpy.importNamespace.and.returnValue(Promise.resolve([]));
    apiSpy.exportNamespace.and.callFake((ns: string) =>
      Promise.resolve(`namespace: ${ns}\nuser_id: null\nentries: {}\n`),
    );

    component.onCloneClick();
    component.cloneDestNs = 'dst';
    await component.onCloneConfirmClick();
    await fixture.whenStable();
    await fixture.whenStable();

    expect(apiSpy.importNamespace).toHaveBeenCalledTimes(1);
    expect(apiSpy.exportNamespace).toHaveBeenCalledTimes(2);
    expect(apiSpy.validateNamespaceBuffer).not.toHaveBeenCalled();
    expect(apiSpy.validatePersistedNamespace).not.toHaveBeenCalled();
  });

  it('(11.5 AC16) destroy-during-clone — late-resolving import does not write state', async () => {
    await loadedWithCloneSrc();
    let resolveLate!: (value: unknown) => void;
    apiSpy.importNamespace.and.returnValue(
      new Promise<unknown>((r) => {
        resolveLate = r;
      }) as unknown as Promise<never>,
    );
    apiSpy.exportNamespace.and.returnValue(
      Promise.resolve('namespace: dst\nuser_id: null\nentries: {}\n'),
    );

    const consoleErrorSpy = spyOn(console, 'error');
    component.onCloneClick();
    component.cloneDestNs = 'dst';
    const clonePromise = component.onCloneConfirmClick();
    expect(component.cloning).toBeTrue();

    fixture.destroy();

    resolveLate([]);
    await clonePromise;
    await Promise.resolve();

    expect(component.namespace).toBe('src');
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('(11.7 AC7) Clone modal Confirm button is gated by isCloneGated', async () => {
    await loadedWithCloneSrc(['src']);
    component.onCloneClick();
    component.cloneDestNs = 'valid-new-ns';
    expect(component.cloneConfirmDisabled).toBeFalse();

    component.lastValidation = failingReport(1);
    expect(component.cloneConfirmDisabled).toBeTrue();
  });

  // ----- Clone modal a11y handlers -----

  it('(11.7 AC18) onCloneDialogHide clears cloneDestNs and cloneInlineError', async () => {
    await loadedWithCloneSrc(['src']);
    component.onCloneClick();
    component.cloneDestNs = 'something';
    component.cloneInlineError = 'pending error';

    component.onCloneDialogHide();

    expect(component.cloneDestNs).toBe('');
    expect(component.cloneInlineError).toBeNull();
  });

  it('(11.7 AC19) onCloneDialogHide returns focus to the outer Clone button', fakeAsync(async () => {
    await loadedWithCloneSrc(['src']);
    fixture.detectChanges();

    const cloneBtn = fixture.nativeElement.querySelector(
      'button[data-test="clone-btn"]',
    ) as HTMLButtonElement;
    component.cloneBtnRef = {
      nativeElement: cloneBtn,
    } as ElementRef<HTMLButtonElement>;

    component.onCloneDialogHide();
    tick(0);

    expect(document.activeElement).toBe(cloneBtn);
  }));

  it('(11.7 AC16) onCloneDialogShow focuses the destination input via cloneDestInputRef', fakeAsync(async () => {
    await loadedWithCloneSrc(['src']);
    component.onCloneClick();
    fixture.detectChanges();

    const stub = document.createElement('input');
    document.body.appendChild(stub);
    component.cloneDestInputRef = {
      nativeElement: stub,
    } as ElementRef<HTMLInputElement>;

    component.onCloneDialogShow();
    tick(0);

    expect(document.activeElement).toBe(stub);
    document.body.removeChild(stub);
  }));

  it('(11.7 AC21) onCloneDestNsChange clears cloneInlineError', async () => {
    await loadedWithCloneSrc(['src']);
    component.cloneInlineError = 'stale error';

    component.onCloneDestNsChange();

    expect(component.cloneInlineError).toBeNull();
  });

  // ---------------------------------------------------------------------
  // a11y live region.
  // ---------------------------------------------------------------------

  it('(11.7 AC12) failing Validate sets a11yAnnouncement to "Validation found N issues"', async () => {
    await loaded('foo: 1\n');
    apiSpy.validateNamespaceBuffer.and.returnValue(
      Promise.resolve(failingReport(3, 2)),
    );

    await component.onValidateBufferClick();
    fixture.detectChanges();

    expect(component.a11yAnnouncement).toBe('Validation found 5 issues');
    const liveRegion = fixture.nativeElement.querySelector(
      '[data-test="a11y-live-region"]',
    ) as HTMLElement;
    expect(liveRegion.textContent?.trim()).toBe('Validation found 5 issues');
  });

  it('(11.7 AC12) Save 422 structured branch announces "Validation found N issues"', async () => {
    await loaded('foo: 1\n');
    component.buffer = 'foo: 2\n';
    apiSpy.exportNamespace.and.returnValue(Promise.resolve('foo: 1\n'));
    apiSpy.importNamespace.and.returnValue(
      Promise.reject(makeHttpError(422, failingReport(1, 0))),
    );

    await component.onSaveClick();

    expect(component.a11yAnnouncement).toBe('Validation found 1 issues');
  });

  it('(11.7 AC14) Clone Confirm 2xx sets a11yAnnouncement to "Cloned to namespace \'X\'"', async () => {
    await loadedWithCloneSrc(['src']);
    apiSpy.importNamespace.and.returnValue(Promise.resolve([]));
    apiSpy.exportNamespace.and.returnValue(
      Promise.resolve('namespace: new-ns\nuser_id: null\nentries: {}\n'),
    );
    component.onCloneClick();
    component.cloneDestNs = 'new-ns';

    await component.onCloneConfirmClick();
    await fixture.whenStable();

    expect(component.a11yAnnouncement).toBe("Cloned to namespace 'new-ns'");
  });

  it('(11.7 AC15) live region is visually-hidden but present in the DOM', async () => {
    await loaded('foo: 1\n');
    fixture.detectChanges();

    const liveRegion = fixture.nativeElement.querySelector(
      '[data-test="a11y-live-region"]',
    ) as HTMLElement;
    expect(liveRegion).not.toBeNull();
    expect(liveRegion.getAttribute('role')).toBe('status');
    expect(liveRegion.getAttribute('aria-live')).toBe('polite');
    expect(liveRegion.getAttribute('aria-atomic')).toBe('true');

    const styles = window.getComputedStyle(liveRegion);
    expect(styles.position).toBe('absolute');
    expect(styles.width).toBe('1px');
    expect(styles.height).toBe('1px');
    expect(styles.overflow).toBe('hidden');
  });

  // ---------------------------------------------------------------------
  // Delete flow (Story 14.1 / ADR-028 frontend leg) — always available.
  // ---------------------------------------------------------------------

  it('(14.1 AC11) Delete button renders whenever the panel has content', async () => {
    await loaded('foo: 1\n');
    const btn = fixture.nativeElement.querySelector(
      'button[data-test="delete-ns-btn"]',
    );
    expect(btn).not.toBeNull();
  });

  it('(14.1 AC11) Delete button is present even when dirty (orthogonal to dirty)', async () => {
    await loaded('foo: 1\n');
    component.buffer = 'foo: 2\n';
    fixture.detectChanges();
    const btn = fixture.nativeElement.querySelector(
      'button[data-test="delete-ns-btn"]',
    ) as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.disabled).toBeFalse();
  });

  it('(14.1 AC12) clicking Delete opens the confirmation; accepting calls deleteNamespace once', async () => {
    await loaded('foo: 1\n');
    apiSpy.deleteNamespace.and.returnValue(Promise.resolve());

    component.onDeleteClick();
    expect(confirmationSpy.confirm).toHaveBeenCalledTimes(1);
    const args = confirmationSpy.confirm.calls.mostRecent().args[0];
    expect(args.header).toBe('Delete namespace');
    expect(args.icon).toBe('pi pi-trash');
    expect(args.message as string).toContain('foo');

    args.accept!();
    await fixture.whenStable();

    expect(apiSpy.deleteNamespace).toHaveBeenCalledOnceWith('foo');
  });

  it('(14.1 AC13) 204 success — emits saved + closed and shows a success toast', async () => {
    await loaded('foo: 1\n');
    apiSpy.deleteNamespace.and.returnValue(Promise.resolve());
    const savedEmit = spyOn(component.saved, 'emit');
    const closedEmit = spyOn(component.closed, 'emit');

    await component.onDeleteConfirm();

    expect(apiSpy.deleteNamespace).toHaveBeenCalledOnceWith('foo');
    expect(savedEmit).toHaveBeenCalledTimes(1);
    expect(closedEmit).toHaveBeenCalledTimes(1);
    expect(component.deleting).toBeFalse();
    const toast = messageSpy.add.calls.mostRecent().args[0];
    expect(toast.severity).toBe('success');
    expect(component.a11yAnnouncement).toBe("Namespace 'foo' deleted");
  });

  it('(14.1 AC14) 403 — not-authorized toast, panel open, state unchanged, single call', async () => {
    await loaded('foo: 1\n');
    const savedEmit = spyOn(component.saved, 'emit');
    apiSpy.deleteNamespace.and.returnValue(Promise.reject(makeHttpError(403)));
    messageSpy.add.calls.reset();

    await component.onDeleteConfirm();

    expect(apiSpy.deleteNamespace).toHaveBeenCalledTimes(1);
    expect(savedEmit).not.toHaveBeenCalled();
    expect(component.serverYaml).toBe('foo: 1\n');
    expect(component.buffer).toBe('foo: 1\n');
    expect(component.deleting).toBeFalse();
    const toast = messageSpy.add.calls.mostRecent().args[0];
    expect(toast.severity).toBe('error');
    expect(toast.summary).toContain('not authorized');
    expect(toast.sticky).toBeFalsy();
  });

  it('(14.1 AC15) 422 structured NamespaceValidationReport — findings surfaced, panel open', async () => {
    await loaded('foo: 1\n');
    const report = failingReport(1, 0);
    apiSpy.deleteNamespace.and.returnValue(
      Promise.reject(makeHttpError(422, report)),
    );

    await component.onDeleteConfirm();

    expect(component.lastValidation).toEqual(report);
    expect(component.rawSaveError).toBeNull();
    expect(component.serverYaml).toBe('foo: 1\n');
    expect(component.a11yAnnouncement).toBe('Validation found 1 issues');
  });

  it('(14.1 AC15) 409 with unstructured body — error toast surfaces the detail, panel open', async () => {
    await loaded('foo: 1\n');
    apiSpy.deleteNamespace.and.returnValue(
      Promise.reject(makeHttpError(409, 'referenced by namespace bar')),
    );
    messageSpy.add.calls.reset();

    await component.onDeleteConfirm();

    expect(component.lastValidation).toBeNull();
    const toast = messageSpy.add.calls.mostRecent().args[0];
    expect(toast.severity).toBe('error');
    expect(toast.detail).toContain('referenced by namespace bar');
  });

  it('(14.1 AC9) Delete 401 — no panel toast, state unchanged', async () => {
    await loaded('foo: 1\n');
    apiSpy.deleteNamespace.and.returnValue(Promise.reject(makeHttpError(401)));
    messageSpy.add.calls.reset();

    await component.onDeleteConfirm();

    expect(messageSpy.add).not.toHaveBeenCalled();
    expect(component.serverYaml).toBe('foo: 1\n');
    expect(component.deleting).toBeFalse();
  });

  it('(14.1 AC16) in-flight guard — button disabled while deleting; second confirm does not fire a second call', async () => {
    await loaded('foo: 1\n');
    let resolveDelete!: () => void;
    apiSpy.deleteNamespace.and.returnValue(
      new Promise<void>((r) => {
        resolveDelete = r;
      }),
    );

    const firstCall = component.onDeleteConfirm();
    expect(component.deleting).toBeTrue();
    fixture.detectChanges();

    const btn = fixture.nativeElement.querySelector(
      'button[data-test="delete-ns-btn"]',
    ) as HTMLButtonElement;
    expect(btn.disabled).toBeTrue();

    void component.onDeleteConfirm();
    component.onDeleteClick();
    expect(confirmationSpy.confirm).not.toHaveBeenCalled();

    resolveDelete();
    await firstCall;

    expect(apiSpy.deleteNamespace).toHaveBeenCalledTimes(1);
    expect(component.deleting).toBeFalse();
  });

  it('(14.1 AC10) onDeleteClick is a no-op while a delete is in flight', async () => {
    await loaded('foo: 1\n');
    component.deleting = true;

    component.onDeleteClick();

    expect(confirmationSpy.confirm).not.toHaveBeenCalled();
  });

  it('(14.1 AC10) destroy-during-delete — late resolution does not write state', async () => {
    await loaded('foo: 1\n');
    let resolveLate!: () => void;
    apiSpy.deleteNamespace.and.returnValue(
      new Promise<void>((r) => {
        resolveLate = r;
      }),
    );
    const savedEmit = spyOn(component.saved, 'emit');
    const consoleErrorSpy = spyOn(console, 'error');

    const deletePromise = component.onDeleteConfirm();
    expect(component.deleting).toBeTrue();

    fixture.destroy();
    resolveLate();
    await deletePromise;
    await Promise.resolve();

    expect(savedEmit).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // Story 12.2 — Clone modal shareable / public toggles (modal unchanged).
  // ---------------------------------------------------------------------

  const cloneSrcYamlWithFlags = `namespace: src
name: Src
shareable: true
public: false
entries: {}
`;

  it('(12.2 AC7) cloneShareable / clonePublic initialize to false', async () => {
    await loadedWithCloneSrc();
    expect(component.cloneShareable).toBeFalse();
    expect(component.clonePublic).toBeFalse();
  });

  it('(12.2 AC7) onCloneCancelClick resets both toggles to false', async () => {
    await loadedWithCloneSrc();
    component.cloneShareable = true;
    component.clonePublic = true;

    component.onCloneCancelClick();

    expect(component.cloneShareable).toBeFalse();
    expect(component.clonePublic).toBeFalse();
  });

  it('(12.2 AC7) onCloneDialogVisibleChange(false) resets both toggles to false', async () => {
    await loadedWithCloneSrc();
    component.cloneShareable = true;
    component.clonePublic = true;

    component.onCloneDialogVisibleChange(false);

    expect(component.cloneShareable).toBeFalse();
    expect(component.clonePublic).toBeFalse();
  });

  it('(12.2 AC7) onCloneDialogHide resets both toggles to false', async () => {
    await loadedWithCloneSrc();
    component.cloneShareable = true;
    component.clonePublic = true;

    component.onCloneDialogHide();

    expect(component.cloneShareable).toBeFalse();
    expect(component.clonePublic).toBeFalse();
  });

  it('(12.2 AC8) onCloneClick pre-fills both toggles from the buffer flags', async () => {
    apiSpy.exportNamespace.and.returnValue(
      Promise.resolve(cloneSrcYamlWithFlags),
    );
    await buildFixture('src');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    component.onCloneClick();

    expect(component.cloneShareable).toBeTrue();
    expect(component.clonePublic).toBeFalse();
    expect(component.cloneDestNs).toMatch(/^src_/);
    expect(component.cloneDestName).toBe('Src_copy');
  });

  it('(12.2 AC8) onCloneClick defaults both toggles to false when the buffer omits the flags', async () => {
    await loadedWithCloneSrc();
    component.cloneShareable = true;
    component.clonePublic = true;

    component.onCloneClick();

    expect(component.cloneShareable).toBeFalse();
    expect(component.clonePublic).toBeFalse();
  });

  it('(12.2 AC9) onCloneConfirmClick passes both toggle values into the import YAML', async () => {
    await loadedWithCloneSrc(['src']);
    apiSpy.importNamespace.and.returnValue(Promise.resolve([]));
    apiSpy.exportNamespace.and.callFake((ns: string) =>
      Promise.resolve(`namespace: ${ns}\nuser_id: null\nentries: {}\n`),
    );

    component.onCloneClick();
    component.cloneDestNs = 'dst';
    component.cloneDestName = 'Dest';
    component.cloneShareable = true;
    component.clonePublic = false;

    await component.onCloneConfirmClick();
    await fixture.whenStable();

    expect(apiSpy.importNamespace).toHaveBeenCalledTimes(1);
    const sent = apiSpy.importNamespace.calls.mostRecent().args[0] as string;
    const parsed = yaml.load(sent) as Record<string, unknown>;
    expect(parsed['shareable']).toBe(true);
    expect(parsed['public']).toBe(false);
    expect(parsed['namespace']).toBe('dst');
    expect(parsed['name']).toBe('Dest');
    expect(component.cloneShareable).toBeFalse();
    expect(component.clonePublic).toBeFalse();
  });

  it('(12.2 AC10) toggle combinations never change cloneConfirmDisabled or cloneValidationError', async () => {
    await loadedWithCloneSrc(['src']);
    component.onCloneClick();
    component.cloneDestNs = 'dst';
    component.cloneDestName = 'Dest';

    const combos: [boolean, boolean][] = [
      [true, true],
      [true, false],
      [false, true],
      [false, false],
    ];
    for (const [s, p] of combos) {
      component.cloneShareable = s;
      component.clonePublic = p;
      expect(component.cloneConfirmDisabled).toBeFalse();
      expect(component.cloneValidationError).toBeNull();
    }
  });

  it('(12.2 AC11) both toggles render after the inputs with distinguishing hints', async () => {
    await loadedWithCloneSrc(['src']);
    component.onCloneClick();
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    const shareable = root.querySelector(
      '[data-test="clone-shareable-toggle"]',
    );
    const isPublic = root.querySelector('[data-test="clone-public-toggle"]');
    expect(shareable).not.toBeNull();
    expect(isPublic).not.toBeNull();

    const ordered = Array.from(
      root.querySelectorAll(
        '[data-test="clone-destname-input"],' +
          '[data-test="clone-destns-input"],' +
          '[data-test="clone-shareable-toggle"],' +
          '[data-test="clone-public-toggle"]',
      ),
    ).map((el) => el.getAttribute('data-test'));
    expect(ordered).toEqual([
      'clone-destname-input',
      'clone-destns-input',
      'clone-shareable-toggle',
      'clone-public-toggle',
    ]);

    expect(
      root.querySelector('label[for="clone-shareable-toggle"]'),
    ).not.toBeNull();
    expect(
      root.querySelector('label[for="clone-public-toggle"]'),
    ).not.toBeNull();

    const shareableHint =
      root.querySelector('#clone-shareable-hint')?.textContent?.toLowerCase() ??
      '';
    const publicHint =
      root.querySelector('#clone-public-hint')?.textContent?.toLowerCase() ??
      '';
    expect(shareableHint).toContain('reference');
    expect(shareableHint).not.toContain('clone');
    expect(publicHint).toContain('clone');
    expect(publicHint).toMatch(/list|read/);
  });
});
