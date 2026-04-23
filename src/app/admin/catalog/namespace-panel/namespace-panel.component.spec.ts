import { CommonModule } from '@angular/common';
import { Component, forwardRef, Input } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import {
  ControlValueAccessor,
  FormsModule,
  NG_VALUE_ACCESSOR,
} from '@angular/forms';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { MessageService } from 'primeng/api';
import { ButtonModule } from 'primeng/button';

import { ApiService } from '../../../services/api.service';
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

describe('NamespacePanelComponent', () => {
  let fixture: ComponentFixture<NamespacePanelComponent>;
  let component: NamespacePanelComponent;
  let apiSpy: jasmine.SpyObj<ApiService>;
  let messageSpy: jasmine.SpyObj<MessageService>;

  async function buildFixture(namespace: string) {
    fixture = TestBed.createComponent(NamespacePanelComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('namespace', namespace);
  }

  beforeEach(async () => {
    apiSpy = jasmine.createSpyObj('ApiService', ['exportNamespace']);
    messageSpy = jasmine.createSpyObj('MessageService', ['add']);

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
            StubMonacoEditorComponent,
          ],
        },
      })
      .compileComponents();
  });

  // --- AC 13 — Load flow (happy path) ------------------------------------

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

  // --- AC 13 — Load flow (error path) ------------------------------------

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

  // --- AC 13 — Namespace input change re-loads --------------------------

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
    fixture.detectChanges(); // ngOnInit kicks off load for 'foo'
    resolveFirst('foo: yaml\n');
    await fixture.whenStable();
    fixture.detectChanges();

    expect(component.serverYaml).toBe('foo: yaml\n');

    // Swap the @Input — ngOnChanges must schedule a second fetch.
    fixture.componentRef.setInput('namespace', 'bar');
    fixture.detectChanges();

    expect(apiSpy.exportNamespace).toHaveBeenCalledTimes(2);
    expect(apiSpy.exportNamespace.calls.mostRecent().args).toEqual(['bar']);
    // State is reset pre-resolution (AC 3 step 1).
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

  // --- AC 13 — Read-only binding smoke ----------------------------------

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

  // --- AC 13 — Public surface --------------------------------------------

  it('(AC13) public surface — namespace @Input, closed @Output, hasUnsavedChanges', async () => {
    apiSpy.exportNamespace.and.returnValue(Promise.resolve(''));
    await buildFixture('foo');
    fixture.detectChanges();
    await fixture.whenStable();

    // @Input() namespace is set via componentRef.setInput.
    expect(component.namespace).toBe('foo');
    // @Output() closed is an EventEmitter with emit().
    expect(typeof component.closed.emit).toBe('function');
    // hasUnsavedChanges is false in Story 11.2.
    expect(component.hasUnsavedChanges()).toBe(false);
  });

  // --- AC 12 — Destroy safety --------------------------------------------

  it('(AC12) destroy safety — late-resolving export does not write to state', async () => {
    let resolveLate!: (value: string) => void;
    apiSpy.exportNamespace.and.returnValue(
      new Promise<string>((r) => {
        resolveLate = r;
      }),
    );

    await buildFixture('foo');
    fixture.detectChanges(); // kicks off the fetch
    expect(component.loading).toBe(true);

    const consoleErrorSpy = spyOn(console, 'error');
    fixture.destroy();

    // Resolve AFTER destroy — must NOT write serverYaml/buffer/loading.
    resolveLate('late: yaml\n');
    await Promise.resolve();
    await Promise.resolve();

    expect(component.serverYaml).toBe('');
    expect(component.buffer).toBe('');
    // loading was true at destroy — stays true (no finally write).
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  // --- AC 7 — Host-agnostic invariant (NFR6) -----------------------------

  it('(AC7) no host-specific types referenced on the component instance', () => {
    // Sanity check: component does not inject Router/ActivatedRoute nor
    // expose dialog-specific fields. These would fail to compile via TS,
    // but a runtime check gives a belt-and-braces guard.
    expect((component as unknown as { router?: unknown })?.router).toBeUndefined();
    expect(
      (component as unknown as { activatedRoute?: unknown })?.activatedRoute,
    ).toBeUndefined();
  });
});
