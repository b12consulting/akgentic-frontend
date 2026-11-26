import { CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { FileUpload } from 'primeng/fileupload';

import { UploadModalComponent } from './upload-modal.component';
import { provideTranslateTesting } from '../../../../../../testing/i18n-testing';

// --------------------------------------------------------------------
// Test helpers
// --------------------------------------------------------------------

function makeFile(name: string, content = 'x'): File {
  return new File([content], name);
}

function installFileUploadSpy(component: UploadModalComponent): jasmine.Spy {
  const clearSpy = jasmine.createSpy('clear');
  component.fileUpload = { clear: clearSpy } as unknown as FileUpload;
  return clearSpy;
}

// --------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------

describe('UploadModalComponent', () => {
  let component: UploadModalComponent;
  let fixture: ComponentFixture<UploadModalComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [UploadModalComponent, NoopAnimationsModule],
      // The dialog's three status sentences go through `TranslateService` now
      // (a p-message takes `[text]`, not a template expression), so the
      // component injects it even with its template stripped.
      providers: [provideTranslateTesting()],
    })
      .overrideComponent(UploadModalComponent, {
        set: {
          // Strip PrimeNG template rendering; we stub the ViewChild manually
          // so tests never require the dialog content to be in the DOM.
          imports: [],
          schemas: [CUSTOM_ELEMENTS_SCHEMA],
          template: '',
        },
      })
      .compileComponents();

    fixture = TestBed.createComponent(UploadModalComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('scenario 1 — clears FileUpload widget after successful upload', fakeAsync(() => {
    const clearSpy = installFileUploadSpy(component);
    component.selectedFiles = [makeFile('a.md'), makeFile('b.md')];

    component.uploadFiles();
    // uploadFiles is async; let the microtask queue drain before advancing
    // the clock past the success-path 1500ms auto-close setTimeout.
    tick(0);
    tick(1500);

    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(component.selectedFiles).toEqual([]);
    expect(component.visible).toBe(false);
  }));

  it('scenario 2 — retains FileUpload widget on upload error', fakeAsync(() => {
    const clearSpy = installFileUploadSpy(component);
    component.selectedFiles = [makeFile('a.md')];

    // Force the success path inside the try-block to throw so that the
    // catch-branch at upload-modal.component.ts:78-80 executes. The auto-close
    // setTimeout is only scheduled on success, so resetModal() must NOT run.
    spyOn(component.uploadComplete, 'emit').and.throwError('network down');

    component.uploadFiles();
    tick(0);
    tick(2000); // well past the 1500ms success timeout that never schedules

    expect(clearSpy).not.toHaveBeenCalled();
    expect(component.selectedFiles.length).toBe(1);
    expect(component.errorMessage).toBe('network down');
  }));

  it('scenario 3 — clears FileUpload widget on manual cancel (onHide)', () => {
    const clearSpy = installFileUploadSpy(component);
    component.selectedFiles = [makeFile('a.md')];
    component.visible = true;

    component.onHide();

    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(component.selectedFiles).toEqual([]);
    expect(component.visible).toBe(false);
  });

  it('scenario 4 — resetModal is safe when FileUpload ViewChild is undefined', () => {
    // Simulate the dialog-never-opened case: ViewChild has not resolved yet.
    component.fileUpload = undefined as unknown as FileUpload;
    component.selectedFiles = [makeFile('a.md')];

    expect(() => component.onHide()).not.toThrow();
    expect(component.selectedFiles).toEqual([]);
  });

  // --- new folder: path composition --------------------------------

  function nameNewFolder(name: string): void {
    component.openNewFolder();
    component.newFolderName = name;
  }

  it('no new folder: the effective target is targetPath unchanged', () => {
    component.targetPath = 'docs';
    expect(component.getEffectiveTargetPath()).toBe('docs');

    component.targetPath = '';
    expect(component.getEffectiveTargetPath()).toBe('');
  });

  it('a name typed with the input closed is not used', () => {
    component.targetPath = 'docs';
    component.newFolderName = 'q4';
    expect(component.getEffectiveTargetPath()).toBe('docs');
  });

  it('root base + new folder: the effective target is the bare folder', () => {
    component.targetPath = '';
    nameNewFolder('q4');
    expect(component.getEffectiveTargetPath()).toBe('q4');
  });

  it('nested base + new folder: the effective target is base/folder', () => {
    component.targetPath = 'docs/reports';
    nameNewFolder('q4');
    expect(component.getEffectiveTargetPath()).toBe('docs/reports/q4');
  });

  it('the new folder name is trimmed', () => {
    component.targetPath = 'docs';
    nameNewFolder('  q4  ');
    expect(component.getEffectiveTargetPath()).toBe('docs/q4');
  });

  it('nested new folders: the effective target is base/folder/subfolder', () => {
    component.targetPath = 'tmp';
    nameNewFolder('hugging-face/test');
    expect(component.newFolderInvalid).toBe(false);
    expect(component.getEffectiveTargetPath()).toBe('tmp/hugging-face/test');
  });

  for (const [typed, path] of [
    [' a / b ', 'a/b'],
    ['/a/b/', 'a/b'],
    ['a/b/c', 'a/b/c'],
  ]) {
    it(`nested names are normalised (${JSON.stringify(typed)} → ${path})`, () => {
      component.targetPath = '';
      nameNewFolder(typed);
      expect(component.getEffectiveTargetPath()).toBe(path);
    });
  }

  it('clearing the new folder brings the target back to the base', () => {
    component.targetPath = 'docs';
    nameNewFolder('q4');

    component.clearNewFolder();

    expect(component.newFolderName).toBe('');
    expect(component.newFolderOpen).toBe(false);
    expect(component.getEffectiveTargetPath()).toBe('docs');
  });

  for (const invalid of [
    '',
    '   ',
    '/',
    'a//b',
    'a/ /b',
    'a\\b',
    '.',
    '..',
    'a/../b',
    'a/./b',
  ]) {
    it(`an invalid name (${JSON.stringify(invalid)}) leaves the target on the base and blocks upload`, () => {
      component.targetPath = 'docs';
      nameNewFolder(invalid);

      expect(component.getEffectiveTargetPath()).toBe('docs');
      expect(component.newFolderInvalid).toBe(true);
    });
  }

  it('the name of a folder that may already exist is valid (the upload merges)', () => {
    component.targetPath = '';
    nameNewFolder('docs');

    expect(component.newFolderInvalid).toBe(false);
    expect(component.getEffectiveTargetPath()).toBe('docs');
  });

  it('onHide() clears the new-folder name and closes the input', () => {
    component.targetPath = 'docs';
    nameNewFolder('q4');

    component.onHide();

    expect(component.newFolderName).toBe('');
    expect(component.newFolderOpen).toBe(false);
    expect(component.newFolderInvalid).toBe(false);
    expect(component.getEffectiveTargetPath()).toBe('docs');
  });

  it('uploadFiles() refuses an invalid name instead of uploading to the base', () => {
    const emitSpy = spyOn(component.uploadComplete, 'emit');
    component.selectedFiles = [makeFile('a.md')];
    component.targetPath = 'docs';
    nameNewFolder('a//b');

    component.uploadFiles();

    expect(emitSpy).not.toHaveBeenCalled();
    expect(component.successMessage).toBeNull();
    expect(component.uploading).toBe(false);
  });

  it('uploadFiles() emits with a valid new-folder name', fakeAsync(() => {
    const emitSpy = spyOn(component.uploadComplete, 'emit');
    installFileUploadSpy(component);
    component.selectedFiles = [makeFile('a.md')];
    nameNewFolder('q4');

    component.uploadFiles();
    tick(0);
    tick(1500);

    expect(emitSpy).toHaveBeenCalledTimes(1);
  }));
});

// --------------------------------------------------------------------
// The real template. The describe above strips it, so a deleted binding
// would leave it green; this one drives the controls through the DOM.
// --------------------------------------------------------------------

describe('UploadModalComponent (rendered template)', () => {
  let component: UploadModalComponent;
  let fixture: ComponentFixture<UploadModalComponent>;

  // p-dialog may render its content outside the host element, so query the
  // whole document; TestBed tears the fixture down after each spec.
  function el<T extends Element>(testId: string, inner = ''): T | null {
    return document.querySelector<T>(
      `[data-testid="${testId}"]${inner ? ' ' + inner : ''}`
    );
  }

  function targetText(): string {
    return (el('upload-target')?.textContent ?? '').replace(/\s+/g, ' ').trim();
  }

  function uploadButton(): HTMLButtonElement {
    const button = el<HTMLButtonElement>('upload-submit', 'button');
    expect(button).withContext('Upload button rendered').not.toBeNull();
    return button!;
  }

  async function settle(): Promise<void> {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  async function type(value: string): Promise<void> {
    const input = el<HTMLInputElement>('new-folder-input');
    expect(input).withContext('new-folder input rendered').not.toBeNull();
    input!.value = value;
    input!.dispatchEvent(new Event('input'));
    await settle();
  }

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [UploadModalComponent, NoopAnimationsModule],
      providers: [provideTranslateTesting()],
    }).compileComponents();

    fixture = TestBed.createComponent(UploadModalComponent);
    component = fixture.componentInstance;
    component.targetPath = 'docs';
    component.visible = true;
    await settle();
  });

  it('New folder → type → preview; invalid name gates Upload; clear restores the base', async () => {
    // A file is selected, so Upload is enabled before any folder is named:
    // with no file it is disabled anyway and would prove nothing.
    component.selectedFiles = [makeFile('a.md')];
    await settle();
    expect(targetText()).toBe('docs');
    expect(el('new-folder-input')).toBeNull();
    expect(uploadButton().disabled).toBe(false);

    // Open the input: the toggle hides, the input appears.
    el<HTMLButtonElement>('new-folder-toggle', 'button')!.click();
    await settle();
    expect(el('new-folder-input')).not.toBeNull();
    expect(el('new-folder-toggle')).toBeNull();

    // A valid name previews under the base.
    await type('q4');
    expect(targetText()).toBe('docs / q4');
    expect(el('new-folder-hint')).toBeNull();
    expect(uploadButton().disabled).toBe(false);

    // Nested names preview under the base too.
    await type('hugging-face/test');
    expect(targetText()).toBe('docs / hugging-face/test');
    expect(el('new-folder-hint')).toBeNull();
    expect(uploadButton().disabled).toBe(false);

    // An invalid name: hint shown, Upload disabled, preview back to the base.
    await type('a//b');
    expect(el('new-folder-hint')).not.toBeNull();
    expect(uploadButton().disabled).toBe(true);
    expect(targetText()).toBe('docs');

    // A valid name again re-enables Upload.
    await type('reports');
    expect(el('new-folder-hint')).toBeNull();
    expect(uploadButton().disabled).toBe(false);
    expect(component.getEffectiveTargetPath()).toBe('docs/reports');

    // Clear: the input goes, the toggle returns, the target is the base.
    el<HTMLButtonElement>('new-folder-clear', 'button')!.click();
    await settle();
    expect(el('new-folder-input')).toBeNull();
    expect(el('new-folder-toggle')).not.toBeNull();
    expect(targetText()).toBe('docs');
    expect(component.newFolderName).toBe('');
  });

  it('opening the input focuses it, and it is labelled and tied to the hint', async () => {
    // Clicking New folder removes the focused toggle, so without autofocus
    // keyboard focus would fall to <body>.
    el<HTMLButtonElement>('new-folder-toggle', 'button')!.click();
    await settle();
    // pAutoFocus focuses through a setTimeout — drain it.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const input = el<HTMLInputElement>('new-folder-input')!;
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute('aria-label')).toBe(
      'workspace.upload.newFolderPlaceholder'
    );

    // Empty name: invalid, and the hint describes the input.
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const hintId = input.getAttribute('aria-describedby');
    expect(hintId).not.toBeNull();
    expect(el('new-folder-hint')).not.toBeNull();
    expect(document.getElementById(hintId!)).toBe(
      el<HTMLElement>('new-folder-hint')
    );

    await type('q4');
    expect(input.getAttribute('aria-invalid')).toBe('false');
    expect(input.hasAttribute('aria-describedby')).toBe(false);
  });

  it('the root base previews the root-folder label, then label / name', async () => {
    component.targetPath = '';
    await settle();
    expect(targetText()).toBe('workspace.upload.rootFolder');

    el<HTMLButtonElement>('new-folder-toggle', 'button')!.click();
    await settle();
    await type('q4');

    expect(targetText()).toBe('workspace.upload.rootFolder / q4');
    expect(component.getEffectiveTargetPath()).toBe('q4');
  });
});
