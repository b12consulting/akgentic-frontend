import { CommonModule } from '@angular/common';
import { Component, forwardRef, Input } from '@angular/core';
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

import { NamespaceValidationReport } from '../../../models/catalog.interface';
import { ApiService } from '../../../services/api.service';
import { HttpError } from '../../../services/fetch.service';
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

describe('NamespacePanelComponent', () => {
  let fixture: ComponentFixture<NamespacePanelComponent>;
  let component: NamespacePanelComponent;
  let apiSpy: jasmine.SpyObj<ApiService>;
  let messageSpy: jasmine.SpyObj<MessageService>;
  let confirmationSpy: jasmine.SpyObj<ConfirmationService>;

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
    ]);
    messageSpy = jasmine.createSpyObj('MessageService', ['add']);
    // Use a REAL ConfirmationService instance (its `requireConfirmation$`
    // Subject is wired) and spy on `.confirm` — PrimeNG's `<p-confirmDialog>`
    // subscribes to `requireConfirmation$` on instantiation, so a bare
    // `jasmine.createSpyObj` breaks the constructor.
    confirmationSpy =
      new ConfirmationService() as jasmine.SpyObj<ConfirmationService>;
    spyOn(confirmationSpy, 'confirm').and.callThrough();

    await TestBed.configureTestingModule({
      imports: [NamespacePanelComponent, NoopAnimationsModule],
      providers: [
        { provide: ApiService, useValue: apiSpy },
        { provide: MessageService, useValue: messageSpy },
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
            StubMonacoEditorComponent,
            ValidationReportComponent,
          ],
          // Swap the locally-provided real ConfirmationService for a spy so
          // the Cancel + confirm-dialog flow is testable deterministically.
          providers: [
            { provide: ConfirmationService, useValue: confirmationSpy },
          ],
        },
      })
      .compileComponents();
  });

  // ---------------------------------------------------------------------
  // Story 11.2 load/view-mode tests carried forward from the prior spec.
  // ---------------------------------------------------------------------

  it('(AC13) load flow (happy path) — populates serverYaml/buffer and clears loading', async () => {
    apiSpy.exportNamespace.and.returnValue(Promise.resolve('key: value\n'));

    await buildFixture('foo');
    fixture.detectChanges(); // triggers ngOnInit
    await fixture.whenStable();
    fixture.detectChanges();

    expect(apiSpy.exportNamespace).toHaveBeenCalledOnceWith('foo');
    expect(component.serverYaml).toBe('key: value\n');
    expect(component.buffer).toBe('key: value\n');
    expect(component.mode).toBe('view');
    expect(component.lastValidation).toBeNull();
    expect(component.loading).toBe(false);
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
    expect(apiSpy.exportNamespace.calls.mostRecent().args).toEqual(['bar']);
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

  it('(AC13) editorOptions.readOnly === true when mode === "view"', async () => {
    apiSpy.exportNamespace.and.returnValue(Promise.resolve('foo: 1\n'));
    await buildFixture('foo');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const options = component.editorOptions;
    expect(options['readOnly']).toBe(true);
    expect(options['language']).toBe('yaml');
    expect(options['automaticLayout']).toBe(true);
    expect(options['theme']).toBe('vs');
  });

  it('(AC13) public surface — namespace @Input, closed/saved @Output, hasUnsavedChanges', async () => {
    apiSpy.exportNamespace.and.returnValue(Promise.resolve(''));
    await buildFixture('foo');
    fixture.detectChanges();
    await fixture.whenStable();

    expect(component.namespace).toBe('foo');
    expect(typeof component.closed.emit).toBe('function');
    expect(typeof component.saved.emit).toBe('function');
    // Story 11.3: hasUnsavedChanges is now a real check.
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
  // Story 11.3 — Edit flip (AC 1)
  // ---------------------------------------------------------------------

  async function loadedEditMode(yaml = 'foo: 1\n'): Promise<void> {
    apiSpy.exportNamespace.and.returnValue(Promise.resolve(yaml));
    await buildFixture('foo');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  it('(11.3 AC1) onEditClick flips mode to edit and Monaco readOnly to false', async () => {
    await loadedEditMode();
    expect(component.mode).toBe('view');

    component.onEditClick();
    fixture.detectChanges();

    expect(component.mode).toBe('edit');
    expect(component.editorOptions['readOnly']).toBe(false);
  });

  // ---------------------------------------------------------------------
  // Story 11.3 — Save enabled/disabled (AC 2)
  // ---------------------------------------------------------------------

  it('(11.3 AC2) Save is disabled when buffer === serverYaml, enabled otherwise', async () => {
    await loadedEditMode('foo: 1\n');
    component.onEditClick();
    fixture.detectChanges();

    // Clean buffer — button[data-test="save-btn"] is disabled.
    let saveBtn = fixture.nativeElement.querySelector(
      'button[data-test="save-btn"]',
    ) as HTMLButtonElement | null;
    expect(saveBtn).not.toBeNull();
    expect(saveBtn!.disabled).toBeTrue();

    // Dirty buffer.
    component.buffer = 'foo: 2\n';
    fixture.detectChanges();
    saveBtn = fixture.nativeElement.querySelector(
      'button[data-test="save-btn"]',
    ) as HTMLButtonElement | null;
    expect(saveBtn!.disabled).toBeFalse();
  });

  // ---------------------------------------------------------------------
  // Story 11.3 — Cancel flows (AC 3 + AC 4)
  // ---------------------------------------------------------------------

  it('(11.3 AC4) onCancelClick with clean buffer flips mode directly — no confirm', async () => {
    await loadedEditMode('foo: 1\n');
    component.onEditClick();
    fixture.detectChanges();

    component.onCancelClick();

    expect(confirmationSpy.confirm).not.toHaveBeenCalled();
    expect(component.mode).toBe('view');
  });

  it('(11.3 AC3) onCancelClick with dirty buffer triggers confirm — accept reverts', async () => {
    await loadedEditMode('foo: 1\n');
    component.onEditClick();
    component.buffer = 'foo: 2\n';
    fixture.detectChanges();

    component.onCancelClick();
    expect(confirmationSpy.confirm).toHaveBeenCalledTimes(1);
    const args = confirmationSpy.confirm.calls.mostRecent().args[0];
    expect(args.message as string).toContain('Discard unsaved changes');

    // Accept → revert.
    args.accept!();
    expect(component.buffer).toBe('foo: 1\n');
    expect(component.mode).toBe('view');
  });

  it('(11.3 AC3) onCancelClick with dirty buffer — dismiss leaves state unchanged', async () => {
    await loadedEditMode('foo: 1\n');
    component.onEditClick();
    component.buffer = 'foo: 2\n';
    fixture.detectChanges();

    component.onCancelClick();
    // Simulate dismiss: call reject if present, else just don't call accept.
    const args = confirmationSpy.confirm.calls.mostRecent().args[0];
    if (args.reject) {
      args.reject();
    }

    expect(component.buffer).toBe('foo: 2\n');
    expect(component.mode).toBe('edit');
  });

  // ---------------------------------------------------------------------
  // Story 11.3 — Save direct-to-import, NOT via validate (AC 5)
  // ---------------------------------------------------------------------

  it('(11.3 AC5) Save posts buffer directly to importNamespace — validateNamespaceBuffer NOT called', async () => {
    await loadedEditMode('foo: 1\n');
    component.onEditClick();
    component.buffer = 'foo: 2\n';
    apiSpy.importNamespace.and.returnValue(Promise.resolve([]));

    await component.onSaveClick();

    expect(apiSpy.validateNamespaceBuffer).not.toHaveBeenCalled();
    expect(apiSpy.importNamespace).toHaveBeenCalledOnceWith('foo: 2\n');
  });

  // ---------------------------------------------------------------------
  // Story 11.3 — Save 2xx success path (AC 6)
  // ---------------------------------------------------------------------

  it('(11.3 AC6) Save 2xx — serverYaml updates, mode flips to view, saved.emit + success toast', async () => {
    await loadedEditMode('foo: 1\n');
    component.onEditClick();
    component.buffer = 'foo: 2\n';
    apiSpy.importNamespace.and.returnValue(Promise.resolve([]));
    const savedEmit = spyOn(component.saved, 'emit');

    await component.onSaveClick();

    expect(component.serverYaml).toBe('foo: 2\n');
    expect(component.mode).toBe('view');
    expect(component.saving).toBe(false);
    expect(savedEmit).toHaveBeenCalledTimes(1);
    const toast = messageSpy.add.calls.mostRecent().args[0];
    expect(toast.severity).toBe('success');
  });

  // ---------------------------------------------------------------------
  // Story 11.3 — Save 422 structured (AC 7)
  // ---------------------------------------------------------------------

  it('(11.3 AC7) Save 422 structured — lastValidation populated, mode stays edit, buffer preserved', async () => {
    await loadedEditMode('foo: 1\n');
    component.onEditClick();
    component.buffer = 'foo: 2\n';
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

    expect(component.mode).toBe('edit');
    expect(component.buffer).toBe('foo: 2\n');
    expect(component.saving).toBe(false);
    expect(component.lastValidation).toEqual(report);
    expect(component.rawSaveError).toBeNull();
  });

  it('(11.3 AC7) Save 422 unstructured — rawSaveError populated, lastValidation null', async () => {
    await loadedEditMode('foo: 1\n');
    component.onEditClick();
    component.buffer = 'foo: 2\n';
    // FastAPI-style error body — does NOT match NamespaceValidationReport.
    const rawBody = { detail: [{ msg: 'field required', loc: ['body'] }] };
    apiSpy.importNamespace.and.returnValue(
      Promise.reject(makeHttpError(422, rawBody)),
    );

    await component.onSaveClick();

    expect(component.lastValidation).toBeNull();
    expect(component.rawSaveError).toContain('field required');
    expect(component.mode).toBe('edit');
    expect(component.buffer).toBe('foo: 2\n');
  });

  // ---------------------------------------------------------------------
  // Story 11.3 — Save 5xx failure path with retry (AC 8)
  // ---------------------------------------------------------------------

  it('(11.3 AC8) Save 5xx — sticky toast + retry callback invokes importNamespace again', async () => {
    await loadedEditMode('foo: 1\n');
    component.onEditClick();
    component.buffer = 'foo: 2\n';
    apiSpy.importNamespace.and.returnValue(Promise.reject(makeHttpError(500)));

    await component.onSaveClick();

    expect(component.mode).toBe('edit');
    expect(component.buffer).toBe('foo: 2\n');
    expect(component.saving).toBe(false);
    expect(component.lastSaveError).not.toBeNull();

    // Verify the sticky error toast fired.
    const errorToast = messageSpy.add.calls.mostRecent().args[0];
    expect(errorToast.severity).toBe('error');
    expect(errorToast.sticky).toBeTrue();

    // Retry button renders in the action row when lastSaveError is set.
    fixture.detectChanges();
    const retryBtn = fixture.nativeElement.querySelector(
      'button[data-test="retry-save-btn"]',
    ) as HTMLButtonElement | null;
    expect(retryBtn).not.toBeNull();

    // Second click — this time a 2xx success — retries with the same buffer.
    apiSpy.importNamespace.calls.reset();
    apiSpy.importNamespace.and.returnValue(Promise.resolve([]));
    await component.onSaveClick();
    expect(apiSpy.importNamespace).toHaveBeenCalledOnceWith('foo: 2\n');
  });

  it('(11.3 AC8) Save 500 does NOT auto-invoke importNamespace a second time', async () => {
    await loadedEditMode('foo: 1\n');
    component.onEditClick();
    component.buffer = 'foo: 2\n';
    apiSpy.importNamespace.and.returnValue(Promise.reject(makeHttpError(500)));

    await component.onSaveClick();
    // No further calls until the operator explicitly clicks Retry.
    expect(apiSpy.importNamespace).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------
  // Story 11.3 — Save 401 silent (AC 9)
  // ---------------------------------------------------------------------

  it('(11.3 AC9) Save 401 — no panel toast, mode stays edit, saving resets', async () => {
    await loadedEditMode('foo: 1\n');
    component.onEditClick();
    component.buffer = 'foo: 2\n';
    apiSpy.importNamespace.and.returnValue(Promise.reject(makeHttpError(401)));

    await component.onSaveClick();

    expect(component.mode).toBe('edit');
    expect(component.buffer).toBe('foo: 2\n');
    expect(component.saving).toBe(false);
    // The panel's handler must not add its own toast — the global toast
    // already fires via FetchService.
    expect(messageSpy.add).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // Story 11.3 — hasUnsavedChanges four-state matrix (AC 11)
  // ---------------------------------------------------------------------

  it('(11.3 AC11) hasUnsavedChanges truth table (view+clean, view+dirty, edit+clean, edit+dirty)', async () => {
    await loadedEditMode('foo: 1\n');

    // view + clean buffer.
    expect(component.mode).toBe('view');
    expect(component.buffer).toBe(component.serverYaml);
    expect(component.hasUnsavedChanges()).toBe(false);

    // view + dirty buffer — mode gate means still false.
    component.buffer = 'foo: 2\n';
    expect(component.hasUnsavedChanges()).toBe(false);

    // Reset for edit cases.
    component.buffer = component.serverYaml;

    // edit + clean.
    component.onEditClick();
    expect(component.hasUnsavedChanges()).toBe(false);

    // edit + dirty.
    component.buffer = 'foo: 2\n';
    expect(component.hasUnsavedChanges()).toBe(true);
  });

  // ---------------------------------------------------------------------
  // Story 11.3 — Destroy-during-save (AC 13)
  // ---------------------------------------------------------------------

  it('(11.3 AC13) destroy-during-save — late-resolving import does not write state', async () => {
    await loadedEditMode('foo: 1\n');
    component.onEditClick();
    component.buffer = 'foo: 2\n';
    let resolveLate!: (value: unknown) => void;
    apiSpy.importNamespace.and.returnValue(
      new Promise<unknown>((r) => {
        resolveLate = r;
      }) as unknown as Promise<never>,
    );

    const consoleErrorSpy = spyOn(console, 'error');
    const savePromise = component.onSaveClick();
    expect(component.saving).toBe(true);

    fixture.destroy();

    resolveLate([]);
    await savePromise;
    await Promise.resolve();

    // No state writes on the destroyed instance.
    expect(component.serverYaml).toBe('foo: 1\n');
    expect(component.mode).toBe('edit');
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // Story 11.4 — Validate flows (buttons, handlers, state, errors)
  // ---------------------------------------------------------------------

  function cleanReport(namespace = 'foo'): NamespaceValidationReport {
    return {
      namespace,
      ok: true,
      global_errors: [],
      entry_issues: [],
    };
  }

  // ----- Button visibility per mode (AC 1 / AC 3) -----

  it('(11.4 AC1) Validate-persisted button visible in view mode, hidden in edit', async () => {
    await loadedEditMode('foo: 1\n');

    let viewBtn = fixture.nativeElement.querySelector(
      'button[data-test="validate-persisted-btn"]',
    );
    expect(viewBtn).not.toBeNull();

    component.onEditClick();
    fixture.detectChanges();

    viewBtn = fixture.nativeElement.querySelector(
      'button[data-test="validate-persisted-btn"]',
    );
    expect(viewBtn).toBeNull();
  });

  it('(11.4 AC3) Validate-buffer button visible in edit mode, hidden in view', async () => {
    await loadedEditMode('foo: 1\n');

    let editBtn = fixture.nativeElement.querySelector(
      'button[data-test="validate-buffer-btn"]',
    );
    expect(editBtn).toBeNull();

    component.onEditClick();
    fixture.detectChanges();

    editBtn = fixture.nativeElement.querySelector(
      'button[data-test="validate-buffer-btn"]',
    );
    expect(editBtn).not.toBeNull();
  });

  // ----- Validate-persisted click — AC 2 -----

  it('(11.4 AC2) onValidatePersistedClick calls validatePersistedNamespace exactly once; clean report hides pane and flashes the view-mode button', async () => {
    await loadedEditMode('foo: 1\n');
    const report = cleanReport();
    apiSpy.validatePersistedNamespace.and.returnValue(Promise.resolve(report));

    await component.onValidatePersistedClick();

    expect(apiSpy.validatePersistedNamespace).toHaveBeenCalledOnceWith('foo');
    // Clean reports no longer render the "Validation passed" pane — the
    // button-flash UX replaces it. `lastValidation` stays null.
    expect(component.lastValidation).toBeNull();
    expect(component.validationFlashPersisted).toBeTrue();
    expect(component.validationFlashBuffer).toBeFalse();
    // Save's fallback field stays untouched.
    expect(component.rawSaveError).toBeNull();
    // No other ApiService spy invoked on this path (beyond the load's export).
    expect(apiSpy.importNamespace).not.toHaveBeenCalled();
    expect(apiSpy.validateNamespaceBuffer).not.toHaveBeenCalled();
  });

  it('onValidatePersistedClick non-clean report still populates lastValidation (findings pane renders)', async () => {
    await loadedEditMode('foo: 1\n');
    const report: NamespaceValidationReport = {
      namespace: 'foo',
      ok: false,
      global_errors: ['schema mismatch'],
      entry_issues: [],
    };
    apiSpy.validatePersistedNamespace.and.returnValue(Promise.resolve(report));

    await component.onValidatePersistedClick();

    expect(component.lastValidation).toEqual(report);
    expect(component.validationFlashPersisted).toBeFalse();
  });

  it('clean-report flash on Validate auto-reverts after 2500ms', fakeAsync(() => {
    void buildFixture('foo');
    apiSpy.exportNamespace.and.returnValue(Promise.resolve('foo: 1\n'));
    apiSpy.validatePersistedNamespace.and.returnValue(
      Promise.resolve(cleanReport()),
    );
    fixture.detectChanges();
    tick();

    void component.onValidatePersistedClick();
    tick();
    expect(component.validationFlashPersisted).toBeTrue();
    // Halfway through the window — still flashing.
    tick(1000);
    expect(component.validationFlashPersisted).toBeTrue();
    // Past the 2500ms window — flag auto-reverts.
    tick(1600);
    expect(component.validationFlashPersisted).toBeFalse();
    expect(component.validationFlashBuffer).toBeFalse();
  }));

  // ----- Validate-buffer click — AC 4 -----

  it('(11.4 AC4) onValidateBufferClick passes snapshot-at-click buffer; live edits post-click do NOT change args', async () => {
    await loadedEditMode('foo: 1\n');
    component.onEditClick();
    component.buffer = 'foo: 2\n';

    let resolveValidate!: (v: NamespaceValidationReport) => void;
    apiSpy.validateNamespaceBuffer.and.returnValue(
      new Promise<NamespaceValidationReport>((r) => {
        resolveValidate = r;
      }),
    );

    const validatePromise = component.onValidateBufferClick();
    // Simulate user typing AFTER click but BEFORE the promise resolves.
    component.buffer = 'foo: 99\n';

    resolveValidate(cleanReport());
    await validatePromise;

    // Spy was called with the pre-edit (snapshot-at-click) buffer.
    expect(apiSpy.validateNamespaceBuffer).toHaveBeenCalledOnceWith('foo: 2\n');
    // Clean report → pane hidden, edit-mode button flashes `success`.
    expect(component.lastValidation).toBeNull();
    expect(component.validationFlashBuffer).toBeTrue();
    expect(component.validationFlashPersisted).toBeFalse();
    // Validate never mutates buffer; the live edit is still present.
    expect(component.buffer).toBe('foo: 99\n');
  });

  it('editing the buffer after a clean Validate-buffer clears the flash immediately', async () => {
    await loadedEditMode('foo: 1\n');
    component.onEditClick();
    component.buffer = 'foo: 2\n';
    apiSpy.validateNamespaceBuffer.and.returnValue(
      Promise.resolve(cleanReport()),
    );

    await component.onValidateBufferClick();
    expect(component.validationFlashBuffer).toBeTrue();

    // User edits the YAML after the clean ack — the green state is now
    // stale, the button must revert to secondary immediately rather than
    // linger until the 2500ms timer elapses.
    component.onBufferChange('foo: 2\n# edited\n');

    expect(component.buffer).toBe('foo: 2\n# edited\n');
    expect(component.validationFlashBuffer).toBeFalse();
  });

  it('editing buffer does NOT clear the flash on the view-mode persisted button (persisted validates server state, not buffer)', async () => {
    await loadedEditMode('foo: 1\n');
    apiSpy.validatePersistedNamespace.and.returnValue(
      Promise.resolve(cleanReport()),
    );
    await component.onValidatePersistedClick();
    expect(component.validationFlashPersisted).toBeTrue();

    // Even if buffer changes (e.g. user flips to edit later), the persisted
    // flash is not bound to the buffer — it stays.
    component.onBufferChange('foo: 99\n');
    expect(component.validationFlashPersisted).toBeTrue();
  });

  it('(11.4 AC4) Validate-buffer does NOT mutate mode, serverYaml, buffer, or call importNamespace', async () => {
    await loadedEditMode('foo: 1\n');
    component.onEditClick();
    component.buffer = 'foo: 2\n';
    apiSpy.validateNamespaceBuffer.and.returnValue(
      Promise.resolve(cleanReport()),
    );

    await component.onValidateBufferClick();

    expect(component.mode).toBe('edit');
    expect(component.buffer).toBe('foo: 2\n');
    expect(component.serverYaml).toBe('foo: 1\n');
    expect(apiSpy.importNamespace).not.toHaveBeenCalled();
    expect(component.rawSaveError).toBeNull();
  });

  // ----- Validate does not gate Save — AC 5 -----

  it('(11.4 AC5) Validate-buffer does NOT gate Save — Save stays enabled iff buffer !== serverYaml', async () => {
    await loadedEditMode('foo: 1\n');
    component.onEditClick();
    component.buffer = 'foo: 2\n';
    fixture.detectChanges();

    const report: NamespaceValidationReport = {
      namespace: 'foo',
      ok: false,
      global_errors: ['x'],
      entry_issues: [],
    };
    apiSpy.validateNamespaceBuffer.and.returnValue(Promise.resolve(report));

    await component.onValidateBufferClick();
    fixture.detectChanges();

    // Save button still enabled (buffer !== serverYaml, saving === false).
    const saveBtn = fixture.nativeElement.querySelector(
      'button[data-test="save-btn"]',
    ) as HTMLButtonElement;
    expect(saveBtn.disabled).toBeFalse();
    // importNamespace never invoked by the validate path.
    expect(apiSpy.importNamespace).not.toHaveBeenCalled();
  });

  // ----- lastValidation preserved across mode flips — AC 10 -----

  it('(11.4 AC10) onEditClick does NOT mutate lastValidation (view → edit)', async () => {
    await loadedEditMode('foo: 1\n');
    const prior = cleanReport();
    component.lastValidation = prior;

    component.onEditClick();

    expect(component.mode).toBe('edit');
    expect(component.lastValidation).toBe(prior);
  });

  it('(11.4 AC10) onCancelClick dirty-accept does NOT mutate lastValidation', async () => {
    await loadedEditMode('foo: 1\n');
    const prior = cleanReport();
    component.onEditClick();
    component.buffer = 'foo: 2\n';
    component.lastValidation = prior;

    component.onCancelClick();
    const args = confirmationSpy.confirm.calls.mostRecent().args[0];
    args.accept!();

    expect(component.mode).toBe('view');
    expect(component.lastValidation).toBe(prior);
  });

  it('(11.4 AC10) onCancelClick clean-flip does NOT mutate lastValidation', async () => {
    await loadedEditMode('foo: 1\n');
    const prior = cleanReport();
    component.onEditClick();
    // Clean buffer — direct flip, no confirm.
    component.lastValidation = prior;

    component.onCancelClick();

    expect(component.mode).toBe('view');
    expect(component.lastValidation).toBe(prior);
  });

  // ----- Validate 5xx → toast, state unchanged — AC 11 -----

  it('(11.4 AC11) Validate 5xx — error toast, lastValidation unchanged, validating resets', async () => {
    await loadedEditMode('foo: 1\n');
    const prior = cleanReport();
    component.lastValidation = prior;
    apiSpy.validatePersistedNamespace.and.returnValue(
      Promise.reject(makeHttpError(500)),
    );

    await component.onValidatePersistedClick();

    expect(component.lastValidation).toBe(prior);
    expect(component.validating).toBe(false);
    expect(component.rawSaveError).toBeNull();
    // One error toast fired (non-sticky).
    const toast = messageSpy.add.calls.mostRecent().args[0];
    expect(toast.severity).toBe('error');
    expect(toast.summary).toBe('Validation failed');
    expect(toast.sticky).toBeFalsy();
  });

  // ----- Validate 401 silent — AC 12 -----

  it('(11.4 AC12) Validate 401 — no panel toast, state unchanged, validating resets', async () => {
    await loadedEditMode('foo: 1\n');
    const prior = cleanReport();
    component.lastValidation = prior;
    messageSpy.add.calls.reset();
    apiSpy.validatePersistedNamespace.and.returnValue(
      Promise.reject(makeHttpError(401)),
    );

    await component.onValidatePersistedClick();

    expect(component.lastValidation).toBe(prior);
    expect(component.validating).toBe(false);
    expect(component.mode).toBe('view');
    expect(messageSpy.add).not.toHaveBeenCalled();
  });

  // ----- Destroy-during-validate — AC 13 -----

  it('(11.4 AC13) destroy-during-validate — late-resolving validate does not write state', async () => {
    await loadedEditMode('foo: 1\n');
    let resolveLate!: (v: NamespaceValidationReport) => void;
    apiSpy.validatePersistedNamespace.and.returnValue(
      new Promise<NamespaceValidationReport>((r) => {
        resolveLate = r;
      }),
    );

    const consoleErrorSpy = spyOn(console, 'error');
    const validatePromise = component.onValidatePersistedClick();
    expect(component.validating).toBe(true);

    fixture.destroy();

    resolveLate(cleanReport('bar'));
    await validatePromise;
    await Promise.resolve();

    // lastValidation was not written post-destroy.
    expect(component.lastValidation).toBeNull();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  // ----- NFR7 — exact REST call budget — AC 14 -----

  it('(11.4 AC14) NFR7 scenario — 1 export + 2 validate-persisted + 1 validate-buffer + 1 import = 5 calls', async () => {
    // Arrange: load with exportSpy.
    await loadedEditMode('foo: 1\n');
    expect(apiSpy.exportNamespace).toHaveBeenCalledTimes(1);

    // Validate-persisted x2.
    apiSpy.validatePersistedNamespace.and.returnValue(
      Promise.resolve(cleanReport()),
    );
    await component.onValidatePersistedClick();
    await component.onValidatePersistedClick();

    // Flip to edit, set dirty buffer, Validate-buffer x1.
    component.onEditClick();
    component.buffer = 'foo: 2\n';
    apiSpy.validateNamespaceBuffer.and.returnValue(
      Promise.resolve(cleanReport()),
    );
    await component.onValidateBufferClick();

    // Save x1 (success).
    apiSpy.importNamespace.and.returnValue(Promise.resolve([]));
    await component.onSaveClick();

    // Tally.
    expect(apiSpy.exportNamespace).toHaveBeenCalledTimes(1);
    expect(apiSpy.validatePersistedNamespace).toHaveBeenCalledTimes(2);
    expect(apiSpy.validateNamespaceBuffer).toHaveBeenCalledTimes(1);
    expect(apiSpy.importNamespace).toHaveBeenCalledTimes(1);
  });

  // ----- editorOptions reference stability — AC 15 -----

  it('(11.4 AC15) editorOptions is reference-stable on a stable mode (regression lock for the getter idiom)', async () => {
    await loadedEditMode('foo: 1\n');
    const first = component.editorOptions;
    const second = component.editorOptions;
    expect(first).toBe(second);

    // Flipping mode creates exactly one new reference.
    component.onEditClick();
    const afterEdit = component.editorOptions;
    expect(afterEdit).not.toBe(first);
    // And the field stays stable on that new mode too.
    expect(component.editorOptions).toBe(afterEdit);
  });

  // ----- onClearValidationClick nulls both fields — AC 8 -----

  it('(11.4 AC8) onClearValidationClick nulls lastValidation AND rawSaveError', async () => {
    await loadedEditMode('foo: 1\n');
    component.lastValidation = cleanReport();
    component.rawSaveError = 'some raw';

    component.onClearValidationClick();

    expect(component.lastValidation).toBeNull();
    expect(component.rawSaveError).toBeNull();
  });

  it('(11.4 AC8) ValidationReportComponent clearRequested output triggers onClearValidationClick', async () => {
    await loadedEditMode('foo: 1\n');
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
  // Story 11.5 — Clone flow (AC 1–AC 16)
  // ---------------------------------------------------------------------

  /**
   * Bundle YAML fixture used by the Clone-flow tests below. The bundle
   * conforms to the v2 wire format: root `namespace` + `user_id` +
   * `entries` map. `payload.description` deliberately mentions "src" so
   * the rewrite helper's structured-rewrite contract is exercised — that
   * string MUST NOT be touched.
   */
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

  // ----- Clone button visibility (AC 1) -----

  it('(11.5 AC1) Clone button is visible in view mode', async () => {
    await loadedWithCloneSrc();
    const btn = fixture.nativeElement.querySelector(
      'button[data-test="clone-btn"]',
    );
    expect(btn).not.toBeNull();
  });

  it('(11.5 AC1) Clone button is visible in edit mode', async () => {
    await loadedWithCloneSrc();
    component.onEditClick();
    fixture.detectChanges();
    const btn = fixture.nativeElement.querySelector(
      'button[data-test="clone-btn"]',
    );
    expect(btn).not.toBeNull();
  });

  it('(11.5 AC1) Clone button is hidden while loading', async () => {
    // Pending export — loading stays true.
    apiSpy.exportNamespace.and.returnValue(new Promise<string>(() => {}));
    await buildFixture('src');
    fixture.detectChanges();
    const btn = fixture.nativeElement.querySelector(
      'button[data-test="clone-btn"]',
    );
    expect(btn).toBeNull();
  });

  it('(11.5 AC1) Clone button is hidden in the empty / error state (serverYaml === "")', async () => {
    apiSpy.exportNamespace.and.returnValue(Promise.reject(new Error('boom')));
    await buildFixture('src');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const btn = fixture.nativeElement.querySelector(
      'button[data-test="clone-btn"]',
    );
    expect(btn).toBeNull();
  });

  // ----- Clicking Clone opens the dialog (AC 2) -----

  it('(11.5 AC2) onCloneClick opens the dialog without a network call', async () => {
    await loadedWithCloneSrc();
    const bufferBefore = component.buffer;
    const modeBefore = component.mode;
    const serverYamlBefore = component.serverYaml;
    apiSpy.importNamespace.calls.reset();

    component.onCloneClick();
    fixture.detectChanges();

    expect(component.cloneDialogVisible).toBeTrue();
    expect(component.buffer).toBe(bufferBefore);
    expect(component.mode).toBe(modeBefore);
    expect(component.serverYaml).toBe(serverYamlBefore);
    expect(apiSpy.importNamespace).not.toHaveBeenCalled();
  });

  it('(11.5 AC2) onCloneClick is a no-op when cloning === true', async () => {
    await loadedWithCloneSrc();
    component.cloning = true;
    component.cloneDialogVisible = false;

    component.onCloneClick();

    expect(component.cloneDialogVisible).toBeFalse();
  });

  // ----- Pre-flight dialog validation (AC 4) -----

  it('(11.5 AC4) Confirm button disabled — empty destNs', async () => {
    await loadedWithCloneSrc();
    component.onCloneClick();
    component.cloneDestNs = '';
    fixture.detectChanges();

    expect(component.cloneConfirmDisabled).toBeTrue();
    expect(component.cloneValidationError).toBe(
      'Destination namespace required',
    );
  });

  it('(11.5 AC4) Confirm button disabled — destNs equals source namespace', async () => {
    await loadedWithCloneSrc();
    component.onCloneClick();
    component.cloneDestNs = 'src';

    expect(component.cloneConfirmDisabled).toBeTrue();
    expect(component.cloneValidationError).toBe(
      'Destination must differ from source namespace',
    );
  });

  it('(11.5 AC4) Confirm button disabled — destNs collides with existingNamespaces', async () => {
    await loadedWithCloneSrc(['src', 'already-there']);
    component.onCloneClick();
    component.cloneDestNs = 'already-there';

    expect(component.cloneConfirmDisabled).toBeTrue();
    expect(component.cloneValidationError).toBe(
      "Namespace 'already-there' already exists",
    );
  });

  it('(11.5 AC4) Confirm button disabled while cloning === true', async () => {
    await loadedWithCloneSrc();
    component.onCloneClick();
    component.cloneDestNs = 'dst';
    component.cloning = true;

    expect(component.cloneConfirmDisabled).toBeTrue();
  });

  it('(11.5 AC4) Confirm button enabled when all checks pass', async () => {
    await loadedWithCloneSrc();
    component.onCloneClick();
    component.cloneDestNs = 'dst';

    expect(component.cloneConfirmDisabled).toBeFalse();
    expect(component.cloneValidationError).toBeNull();
  });

  // ----- Clone takes buffer, not serverYaml (AC 5) -----

  it('(11.5 AC5) onCloneConfirmClick captures buffer (not serverYaml) as the clone source', async () => {
    await loadedWithCloneSrc();
    component.onEditClick();
    // Operator edits the buffer — add an extra entry that is NOT in
    // serverYaml to uniquely distinguish the two sources.
    component.buffer = `namespace: src
user_id: null
entries:
  team-1:
    kind: team
    model_type: BaseTeamModel
    payload:
      description: "configured for src namespace"
  extra-entry:
    kind: agent
    model_type: BaseAgentModel
    payload:
      role: helper
`;
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
    expect(entries['extra-entry']).toBeDefined();
  });

  // ----- Clone Confirm happy path (AC 8, AC 12, AC 14) -----

  it('(11.5 AC8+12+14) Clone Confirm happy path — import then re-export, land on destNs in view mode', async () => {
    await loadedWithCloneSrc(['src']);
    apiSpy.importNamespace.and.returnValue(Promise.resolve([]));

    const exportedFresh = 'namespace: dst\nuser_id: null\nentries: {}\n';
    // After the clone re-load, exportNamespace is called with 'dst'.
    apiSpy.exportNamespace.and.callFake((ns: string) =>
      Promise.resolve(ns === 'dst' ? exportedFresh : cloneSrcYaml),
    );
    const savedEmit = spyOn(component.saved, 'emit');

    component.onCloneClick();
    component.cloneDestNs = 'dst';
    await component.onCloneConfirmClick();
    // onCloneConfirmClick fires `loadNamespace(destNs)` as fire-and-forget;
    // drain microtasks so it resolves before assertions.
    await fixture.whenStable();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(apiSpy.importNamespace).toHaveBeenCalledTimes(1);
    // exportNamespace called twice: once on mount (cloneSrcYaml), once for
    // the re-load (exportedFresh).
    expect(apiSpy.exportNamespace).toHaveBeenCalledTimes(2);
    expect(apiSpy.exportNamespace.calls.mostRecent().args).toEqual(['dst']);
    expect(component.namespace).toBe('dst');
    expect(component.mode).toBe('view');
    expect(component.cloneDialogVisible).toBeFalse();
    expect(component.cloneDestNs).toBe('');
    expect(component.cloning).toBeFalse();
    expect(savedEmit).toHaveBeenCalledTimes(1);
    // Success toast fired exactly once with the destNs-interpolated summary.
    const toasts = messageSpy.add.calls.allArgs().map((a) => a[0]);
    const success = toasts.find((t) => t.severity === 'success');
    expect(success).toBeDefined();
    expect(success!.summary).toContain("'dst'");
  });

  // ----- Clone 422 structured (AC 9) -----

  it('(11.5 AC9) Clone 422 structured — lastValidation populated, dialog stays open, source intact', async () => {
    await loadedWithCloneSrc();
    const report: NamespaceValidationReport = {
      namespace: 'dst',
      ok: false,
      global_errors: ['invalid entry'],
      entry_issues: [],
    };
    apiSpy.importNamespace.and.returnValue(
      Promise.reject(makeHttpError(422, report)),
    );

    component.onCloneClick();
    component.cloneDestNs = 'dst';
    await component.onCloneConfirmClick();

    expect(component.lastValidation).toEqual(report);
    expect(component.rawSaveError).toBeNull();
    expect(component.cloneDialogVisible).toBeTrue();
    expect(component.namespace).toBe('src');
    expect(component.mode).toBe('view');
    expect(component.buffer).toBe(cloneSrcYaml);
    expect(component.serverYaml).toBe(cloneSrcYaml);
    expect(component.cloning).toBeFalse();
  });

  // ----- Clone 422 unstructured (AC 9) -----

  it('(11.5 AC9) Clone 422 unstructured — rawSaveError populated, dialog stays open, source intact', async () => {
    await loadedWithCloneSrc();
    apiSpy.importNamespace.and.returnValue(
      Promise.reject(makeHttpError(422, 'FastAPI detail string')),
    );

    component.onCloneClick();
    component.cloneDestNs = 'dst';
    await component.onCloneConfirmClick();

    expect(component.rawSaveError).toBe('FastAPI detail string');
    expect(component.lastValidation).toBeNull();
    expect(component.cloneDialogVisible).toBeTrue();
    expect(component.namespace).toBe('src');
    expect(component.cloning).toBeFalse();
  });

  // ----- Clone 5xx (AC 9, AC 10) -----

  it('(11.5 AC9+10) Clone 5xx — sticky toast, lastCloneError populated, source intact', async () => {
    await loadedWithCloneSrc();
    // Seed dirty edit state so AC 10's "source intact" check covers mode +
    // buffer too.
    component.onEditClick();
    component.buffer = cloneSrcYaml + '# edited marker\n';
    const editedBuffer = component.buffer;
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
    // Source state intact.
    expect(component.namespace).toBe('src');
    expect(component.mode).toBe('edit');
    expect(component.buffer).toBe(editedBuffer);
    expect(component.serverYaml).toBe(cloneSrcYaml);
    // Sticky error toast fired.
    const lastToast = messageSpy.add.calls.mostRecent().args[0];
    expect(lastToast.severity).toBe('error');
    expect(lastToast.sticky).toBeTrue();
  });

  // ----- Clone 401 silent (AC 9) -----

  it('(11.5 AC9) Clone 401 — no panel toast, dialog stays open, cloning resets', async () => {
    await loadedWithCloneSrc();
    apiSpy.importNamespace.and.returnValue(
      Promise.reject(makeHttpError(401)),
    );
    messageSpy.add.calls.reset();

    component.onCloneClick();
    component.cloneDestNs = 'dst';
    await component.onCloneConfirmClick();

    expect(messageSpy.add).not.toHaveBeenCalled();
    expect(component.cloning).toBeFalse();
    expect(component.cloneDialogVisible).toBeTrue();
    expect(component.lastCloneError).toBeNull();
  });

  // ----- Clone CloneYamlError (AC 11) -----

  it('(11.5 AC11) CloneYamlError — no import call, toast fired, cloning resets, lastCloneError NOT set', async () => {
    await loadedWithCloneSrc();
    component.onEditClick();
    // Buffer is NOT a valid bundle root mapping — forces
    // rewriteNamespaceInYaml to throw CloneYamlError before the network
    // call.
    component.buffer = '- not a mapping\n';
    apiSpy.importNamespace.calls.reset();
    messageSpy.add.calls.reset();

    component.onCloneClick();
    component.cloneDestNs = 'dst';
    await component.onCloneConfirmClick();

    expect(apiSpy.importNamespace).not.toHaveBeenCalled();
    expect(component.cloning).toBeFalse();
    expect(component.lastCloneError).toBeNull();
    expect(messageSpy.add).toHaveBeenCalledTimes(1);
    const toast = messageSpy.add.calls.mostRecent().args[0];
    expect(toast.severity).toBe('error');
  });

  // ----- NFR7 budget (AC 14) -----

  it('(11.5 AC14) NFR7 — clone happy path = 1 import + 2 exports total, no other spy calls', async () => {
    await loadedWithCloneSrc();
    // 1 export fired during mount; now clone.
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

  // ----- Destroy-during-clone (AC 16) -----

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

    // No state writes on the destroyed instance.
    expect(component.namespace).toBe('src');
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});
