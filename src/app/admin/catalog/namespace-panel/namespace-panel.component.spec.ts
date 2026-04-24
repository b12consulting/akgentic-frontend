import { CommonModule } from '@angular/common';
import { Component, forwardRef, Input } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import {
  ControlValueAccessor,
  FormsModule,
  NG_VALUE_ACCESSOR,
} from '@angular/forms';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { ConfirmationService, MessageService } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { ConfirmDialogModule } from 'primeng/confirmdialog';

import { NamespaceValidationReport } from '../../../models/catalog.interface';
import { ApiService } from '../../../services/api.service';
import { HttpError } from '../../../services/fetch.service';
import { NamespacePanelComponent } from './namespace-panel.component';

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
            StubMonacoEditorComponent,
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
});
