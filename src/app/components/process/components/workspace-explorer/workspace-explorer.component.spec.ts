import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  CUSTOM_ELEMENTS_SCHEMA,
} from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { TreeNode } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { ToolbarModule } from 'primeng/toolbar';
import { BehaviorSubject, Subject } from 'rxjs';

import { ContextService } from '../../../../core/context/context.service';
import {
  WorkspaceInvalidation,
  WorkspaceInvalidationService,
} from '../../selectors/workspace-invalidation.selector';
import {
  FileContent,
  FileNode,
  WorkspaceService,
} from '../../workspace/workspace.service';
import { UploadModalComponent } from './upload-modal/upload-modal.component';
import { WorkspaceExplorerComponent } from './workspace-explorer.component';

// --------------------------------------------------------------------
// Fixture helpers
// --------------------------------------------------------------------

/**
 * The seam every routing spec drives: a bare Subject standing in for the
 * projection. These specs test the explorer's ROUTING, never the fold — the
 * fold is `workspace-invalidation.selector.spec.ts`'s subject and must not be
 * re-tested through a component.
 *
 * Every TestBed in this file provides one, because the explorer now injects the
 * service unconditionally and a missing provider is a NullInjectorError rather
 * than an inert dependency.
 */
class FakeWorkspaceInvalidationService {
  readonly invalidations$ = new Subject<WorkspaceInvalidation>();
}

/** One instruction, with every unnamed target empty. */
function invalidation(
  overrides: Partial<WorkspaceInvalidation> = {},
): WorkspaceInvalidation {
  return {
    workspaceId: 'proc',
    wholeTree: false,
    directories: [],
    files: [],
    deletions: [],
    ...overrides,
  };
}

function makeTeam(): any {
  return {
    team_id: 'proc',
    name: 'Demo Team',
    status: 'running',
    created_at: '2026-04-08T10:00:00Z',
    updated_at: '2026-04-08T10:00:00Z',
    config_name: 'demo',
    description: null,
  };
}

function fileNode(overrides: Partial<FileNode>): FileNode {
  return {
    name: overrides.name || 'x',
    path: overrides.path || 'x',
    type: overrides.type || 'file',
    size: overrides.size ?? 1,
    extension: overrides.extension,
    ...overrides,
  };
}

/**
 * One of the three upload controls, in either override this file uses.
 *
 * Where PrimeNG's `ButtonModule` is NOT imported, `<p-button>` is an unknown
 * custom element with no inner `<button>` and every property binding lands
 * straight on the element object — so `disabled` is read off the host itself
 * and is never reflected to an attribute. Where `ButtonModule` IS imported,
 * `[disabled]` is a real Button input (read off the inner `<button>`) while
 * `[pTooltip]` stays unclaimed, because `TooltipModule` is deliberately left
 * out, and therefore still lands on the host as `pTooltip`.
 */
interface UploadControlEl extends HTMLElement {
  disabled?: boolean;
  pTooltip?: string;
}

/** Query one upload control by its STATIC `label` attribute (a real attribute). */
function uploadControl(host: HTMLElement, label: string): UploadControlEl | null {
  return host.querySelector(`p-button[label="${label}"]`) as UploadControlEl | null;
}

/**
 * Drive the declarative `toObservable(workspaceId) → switchMap` root load:
 * `detectChanges()` flushes the effect that feeds the signal value into the
 * stream; `whenStable()` waits for the resolved fetch promise to settle the
 * signals. Used everywhere the old spec called `ngOnInit()`/`loadWorkspace()`.
 */
async function flushRootLoad(
  fixture: ComponentFixture<WorkspaceExplorerComponent>,
): Promise<void> {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

/** Drain the microtask queue so fire-and-forget async work settles. */
function flushMicrotasks(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** A promise whose settlement the spec controls, to observe an in-flight window. */
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('WorkspaceExplorerComponent', () => {
  let component: WorkspaceExplorerComponent;
  let fixture: ComponentFixture<WorkspaceExplorerComponent>;
  let workspaceServiceSpy: jasmine.SpyObj<WorkspaceService>;
  let invalidationStub: FakeWorkspaceInvalidationService;
  let contextServiceStub: {
    currentProcessId$: BehaviorSubject<string>;
    currentTeamRunning$: BehaviorSubject<boolean>;
    getCurrentTeam: jasmine.Spy;
  };

  beforeEach(async () => {
    workspaceServiceSpy = jasmine.createSpyObj('WorkspaceService', [
      'getWorkspaceTree',
      'getFileContent',
      'getDownloadUrl',
      'uploadFiles',
    ]);
    invalidationStub = new FakeWorkspaceInvalidationService();
    contextServiceStub = {
      currentProcessId$: new BehaviorSubject<string>('proc'),
      currentTeamRunning$: new BehaviorSubject<boolean>(true),
      getCurrentTeam: jasmine
        .createSpy('getCurrentTeam')
        .and.callFake(async () => makeTeam()),
    };

    await TestBed.configureTestingModule({
      imports: [WorkspaceExplorerComponent, NoopAnimationsModule],
      providers: [
        { provide: WorkspaceService, useValue: workspaceServiceSpy },
        { provide: ContextService, useValue: contextServiceStub },
        {
          provide: WorkspaceInvalidationService,
          useValue: invalidationStub,
        },
      ],
    })
      .overrideComponent(WorkspaceExplorerComponent, {
        set: {
          imports: [CommonModule],
          schemas: [CUSTOM_ELEMENTS_SCHEMA],
        },
      })
      .compileComponents();
  });

  // --- declarative root-tree load -----------------------------------

  describe('root-tree load', () => {
    it('scenario 1 — root listing wraps backend entries under synthetic Root Folder', async () => {
      workspaceServiceSpy.getWorkspaceTree.and.resolveTo([
        fileNode({
          name: 'a.md',
          path: 'a.md',
          type: 'file',
          size: 10,
          extension: '.md',
        }),
        fileNode({ name: 'sub', path: 'sub', type: 'directory', size: 0 }),
      ]);

      fixture = TestBed.createComponent(WorkspaceExplorerComponent);
      component = fixture.componentInstance;
      await flushRootLoad(fixture);

      expect(component.treeNodes().length).toBe(1);
      const root = component.treeNodes()[0];
      expect(root.label).toBe('Root Folder');
      expect(root.icon).toBe('pi pi-home');
      expect(root.expanded).toBe(true);
      expect(root.children?.length).toBe(2);
      expect(component.errorMessage()).toBeNull();

      // The directory child should be lazy (children === undefined, leaf false)
      const subChild = root.children![1];
      expect(subChild.label).toBe('sub');
      expect(subChild.leaf).toBe(false);
      expect(subChild.children).toBeUndefined();

      // The file child should be a leaf
      const fileChild = root.children![0];
      expect(fileChild.label).toBe('a.md');
      expect(fileChild.leaf).toBe(true);
    });

    it('scenario 2 — empty backend renders synthetic root with empty children', async () => {
      workspaceServiceSpy.getWorkspaceTree.and.resolveTo([]);

      fixture = TestBed.createComponent(WorkspaceExplorerComponent);
      component = fixture.componentInstance;
      await flushRootLoad(fixture);

      // Synthetic root always exists; its children are []
      expect(component.treeNodes().length).toBe(1);
      expect(component.treeNodes()[0].label).toBe('Root Folder');
      expect(component.treeNodes()[0].children).toEqual([]);
      expect(component.errorMessage()).toBeNull();
    });

    it('scenario 3 — HTTP error sets errorMessage and clears loading', async () => {
      workspaceServiceSpy.getWorkspaceTree.and.rejectWith(new Error('500'));

      fixture = TestBed.createComponent(WorkspaceExplorerComponent);
      component = fixture.componentInstance;
      await flushRootLoad(fixture);

      expect(component.errorMessage()).toBe('500');
      expect(component.loading()).toBe(false);
    });
  });

  // --- onNodeExpand --------------------------------------------------

  describe('onNodeExpand', () => {
    beforeEach(() => {
      // Neutral initial state; tests manually fabricate TreeNodes.
      workspaceServiceSpy.getWorkspaceTree.and.resolveTo([]);
      fixture = TestBed.createComponent(WorkspaceExplorerComponent);
      component = fixture.componentInstance;
      component.processId = 'proc';
    });

    it('scenario 4 — first-click on unloaded directory fetches and populates children', async () => {
      const subDir: TreeNode = {
        label: 'sub',
        data: fileNode({ name: 'sub', path: 'sub', type: 'directory' }),
        leaf: false,
        children: undefined,
      };
      component.treeNodes.set([subDir]);

      workspaceServiceSpy.getWorkspaceTree.calls.reset();
      workspaceServiceSpy.getWorkspaceTree.and.resolveTo([
        fileNode({
          name: 'inner.ts',
          path: 'sub/inner.ts',
          type: 'file',
          size: 1,
          extension: '.ts',
        }),
      ]);

      await component.onNodeExpand({ node: subDir });

      expect(workspaceServiceSpy.getWorkspaceTree).toHaveBeenCalledOnceWith(
        'proc',
        'sub'
      );
      expect(subDir.children?.length).toBe(1);
      expect(subDir.children![0].leaf).toBe(true);
      expect(subDir.children![0].label).toBe('inner.ts');
    });

    it('scenario 5 — second-click on already-loaded directory is a no-op', async () => {
      const subDir: TreeNode = {
        label: 'sub',
        data: fileNode({ name: 'sub', path: 'sub', type: 'directory' }),
        leaf: false,
        children: undefined,
      };
      component.treeNodes.set([subDir]);

      workspaceServiceSpy.getWorkspaceTree.calls.reset();
      workspaceServiceSpy.getWorkspaceTree.and.resolveTo([
        fileNode({ name: 'x', path: 'sub/x', type: 'file' }),
      ]);

      await component.onNodeExpand({ node: subDir });
      await component.onNodeExpand({ node: subDir });

      expect(workspaceServiceSpy.getWorkspaceTree.calls.count()).toBe(1);
    });

    it('scenario 6 — expand on file node is a no-op', async () => {
      const fileNd: TreeNode = {
        label: 'a.md',
        data: fileNode({ name: 'a.md', path: 'a.md', type: 'file' }),
        leaf: true,
        children: undefined,
      };

      workspaceServiceSpy.getWorkspaceTree.calls.reset();
      await component.onNodeExpand({ node: fileNd });

      expect(workspaceServiceSpy.getWorkspaceTree).not.toHaveBeenCalled();
    });

    it('scenario 7 — empty-directory response caches (second click is a no-op)', async () => {
      const subDir: TreeNode = {
        label: 'empty',
        data: fileNode({ name: 'empty', path: 'empty', type: 'directory' }),
        leaf: false,
        children: undefined,
      };
      component.treeNodes.set([subDir]);

      workspaceServiceSpy.getWorkspaceTree.calls.reset();
      workspaceServiceSpy.getWorkspaceTree.and.resolveTo([]);

      await component.onNodeExpand({ node: subDir });
      expect(subDir.children).toEqual([]);

      await component.onNodeExpand({ node: subDir });
      expect(workspaceServiceSpy.getWorkspaceTree.calls.count()).toBe(1);
    });

    it('scenario 8 — HTTP error sets errorMessage and leaves children undefined (retryable)', async () => {
      const subDir: TreeNode = {
        label: 'bad',
        data: fileNode({ name: 'bad', path: 'bad', type: 'directory' }),
        leaf: false,
        children: undefined,
      };
      component.treeNodes.set([subDir]);

      workspaceServiceSpy.getWorkspaceTree.calls.reset();
      workspaceServiceSpy.getWorkspaceTree.and.rejectWith(new Error('boom'));

      await component.onNodeExpand({ node: subDir });

      expect(component.errorMessage()).toBe('boom');
      expect(subDir.children).toBeUndefined();
    });
  });

  // --- loadFileContent (AC2) ----------------------------------------

  describe('loadFileContent', () => {
    beforeEach(() => {
      workspaceServiceSpy.getWorkspaceTree.and.resolveTo([]);
      fixture = TestBed.createComponent(WorkspaceExplorerComponent);
      component = fixture.componentInstance;
      component.processId = 'proc';
    });

    it('scenario 19 — text result writes fileContent, clears loadingContent and isBinaryFile', async () => {
      // The pane is showing the file being read. Previously this scenario drove
      // the loader with no selection at all — a state no production caller can
      // produce, and one whose result is now applied to nothing (scenario 70).
      component.selectedFile.set(
        fileNode({
          name: 'readme.txt',
          path: 'docs/readme.txt',
          type: 'file',
          extension: '.txt',
        })
      );
      workspaceServiceSpy.getFileContent.and.resolveTo({
        content: 'hello world',
        type: 'text',
      });

      await component.loadFileContent('docs/readme.txt');

      expect(component.fileContent()).toBe('hello world');
      expect(component.loadingContent()).toBe(false);
      expect(component.isBinaryFile()).toBe(false);
      expect(component.isMarkdownFile()).toBe(false);
      expect(component.errorMessage()).toBeNull();
    });

    it('scenario 20 — a .md selected file flags isMarkdownFile on a text result', async () => {
      component.selectedFile.set(
        fileNode({
          name: 'a.md',
          path: 'docs/a.md',
          type: 'file',
          extension: '.md',
        })
      );
      workspaceServiceSpy.getFileContent.and.resolveTo({
        content: '# Title',
        type: 'text',
      });

      await component.loadFileContent('docs/a.md');

      expect(component.fileContent()).toBe('# Title');
      expect(component.isMarkdownFile()).toBe(true);
      expect(component.isBinaryFile()).toBe(false);
      expect(component.loadingContent()).toBe(false);
    });

    it('scenario 21 — binary result flags isBinaryFile and shows the binary message', async () => {
      // Same correction as scenario 19: the pane must be showing the file whose
      // bytes are read, because a result for any other path is now discarded.
      component.selectedFile.set(
        fileNode({
          name: 'image.png',
          path: 'docs/image.png',
          type: 'file',
          extension: '.png',
        })
      );
      workspaceServiceSpy.getFileContent.and.resolveTo({
        content: null,
        type: 'binary',
        message: 'Binary file cannot be displayed',
      });

      await component.loadFileContent('docs/image.png');

      expect(component.isBinaryFile()).toBe(true);
      expect(component.fileContent()).toBe('Binary file cannot be displayed');
      expect(component.isMarkdownFile()).toBe(false);
      expect(component.loadingContent()).toBe(false);
    });

    it('scenario 22 — rejected fetch sets errorMessage and clears loadingContent', async () => {
      workspaceServiceSpy.getFileContent.and.rejectWith(new Error('read failed'));

      await component.loadFileContent('docs/bad.txt');

      expect(component.errorMessage()).toBe('read failed');
      expect(component.loadingContent()).toBe(false);
      expect(component.fileContent()).toBeNull();
    });
  });

  // --- onNodeSelect (AC3) -------------------------------------------

  describe('onNodeSelect', () => {
    beforeEach(() => {
      workspaceServiceSpy.getWorkspaceTree.and.resolveTo([]);
      workspaceServiceSpy.getFileContent.and.resolveTo({
        content: 'data',
        type: 'text',
      });
      fixture = TestBed.createComponent(WorkspaceExplorerComponent);
      component = fixture.componentInstance;
      component.processId = 'proc';
    });

    it('scenario 23 — selecting a file sets selectedFile, clears selectedFolder, loads content', async () => {
      // Seed a stale folder selection to prove it is cleared.
      component.selectedFolder.set(
        fileNode({ name: 'old', path: 'old', type: 'directory' })
      );
      const file = fileNode({
        name: 'a.ts',
        path: 'src/a.ts',
        type: 'file',
        extension: '.ts',
      });

      await component.onNodeSelect({ node: { data: file } });

      expect(component.selectedFile()).toEqual(file);
      expect(component.selectedFolder()).toBeNull();
      expect(workspaceServiceSpy.getFileContent).toHaveBeenCalledWith(
        'proc',
        'src/a.ts',
        undefined
      );
      expect(component.fileContent()).toBe('data');
    });

    it('scenario 24 — selecting a directory sets selectedFolder, clears file + content signals', async () => {
      // Seed a stale file + content selection to prove they are cleared.
      component.selectedFile.set(
        fileNode({ name: 'a.ts', path: 'src/a.ts', type: 'file' })
      );
      component.fileContent.set('stale content');
      component.isBinaryFile.set(true);
      component.isMarkdownFile.set(true);

      workspaceServiceSpy.getFileContent.calls.reset();
      const dir = fileNode({ name: 'src', path: 'src', type: 'directory' });

      await component.onNodeSelect({ node: { data: dir } });

      expect(component.selectedFolder()).toEqual(dir);
      expect(component.selectedFile()).toBeNull();
      expect(component.fileContent()).toBeNull();
      expect(component.isBinaryFile()).toBe(false);
      expect(component.isMarkdownFile()).toBe(false);
      // Selecting a directory loads no content.
      expect(workspaceServiceSpy.getFileContent).not.toHaveBeenCalled();
    });
  });

  // --- refreshSelectedFile (Epic 38) ---------------------------------
  //
  // The panel used to render a file once, at selection time, and never read it
  // again. These specs cover the per-file refresh: body AND metadata, without
  // blanking the pane. The "without blanking" half is the one that silently
  // regresses, so it is asserted DURING the in-flight window (scenario 48) —
  // a spec that only checks the final content passes against an implementation
  // that blanks and repaints, which is the bug being fixed.

  describe('refreshSelectedFile', () => {
    const OPEN_FILE_PATH = 'docs/a.md';

    function openFile(size = 10): FileNode {
      return fileNode({
        name: 'a.md',
        path: OPEN_FILE_PATH,
        type: 'file',
        size,
        extension: '.md',
      });
    }

    /** Root wrapper → `docs` (materialized) → `a.md`. */
    function materializedTree(): TreeNode {
      const aMd: TreeNode = {
        label: 'a.md',
        data: openFile(10),
        leaf: true,
      };
      const docs: TreeNode = {
        label: 'docs',
        data: fileNode({ name: 'docs', path: 'docs', type: 'directory' }),
        leaf: false,
        children: [aMd],
      };
      return {
        label: 'Root Folder',
        data: fileNode({ name: 'Root Folder', path: '', type: 'directory' }),
        children: [docs],
        expanded: true,
      };
    }

    beforeEach(() => {
      workspaceServiceSpy.getWorkspaceTree.and.resolveTo([]);
      workspaceServiceSpy.getFileContent.and.resolveTo({
        content: 'first',
        type: 'text',
      });
      fixture = TestBed.createComponent(WorkspaceExplorerComponent);
      component = fixture.componentInstance;
      component.processId = 'proc';
    });

    it('scenario 45 — activating refresh re-reads the body and renders the new content', async () => {
      component.selectedFile.set(openFile());
      await component.loadFileContent(OPEN_FILE_PATH);
      expect(component.fileContent()).toBe('first');

      workspaceServiceSpy.getFileContent.and.resolveTo({
        content: 'first + appended',
        type: 'text',
      });
      workspaceServiceSpy.getWorkspaceTree.and.resolveTo([openFile(2048)]);

      await component.refreshSelectedFile();

      expect(component.fileContent()).toBe('first + appended');
    });

    it('scenario 46 — the same activation re-resolves the file entry and splices the fresh listing', async () => {
      component.treeNodes.set([materializedTree()]);
      component.selectedFile.set(openFile(10));
      component.fileContent.set('first');

      workspaceServiceSpy.getWorkspaceTree.calls.reset();
      workspaceServiceSpy.getFileContent.calls.reset();
      workspaceServiceSpy.getWorkspaceTree.and.resolveTo([openFile(2048)]);
      workspaceServiceSpy.getFileContent.and.resolveTo({
        content: 'first + appended',
        type: 'text',
      });

      await component.refreshSelectedFile();

      // BOTH halves ran on the one activation.
      expect(workspaceServiceSpy.getFileContent.calls.count()).toBe(1);
      expect(workspaceServiceSpy.getWorkspaceTree).toHaveBeenCalledOnceWith(
        'proc',
        'docs'
      );

      // The metadata the toolbar tag reads moved with the body.
      expect(component.selectedFile()!.size).toBe(2048);
      // ...and so did the tree entry behind it.
      const docsNode = component.treeNodes()[0].children![0];
      expect(docsNode.children!.length).toBe(1);
      expect((docsNode.children![0].data as FileNode).size).toBe(2048);
    });

    it('scenario 47 — a file in a never-expanded directory refreshes without throwing or corrupting the tree', async () => {
      // Only the synthetic root is materialized; `docs` was never expanded.
      const bareRoot: TreeNode = {
        label: 'Root Folder',
        data: fileNode({ name: 'Root Folder', path: '', type: 'directory' }),
        children: [],
        expanded: true,
      };
      component.treeNodes.set([bareRoot]);
      component.selectedFile.set(openFile(10));

      workspaceServiceSpy.getWorkspaceTree.and.resolveTo([openFile(2048)]);
      workspaceServiceSpy.getFileContent.and.resolveTo({
        content: 'body',
        type: 'text',
      });

      await expectAsync(component.refreshSelectedFile()).toBeResolved();

      // The unmaterialized target is left alone; the open file still refreshed.
      expect(component.treeNodes()[0].children).toEqual([]);
      expect(component.selectedFile()!.size).toBe(2048);
      expect(component.fileContent()).toBe('body');
    });

    it('scenario 48 — the pane is never blanked: fileContent stays non-null and loadingContent stays down across the whole cycle', async () => {
      component.selectedFile.set(openFile(10));
      component.fileContent.set('old body');
      workspaceServiceSpy.getWorkspaceTree.and.resolveTo([openFile(2048)]);

      const body = deferred<FileContent>();
      workspaceServiceSpy.getFileContent.and.returnValue(body.promise);

      const observed: { content: string | null; loading: boolean }[] = [];
      const observe = (): void => {
        observed.push({
          content: component.fileContent(),
          loading: component.loadingContent(),
        });
      };

      observe();
      const cycle = component.refreshSelectedFile();
      // Synchronous entry: a blanking implementation has already nulled the
      // pane and raised the spinner by this point.
      observe();
      await Promise.resolve();
      observe();
      await Promise.resolve();
      observe();

      body.resolve({ content: 'new body', type: 'text' });
      await cycle;
      observe();

      expect(observed.map((o) => o.content)).not.toContain(null);
      expect(observed.map((o) => o.loading)).not.toContain(true);
      expect(component.fileContent()).toBe('new body');
      expect(component.refreshingFile()).toBe(false);
    });

    it('scenario 49 — the selection path still blanks, still raises loadingContent and still issues exactly one request', async () => {
      component.fileContent.set('stale body');
      workspaceServiceSpy.getWorkspaceTree.calls.reset();
      workspaceServiceSpy.getFileContent.calls.reset();

      const body = deferred<FileContent>();
      workspaceServiceSpy.getFileContent.and.returnValue(body.promise);

      const selection = component.onNodeSelect({ node: { data: openFile() } });

      expect(component.fileContent()).toBeNull();
      expect(component.loadingContent()).toBe(true);

      body.resolve({ content: 'body', type: 'text' });
      await selection;

      expect(component.loadingContent()).toBe(false);
      expect(component.fileContent()).toBe('body');
      // One body read, and NO directory listing — selection is not a refresh.
      expect(workspaceServiceSpy.getFileContent.calls.count()).toBe(1);
      expect(workspaceServiceSpy.getWorkspaceTree).not.toHaveBeenCalled();
    });

    it('scenario 50 — a failed body read keeps the stale body and reports the error', async () => {
      const original = openFile(10);
      component.selectedFile.set(original);
      component.fileContent.set('old body');

      workspaceServiceSpy.getWorkspaceTree.and.resolveTo([openFile(2048)]);
      workspaceServiceSpy.getFileContent.and.rejectWith(new Error('read failed'));

      await component.refreshSelectedFile();

      expect(component.errorMessage()).toBe('read failed');
      expect(component.fileContent()).toBe('old body');
      expect(component.loadingContent()).toBe(false);
      expect(component.refreshingFile()).toBe(false);
    });

    it('scenario 51 — a failed listing leaves selectedFile alone, still refreshes the body, and releases the button', async () => {
      const original = openFile(10);
      component.selectedFile.set(original);
      component.fileContent.set('old body');

      workspaceServiceSpy.getWorkspaceTree.and.rejectWith(
        new Error('listing failed')
      );
      workspaceServiceSpy.getFileContent.and.resolveTo({
        content: 'new body',
        type: 'text',
      });

      await component.refreshSelectedFile();

      expect(component.errorMessage()).toBe('listing failed');
      expect(component.selectedFile()).toEqual(original);
      expect(component.fileContent()).toBe('new body');
      expect(component.refreshingFile()).toBe(false);
    });

    it('scenario 52 — a vanished file leaves selectedFile as it is', async () => {
      const original = openFile(10);
      component.selectedFile.set(original);
      // Fresh listing no longer carries the open file's path.
      workspaceServiceSpy.getWorkspaceTree.and.resolveTo([
        fileNode({ name: 'b.md', path: 'docs/b.md', type: 'file', size: 5 }),
      ]);
      workspaceServiceSpy.getFileContent.and.resolveTo({
        content: 'body',
        type: 'text',
      });

      await component.refreshSelectedFile();

      expect(component.selectedFile()).toEqual(original);
    });

    it('scenario 53 — with no file open the refresh is a no-op', async () => {
      component.selectedFile.set(null);
      workspaceServiceSpy.getWorkspaceTree.calls.reset();
      workspaceServiceSpy.getFileContent.calls.reset();

      await component.refreshSelectedFile();

      expect(workspaceServiceSpy.getFileContent).not.toHaveBeenCalled();
      expect(workspaceServiceSpy.getWorkspaceTree).not.toHaveBeenCalled();
    });

    it('scenario 54 — a set workspaceId is threaded through BOTH the body read and the listing', async () => {
      fixture.componentRef.setInput('workspaceId', 'ws-1');
      await flushRootLoad(fixture);

      component.selectedFile.set(openFile(10));
      workspaceServiceSpy.getWorkspaceTree.calls.reset();
      workspaceServiceSpy.getFileContent.calls.reset();
      workspaceServiceSpy.getWorkspaceTree.and.resolveTo([openFile(2048)]);
      workspaceServiceSpy.getFileContent.and.resolveTo({
        content: 'body',
        type: 'text',
      });

      await component.refreshSelectedFile();

      expect(workspaceServiceSpy.getFileContent).toHaveBeenCalledOnceWith(
        'proc',
        OPEN_FILE_PATH,
        'ws-1'
      );
      expect(workspaceServiceSpy.getWorkspaceTree).toHaveBeenCalledOnceWith(
        'proc',
        'docs',
        'ws-1'
      );
    });

    it('scenario 55 — an unset workspaceId omits the id on both calls', async () => {
      component.selectedFile.set(openFile(10));
      workspaceServiceSpy.getWorkspaceTree.calls.reset();
      workspaceServiceSpy.getFileContent.calls.reset();
      workspaceServiceSpy.getWorkspaceTree.and.resolveTo([openFile(2048)]);
      workspaceServiceSpy.getFileContent.and.resolveTo({
        content: 'body',
        type: 'text',
      });

      await component.refreshSelectedFile();

      expect(workspaceServiceSpy.getFileContent).toHaveBeenCalledOnceWith(
        'proc',
        OPEN_FILE_PATH,
        undefined
      );
      // The unset path keeps today's 2-arg listing shape.
      expect(workspaceServiceSpy.getWorkspaceTree).toHaveBeenCalledOnceWith(
        'proc',
        'docs'
      );
    });

    it('scenario 56 — the navigator refresh re-runs the root load AND re-reads the open file', async () => {
      component.selectedFile.set(openFile(10));
      workspaceServiceSpy.getWorkspaceTree.calls.reset();
      workspaceServiceSpy.getFileContent.calls.reset();
      workspaceServiceSpy.getWorkspaceTree.and.resolveTo([openFile(2048)]);
      workspaceServiceSpy.getFileContent.and.resolveTo({
        content: 'body',
        type: 'text',
      });

      component.refresh();
      await flushMicrotasks();

      // Root tree half.
      expect(workspaceServiceSpy.getWorkspaceTree).toHaveBeenCalledWith(
        'proc',
        ''
      );
      // Open-file half, through the same per-file path.
      expect(workspaceServiceSpy.getWorkspaceTree).toHaveBeenCalledWith(
        'proc',
        'docs'
      );
      expect(workspaceServiceSpy.getFileContent).toHaveBeenCalledOnceWith(
        'proc',
        OPEN_FILE_PATH,
        undefined
      );
      expect(component.selectedFile()!.size).toBe(2048);
    });

    it('scenario 57 — with no file open the navigator refresh is tree-only', async () => {
      component.selectedFile.set(null);
      workspaceServiceSpy.getWorkspaceTree.calls.reset();
      workspaceServiceSpy.getFileContent.calls.reset();

      component.refresh();
      await flushMicrotasks();

      expect(workspaceServiceSpy.getWorkspaceTree).toHaveBeenCalledOnceWith(
        'proc',
        ''
      );
      expect(workspaceServiceSpy.getFileContent).not.toHaveBeenCalled();
    });

    // The toolbar control's [disabled] binding is the only thing stopping a
    // second per-file read — and the NAVIGATOR's refresh reaches this method
    // without being bound to it. So the gate is enforced in the method too:
    // two reads of one file settle in arbitrary order, and the loser repaints
    // the pane with the older bytes.

    it('scenario 63 — a second activation while a refresh is in flight is ignored', async () => {
      component.selectedFile.set(openFile(10));
      component.fileContent.set('old body');
      workspaceServiceSpy.getWorkspaceTree.calls.reset();
      workspaceServiceSpy.getFileContent.calls.reset();
      workspaceServiceSpy.getWorkspaceTree.and.resolveTo([openFile(2048)]);

      const body = deferred<FileContent>();
      workspaceServiceSpy.getFileContent.and.returnValue(body.promise);

      const first = component.refreshSelectedFile();
      // The path the navigator's control takes: not gated on refreshingFile.
      await component.refreshSelectedFile();

      expect(workspaceServiceSpy.getFileContent.calls.count()).toBe(1);
      // The in-flight flag is still held by the FIRST cycle, so the button
      // stays disabled rather than being released by the ignored activation.
      expect(component.refreshingFile()).toBe(true);

      body.resolve({ content: 'new body', type: 'text' });
      await first;

      expect(component.refreshingFile()).toBe(false);
      expect(component.fileContent()).toBe('new body');
      expect(workspaceServiceSpy.getFileContent.calls.count()).toBe(1);
    });

    it('scenario 64 — the navigator refresh skips the file half while an initial load is in flight', async () => {
      component.selectedFile.set(openFile(10));
      workspaceServiceSpy.getWorkspaceTree.calls.reset();
      workspaceServiceSpy.getFileContent.calls.reset();
      workspaceServiceSpy.getWorkspaceTree.and.resolveTo([]);

      // A selection load is still fetching this file's current bytes.
      component.loadingContent.set(true);

      component.refresh();
      await flushMicrotasks();

      // The tree half runs as always; the file half does not race the load
      // that is already reading the file (the gate the button applies).
      expect(workspaceServiceSpy.getWorkspaceTree).toHaveBeenCalledOnceWith(
        'proc',
        ''
      );
      expect(workspaceServiceSpy.getFileContent).not.toHaveBeenCalled();
    });
  });

  // --- superseded reads (Epic 39, FR8) -------------------------------
  //
  // Two body reads are trivially concurrent: `onNodeSelect` sets `selectedFile`
  // and issues a read without awaiting or cancelling one already in flight. If
  // the OLDER read resolves LAST it still wins every write it is allowed to
  // make, and the pane renders one file's bytes under another file's name and
  // size tag. The tree closed the same race declaratively with `switchMap`; the
  // body read never had an equivalent. These scenarios pin that equivalent —
  // the body, both renderer flags, the error banner, the spinner, and the
  // metadata twin in `refreshFileMetadata`.
  //
  // The reads are overlapped through the REAL entry point wherever the defect
  // is the subject, because `onNodeSelect`'s `selectedFile` write order is part
  // of what makes the race reachable.

  describe('superseded reads', () => {
    function fileA(): FileNode {
      return fileNode({
        name: 'a.txt',
        path: 'docs/a.txt',
        type: 'file',
        size: 10,
        extension: '.txt',
      });
    }

    function fileB(): FileNode {
      return fileNode({
        name: 'b.txt',
        path: 'docs/b.txt',
        type: 'file',
        size: 20,
        extension: '.txt',
      });
    }

    beforeEach(() => {
      workspaceServiceSpy.getWorkspaceTree.and.resolveTo([]);
      fixture = TestBed.createComponent(WorkspaceExplorerComponent);
      component = fixture.componentInstance;
      component.processId = 'proc';
    });

    it('scenario 65 — the older read resolving LAST does not replace the newer file body', async () => {
      const a = deferred<FileContent>();
      const b = deferred<FileContent>();
      workspaceServiceSpy.getFileContent.and.returnValues(a.promise, b.promise);

      const first = component.onNodeSelect({ node: { data: fileA() } });
      const second = component.onNodeSelect({ node: { data: fileB() } });

      b.resolve({ content: 'B body', type: 'text' });
      await second;
      // A loses the race and resolves into a pane that has moved on.
      a.resolve({ content: 'A body', type: 'text' });
      await first;

      expect(component.fileContent()).toBe('B body');
      expect(component.selectedFile()!.path).toBe('docs/b.txt');
    });

    it('scenario 66 — a stale binary result flips neither the renderer flag nor the body', async () => {
      const a = deferred<FileContent>();
      const b = deferred<FileContent>();
      workspaceServiceSpy.getFileContent.and.returnValues(a.promise, b.promise);

      const png = fileNode({
        name: 'img.png',
        path: 'docs/img.png',
        type: 'file',
        size: 99,
        extension: '.png',
      });
      const first = component.onNodeSelect({ node: { data: png } });
      const second = component.onNodeSelect({ node: { data: fileB() } });

      b.resolve({ content: 'B body', type: 'text' });
      await second;
      a.resolve({
        content: null,
        type: 'binary',
        message: 'Binary file cannot be displayed',
      });
      await first;

      // The binary placeholder never reaches the pane.
      expect(component.isBinaryFile()).toBe(false);
      expect(component.fileContent()).toBe('B body');
    });

    it('scenario 67 — a stale .md result does not switch the renderer under an open .txt file', async () => {
      const a = deferred<FileContent>();
      const b = deferred<FileContent>();
      workspaceServiceSpy.getFileContent.and.returnValues(a.promise, b.promise);

      const md = fileNode({
        name: 'a.md',
        path: 'docs/a.md',
        type: 'file',
        size: 10,
        extension: '.md',
      });
      const first = component.onNodeSelect({ node: { data: md } });
      const second = component.onNodeSelect({ node: { data: fileB() } });

      b.resolve({ content: 'B body', type: 'text' });
      await second;
      a.resolve({ content: '# Title', type: 'text' });
      await first;

      // Guards the half-finished fix: an implementation that guards the body
      // write but leaves the flag writes outside the guard passes scenario 65
      // and fails here.
      expect(component.isMarkdownFile()).toBe(false);
      expect(component.fileContent()).toBe('B body');
    });

    it('scenario 68 — markdown-ness comes from the requested path, not from FileNode.extension', async () => {
      // `extension` deliberately absent: the flag must not depend on a listing
      // field the backend may omit, nor on what `selectedFile` holds when the
      // response lands.
      component.selectedFile.set(
        fileNode({ name: 'a.md', path: 'docs/a.md', type: 'file', size: 10 })
      );
      workspaceServiceSpy.getFileContent.and.resolveTo({
        content: '# Title',
        type: 'text',
      });

      await component.loadFileContent('docs/a.md');

      expect(component.isMarkdownFile()).toBe(true);
      expect(component.fileContent()).toBe('# Title');

      // Case-insensitive, like the extension comparison it replaces.
      component.selectedFile.set(
        fileNode({ name: 'B.MD', path: 'docs/B.MD', type: 'file', size: 4 })
      );
      await component.loadFileContent('docs/B.MD');

      expect(component.isMarkdownFile()).toBe(true);
    });

    it('scenario 69 — a superseded metadata refresh does not write a stale FileNode into selectedFile', async () => {
      component.selectedFile.set(fileA());
      workspaceServiceSpy.getFileContent.and.resolveTo({
        content: 'A body',
        type: 'text',
      });
      const listing = deferred<FileNode[]>();
      workspaceServiceSpy.getWorkspaceTree.and.returnValue(listing.promise);

      const cycle = component.refreshSelectedFile();
      // The body half has settled; the directory listing is still in flight.
      await flushMicrotasks();
      component.selectedFile.set(fileB());

      listing.resolve([
        fileNode({
          name: 'a.txt',
          path: 'docs/a.txt',
          type: 'file',
          size: 2048,
          extension: '.txt',
        }),
      ]);
      await cycle;

      // File A's name and size tag must not land above file B's body.
      expect(component.selectedFile()!.path).toBe('docs/b.txt');
      expect(component.selectedFile()!.size).toBe(20);
    });

    it('scenario 70 — with no file selected a resolved read is applied to nothing', async () => {
      component.selectedFile.set(null);
      workspaceServiceSpy.getFileContent.and.resolveTo({
        content: 'orphan body',
        type: 'text',
      });

      // The stated semantics: no selection means no pane to write into. Both
      // production entry points establish or require `selectedFile` first, so
      // this state is reachable only by driving the loader directly.
      await expectAsync(component.loadFileContent('docs/x.txt')).toBeResolved();

      expect(component.fileContent()).toBeNull();
      expect(component.isBinaryFile()).toBe(false);
      expect(component.isMarkdownFile()).toBe(false);
      expect(component.loadingContent()).toBe(false);
    });

    it('scenario 71 — a superseded read that FAILS does not banner over the file now on screen', async () => {
      const a = deferred<FileContent>();
      const b = deferred<FileContent>();
      workspaceServiceSpy.getFileContent.and.returnValues(a.promise, b.promise);

      const first = component.onNodeSelect({ node: { data: fileA() } });
      const second = component.onNodeSelect({ node: { data: fileB() } });

      b.resolve({ content: 'B body', type: 'text' });
      await second;
      a.reject(new Error('A read failed'));
      await first;

      expect(component.errorMessage()).toBeNull();
      expect(component.fileContent()).toBe('B body');
    });

    it('scenario 72 — a superseded read does not lower the spinner a newer read is still holding', async () => {
      const a = deferred<FileContent>();
      const b = deferred<FileContent>();
      workspaceServiceSpy.getFileContent.and.returnValues(a.promise, b.promise);

      const first = component.onNodeSelect({ node: { data: fileA() } });
      const second = component.onNodeSelect({ node: { data: fileB() } });

      a.resolve({ content: 'A body', type: 'text' });
      await first;

      // B is still fetching, so the pane is blank and the spinner belongs to it.
      expect(component.loadingContent()).toBe(true);
      expect(component.fileContent()).toBeNull();

      b.resolve({ content: 'B body', type: 'text' });
      await second;

      expect(component.loadingContent()).toBe(false);
      expect(component.fileContent()).toBe('B body');
    });

    it('scenario 73 — selecting a directory mid-read leaves the folder pane alone and still releases the spinner', async () => {
      const a = deferred<FileContent>();
      workspaceServiceSpy.getFileContent.and.returnValue(a.promise);

      const first = component.onNodeSelect({ node: { data: fileA() } });
      await component.onNodeSelect({
        node: {
          data: fileNode({ name: 'docs', path: 'docs', type: 'directory' }),
        },
      });

      a.resolve({ content: 'A body', type: 'text' });
      await first;

      expect(component.selectedFile()).toBeNull();
      // The late body does not repaint a pane that is showing a folder...
      expect(component.fileContent()).toBeNull();
      // ...and the spinner still comes down: the directory branch issues no
      // read, so the read in flight is still the one that owns it. A release
      // gated on the path would strand it raised for ever here.
      expect(component.loadingContent()).toBe(false);
    });
  });

  // --- nothing polls (Epic 38) ---------------------------------------
  //
  // `window.setTimeout` is used by zone.js and Angular internals, so spying on
  // it proves nothing. `setInterval` is the one a polling implementation would
  // reach for, and nothing on this path uses it.

  describe('no polling', () => {
    it('scenario 58 — construction and a full refresh cycle create no interval', async () => {
      workspaceServiceSpy.getWorkspaceTree.and.resolveTo([]);
      workspaceServiceSpy.getFileContent.and.resolveTo({
        content: 'body',
        type: 'text',
      });
      const intervalSpy = spyOn(window, 'setInterval').and.callThrough();

      fixture = TestBed.createComponent(WorkspaceExplorerComponent);
      component = fixture.componentInstance;
      component.processId = 'proc';
      await flushRootLoad(fixture);

      component.selectedFile.set(
        fileNode({
          name: 'a.md',
          path: 'docs/a.md',
          type: 'file',
          size: 10,
          extension: '.md',
        })
      );
      await component.refreshSelectedFile();

      expect(intervalSpy).not.toHaveBeenCalled();
    });
  });

  // --- handleUploadComplete -----------------------------------------

  describe('handleUploadComplete', () => {
    beforeEach(() => {
      // Keep the declarative root load happy with an empty listing
      workspaceServiceSpy.getWorkspaceTree.and.resolveTo([]);
      workspaceServiceSpy.uploadFiles.and.resolveTo();
      fixture = TestBed.createComponent(WorkspaceExplorerComponent);
      component = fixture.componentInstance;
      component.processId = 'proc';
    });

    it('scenario 9 — refreshes only the target subdirectory', async () => {
      // Set up a tree with root + expanded `docs` subdir containing a.md
      const aMd: TreeNode = {
        label: 'a.md',
        data: fileNode({
          name: 'a.md',
          path: 'docs/a.md',
          type: 'file',
          extension: '.md',
        }),
        leaf: true,
      };
      const docs: TreeNode = {
        label: 'docs',
        data: fileNode({ name: 'docs', path: 'docs', type: 'directory' }),
        leaf: false,
        children: [aMd],
      };
      const root: TreeNode = {
        label: 'Root Folder',
        data: fileNode({
          name: 'Root Folder',
          path: '',
          type: 'directory',
        }),
        children: [docs],
        expanded: true,
      };
      component.treeNodes.set([root]);
      component.uploadTargetPath = 'docs';

      // Stub the upload modal ViewChild
      component.uploadModal = {
        getSelectedFiles: () => [new File(['x'], 'b.md')],
      } as unknown as UploadModalComponent;

      // Fresh listing for docs after upload
      workspaceServiceSpy.getWorkspaceTree.calls.reset();
      workspaceServiceSpy.getWorkspaceTree.and.resolveTo([
        fileNode({
          name: 'a.md',
          path: 'docs/a.md',
          type: 'file',
          extension: '.md',
        }),
        fileNode({
          name: 'b.md',
          path: 'docs/b.md',
          type: 'file',
          extension: '.md',
        }),
      ]);

      await component.handleUploadComplete();

      expect(workspaceServiceSpy.uploadFiles).toHaveBeenCalledTimes(1);
      expect(workspaceServiceSpy.getWorkspaceTree).toHaveBeenCalledOnceWith(
        'proc',
        'docs'
      );

      const refreshedDocs = component.treeNodes()[0].children![0];
      expect(refreshedDocs.children?.length).toBe(2);
    });

    it('scenario 10 — root target refreshes the synthetic Root Folder wrapper children', async () => {
      const root: TreeNode = {
        label: 'Root Folder',
        data: fileNode({
          name: 'Root Folder',
          path: '',
          type: 'directory',
        }),
        children: [],
        expanded: true,
      };
      component.treeNodes.set([root]);
      component.uploadTargetPath = '';
      component.uploadModal = {
        getSelectedFiles: () => [new File(['x'], 'c.md')],
      } as unknown as UploadModalComponent;

      workspaceServiceSpy.getWorkspaceTree.calls.reset();
      workspaceServiceSpy.getWorkspaceTree.and.resolveTo([
        fileNode({
          name: 'c.md',
          path: 'c.md',
          type: 'file',
          extension: '.md',
        }),
      ]);

      await component.handleUploadComplete();

      expect(workspaceServiceSpy.getWorkspaceTree).toHaveBeenCalledOnceWith(
        'proc',
        ''
      );
      // Root wrapper itself stays; its children are replaced with fresh listing
      expect(component.treeNodes().length).toBe(1);
      expect(component.treeNodes()[0].label).toBe('Root Folder');
      expect(component.treeNodes()[0].children?.length).toBe(1);
      expect(component.treeNodes()[0].children![0].label).toBe('c.md');
    });

    it('scenario 11 — no files selected: no-op (uploadFiles NOT called)', async () => {
      component.uploadModal = {
        getSelectedFiles: () => [],
      } as unknown as UploadModalComponent;
      workspaceServiceSpy.uploadFiles.calls.reset();

      await component.handleUploadComplete();

      expect(workspaceServiceSpy.uploadFiles).not.toHaveBeenCalled();
    });
  });

  // --- workspaceId threading (AC7) -----------------------------------

  describe('workspaceId threading', () => {
    beforeEach(() => {
      workspaceServiceSpy.getWorkspaceTree.and.resolveTo([]);
      workspaceServiceSpy.getFileContent.and.resolveTo({
        content: 'x',
        type: 'text',
      });
      workspaceServiceSpy.getDownloadUrl.and.returnValue('http://dl');
      workspaceServiceSpy.uploadFiles.and.resolveTo();
      fixture = TestBed.createComponent(WorkspaceExplorerComponent);
      component = fixture.componentInstance;
      component.processId = 'proc';
    });

    it('scenario 12 — set workspaceId threads as the trailing arg on every call', async () => {
      fixture.componentRef.setInput('workspaceId', 'ws-1');

      // getWorkspaceTree via the declarative root load
      await flushRootLoad(fixture);
      expect(workspaceServiceSpy.getWorkspaceTree).toHaveBeenCalledWith(
        'proc',
        '',
        'ws-1'
      );

      // getWorkspaceTree via onNodeExpand
      const subDir: TreeNode = {
        label: 'sub',
        data: fileNode({ name: 'sub', path: 'sub', type: 'directory' }),
        leaf: false,
        children: undefined,
      };
      await component.onNodeExpand({ node: subDir });
      expect(workspaceServiceSpy.getWorkspaceTree).toHaveBeenCalledWith(
        'proc',
        'sub',
        'ws-1'
      );

      // getFileContent via loadFileContent
      await component.loadFileContent('docs/a.md');
      expect(workspaceServiceSpy.getFileContent).toHaveBeenCalledWith(
        'proc',
        'docs/a.md',
        'ws-1'
      );

      // getDownloadUrl via downloadFile
      component.selectedFile.set(
        fileNode({
          name: 'a.md',
          path: 'docs/a.md',
          type: 'file',
        })
      );
      spyOn(window, 'open');
      component.downloadFile();
      expect(workspaceServiceSpy.getDownloadUrl).toHaveBeenCalledWith(
        'proc',
        'docs/a.md',
        'ws-1'
      );

      // uploadFiles via handleUploadComplete
      component.uploadTargetPath = 'docs';
      component.uploadModal = {
        getSelectedFiles: () => [new File(['x'], 'b.md')],
      } as unknown as UploadModalComponent;
      await component.handleUploadComplete();
      expect(workspaceServiceSpy.uploadFiles).toHaveBeenCalledWith(
        'proc',
        jasmine.any(Array),
        'docs',
        'ws-1'
      );
    });

    it('scenario 13 — unset workspaceId keeps the 2-arg getWorkspaceTree shape', async () => {
      // workspaceId left undefined — the root load issues the 2-arg call
      await flushRootLoad(fixture);
      expect(workspaceServiceSpy.getWorkspaceTree).toHaveBeenCalledOnceWith(
        'proc',
        ''
      );
    });

    it('scenario 13b — unset workspaceId omits the trailing id on content/download/upload/lazy-expand calls', async () => {
      // workspaceId left undefined for the whole scenario.

      // getFileContent via loadFileContent: signal getter returns undefined and
      // is passed through verbatim (no `ws` query param ⇒ backend team_id fallback).
      await component.loadFileContent('docs/a.md');
      expect(workspaceServiceSpy.getFileContent).toHaveBeenCalledWith(
        'proc',
        'docs/a.md',
        undefined
      );

      // getDownloadUrl via downloadFile: same undefined-id passthrough.
      component.selectedFile.set(
        fileNode({ name: 'a.md', path: 'docs/a.md', type: 'file' })
      );
      spyOn(window, 'open');
      component.downloadFile();
      expect(workspaceServiceSpy.getDownloadUrl).toHaveBeenCalledWith(
        'proc',
        'docs/a.md',
        undefined
      );

      // uploadFiles via handleUploadComplete: trailing id omitted (undefined).
      component.uploadTargetPath = 'docs';
      component.uploadModal = {
        getSelectedFiles: () => [new File(['x'], 'b.md')],
      } as unknown as UploadModalComponent;
      await component.handleUploadComplete();
      expect(workspaceServiceSpy.uploadFiles).toHaveBeenCalledWith(
        'proc',
        jasmine.any(Array),
        'docs',
        undefined
      );

      // getWorkspaceTree via onNodeExpand: unset path keeps the 2-arg shape (no `ws`).
      const subDir: TreeNode = {
        label: 'sub',
        data: fileNode({ name: 'sub', path: 'sub', type: 'directory' }),
        leaf: false,
        children: undefined,
      };
      workspaceServiceSpy.getWorkspaceTree.calls.reset();
      await component.onNodeExpand({ node: subDir });
      expect(workspaceServiceSpy.getWorkspaceTree).toHaveBeenCalledOnceWith(
        'proc',
        'sub'
      );
    });
  });

  // --- signal re-assignment + CD invariants (AC4, AC6) --------------

  describe('treeNodes signal re-assignment', () => {
    beforeEach(() => {
      workspaceServiceSpy.getWorkspaceTree.and.resolveTo([]);
      fixture = TestBed.createComponent(WorkspaceExplorerComponent);
      component = fixture.componentInstance;
      component.processId = 'proc';
    });

    it('scenario 25 — a successful expand re-assigns treeNodes() to a new array reference', async () => {
      const subDir: TreeNode = {
        label: 'sub',
        data: fileNode({ name: 'sub', path: 'sub', type: 'directory' }),
        leaf: false,
        children: undefined,
      };
      component.treeNodes.set([subDir]);
      const before = component.treeNodes();

      workspaceServiceSpy.getWorkspaceTree.calls.reset();
      workspaceServiceSpy.getWorkspaceTree.and.resolveTo([
        fileNode({ name: 'inner.ts', path: 'sub/inner.ts', type: 'file' }),
      ]);

      await component.onNodeExpand({ node: subDir });

      // New top-level array identity ⇒ the OnPush/signal CD is scheduled
      // (re-assigning the signal is the documented expand mechanism — NFR6).
      const after = component.treeNodes();
      expect(after).not.toBe(before);
      expect(after[0]).toBe(subDir); // same node, mutated in place
      expect(subDir.children?.length).toBe(1);
    });

    it('scenario 26 — onNodeExpand schedules CD via signal re-assignment, not markForCheck', async () => {
      // NFR6 invariant: the lazy-expand path repaints by re-assigning the
      // treeNodes signal; it must NOT reach for the ChangeDetectorRef. If a
      // markForCheck() crept onto this path, spying the ref would catch it.
      const cdr = (
        component as unknown as {
          cdr?: { markForCheck: () => void };
          changeDetectorRef?: { markForCheck: () => void };
        }
      );
      const ref = cdr.cdr ?? cdr.changeDetectorRef;
      const markSpy = ref ? spyOn(ref, 'markForCheck').and.callThrough() : null;

      const subDir: TreeNode = {
        label: 'sub',
        data: fileNode({ name: 'sub', path: 'sub', type: 'directory' }),
        leaf: false,
        children: undefined,
      };
      component.treeNodes.set([subDir]);

      workspaceServiceSpy.getWorkspaceTree.calls.reset();
      workspaceServiceSpy.getWorkspaceTree.and.resolveTo([
        fileNode({ name: 'inner.ts', path: 'sub/inner.ts', type: 'file' }),
      ]);

      await component.onNodeExpand({ node: subDir });

      if (markSpy) {
        // At most one markForCheck() over the whole component, and the expand
        // path does not rely on it — the signal re-assignment is sufficient.
        expect(markSpy).not.toHaveBeenCalled();
      }
      // The repaint mechanism that DID fire: a new treeNodes() reference.
      expect(component.treeNodes()[0].children?.length).toBe(1);
    });
  });

  // --- workspaceId signal-input re-trigger + race closure (AC6) -------

  describe('workspaceId signal-input re-trigger', () => {
    beforeEach(() => {
      workspaceServiceSpy.getWorkspaceTree.and.resolveTo([]);
      fixture = TestBed.createComponent(WorkspaceExplorerComponent);
      component = fixture.componentInstance;
    });

    it('scenario 14 — a workspaceId change re-triggers the root fetch via switchMap', async () => {
      // initial load (undefined workspaceId)
      await flushRootLoad(fixture);
      expect(workspaceServiceSpy.getWorkspaceTree).toHaveBeenCalledOnceWith(
        'proc',
        ''
      );

      // change the bound signal input ⇒ a new switchMap emission ⇒ refetch
      fixture.componentRef.setInput('workspaceId', 'ws-2');
      await flushRootLoad(fixture);

      expect(workspaceServiceSpy.getWorkspaceTree).toHaveBeenCalledWith(
        'proc',
        '',
        'ws-2'
      );
      expect(workspaceServiceSpy.getWorkspaceTree.calls.count()).toBe(2);
    });

    it('scenario 15 — setting the same workspaceId value does not refetch', async () => {
      fixture.componentRef.setInput('workspaceId', 'ws-1');
      await flushRootLoad(fixture);
      expect(workspaceServiceSpy.getWorkspaceTree.calls.count()).toBe(1);

      // signal inputs dedupe equal values: no new emission, no refetch
      fixture.componentRef.setInput('workspaceId', 'ws-1');
      await flushRootLoad(fixture);
      expect(workspaceServiceSpy.getWorkspaceTree.calls.count()).toBe(1);
    });

    it('scenario 16 — a superseded slow response does not clobber the newer tab tree (switchMap race closure)', async () => {
      // First (slow) fetch for ws-A: resolves LATE.
      let resolveSlow!: (v: FileNode[]) => void;
      const slow = new Promise<FileNode[]>((res) => (resolveSlow = res));
      workspaceServiceSpy.getWorkspaceTree.and.returnValue(slow);

      fixture.componentRef.setInput('workspaceId', 'ws-A');
      fixture.detectChanges(); // kick the ws-A switchMap emission (still pending)

      // Second (fast) fetch for ws-B: resolves immediately and wins.
      workspaceServiceSpy.getWorkspaceTree.and.resolveTo([
        fileNode({ name: 'fromB.md', path: 'fromB.md', type: 'file' }),
      ]);
      fixture.componentRef.setInput('workspaceId', 'ws-B');
      await flushRootLoad(fixture);

      // ws-B's tree is in place
      expect(component.treeNodes()[0].children![0].label).toBe('fromB.md');

      // Now the stale ws-A response finally arrives — switchMap cancelled it,
      // so it must NOT overwrite ws-B's tree.
      resolveSlow([
        fileNode({ name: 'fromA.md', path: 'fromA.md', type: 'file' }),
      ]);
      await flushRootLoad(fixture);

      expect(component.treeNodes()[0].children![0].label).toBe('fromB.md');
    });
  });

  // --- OnChanges removal (AC5) ---------------------------------------

  describe('OnChanges removal', () => {
    it('scenario 17 — component no longer implements OnChanges (no ngOnChanges method)', () => {
      fixture = TestBed.createComponent(WorkspaceExplorerComponent);
      component = fixture.componentInstance;

      expect(
        (component as unknown as { ngOnChanges?: unknown }).ngOnChanges
      ).toBeUndefined();
    });
  });
});

// --------------------------------------------------------------------
// NFR3 regression gate (AC1) — the falsifiability gate.
//
// Hosts the explorer inside an OnPush parent that is rendered ONCE and then
// never re-marked. When the root tree resolves, the spinner must be gone and
// loading() must be false WITHOUT any further change-detection trigger from
// the parent. This fails against the default-CD / `loading`-field impl (the
// child's field mutation never marks the OnPush parent dirty, so the view is
// stale) and passes against the signal/OnPush impl.
// --------------------------------------------------------------------

@Component({
  selector: 'app-onpush-host',
  standalone: true,
  imports: [WorkspaceExplorerComponent],
  template: `<app-workspace-explorer />`,
  // OnPush parent: after the first render it is NEVER re-marked by the test.
  changeDetection: ChangeDetectionStrategy.OnPush,
})
class OnPushHostComponent {}

describe('WorkspaceExplorerComponent — NFR3 OnPush regression gate', () => {
  let workspaceServiceSpy: jasmine.SpyObj<WorkspaceService>;
  let contextServiceStub: {
    currentProcessId$: BehaviorSubject<string>;
    currentTeamRunning$: BehaviorSubject<boolean>;
    getCurrentTeam: jasmine.Spy;
  };

  beforeEach(async () => {
    workspaceServiceSpy = jasmine.createSpyObj('WorkspaceService', [
      'getWorkspaceTree',
      'getFileContent',
      'getDownloadUrl',
      'uploadFiles',
    ]);
    contextServiceStub = {
      currentProcessId$: new BehaviorSubject<string>('proc'),
      currentTeamRunning$: new BehaviorSubject<boolean>(true),
      getCurrentTeam: jasmine
        .createSpy('getCurrentTeam')
        .and.callFake(async () => makeTeam()),
    };

    await TestBed.configureTestingModule({
      imports: [OnPushHostComponent, NoopAnimationsModule],
      providers: [
        { provide: WorkspaceService, useValue: workspaceServiceSpy },
        { provide: ContextService, useValue: contextServiceStub },
        {
          provide: WorkspaceInvalidationService,
          useValue: new FakeWorkspaceInvalidationService(),
        },
      ],
    })
      .overrideComponent(WorkspaceExplorerComponent, {
        set: {
          imports: [CommonModule],
          schemas: [CUSTOM_ELEMENTS_SCHEMA],
        },
      })
      .compileComponents();
  });

  it('scenario 18 — spinner clears after the tree resolves WITHOUT re-marking the OnPush parent', async () => {
    // Slow-ish promise so the spinner is visible on the first render.
    let resolveTree!: (v: FileNode[]) => void;
    const treePromise = new Promise<FileNode[]>((res) => (resolveTree = res));
    workspaceServiceSpy.getWorkspaceTree.and.returnValue(treePromise);

    const hostFixture: ComponentFixture<OnPushHostComponent> =
      TestBed.createComponent(OnPushHostComponent);

    // Attach the fixture to ApplicationRef and let zone-driven change detection
    // run on stabilization — faithfully reproducing the running app, where a
    // settled fetch promise triggers a GLOBAL ApplicationRef.tick(), NOT a
    // targeted parent detectChanges(). autoDetect NEVER force-checks the OnPush
    // parent: tick() walks from the root and re-checks only views on a dirty
    // path. With the OLD default-CD/`loading`-field impl the explorer's field
    // mutation never marks the OnPush parent's subtree dirty, so tick skips it
    // and the spinner stays (this spec fails); with the signal/OnPush impl the
    // signal write marks the explorer dirty up the chain, so tick re-checks it
    // and the spinner clears (this spec passes).
    hostFixture.autoDetectChanges(true);

    const explorerDe = hostFixture.debugElement.children[0];
    const explorer =
      explorerDe.componentInstance as WorkspaceExplorerComponent;

    expect(explorer.loading()).toBe(true);
    expect(
      hostFixture.nativeElement.querySelector('p-progressspinner') ||
        hostFixture.nativeElement.querySelector('p-progressSpinner')
    ).withContext('spinner should be visible while pending').not.toBeNull();

    // Resolve the tree. CRITICALLY: never call hostFixture.detectChanges()
    // (which would force-check the OnPush parent). Only let the zone settle —
    // the spinner must clear via the signal-driven global tick alone.
    resolveTree([fileNode({ name: 'a.md', path: 'a.md', type: 'file' })]);
    await hostFixture.whenStable();

    // The signal write repainted the explorer's own OnPush view via the global
    // tick, even though the parent was never explicitly re-marked.
    expect(explorer.loading()).toBe(false);
    expect(
      hostFixture.nativeElement.querySelector('p-progressspinner') ||
        hostFixture.nativeElement.querySelector('p-progressSpinner')
    ).withContext('spinner must be gone after resolve').toBeNull();
  });

  // --- the content-pane gate (AC1, NFR3 analogue) -------------------
  //
  // The 24-2 analogue of scenario 18: the SAME OnPush stall, but on the
  // content pane instead of the tree pane. Host the explorer inside an OnPush
  // parent rendered once and never re-marked; select a file (driving
  // loadFileContent with a slow getFileContent); the content-pane spinner must
  // clear and fileContent() must be set after the promise resolves WITHOUT any
  // further parent re-mark. Fails against a default-CD / loadingContent-field
  // impl (the child's field mutation never marks the OnPush parent dirty);
  // passes against the signal/OnPush impl (the signal write does). The query is
  // scoped to `.panel-content` so the tree-pane spinner never false-positives.

  function contentSpinner(host: ComponentFixture<OnPushHostComponent>): Element | null {
    const pane = host.nativeElement.querySelector('.panel-content');
    if (!pane) return null;
    return (
      pane.querySelector('p-progressspinner') ||
      pane.querySelector('p-progressSpinner')
    );
  }

  it('scenario 27 — content spinner clears after getFileContent resolves WITHOUT re-marking the OnPush parent', async () => {
    // Root tree resolves immediately so the tree pane is settled and we are
    // exercising ONLY the content pane. A plain-text file (not .md) is used so
    // the content renders via the `<pre><code>` block — the host describe
    // overrides imports to CommonModule only, so the `<markdown>` component
    // (no custom-element dash) is not resolvable here, and the gate does not
    // depend on markdown rendering anyway.
    workspaceServiceSpy.getWorkspaceTree.and.resolveTo([
      fileNode({
        name: 'a.txt',
        path: 'a.txt',
        type: 'file',
        extension: '.txt',
      }),
    ]);
    // Slow file-content promise so the content spinner is visible while pending.
    let resolveContent!: (v: { content: string | null; type: string }) => void;
    const contentPromise = new Promise<{ content: string | null; type: string }>(
      (res) => (resolveContent = res)
    );
    workspaceServiceSpy.getFileContent.and.returnValue(contentPromise as any);

    const hostFixture: ComponentFixture<OnPushHostComponent> =
      TestBed.createComponent(OnPushHostComponent);

    // Faithful reproduction of the running app: zone-driven global tick on
    // stabilization, NEVER a targeted parent detectChanges(). See scenario 18.
    hostFixture.autoDetectChanges(true);

    const explorerDe = hostFixture.debugElement.children[0];
    const explorer =
      explorerDe.componentInstance as WorkspaceExplorerComponent;

    // Wait for the root tree load to settle so the explorer is fully rendered.
    await hostFixture.whenStable();

    // Drive a file selection ⇒ loadFileContent ⇒ loadingContent() true.
    const file = fileNode({
      name: 'a.txt',
      path: 'a.txt',
      type: 'file',
      extension: '.txt',
    });
    // Fire-and-await-later: do NOT await (the promise is still pending) so we
    // can observe the spinner-visible state first.
    const selectPromise = explorer.onNodeSelect({ node: { data: file } });
    await hostFixture.whenStable();

    expect(explorer.loadingContent()).toBe(true);
    expect(contentSpinner(hostFixture))
      .withContext('content spinner should be visible while pending')
      .not.toBeNull();

    // Resolve the content. CRITICALLY: never call hostFixture.detectChanges()
    // (which would force-check the OnPush parent). Only let the zone settle —
    // the spinner must clear via the signal-driven global tick alone.
    resolveContent({ content: 'plain text body', type: 'text' });
    await selectPromise;
    await hostFixture.whenStable();

    expect(explorer.loadingContent()).toBe(false);
    expect(explorer.fileContent()).toBe('plain text body');
    expect(contentSpinner(hostFixture))
      .withContext('content spinner must be gone after resolve')
      .toBeNull();
  });

  // --- the run-state gate (FR9 falsifiability gate) ------------------
  //
  // Scenario 18's shape applied to run state: the explorer sits inside an
  // OnPush parent rendered ONCE and never re-marked, and the flip must land
  // after whenStable() alone — this spec calls detectChanges() nowhere. What it
  // adds over the detectChanges()-driven specs in the `live run-state tracking`
  // block is the PROPAGATION step: the repaint has to arrive via a
  // scheduler-driven global ApplicationRef.tick() that walks past an ancestor
  // nobody marked, so the notification must travel UP the chain — the running
  // app's actual mechanism, and the one a bare field write cannot reach.
  //
  // Both near-misses are excluded, verified by mutation rather than argued: a
  // re-fetched snapshot never flips at all (this spec + 6 siblings red), and a
  // plain field write with no markForCheck flips the field but not the view
  // (this spec + 5 siblings red).
  //
  // For whoever writes the next one of these: fixture.detectChanges() does NOT
  // force-check the component under test. It runs change detection from the
  // fixture's ROOT view, of which the component is an OnPush child, so the
  // component's own view is skipped unless something marked it dirty. That is
  // why the detectChanges()-based specs below are falsifiable too, and why a
  // spec of this kind is a complement to them rather than the only real gate.

  it('scenario 36 — a run-state flip repaints the upload gate WITHOUT re-marking the OnPush parent', async () => {
    workspaceServiceSpy.getWorkspaceTree.and.resolveTo([]);
    // The stub's default is `true`; start stopped so the flip is observable.
    contextServiceStub.currentTeamRunning$.next(false);

    const hostFixture: ComponentFixture<OnPushHostComponent> =
      TestBed.createComponent(OnPushHostComponent);

    // Faithful reproduction of the running app, exactly as scenario 18:
    // zone-driven global tick on stabilization. CRITICALLY, this spec never
    // calls hostFixture.detectChanges() — that would force-check the OnPush
    // parent and destroy the gate.
    hostFixture.autoDetectChanges(true);
    await hostFixture.whenStable();

    const gate = (): UploadControlEl =>
      uploadControl(hostFixture.nativeElement, 'Upload to Root')!;

    expect(gate())
      .withContext('root upload control should be rendered')
      .not.toBeNull();
    expect(gate().disabled).toBe(true);

    contextServiceStub.currentTeamRunning$.next(true);
    await hostFixture.whenStable();

    expect(gate().disabled).toBe(false);
  });
});

// --------------------------------------------------------------------
// Live run-state tracking (FR9).
//
// The three upload controls read run state LIVE off
// `ContextService.currentTeamRunning$` — the stream ADR-010 makes the sole
// writer of — instead of latching it once at init. Every spec here drives the
// subject AFTER the component is created and never re-runs initialization: a
// spec that re-invokes an init hook passes just as happily against the one-shot
// `firstValueFrom` snapshot this replaces, and would therefore prove nothing.
//
// This block has its OWN TestBed with a widened override, and that is
// load-bearing rather than convenience. Under the CommonModule-only override
// used by the two describes above, the toolbar's "Upload here" control cannot
// render AT ALL: it lives inside `<ng-template pTemplate="end">`, and only
// PrimeNG's Toolbar instantiates that template. So `ButtonModule` and
// `ToolbarModule` are added here — the fallback the story documents — while the
// existing describes' overrides stay untouched (scenario 18 and scenario 27
// were tuned without PrimeNG and must stay that way). p-tree, p-card, p-tag,
// the spinner, the upload modal and ngx-markdown all remain stubbed by
// CUSTOM_ELEMENTS_SCHEMA.
//
// `TooltipModule` is deliberately NOT imported, so `[pTooltip]` stays an
// unclaimed property binding that lands on the p-button host element and can be
// read straight back off it. `[disabled]`, in contrast, IS a Button input, and
// PrimeNG propagates it onto the inner <button> — the same idiom as
// `home.component.spec.ts`.
// --------------------------------------------------------------------

describe('WorkspaceExplorerComponent — live run-state tracking (FR9)', () => {
  const STOPPED_TOOLTIP = 'Process must be running to upload files';

  let component: WorkspaceExplorerComponent;
  let fixture: ComponentFixture<WorkspaceExplorerComponent>;
  let workspaceServiceSpy: jasmine.SpyObj<WorkspaceService>;
  let contextServiceStub: {
    currentProcessId$: BehaviorSubject<string>;
    currentTeamRunning$: BehaviorSubject<boolean>;
    getCurrentTeam: jasmine.Spy;
  };

  beforeEach(async () => {
    workspaceServiceSpy = jasmine.createSpyObj('WorkspaceService', [
      'getWorkspaceTree',
      'getFileContent',
      'getDownloadUrl',
      'uploadFiles',
    ]);
    workspaceServiceSpy.getWorkspaceTree.and.resolveTo([]);
    workspaceServiceSpy.getFileContent.and.resolveTo({
      content: 'x',
      type: 'text',
    });
    contextServiceStub = {
      currentProcessId$: new BehaviorSubject<string>('proc'),
      currentTeamRunning$: new BehaviorSubject<boolean>(true),
      getCurrentTeam: jasmine
        .createSpy('getCurrentTeam')
        .and.callFake(async () => makeTeam()),
    };

    await TestBed.configureTestingModule({
      imports: [WorkspaceExplorerComponent, NoopAnimationsModule],
      providers: [
        { provide: WorkspaceService, useValue: workspaceServiceSpy },
        { provide: ContextService, useValue: contextServiceStub },
        {
          provide: WorkspaceInvalidationService,
          useValue: new FakeWorkspaceInvalidationService(),
        },
      ],
    })
      .overrideComponent(WorkspaceExplorerComponent, {
        set: {
          imports: [CommonModule, ButtonModule, ToolbarModule],
          schemas: [CUSTOM_ELEMENTS_SCHEMA],
        },
      })
      .compileComponents();
  });

  /** The p-button host carrying this static `label` attribute. */
  function host(label: string): UploadControlEl {
    const el = uploadControl(fixture.nativeElement, label);
    expect(el)
      .withContext(`control "${label}" should be rendered`)
      .not.toBeNull();
    return el!;
  }

  /** PrimeNG propagates the [disabled] input onto the inner <button>. */
  function isDisabled(label: string): boolean {
    const btn = host(label).querySelector('button');
    expect(btn)
      .withContext(`inner <button> of control "${label}"`)
      .not.toBeNull();
    return (btn as HTMLButtonElement).disabled;
  }

  /** The unclaimed [pTooltip] property binding, read off the p-button host. */
  function tooltipOf(label: string): string | undefined {
    return host(label).pTooltip;
  }

  /**
   * Reach the folder-selected render state — where "Upload here" and "Upload
   * Files" live — by writing the signal directly. `onNodeSelect` would also
   * fire a `getFileContent` fetch that has nothing to do with run state.
   */
  function selectFolder(): void {
    component.selectedFolder.set(
      fileNode({ name: 'docs', path: 'docs', type: 'directory' })
    );
    fixture.detectChanges();
  }

  function clearSelection(): void {
    component.selectedFolder.set(null);
    fixture.detectChanges();
  }

  /**
   * Create the component with the team ALREADY stopped, and settle it. The
   * stub's `currentTeamRunning$` default is `true`, so a "starts stopped" spec
   * MUST push `false` BEFORE createComponent or it asserts nothing.
   */
  async function createStopped(): Promise<void> {
    contextServiceStub.currentTeamRunning$.next(false);
    fixture = TestBed.createComponent(WorkspaceExplorerComponent);
    component = fixture.componentInstance;
    await flushRootLoad(fixture);
  }

  /** Create the component with the team running, and settle it. */
  async function createRunning(): Promise<void> {
    contextServiceStub.currentTeamRunning$.next(true);
    fixture = TestBed.createComponent(WorkspaceExplorerComponent);
    component = fixture.componentInstance;
    await flushRootLoad(fixture);
  }

  it('scenario 37 — a flip to running enables the root-placeholder control, with no re-init and no extra call', async () => {
    await createStopped();
    expect(isDisabled('Upload to Root')).toBe(true);

    const treeCalls = workspaceServiceSpy.getWorkspaceTree.calls.count();
    const contentCalls = workspaceServiceSpy.getFileContent.calls.count();
    contextServiceStub.getCurrentTeam.calls.reset();

    contextServiceStub.currentTeamRunning$.next(true);
    fixture.detectChanges();

    expect(isDisabled('Upload to Root')).toBe(false);
    // Nothing was re-fetched to learn the new state: the stream IS the state.
    expect(workspaceServiceSpy.getWorkspaceTree.calls.count()).toBe(treeCalls);
    expect(workspaceServiceSpy.getFileContent.calls.count()).toBe(contentCalls);
    expect(contextServiceStub.getCurrentTeam).not.toHaveBeenCalled();
  });

  it('scenario 38 — a flip to running enables both folder-selected controls, with no re-init and no extra call', async () => {
    await createStopped();
    selectFolder();

    expect(isDisabled('Upload here')).toBe(true);
    expect(isDisabled('Upload Files')).toBe(true);

    const treeCalls = workspaceServiceSpy.getWorkspaceTree.calls.count();
    const contentCalls = workspaceServiceSpy.getFileContent.calls.count();
    contextServiceStub.getCurrentTeam.calls.reset();

    contextServiceStub.currentTeamRunning$.next(true);
    fixture.detectChanges();

    expect(isDisabled('Upload here')).toBe(false);
    expect(isDisabled('Upload Files')).toBe(false);
    expect(workspaceServiceSpy.getWorkspaceTree.calls.count()).toBe(treeCalls);
    expect(workspaceServiceSpy.getFileContent.calls.count()).toBe(contentCalls);
    expect(contextServiceStub.getCurrentTeam).not.toHaveBeenCalled();
  });

  it('scenario 39 — the reverse flip disables the root-placeholder control again', async () => {
    await createRunning();
    expect(isDisabled('Upload to Root')).toBe(false);

    const treeCalls = workspaceServiceSpy.getWorkspaceTree.calls.count();
    contextServiceStub.getCurrentTeam.calls.reset();

    contextServiceStub.currentTeamRunning$.next(false);
    fixture.detectChanges();

    expect(isDisabled('Upload to Root')).toBe(true);
    expect(workspaceServiceSpy.getWorkspaceTree.calls.count()).toBe(treeCalls);
    expect(contextServiceStub.getCurrentTeam).not.toHaveBeenCalled();
  });

  it('scenario 40 — the reverse flip disables both folder-selected controls again', async () => {
    await createRunning();
    selectFolder();

    expect(isDisabled('Upload here')).toBe(false);
    expect(isDisabled('Upload Files')).toBe(false);

    const treeCalls = workspaceServiceSpy.getWorkspaceTree.calls.count();
    contextServiceStub.getCurrentTeam.calls.reset();

    contextServiceStub.currentTeamRunning$.next(false);
    fixture.detectChanges();

    expect(isDisabled('Upload here')).toBe(true);
    expect(isDisabled('Upload Files')).toBe(true);
    expect(workspaceServiceSpy.getWorkspaceTree.calls.count()).toBe(treeCalls);
    expect(contextServiceStub.getCurrentTeam).not.toHaveBeenCalled();
  });

  it('scenario 41 — run state is correct on the FIRST render (a single detectChanges, no disabled frame)', () => {
    // The stub's default is `true`, so the team is running at construction.
    // Exactly ONE synchronous change-detection pass and NO await: the
    // predecessor only settled its snapshot a microtask later, once ngOnInit's
    // `await` resolved, so it painted a disabled frame here.
    fixture = TestBed.createComponent(WorkspaceExplorerComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();

    expect(component.isProcessRunning()).toBe(true);
    expect(isDisabled('Upload to Root')).toBe(false);
  });

  // (A spec asserting `ngOnInit`/`checkProcessStatus` are `undefined` was
  // dropped in review: it cannot fail for any run-state defect — it stayed
  // green under BOTH near-miss mutations — while it WOULD fail the day an
  // unrelated `ngOnInit` is added. "No init hook latches run state" is asserted
  // behaviourally by scenarios 36-40 and 44, which prove the value tracks the
  // stream after construction, and by 37/38's no-extra-call assertions.)

  it('scenario 43 — the run-state subscription is torn down on destroy', async () => {
    await createStopped();
    expect(contextServiceStub.currentTeamRunning$.observed).toBe(true);

    fixture.destroy();

    // rxjs 7 `Subject.observed`: no subscriber left on the stream.
    expect(contextServiceStub.currentTeamRunning$.observed).toBe(false);
    expect(contextServiceStub.currentTeamRunning$.observers.length).toBe(0);

    // A later emission cannot reach the destroyed component.
    contextServiceStub.currentTeamRunning$.next(true);
    expect(component.isProcessRunning()).toBe(false);
  });

  it('scenario 44 — all three tooltips read the same live source as the three disabled bindings', async () => {
    await createStopped();

    expect(tooltipOf('Upload to Root')).toBe(STOPPED_TOOLTIP);
    selectFolder();
    expect(tooltipOf('Upload here')).toBe(STOPPED_TOOLTIP);
    expect(tooltipOf('Upload Files')).toBe(STOPPED_TOOLTIP);

    contextServiceStub.currentTeamRunning$.next(true);
    fixture.detectChanges();

    // Running: none of the three presents the stopped-team tooltip.
    expect(tooltipOf('Upload here')).toBe('');
    expect(tooltipOf('Upload Files')).toBe('');
    clearSelection();
    expect(tooltipOf('Upload to Root')).toBe('');
  });
});

// --------------------------------------------------------------------
// The per-file refresh control (Epic 38).
//
// Reuses the widened override documented above — `ButtonModule` so `[disabled]`
// reaches a real inner <button>, `ToolbarModule` so the `end`/`start` templates
// are instantiated at all. `TooltipModule` stays out, so the STATIC
// `pTooltip="..."` attribute survives in the DOM and is what these specs query
// by (the same idiom as the `label` attribute above). `p-tag` remains stubbed by
// CUSTOM_ELEMENTS_SCHEMA, so its `[value]` binding lands on the element object —
// reading it back asserts what the TEMPLATE computed, not what a signal holds.
// --------------------------------------------------------------------

describe('WorkspaceExplorerComponent — per-file refresh control (Epic 38)', () => {
  const FILE_REFRESH = 'p-button[pTooltip="Refresh this file"]';
  const WORKSPACE_REFRESH = 'p-button[pTooltip="Refresh workspace"]';
  const SIZE_TAG = 'p-tag[severity="secondary"]';

  let component: WorkspaceExplorerComponent;
  let fixture: ComponentFixture<WorkspaceExplorerComponent>;
  let workspaceServiceSpy: jasmine.SpyObj<WorkspaceService>;

  /**
   * A PLAIN-TEXT file, deliberately: a `.md` file would render the pane through
   * `<markdown>`, which is not resolvable under this override (no dash in the
   * tag ⇒ CUSTOM_ELEMENTS_SCHEMA does not cover it) — the same constraint
   * scenario 27 documents. Nothing here depends on markdown rendering.
   */
  function openFile(size: number): FileNode {
    return fileNode({
      name: 'a.txt',
      path: 'docs/a.txt',
      type: 'file',
      size,
      extension: '.txt',
    });
  }

  beforeEach(async () => {
    workspaceServiceSpy = jasmine.createSpyObj('WorkspaceService', [
      'getWorkspaceTree',
      'getFileContent',
      'getDownloadUrl',
      'uploadFiles',
    ]);
    workspaceServiceSpy.getWorkspaceTree.and.resolveTo([]);
    workspaceServiceSpy.getFileContent.and.resolveTo({
      content: 'body',
      type: 'text',
    });

    await TestBed.configureTestingModule({
      imports: [WorkspaceExplorerComponent, NoopAnimationsModule],
      providers: [
        { provide: WorkspaceService, useValue: workspaceServiceSpy },
        {
          provide: ContextService,
          useValue: {
            currentProcessId$: new BehaviorSubject<string>('proc'),
            currentTeamRunning$: new BehaviorSubject<boolean>(true),
            getCurrentTeam: jasmine
              .createSpy('getCurrentTeam')
              .and.callFake(async () => makeTeam()),
          },
        },
        {
          provide: WorkspaceInvalidationService,
          useValue: new FakeWorkspaceInvalidationService(),
        },
      ],
    })
      .overrideComponent(WorkspaceExplorerComponent, {
        set: {
          imports: [CommonModule, ButtonModule, ToolbarModule],
          schemas: [CUSTOM_ELEMENTS_SCHEMA],
        },
      })
      .compileComponents();

    fixture = TestBed.createComponent(WorkspaceExplorerComponent);
    component = fixture.componentInstance;
    component.processId = 'proc';
    await flushRootLoad(fixture);
  });

  function refreshControl(): HTMLElement | null {
    return fixture.nativeElement.querySelector(FILE_REFRESH);
  }

  /** PrimeNG propagates the [disabled] input onto the inner <button>. */
  function refreshDisabled(): boolean {
    const btn = refreshControl()!.querySelector('button');
    expect(btn).withContext('inner <button> of the refresh control').not.toBeNull();
    return (btn as HTMLButtonElement).disabled;
  }

  async function selectOpenFile(size = 10): Promise<void> {
    component.selectedFile.set(openFile(size));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  it('scenario 59 — the control renders only with a file open, in the preview toolbar, before Download', async () => {
    // No file open ⇒ neither the refresh nor the download control is rendered.
    expect(refreshControl()).toBeNull();

    await selectOpenFile();

    const refresh = refreshControl();
    expect(refresh).withContext('per-file refresh control').not.toBeNull();
    expect(refresh!.getAttribute('icon')).toBe('pi pi-refresh');
    expect(refresh!.getAttribute('severity')).toBe('secondary');
    // Labelled, like every other control in this toolbar. The icon-only
    // register belongs to the navigator header, not here.
    expect(refresh!.getAttribute('label')).toBe('Refresh');

    const button = fixture.debugElement.query(By.css(FILE_REFRESH))
      .componentInstance as { text: boolean; rounded: boolean };
    expect(button.text).toBe(true);
    expect(button.rounded).toBe(true);

    // Immediately before Download, and inside the same toolbar container.
    const download = fixture.nativeElement.querySelector(
      'p-button[label="Download"]'
    ) as HTMLElement;
    expect(download).withContext('download control').not.toBeNull();
    expect(refresh!.parentElement).toBe(download.parentElement);
    expect(refresh!.nextElementSibling).toBe(download);

    // The navigator's workspace-scoped control keeps its own tooltip.
    expect(
      fixture.nativeElement.querySelector(WORKSPACE_REFRESH)
    ).withContext('navigator refresh control').not.toBeNull();
  });

  it('scenario 60 — the rendered size tag carries the fresh size after a refresh', async () => {
    await selectOpenFile(10);

    const sizeTag = (): { value?: string } =>
      fixture.nativeElement.querySelector(SIZE_TAG) as unknown as {
        value?: string;
      };
    expect(sizeTag().value).toBe('10 B');

    workspaceServiceSpy.getWorkspaceTree.and.resolveTo([openFile(2048)]);
    workspaceServiceSpy.getFileContent.and.resolveTo({
      content: 'body + appended',
      type: 'text',
    });

    await component.refreshSelectedFile();
    fixture.detectChanges();

    expect(sizeTag().value).toBe('2 KB');
  });

  it('scenario 61 — the control is disabled while a refresh is in flight', async () => {
    await selectOpenFile();
    expect(refreshDisabled()).toBe(false);

    const body = deferred<FileContent>();
    workspaceServiceSpy.getFileContent.and.returnValue(body.promise);

    const cycle = component.refreshSelectedFile();
    fixture.detectChanges();
    expect(refreshDisabled()).toBe(true);

    body.resolve({ content: 'body', type: 'text' });
    await cycle;
    fixture.detectChanges();

    expect(refreshDisabled()).toBe(false);
  });

  it('scenario 62 — the control is disabled while an initial load is in flight', async () => {
    await selectOpenFile();

    component.loadingContent.set(true);
    fixture.detectChanges();
    expect(refreshDisabled()).toBe(true);

    component.loadingContent.set(false);
    fixture.detectChanges();
    expect(refreshDisabled()).toBe(false);
  });
});

// --------------------------------------------------------------------
// Workspace invalidation routing (Epic 39, FR9/FR10/NFR4).
//
// The panel used to ignore the message log it was already receiving: a tool
// that wrote a file left the tree and the pane stale until the user pressed
// Refresh. These scenarios cover the subscription, the workspace filter, the
// coalescing and the routing — never the fold, which is
// `workspace-invalidation.selector.spec.ts`'s subject. The seam is the stub's
// Subject: instructions are pushed into it directly, so nothing here depends on
// frames, batching or the projection's internals.
//
// The widened override is reused (`ButtonModule` + `ToolbarModule`) because two
// scenarios go through the rendered view: the deletion notice and the manual
// controls. `p-tree`, `p-tag`, the spinner and the upload modal stay stubbed by
// CUSTOM_ELEMENTS_SCHEMA, and the open file is deliberately a `.txt` — a `.md`
// would render through `<markdown>`, which has no dash and is therefore not
// resolvable under this override (the constraint scenario 27 documents).
// --------------------------------------------------------------------

describe('WorkspaceExplorerComponent — workspace invalidation routing (Epic 39)', () => {
  const TEAM_ID = 'proc';
  const OPEN_PATH = 'docs/a.txt';
  const FILE_REFRESH = 'p-button[pTooltip="Refresh this file"]';
  const WORKSPACE_REFRESH = 'p-button[pTooltip="Refresh workspace"]';
  const SIZE_TAG = 'p-tag[severity="secondary"]';

  let component: WorkspaceExplorerComponent;
  let fixture: ComponentFixture<WorkspaceExplorerComponent>;
  let workspaceServiceSpy: jasmine.SpyObj<WorkspaceService>;
  let invalidations: FakeWorkspaceInvalidationService;

  function openFile(size = 10): FileNode {
    return fileNode({
      name: 'a.txt',
      path: OPEN_PATH,
      type: 'file',
      size,
      extension: '.txt',
    });
  }

  /** Root wrapper → `docs` (materialized) → `a.txt`. */
  function materializedTree(): TreeNode {
    const aTxt: TreeNode = { label: 'a.txt', data: openFile(10), leaf: true };
    const docs: TreeNode = {
      label: 'docs',
      data: fileNode({ name: 'docs', path: 'docs', type: 'directory' }),
      leaf: false,
      children: [aTxt],
    };
    return {
      label: 'Root Folder',
      data: fileNode({ name: 'Root Folder', path: '', type: 'directory' }),
      children: [docs],
      expanded: true,
    };
  }

  beforeEach(async () => {
    workspaceServiceSpy = jasmine.createSpyObj('WorkspaceService', [
      'getWorkspaceTree',
      'getFileContent',
      'getDownloadUrl',
      'uploadFiles',
    ]);
    workspaceServiceSpy.getWorkspaceTree.and.resolveTo([]);
    workspaceServiceSpy.getFileContent.and.resolveTo({
      content: 'body',
      type: 'text',
    });
    invalidations = new FakeWorkspaceInvalidationService();

    await TestBed.configureTestingModule({
      imports: [WorkspaceExplorerComponent, NoopAnimationsModule],
      providers: [
        { provide: WorkspaceService, useValue: workspaceServiceSpy },
        {
          provide: ContextService,
          useValue: {
            currentProcessId$: new BehaviorSubject<string>(TEAM_ID),
            currentTeamRunning$: new BehaviorSubject<boolean>(true),
            getCurrentTeam: jasmine
              .createSpy('getCurrentTeam')
              .and.callFake(async () => makeTeam()),
          },
        },
        { provide: WorkspaceInvalidationService, useValue: invalidations },
      ],
    })
      .overrideComponent(WorkspaceExplorerComponent, {
        set: {
          imports: [CommonModule, ButtonModule, ToolbarModule],
          schemas: [CUSTOM_ELEMENTS_SCHEMA],
        },
      })
      .compileComponents();

    fixture = TestBed.createComponent(WorkspaceExplorerComponent);
    component = fixture.componentInstance;
    await flushRootLoad(fixture);
    workspaceServiceSpy.getWorkspaceTree.calls.reset();
    workspaceServiceSpy.getFileContent.calls.reset();
  });

  /**
   * Push instructions as ONE synchronous delta — which is exactly how the
   * projection emits a burst — then let the coalescer's microtask flush and the
   * fetches it issues settle.
   */
  async function deliver(...batch: WorkspaceInvalidation[]): Promise<void> {
    for (const instruction of batch) {
      invalidations.invalidations$.next(instruction);
    }
    await flushMicrotasks();
    await flushMicrotasks();
  }

  /** Open a file in the pane through the real selection path, and settle it. */
  async function openInPane(size = 10): Promise<void> {
    await component.onNodeSelect({ node: { data: openFile(size) } });
    fixture.detectChanges();
    workspaceServiceSpy.getWorkspaceTree.calls.reset();
    workspaceServiceSpy.getFileContent.calls.reset();
  }

  /** The `path` argument of every listing issued, in call order. */
  function listedPaths(): string[] {
    return workspaceServiceSpy.getWorkspaceTree.calls
      .allArgs()
      .map((args) => args[1] as string);
  }

  // --- addressing the right workspace (AC2, AC3) ---------------------

  it('scenario 74 — an instruction for another workspace changes nothing (workspaceId SET)', async () => {
    fixture.componentRef.setInput('workspaceId', 'ws-b');
    await flushRootLoad(fixture);
    workspaceServiceSpy.getWorkspaceTree.calls.reset();
    workspaceServiceSpy.getFileContent.calls.reset();

    await deliver(
      invalidation({
        workspaceId: 'ws-a',
        directories: ['docs'],
        files: ['docs/a.txt'],
      }),
    );

    expect(workspaceServiceSpy.getWorkspaceTree).not.toHaveBeenCalled();
    expect(workspaceServiceSpy.getFileContent).not.toHaveBeenCalled();
    expect(component.deletedNotice()).toBeNull();
  });

  it('scenario 75 — with workspaceId UNSET only the team id addresses this explorer', async () => {
    // The default tab passes `undefined` for the input, and the registry keys
    // the default descriptor on the TEAM id. A naive
    // `instruction.workspaceId === this.workspaceId()` is `'proc' === undefined`
    // here and drops every instruction this explorer exists to act on.
    await deliver(invalidation({ workspaceId: 'ws-a', directories: ['docs'] }));

    expect(workspaceServiceSpy.getWorkspaceTree).not.toHaveBeenCalled();

    await deliver(invalidation({ workspaceId: TEAM_ID, directories: ['docs'] }));

    expect(workspaceServiceSpy.getWorkspaceTree).toHaveBeenCalledOnceWith(
      'proc',
      'docs',
    );
  });

  it('scenario 76 — the addressed id is resolved per instruction, never captured at construction', async () => {
    // `workspace-tabs` sets this input AFTER construction, as here. An
    // implementation that read the signal once in the constructor saw
    // `undefined` for this tab and would act on the TEAM id's instructions
    // instead of its own — both halves of that are asserted.
    fixture.componentRef.setInput('workspaceId', 'ws-b');
    await flushRootLoad(fixture);
    workspaceServiceSpy.getWorkspaceTree.calls.reset();

    await deliver(invalidation({ workspaceId: 'ws-b', directories: ['docs'] }));

    expect(workspaceServiceSpy.getWorkspaceTree).toHaveBeenCalledOnceWith(
      'proc',
      'docs',
      'ws-b',
    );

    workspaceServiceSpy.getWorkspaceTree.calls.reset();
    await deliver(invalidation({ workspaceId: TEAM_ID, directories: ['docs'] }));

    expect(workspaceServiceSpy.getWorkspaceTree).not.toHaveBeenCalled();
  });

  // --- routing a directory invalidation (AC4, AC5) -------------------

  it('scenario 77 — a directory instruction re-lists that directory only, and splices the result', async () => {
    component.treeNodes.set([materializedTree()]);
    workspaceServiceSpy.getWorkspaceTree.and.resolveTo([openFile(2048)]);

    await deliver(invalidation({ directories: ['docs'] }));

    // One listing, for `docs` — the root tree load was NOT re-run.
    expect(workspaceServiceSpy.getWorkspaceTree).toHaveBeenCalledOnceWith(
      'proc',
      'docs',
    );
    expect(workspaceServiceSpy.getFileContent).not.toHaveBeenCalled();

    // ...and it went in through the existing splice.
    const docsNode = component.treeNodes()[0].children![0];
    expect(docsNode.children!.length).toBe(1);
    expect((docsNode.children![0].data as FileNode).size).toBe(2048);
  });

  // --- routing the open file: the refresh path, not the selection path -----

  it('scenario 78 — the open file is re-read through the REFRESH path: the pane is never blanked', async () => {
    await openInPane();
    expect(component.fileContent()).toBe('body');

    const body = deferred<FileContent>();
    workspaceServiceSpy.getFileContent.and.returnValue(body.promise);
    workspaceServiceSpy.getWorkspaceTree.and.resolveTo([openFile(2048)]);

    await deliver(
      invalidation({ directories: ['docs'], files: [OPEN_PATH] }),
    );

    // IN FLIGHT — the assertion that matters. An implementation routing through
    // the selection path (`loadFileContent(path)` without the refresh flag) has
    // already nulled the body and raised the spinner by this point, and would
    // still satisfy an outcome-only assertion once the read resolves.
    expect(workspaceServiceSpy.getFileContent.calls.count()).toBe(1);
    expect(component.fileContent()).toBe('body');
    expect(component.loadingContent()).toBe(false);

    body.resolve({ content: 'new body', type: 'text' });
    await flushMicrotasks();

    expect(component.fileContent()).toBe('new body');
    expect(component.loadingContent()).toBe(false);
  });

  it('scenario 79 — the same action refreshes the metadata, and lists the parent directory exactly ONCE', async () => {
    await openInPane(10);
    fixture.detectChanges();
    const sizeTag = (): { value?: string } =>
      fixture.nativeElement.querySelector(SIZE_TAG) as unknown as {
        value?: string;
      };
    expect(sizeTag().value).toBe('10 B');

    workspaceServiceSpy.getWorkspaceTree.and.resolveTo([openFile(2048)]);
    workspaceServiceSpy.getFileContent.and.resolveTo({
      content: 'new body',
      type: 'text',
    });

    // A `workspace_edit` on the open file names BOTH its directory and itself.
    // `refreshSelectedFile()` already re-lists the parent, so routing both
    // naively issues two listings of `docs`.
    await deliver(
      invalidation({ directories: ['docs'], files: [OPEN_PATH] }),
    );
    fixture.detectChanges();

    expect(listedPaths()).toEqual(['docs']);
    expect(component.selectedFile()!.size).toBe(2048);
    expect(sizeTag().value).toBe('2 KB');
  });

  it('scenario 80 — a change to a file that is NOT the open one issues no body read', async () => {
    await openInPane();

    await deliver(
      invalidation({ directories: ['docs'], files: ['docs/z.txt'] }),
    );

    // Directory granularity is the contract: the tree entry is how a non-open
    // file's change becomes visible.
    expect(workspaceServiceSpy.getFileContent).not.toHaveBeenCalled();
    expect(workspaceServiceSpy.getWorkspaceTree).toHaveBeenCalledOnceWith(
      'proc',
      'docs',
    );
  });

  // --- a deleted open file (AC10-AC14) -------------------------------

  it('scenario 81 — a deleted open file clears the pane and the selection, and is NEVER re-read', async () => {
    await openInPane();
    // Prove both renderer flags are cleared rather than merely already false.
    component.isBinaryFile.set(true);
    component.isMarkdownFile.set(true);

    await deliver(
      invalidation({ directories: ['docs'], deletions: [OPEN_PATH] }),
    );
    fixture.detectChanges();

    // Re-reading a deleted path 404s — which is why `deletions` is its own field.
    expect(workspaceServiceSpy.getFileContent).not.toHaveBeenCalled();
    expect(component.selectedFile()).toBeNull();
    expect(component.fileContent()).toBeNull();
    expect(component.isBinaryFile()).toBe(false);
    expect(component.isMarkdownFile()).toBe(false);
    expect(component.deletedNotice()).toBe(OPEN_PATH);

    // The parent directory is re-listed in the same batch, so the tree entry
    // disappears with the pane.
    expect(workspaceServiceSpy.getWorkspaceTree).toHaveBeenCalledOnceWith(
      'proc',
      'docs',
    );

    // ...and the notice reaches the preview pane, naming the file.
    const notice = fixture.nativeElement.querySelector(
      '.deleted-notice',
    ) as HTMLElement | null;
    expect(notice).withContext('deletion notice block').not.toBeNull();
    expect(notice!.textContent).toContain(OPEN_PATH);
  });

  it('scenario 82 — the deletion notice leaves errorMessage null and the navigator tree rendered', async () => {
    component.treeNodes.set([materializedTree()]);
    await openInPane();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('p-tree'))
      .withContext('navigator tree before the deletion')
      .not.toBeNull();

    await deliver(
      invalidation({ directories: ['docs'], deletions: [OPEN_PATH] }),
    );
    fixture.detectChanges();

    // `errorMessage` gates the tree
    // (`*ngIf="!loading() && !errorMessage() && treeNodes().length > 0"`), so
    // reporting the deletion there would blank the navigator the user needs in
    // order to select something else. Asserted through the rendered view, not
    // only through the signal.
    expect(component.errorMessage()).toBeNull();
    expect(fixture.nativeElement.querySelector('p-tree'))
      .withContext('navigator tree after the deletion')
      .not.toBeNull();
  });

  it('scenario 83 — the next selection clears the notice, in both branches', async () => {
    component.deletedNotice.set(OPEN_PATH);
    await component.onNodeSelect({
      node: {
        data: fileNode({
          name: 'b.txt',
          path: 'docs/b.txt',
          type: 'file',
          extension: '.txt',
        }),
      },
    });
    expect(component.deletedNotice()).toBeNull();

    component.deletedNotice.set(OPEN_PATH);
    await component.onNodeSelect({
      node: {
        data: fileNode({ name: 'docs', path: 'docs', type: 'directory' }),
      },
    });
    expect(component.deletedNotice()).toBeNull();
  });

  it('scenario 84 — within one batch a deletion of the open file beats a change to it', async () => {
    await openInPane();

    // The residual this ordering accepts: a delete-then-recreate inside one
    // 16 ms batch settles as "deleted", and the next batch or either Refresh
    // control recovers it.
    await deliver(
      invalidation({ directories: ['docs'], files: [OPEN_PATH] }),
      invalidation({ directories: ['docs'], deletions: [OPEN_PATH] }),
    );

    expect(workspaceServiceSpy.getFileContent).not.toHaveBeenCalled();
    expect(component.selectedFile()).toBeNull();
    expect(component.deletedNotice()).toBe(OPEN_PATH);
  });

  // --- whole-tree invalidation (AC15) --------------------------------

  it('scenario 85 — wholeTree re-runs the root load and re-reads the open file, reconciling no named target', async () => {
    await openInPane();

    // `directories` is empty by construction on a whole-tree instruction; it is
    // populated here on purpose, to pin that a whole-tree refresh is never
    // reconciled against named targets.
    await deliver(
      invalidation({ wholeTree: true, directories: ['other'], files: ['other/x'] }),
    );

    const listed = listedPaths();
    expect(listed).withContext('root tree reload').toContain('');
    expect(listed).withContext("the open file's metadata half").toContain('docs');
    expect(listed).not.toContain('other');
    expect(workspaceServiceSpy.getFileContent).toHaveBeenCalledOnceWith(
      'proc',
      OPEN_PATH,
      undefined,
    );
  });

  // --- bounded request volume (AC16, AC17, AC18) ---------------------

  it('scenario 86 — ten mutations into one directory produce exactly ONE listing', async () => {
    // The projection emits one instruction per completed call and pushes the
    // whole delta out synchronously, so batching hands this to nobody: routing
    // each instruction as it arrives issues ten listings of `docs`.
    const burst = Array.from({ length: 10 }, (_, i) =>
      invalidation({ directories: ['docs'], files: [`docs/f${i}.txt`] }),
    );

    await deliver(...burst);

    expect(workspaceServiceSpy.getWorkspaceTree).toHaveBeenCalledOnceWith(
      'proc',
      'docs',
    );
  });

  it('scenario 87 — ten mutations across three directories produce THREE listings, not one and not ten', async () => {
    const dirs = ['docs', 'src', 'assets'];
    const burst = Array.from({ length: 10 }, (_, i) =>
      invalidation({
        directories: [dirs[i % 3]],
        files: [`${dirs[i % 3]}/f${i}.txt`],
      }),
    );

    await deliver(...burst);

    // Coalescing unions the targets; it does not collapse them.
    expect(workspaceServiceSpy.getWorkspaceTree.calls.count()).toBe(3);
    expect(listedPaths().slice().sort()).toEqual(['assets', 'docs', 'src']);
  });

  it('scenario 88 — the batch flushes on a MICROTASK, and no interval is created', async () => {
    const intervalSpy = spyOn(window, 'setInterval').and.callThrough();

    invalidations.invalidations$.next(invalidation({ directories: ['docs'] }));
    // One microtask turn — not a timer tick. A `setTimeout` / `bufferTime`
    // debounce has not fired by this point.
    await Promise.resolve();

    expect(workspaceServiceSpy.getWorkspaceTree).toHaveBeenCalledOnceWith(
      'proc',
      'docs',
    );
    expect(intervalSpy).not.toHaveBeenCalled();
  });

  // --- the manual controls stay (AC19) -------------------------------

  it('scenario 89 — both manual Refresh controls are still rendered and still work', async () => {
    // `SandboxTool.exec_command` mutates the workspace with only `cmd`/`cwd` in
    // its arguments and is permanently invisible to this mechanism, so these two
    // controls are a sandbox-using team's only coverage. This is the guard
    // against a later tidy-up that deletes them as now-redundant.
    await openInPane(10);
    fixture.detectChanges();

    const workspaceRefresh = fixture.debugElement.query(
      By.css(WORKSPACE_REFRESH),
    );
    expect(workspaceRefresh).withContext('navigator refresh').not.toBeNull();
    expect(
      (workspaceRefresh.nativeElement as HTMLElement).getAttribute('icon'),
    ).toBe('pi pi-refresh');

    workspaceServiceSpy.getWorkspaceTree.and.resolveTo([openFile(2048)]);
    workspaceRefresh.triggerEventHandler('onClick', {});
    await flushMicrotasks();
    await flushMicrotasks();

    // Unchanged behaviour: root tree reload AND the open-file re-read.
    expect(listedPaths()).toContain('');
    expect(listedPaths()).toContain('docs');
    expect(workspaceServiceSpy.getFileContent).toHaveBeenCalledOnceWith(
      'proc',
      OPEN_PATH,
      undefined,
    );

    workspaceServiceSpy.getWorkspaceTree.calls.reset();
    workspaceServiceSpy.getFileContent.calls.reset();
    fixture.detectChanges();

    const fileRefresh = fixture.debugElement.query(By.css(FILE_REFRESH));
    expect(fileRefresh).withContext('per-file refresh').not.toBeNull();
    expect((fileRefresh.nativeElement as HTMLElement).getAttribute('label')).toBe(
      'Refresh',
    );
    expect(
      (fileRefresh.nativeElement as HTMLElement).querySelector('button')!
        .disabled,
    ).toBe(false);

    fileRefresh.triggerEventHandler('onClick', {});
    await flushMicrotasks();
    await flushMicrotasks();

    expect(workspaceServiceSpy.getFileContent).toHaveBeenCalledOnceWith(
      'proc',
      OPEN_PATH,
      undefined,
    );
    expect(workspaceServiceSpy.getWorkspaceTree).toHaveBeenCalledOnceWith(
      'proc',
      'docs',
    );
  });

  // --- lifecycle (AC21, AC22) ----------------------------------------

  it('scenario 90 — the subscription is torn down on destroy', async () => {
    await openInPane();
    expect(invalidations.invalidations$.observed).toBe(true);

    fixture.destroy();

    expect(invalidations.invalidations$.observed).toBe(false);
    expect(invalidations.invalidations$.observers.length).toBe(0);

    await deliver(
      invalidation({ directories: ['docs'], deletions: [OPEN_PATH] }),
    );

    expect(workspaceServiceSpy.getWorkspaceTree).not.toHaveBeenCalled();
    expect(workspaceServiceSpy.getFileContent).not.toHaveBeenCalled();
    expect(component.deletedNotice()).toBeNull();
    expect(component.selectedFile()).not.toBeNull();
  });

  it('scenario 91 — a second explorer takes its OWN subscription to the shared stream', async () => {
    // Two workspace tabs mean two subscriptions to one non-`shareReplay`ed
    // instance: each baselines independently and neither replays the other's
    // history.
    const second = TestBed.createComponent(WorkspaceExplorerComponent);
    await flushRootLoad(second);
    workspaceServiceSpy.getWorkspaceTree.calls.reset();

    expect(invalidations.invalidations$.observers.length).toBe(2);

    await deliver(invalidation({ directories: ['docs'] }));

    expect(workspaceServiceSpy.getWorkspaceTree.calls.count()).toBe(2);
    expect(listedPaths()).toEqual(['docs', 'docs']);

    second.destroy();
  });

  // --- the refresh the guard declines (review 39-4) -------------------

  it('scenario 92 — a declined per-file refresh still leaves the parent directory listed', async () => {
    // The per-file refresh declines while a read of the same file is already in
    // flight (ADR-030 §D3). The parent directory is dropped from the directory
    // pass ONLY because that refresh re-lists it — so dropping it for a refresh
    // that never runs issues nothing at all for a batch that named both, and
    // the tree entry stays stale with nothing scheduled to correct it. This
    // window is user-invisible before this story and routine after it, because
    // reads now fire from the event stream with no gesture behind them.
    const body = deferred<FileContent>();
    workspaceServiceSpy.getFileContent.and.returnValue(body.promise);
    void component.onNodeSelect({ node: { data: openFile(10) } });
    expect(component.loadingContent())
      .withContext('selection read in flight')
      .toBe(true);
    workspaceServiceSpy.getWorkspaceTree.calls.reset();
    workspaceServiceSpy.getFileContent.calls.reset();

    await deliver(invalidation({ directories: ['docs'], files: [OPEN_PATH] }));

    expect(workspaceServiceSpy.getFileContent)
      .withContext('no second body read races the one in flight')
      .not.toHaveBeenCalled();
    expect(listedPaths()).toEqual(['docs']);

    body.resolve({ content: 'body', type: 'text' });
    await flushMicrotasks();
  });

  it('scenario 93 — a background listing that FAILS does not banner, and leaves the tree rendered', async () => {
    component.treeNodes.set([materializedTree()]);
    fixture.detectChanges();
    workspaceServiceSpy.getWorkspaceTree.and.rejectWith(new Error('boom'));

    await deliver(invalidation({ directories: ['docs'] }));
    fixture.detectChanges();

    // No user gesture is behind this fetch, and `errorMessage` gates the
    // navigator's tree — bannering here would blank the file tree over a
    // background listing, the same panel-wide outage the deletion path refuses.
    // The manual Refresh controls remain the loud path.
    expect(component.errorMessage()).toBeNull();
    expect(fixture.nativeElement.querySelector('p-tree'))
      .withContext('navigator tree after a failed background listing')
      .not.toBeNull();
  });
});
