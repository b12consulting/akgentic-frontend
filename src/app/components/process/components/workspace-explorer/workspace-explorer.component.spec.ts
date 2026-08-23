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
    it('scenario 1 — root listing becomes treeNodes directly, with no wrapper node', async () => {
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

      // The root's ENTRIES are treeNodes: `''` is the root, so there is no node
      // standing for it and the one-element wrapper array is gone (FR2, §D4).
      expect(component.treeNodes().length).toBe(2);
      expect(component.treeError()).toBeNull();

      // The directory child should be lazy (children === undefined, leaf false)
      const subChild = component.treeNodes()[1];
      expect(subChild.label).toBe('sub');
      expect(subChild.leaf).toBe(false);
      expect(subChild.children).toBeUndefined();

      // The file child should be a leaf
      const fileChild = component.treeNodes()[0];
      expect(fileChild.label).toBe('a.md');
      expect(fileChild.leaf).toBe(true);
    });

    it('scenario 2 — empty backend leaves treeNodes empty', async () => {
      workspaceServiceSpy.getWorkspaceTree.and.resolveTo([]);

      fixture = TestBed.createComponent(WorkspaceExplorerComponent);
      component = fixture.componentInstance;
      await flushRootLoad(fixture);

      // No wrapper means an empty workspace really is an empty array — which is
      // what makes the navigator's "No files found" block reachable (AC13).
      expect(component.treeNodes()).toEqual([]);
      expect(component.treeError()).toBeNull();
    });

    it('scenario 3 — HTTP error sets treeError and clears loading', async () => {
      workspaceServiceSpy.getWorkspaceTree.and.rejectWith(new Error('500'));

      fixture = TestBed.createComponent(WorkspaceExplorerComponent);
      component = fixture.componentInstance;
      await flushRootLoad(fixture);

      expect(component.treeError()).toBe('500');
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

    it('scenario 8 — HTTP error sets treeError and leaves children undefined (retryable)', async () => {
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

      // The lazy expand is a TREE-scoped read, so its failure gates the tree.
      expect(component.treeError()).toBe('boom');
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

    it('scenario 19 — text result writes a text-kinded content and clears loadingContent', async () => {
      // The pane is showing the file being read. Previously this scenario drove
      // the loader with no selection at all — a state no production caller can
      // produce, and one whose result is now applied to nothing (scenario 70).
      component.openFile.set(
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

      // One signal carries both facts, so `binary && markdown` cannot be
      // asserted away — it cannot be constructed (FR3).
      expect(component.content()).toEqual({ kind: 'text', body: 'hello world' });
      expect(component.loadingContent()).toBe(false);
      expect(component.fileError()).toBeNull();
    });

    it('scenario 20 — a .md open file yields the markdown kind on a text result', async () => {
      component.openFile.set(
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

      expect(component.content()).toEqual({ kind: 'markdown', body: '# Title' });
      expect(component.loadingContent()).toBe(false);
    });

    it('scenario 21 — binary result yields the binary kind and shows the binary message', async () => {
      // Same correction as scenario 19: the pane must be showing the file whose
      // bytes are read, because a result for any other path is now discarded.
      component.openFile.set(
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

      expect(component.content()).toEqual({
        kind: 'binary',
        body: 'Binary file cannot be displayed',
      });
      expect(component.loadingContent()).toBe(false);
    });

    it('scenario 22 — rejected fetch sets fileError and clears loadingContent', async () => {
      workspaceServiceSpy.getFileContent.and.rejectWith(new Error('read failed'));

      await component.loadFileContent('docs/bad.txt');

      // A body read is FILE-scoped: after the split it cannot reach the signal
      // that gates the navigator's tree at all (FR5).
      expect(component.fileError()).toBe('read failed');
      expect(component.treeError()).toBeNull();
      expect(component.loadingContent()).toBe(false);
      expect(component.content()).toBeNull();
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

    it("scenario 23 — selecting a file sets openFile, loads content, and descends to that file's directory", async () => {
      // Seed a DIFFERENT directory, so the descent is observable. Story 45-1
      // asserted this stayed `'old'` and recorded the question; ADR-033 §D3 was
      // amended to decide it, because "Back stays put" and "Back from a nested
      // file lands in that file's directory" are the same sentence only if
      // opening the file moved you there. A behaviour change, not a rename.
      component.currentDirectory.set('old');
      const file = fileNode({
        name: 'a.ts',
        path: 'src/a.ts',
        type: 'file',
        extension: '.ts',
      });

      await component.onNodeSelect({ node: { data: file } });

      expect(component.openFile()).toEqual(file);
      expect(component.currentDirectory()).toBe('src');
      expect(workspaceServiceSpy.getFileContent).toHaveBeenCalledWith(
        'proc',
        'src/a.ts',
        undefined
      );
      expect(component.content()).toEqual({ kind: 'text', body: 'data' });
    });

    it('scenario 24 — selecting a directory sets currentDirectory, clears the open file and its content', async () => {
      // Seed a stale open file + content to prove they are cleared.
      component.openFile.set(
        fileNode({ name: 'a.ts', path: 'src/a.ts', type: 'file' })
      );
      component.content.set({ kind: 'binary', body: 'stale content' });

      workspaceServiceSpy.getFileContent.calls.reset();
      const dir = fileNode({ name: 'src', path: 'src', type: 'directory' });

      await component.onNodeSelect({ node: { data: dir } });

      expect(component.currentDirectory()).toBe('src');
      expect(component.openFile()).toBeNull();
      expect(component.content()).toBeNull();
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

    /**
     * `docs` (materialized) → `a.md`, as ONE root entry. There is no wrapper
     * node any more, so callers spread this into `treeNodes` directly:
     * `treeNodes.set([materializedTree()])` IS the root's entry list.
     */
    function materializedTree(): TreeNode {
      const aMd: TreeNode = {
        label: 'a.md',
        data: openFile(10),
        leaf: true,
      };
      return {
        label: 'docs',
        data: fileNode({ name: 'docs', path: 'docs', type: 'directory' }),
        leaf: false,
        children: [aMd],
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
      component.openFile.set(openFile());
      await component.loadFileContent(OPEN_FILE_PATH);
      expect(component.content()?.body).toBe('first');

      workspaceServiceSpy.getFileContent.and.resolveTo({
        content: 'first + appended',
        type: 'text',
      });
      workspaceServiceSpy.getWorkspaceTree.and.resolveTo([openFile(2048)]);

      await component.refreshSelectedFile();

      expect(component.content()?.body).toBe('first + appended');
    });

    it('scenario 46 — the same activation re-resolves the file entry and splices the fresh listing', async () => {
      component.treeNodes.set([materializedTree()]);
      component.openFile.set(openFile(10));
      component.content.set({ kind: 'markdown', body: 'first' });

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
      expect(component.openFile()!.size).toBe(2048);
      // ...and so did the tree entry behind it.
      const docsNode = component.treeNodes()[0];
      expect(docsNode.children!.length).toBe(1);
      expect((docsNode.children![0].data as FileNode).size).toBe(2048);
    });

    it('scenario 47 — a file in a never-expanded directory refreshes without throwing or corrupting the tree', async () => {
      // The root listing is empty and `docs` was never expanded, so the walk
      // finds no target — the case the wrapper node used to stand in for.
      component.treeNodes.set([]);
      component.openFile.set(openFile(10));

      workspaceServiceSpy.getWorkspaceTree.and.resolveTo([openFile(2048)]);
      workspaceServiceSpy.getFileContent.and.resolveTo({
        content: 'body',
        type: 'text',
      });

      await expectAsync(component.refreshSelectedFile()).toBeResolved();

      // The unmaterialized target is left alone; the open file still refreshed.
      expect(component.treeNodes()).toEqual([]);
      expect(component.openFile()!.size).toBe(2048);
      expect(component.content()?.body).toBe('body');
    });

    it('scenario 48 — the pane is never blanked: content stays non-null and loadingContent stays down across the whole cycle', async () => {
      component.openFile.set(openFile(10));
      component.content.set({ kind: 'markdown', body: 'old body' });
      workspaceServiceSpy.getWorkspaceTree.and.resolveTo([openFile(2048)]);

      const body = deferred<FileContent>();
      workspaceServiceSpy.getFileContent.and.returnValue(body.promise);

      const observed: { content: string | null; loading: boolean }[] = [];
      const observe = (): void => {
        observed.push({
          content: component.content()?.body ?? null,
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
      expect(component.content()?.body).toBe('new body');
      expect(component.refreshingFile()).toBe(false);
    });

    it('scenario 49 — the selection path still blanks, still raises loadingContent and still issues exactly one request', async () => {
      component.content.set({ kind: 'markdown', body: 'stale body' });
      workspaceServiceSpy.getWorkspaceTree.calls.reset();
      workspaceServiceSpy.getFileContent.calls.reset();

      const body = deferred<FileContent>();
      workspaceServiceSpy.getFileContent.and.returnValue(body.promise);

      const selection = component.onNodeSelect({ node: { data: openFile() } });

      expect(component.content()).toBeNull();
      expect(component.loadingContent()).toBe(true);

      body.resolve({ content: 'body', type: 'text' });
      await selection;

      expect(component.loadingContent()).toBe(false);
      expect(component.content()?.body).toBe('body');
      // One body read, and NO directory listing — selection is not a refresh.
      expect(workspaceServiceSpy.getFileContent.calls.count()).toBe(1);
      expect(workspaceServiceSpy.getWorkspaceTree).not.toHaveBeenCalled();
    });

    it('scenario 50 — a failed body read keeps the stale body and reports the error', async () => {
      const original = openFile(10);
      component.openFile.set(original);
      component.content.set({ kind: 'markdown', body: 'old body' });

      workspaceServiceSpy.getWorkspaceTree.and.resolveTo([openFile(2048)]);
      workspaceServiceSpy.getFileContent.and.rejectWith(new Error('read failed'));

      await component.refreshSelectedFile();

      // The banner AND the body — the pane reports the failure over the stale
      // bytes rather than instead of them. Scenario 114 pins the same fact
      // through the DOM, which is the only place a switch that subsumed the
      // content would show up.
      expect(component.fileError()).toBe('read failed');
      expect(component.content()?.body).toBe('old body');
      expect(component.loadingContent()).toBe(false);
      expect(component.refreshingFile()).toBe(false);
    });

    it('scenario 51 — a failed listing leaves openFile alone, still refreshes the body, and releases the button', async () => {
      const original = openFile(10);
      component.openFile.set(original);
      component.content.set({ kind: 'markdown', body: 'old body' });

      workspaceServiceSpy.getWorkspaceTree.and.rejectWith(
        new Error('listing failed')
      );
      workspaceServiceSpy.getFileContent.and.resolveTo({
        content: 'new body',
        type: 'text',
      });

      await component.refreshSelectedFile();

      expect(component.fileError()).toBe('listing failed');
      expect(component.openFile()).toEqual(original);
      expect(component.content()?.body).toBe('new body');
      expect(component.refreshingFile()).toBe(false);
    });

    it('scenario 52 — a vanished file leaves openFile as it is', async () => {
      const original = openFile(10);
      component.openFile.set(original);
      // Fresh listing no longer carries the open file's path.
      workspaceServiceSpy.getWorkspaceTree.and.resolveTo([
        fileNode({ name: 'b.md', path: 'docs/b.md', type: 'file', size: 5 }),
      ]);
      workspaceServiceSpy.getFileContent.and.resolveTo({
        content: 'body',
        type: 'text',
      });

      await component.refreshSelectedFile();

      expect(component.openFile()).toEqual(original);
    });

    it('scenario 53 — with no file open the refresh is a no-op', async () => {
      component.openFile.set(null);
      workspaceServiceSpy.getWorkspaceTree.calls.reset();
      workspaceServiceSpy.getFileContent.calls.reset();

      await component.refreshSelectedFile();

      expect(workspaceServiceSpy.getFileContent).not.toHaveBeenCalled();
      expect(workspaceServiceSpy.getWorkspaceTree).not.toHaveBeenCalled();
    });

    it('scenario 54 — a set workspaceId is threaded through BOTH the body read and the listing', async () => {
      fixture.componentRef.setInput('workspaceId', 'ws-1');
      await flushRootLoad(fixture);

      component.openFile.set(openFile(10));
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
      component.openFile.set(openFile(10));
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
      component.openFile.set(openFile(10));
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
      expect(component.openFile()!.size).toBe(2048);
    });

    it('scenario 57 — with no file open the navigator refresh is tree-only', async () => {
      component.openFile.set(null);
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
      component.openFile.set(openFile(10));
      component.content.set({ kind: 'markdown', body: 'old body' });
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
      expect(component.content()?.body).toBe('new body');
      expect(workspaceServiceSpy.getFileContent.calls.count()).toBe(1);
    });

    it('scenario 64 — the navigator refresh skips the file half while an initial load is in flight', async () => {
      component.openFile.set(openFile(10));
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
  // Two body reads are trivially concurrent: `onNodeSelect` sets `openFile`
  // and issues a read without awaiting or cancelling one already in flight. If
  // the OLDER read resolves LAST it still wins every write it is allowed to
  // make, and the pane renders one file's bytes under another file's name and
  // size tag. The tree closed the same race declaratively with `switchMap`; the
  // body read never had an equivalent. These scenarios pin that equivalent —
  // the body, both renderer flags, the error banner, the spinner, and the
  // metadata twin in `refreshFileMetadata`.
  //
  // The reads are overlapped through the REAL entry point wherever the defect
  // is the subject, because `onNodeSelect`'s `openFile` write order is part
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

      expect(component.content()?.body).toBe('B body');
      expect(component.openFile()!.path).toBe('docs/b.txt');
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
      expect(component.content()?.kind).toBe('text');
      expect(component.content()?.body).toBe('B body');
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
      // write but leaves the kind write outside the guard passes scenario 65
      // and fails here.
      expect(component.content()?.kind).toBe('text');
      expect(component.content()?.body).toBe('B body');
    });

    it('scenario 68 — markdown-ness comes from the requested path, not from FileNode.extension', async () => {
      // `extension` deliberately absent: the flag must not depend on a listing
      // field the backend may omit, nor on what `openFile` holds when the
      // response lands.
      component.openFile.set(
        fileNode({ name: 'a.md', path: 'docs/a.md', type: 'file', size: 10 })
      );
      workspaceServiceSpy.getFileContent.and.resolveTo({
        content: '# Title',
        type: 'text',
      });

      await component.loadFileContent('docs/a.md');

      expect(component.content()).toEqual({ kind: 'markdown', body: '# Title' });

      // Case-insensitive, like the extension comparison it replaces.
      component.openFile.set(
        fileNode({ name: 'B.MD', path: 'docs/B.MD', type: 'file', size: 4 })
      );
      await component.loadFileContent('docs/B.MD');

      expect(component.content()?.kind).toBe('markdown');
    });

    it('scenario 69 — a superseded metadata refresh does not write a stale FileNode into openFile', async () => {
      component.openFile.set(fileA());
      workspaceServiceSpy.getFileContent.and.resolveTo({
        content: 'A body',
        type: 'text',
      });
      const listing = deferred<FileNode[]>();
      workspaceServiceSpy.getWorkspaceTree.and.returnValue(listing.promise);

      const cycle = component.refreshSelectedFile();
      // The body half has settled; the directory listing is still in flight.
      await flushMicrotasks();
      component.openFile.set(fileB());

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
      expect(component.openFile()!.path).toBe('docs/b.txt');
      expect(component.openFile()!.size).toBe(20);
    });

    it('scenario 70 — with no file selected a resolved read is applied to nothing', async () => {
      component.openFile.set(null);
      workspaceServiceSpy.getFileContent.and.resolveTo({
        content: 'orphan body',
        type: 'text',
      });

      // The stated semantics: no selection means no pane to write into. Both
      // production entry points establish or require `openFile` first, so
      // this state is reachable only by driving the loader directly.
      await expectAsync(component.loadFileContent('docs/x.txt')).toBeResolved();

      expect(component.content()).toBeNull();
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

      expect(component.fileError()).toBeNull();
      expect(component.content()?.body).toBe('B body');
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
      expect(component.content()).toBeNull();

      b.resolve({ content: 'B body', type: 'text' });
      await second;

      expect(component.loadingContent()).toBe(false);
      expect(component.content()?.body).toBe('B body');
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

      expect(component.openFile()).toBeNull();
      // The late body does not repaint a pane that is showing a folder...
      expect(component.content()).toBeNull();
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

      component.openFile.set(
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
      // `docs` IS a root entry — there is no wrapper node above it.
      component.treeNodes.set([docs]);
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

      const refreshedDocs = component.treeNodes()[0];
      expect(refreshedDocs.children?.length).toBe(2);
    });

    it('scenario 10 — a root target replaces treeNodes wholesale', async () => {
      component.treeNodes.set([]);
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
      // There is no wrapper whose children get replaced: the root's children
      // ARE `treeNodes`, so the fresh listing simply becomes the array (FR2).
      expect(component.treeNodes().length).toBe(1);
      expect(component.treeNodes()[0].label).toBe('c.md');
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
      component.openFile.set(
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
      component.openFile.set(
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
      expect(component.treeNodes()[0].label).toBe('fromB.md');

      // Now the stale ws-A response finally arrives — switchMap cancelled it,
      // so it must NOT overwrite ws-B's tree.
      resolveSlow([
        fileNode({ name: 'fromA.md', path: 'fromA.md', type: 'file' }),
      ]);
      await flushRootLoad(fixture);

      expect(component.treeNodes()[0].label).toBe('fromB.md');
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
  // clear and content() must be set after the promise resolves WITHOUT any
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
    expect(explorer.content()?.body).toBe('plain text body');
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
   * Reach the in-a-folder render state — where the footer's "Upload Files"
   * lives — by writing the signal directly. `onNodeSelect` would also fire a
   * `getFileContent` fetch that has nothing to do with run state.
   */
  function selectFolder(): void {
    component.currentDirectory.set('docs');
    fixture.detectChanges();
  }

  /** Back to the root, which is `''` and not "nothing selected" (§D1). */
  function clearSelection(): void {
    component.currentDirectory.set('');
    fixture.detectChanges();
  }

  /**
   * Reach the file-open render state — where "Upload here" lives after ADR-033
   * §D8 re-gated it on `openFile()`. The signals are written directly for the
   * same reason `selectFolder` writes one: going through `onNodeSelect` fires a
   * `getFileContent` read, and this block's no-extra-call assertions count it.
   *
   * `currentDirectory` is set to the file's parent because §D3 says that is
   * where opening a file leaves the pane — so the state reached here is the one
   * a real file open produces, not an assembled approximation.
   */
  function openFileInPane(): void {
    component.currentDirectory.set('docs');
    component.openFile.set(
      fileNode({
        name: 'a.txt',
        path: 'docs/a.txt',
        type: 'file',
        extension: '.txt',
      }),
    );
    fixture.detectChanges();
  }

  /** Close the open file without a control, so no listing fetch is issued. */
  function closeOpenFile(): void {
    component.openFile.set(null);
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

  // The two non-root controls no longer share one render state: ADR-033 §D8
  // hides "Upload here" in the list view, so its run-state coverage is driven
  // from the FILE-OPEN state while "Upload Files" keeps the folder state. The
  // gate on both is what FR9 protects, and it is asserted on both — losing
  // either half would be a silent regression in exactly that.

  it('scenario 38 — a flip to running enables the folder footer AND the file-open toolbar control, with no re-init and no extra call', async () => {
    await createStopped();
    selectFolder();
    expect(isDisabled('Upload Files')).toBe(true);
    openFileInPane();
    expect(isDisabled('Upload here')).toBe(true);

    const treeCalls = workspaceServiceSpy.getWorkspaceTree.calls.count();
    const contentCalls = workspaceServiceSpy.getFileContent.calls.count();
    contextServiceStub.getCurrentTeam.calls.reset();

    contextServiceStub.currentTeamRunning$.next(true);
    fixture.detectChanges();

    expect(isDisabled('Upload here')).toBe(false);
    closeOpenFile();
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

  it('scenario 40 — the reverse flip disables the folder footer AND the file-open toolbar control again', async () => {
    await createRunning();
    selectFolder();
    expect(isDisabled('Upload Files')).toBe(false);
    openFileInPane();
    expect(isDisabled('Upload here')).toBe(false);

    const treeCalls = workspaceServiceSpy.getWorkspaceTree.calls.count();
    contextServiceStub.getCurrentTeam.calls.reset();

    contextServiceStub.currentTeamRunning$.next(false);
    fixture.detectChanges();

    expect(isDisabled('Upload here')).toBe(true);
    closeOpenFile();
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
    expect(tooltipOf('Upload Files')).toBe(STOPPED_TOOLTIP);
    // "Upload here" now presents from the file-open state (ADR-033 §D8); the
    // tooltip and the disabled binding still read the one live source.
    openFileInPane();
    expect(tooltipOf('Upload here')).toBe(STOPPED_TOOLTIP);

    contextServiceStub.currentTeamRunning$.next(true);
    fixture.detectChanges();

    // Running: none of the three presents the stopped-team tooltip.
    expect(tooltipOf('Upload here')).toBe('');
    closeOpenFile();
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
    component.openFile.set(openFile(size));
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

  /** `docs` (materialized) → `a.txt`, as ONE root entry — there is no wrapper. */
  function materializedTree(): TreeNode {
    const aTxt: TreeNode = { label: 'a.txt', data: openFile(10), leaf: true };
    return {
      label: 'docs',
      data: fileNode({ name: 'docs', path: 'docs', type: 'directory' }),
      leaf: false,
      children: [aTxt],
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
    const docsNode = component.treeNodes()[0];
    expect(docsNode.children!.length).toBe(1);
    expect((docsNode.children![0].data as FileNode).size).toBe(2048);
  });

  // --- routing the open file: the refresh path, not the selection path -----

  it('scenario 78 — the open file is re-read through the REFRESH path: the pane is never blanked', async () => {
    await openInPane();
    expect(component.content()?.body).toBe('body');

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
    expect(component.content()?.body).toBe('body');
    expect(component.loadingContent()).toBe(false);

    body.resolve({ content: 'new body', type: 'text' });
    await flushMicrotasks();

    expect(component.content()?.body).toBe('new body');
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
    expect(component.openFile()!.size).toBe(2048);
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
    // Prove the loaded content is cleared rather than merely already null.
    component.content.set({ kind: 'binary', body: 'stale' });

    await deliver(
      invalidation({ directories: ['docs'], deletions: [OPEN_PATH] }),
    );
    fixture.detectChanges();

    // Re-reading a deleted path 404s — which is why `deletions` is its own field.
    expect(workspaceServiceSpy.getFileContent).not.toHaveBeenCalled();
    expect(component.openFile()).toBeNull();
    expect(component.content()).toBeNull();
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

  it('scenario 82 — the deletion notice leaves BOTH error halves null and the navigator tree rendered', async () => {
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

    // `treeError` gates the tree
    // (`*ngIf="!loading() && !treeError() && treeNodes().length > 0"`), so
    // reporting the deletion there would blank the navigator the user needs in
    // order to select something else. Asserted through the rendered view, not
    // only through the signal.
    //
    // BOTH halves, deliberately. Before the split this asserted a file-path
    // writer against a tree-scoped consequence; after it, the tree half is
    // structurally unreachable from here and the file half is the one a lazy
    // implementation would still reach for. Asserting only the half that can
    // still be written would silently drop the original assertion's meaning.
    expect(component.treeError()).toBeNull();
    expect(component.fileError()).toBeNull();
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
    expect(component.openFile()).toBeNull();
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
    expect(component.openFile()).not.toBeNull();
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

    // No user gesture is behind this fetch, and `treeError` gates the
    // navigator's tree — bannering here would blank the file tree over a
    // background listing, the same panel-wide outage the deletion path refuses.
    // The manual Refresh controls remain the loud path.
    expect(component.treeError()).toBeNull();
    expect(fixture.nativeElement.querySelector('p-tree'))
      .withContext('navigator tree after a failed background listing')
      .not.toBeNull();
  });
});

// --------------------------------------------------------------------
// Gesture-less reads log instead of bannering (Epic 40, FR1-FR3).
//
// `treeError` gates the navigator's `p-tree` AND its empty state, so ANY write
// to it removes the file tree. That was tolerable while every read followed a
// user gesture. Epic 39 made reads fire from the event stream, and a background
// 404 or transient 500 now blanks the whole navigator with nothing behind it —
// and `openFile` is never cleared, so `Refresh workspace` re-enters the
// identical cycle and the panel stays broken until the user switches tab or
// team.
//
// Epic 45's error split (ADR-033 §D7) narrows which routes can reach that
// signal at all — a body read can no longer reach it under any conditions —
// but it does not replace this rule: `treeError` still has two gesture-less
// writers of its own (the root load and the lazy expand), and the file half
// still owns a banner the pane shows.
//
// The rule is one rule on every route the event stream can reach: the body
// read, the directory listing and the whole-tree root load. Both halves of it
// matter — a gesture-less read must not WRITE the banner, and must not CLEAR it
// either, because the tree is rendered from `treeNodes` regardless of whether
// that tree was ever re-validated.
//
// The three GESTURE paths are pinned just as hard: the cheap version of this
// fix (never write the banner from `loadFileContent` at all) satisfies every
// background scenario below while deleting the error reporting a user who
// selects an unreadable file depends on.
// --------------------------------------------------------------------

describe('WorkspaceExplorerComponent — gesture-less reads log instead of bannering (Epic 40)', () => {
  const TEAM_ID = 'proc';
  const OPEN_PATH = 'docs/a.txt';
  const FILE_REFRESH = 'p-button[pTooltip="Refresh this file"]';
  const WORKSPACE_REFRESH = 'p-button[pTooltip="Refresh workspace"]';

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

  /** `docs` (materialized) → `a.txt`, as ONE root entry — there is no wrapper. */
  function materializedTree(): TreeNode {
    const aTxt: TreeNode = { label: 'a.txt', data: openFile(10), leaf: true };
    return {
      label: 'docs',
      data: fileNode({ name: 'docs', path: 'docs', type: 'directory' }),
      leaf: false,
      children: [aTxt],
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

  /** Push instructions as ONE synchronous delta, then settle the fetches. */
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

  /** Settle a control activation: two macrotask turns drain both halves. */
  async function settle(): Promise<void> {
    await flushMicrotasks();
    await flushMicrotasks();
  }

  function tree(): HTMLElement | null {
    return fixture.nativeElement.querySelector('p-tree') as HTMLElement | null;
  }

  // --- FR1: a gesture-less read logs, on every route -----------------

  it('scenario 94 — a background BODY re-read that fails logs, and blanks nothing', async () => {
    component.treeNodes.set([materializedTree()]);
    await openInPane();
    fixture.detectChanges();
    expect(component.content()?.body).toBe('body');
    expect(tree()).withContext('navigator tree before the failure').not.toBeNull();

    const consoleError = spyOn(console, 'error');
    workspaceServiceSpy.getFileContent.and.rejectWith(new Error('boom'));
    workspaceServiceSpy.getWorkspaceTree.and.resolveTo([openFile(2048)]);

    await deliver(invalidation({ directories: ['docs'], files: [OPEN_PATH] }));
    fixture.detectChanges();

    // Nobody asked for this read, so it does not banner. Intermediate state is
    // asserted too: a spec that only checked the banner would pass on a
    // component that blanked the pane and raised a spinner instead.
    expect(component.fileError()).toBeNull();
    expect(tree()).withContext('navigator tree after the failure').not.toBeNull();
    expect(component.content()?.body)
      .withContext('the pane keeps its last good bytes')
      .toBe('body');
    expect(component.loadingContent()).toBe(false);
    expect(consoleError).toHaveBeenCalled();
  });

  it('scenario 95 — a background WHOLE-TREE root load that fails logs, and leaves the tree rendered', async () => {
    component.treeNodes.set([materializedTree()]);
    fixture.detectChanges();

    const consoleError = spyOn(console, 'error');
    workspaceServiceSpy.getWorkspaceTree.and.rejectWith(new Error('boom'));

    await deliver(invalidation({ wholeTree: true }));
    fixture.detectChanges();

    // Fixing the body read and leaving the root load bannering repeats the
    // original mistake one level up. The error split does NOT close this: the
    // root load is exactly the writer that still owns `treeError`.
    expect(component.treeError()).toBeNull();
    expect(component.treeNodes().length)
      .withContext('the previously loaded tree survives')
      .toBe(1);
    expect(tree()).withContext('navigator tree after a failed background root load').not.toBeNull();
    expect(consoleError).toHaveBeenCalled();
  });

  it('scenario 96 — a background METADATA listing that fails logs, and does not banner', async () => {
    await openInPane();

    const consoleError = spyOn(console, 'error');
    workspaceServiceSpy.getFileContent.and.resolveTo({
      content: 'new body',
      type: 'text',
    });
    workspaceServiceSpy.getWorkspaceTree.and.rejectWith(new Error('listing boom'));

    // No `directories` — this isolates the listing the per-file refresh issues
    // itself, which is a different writer from `routeInvalidation`'s own
    // directory pass (the one that already complied).
    await deliver(invalidation({ files: [OPEN_PATH] }));
    fixture.detectChanges();

    expect(component.fileError()).toBeNull();
    expect(component.content()?.body)
      .withContext('the body half still landed')
      .toBe('new body');
    expect(consoleError).toHaveBeenCalled();
  });

  // --- FR2: a gesture-less read does not clear the banner either ------

  it('scenario 97 — a background body re-read does not clear a genuine root-load banner', async () => {
    component.treeNodes.set([materializedTree()]);
    await openInPane();
    component.treeError.set('Failed to load workspace');
    fixture.detectChanges();
    expect(tree()).withContext('navigator hidden by the genuine banner').toBeNull();

    workspaceServiceSpy.getFileContent.and.resolveTo({
      content: 'new body',
      type: 'text',
    });
    workspaceServiceSpy.getWorkspaceTree.and.resolveTo([openFile(2048)]);

    await deliver(invalidation({ files: [OPEN_PATH] }));
    fixture.detectChanges();

    // The entry-side clear is a tree-scoped write in the other direction:
    // erasing it makes the navigator reappear rendering a stale tree with the
    // failure silently gone.
    //
    // After the error split this is STRUCTURALLY true rather than
    // behaviourally true — a body read writes `fileError` and cannot reach
    // `treeError` under any conditions. That is the intended strengthening, and
    // the scenario is kept rather than deleted because it is what pins the
    // structure: an implementation that re-merged the two halves fails here.
    expect(component.treeError()).toBe('Failed to load workspace');
    expect(tree()).withContext('navigator still hidden').toBeNull();
  });

  it('scenario 98 — a background root load does not clear the banner on entry either', async () => {
    component.treeNodes.set([materializedTree()]);
    component.treeError.set('Failed to load workspace');

    const pending = deferred<FileNode[]>();
    workspaceServiceSpy.getWorkspaceTree.and.returnValue(pending.promise);

    invalidations.invalidations$.next(invalidation({ wholeTree: true }));
    await flushMicrotasks();

    // IN FLIGHT — the assertion that matters. The entry clear runs at
    // subscribe time, so an unconditional `treeError.set(null)` has already
    // erased the banner by this point and an outcome-only assertion after the
    // load settles would never see it.
    expect(component.treeError()).toBe('Failed to load workspace');

    pending.resolve([]);
    await settle();

    // ...and no "clear on success" rule is invented here either: neither the
    // epic nor the ADR states one.
    expect(component.treeError()).toBe('Failed to load workspace');
  });

  // --- the stuck cycle: an outage rather than a glitch ----------------

  it('scenario 99 — after a background failure the panel is usable and Refresh workspace repaints it', async () => {
    component.treeNodes.set([materializedTree()]);
    await openInPane();
    fixture.detectChanges();

    spyOn(console, 'error');
    workspaceServiceSpy.getFileContent.and.rejectWith(new Error('boom'));
    workspaceServiceSpy.getWorkspaceTree.and.rejectWith(new Error('boom'));

    await deliver(invalidation({ directories: ['docs'], files: [OPEN_PATH] }));
    fixture.detectChanges();

    expect(component.treeError()).toBeNull();
    expect(component.fileError()).toBeNull();
    expect(tree()).withContext('navigator survives the background failure').not.toBeNull();

    // The escape route the outage removed: with the banner up the tree is gone,
    // and `openFile` is never cleared, so this control re-enters the identical
    // failing cycle and the panel stays broken from the inside.
    workspaceServiceSpy.getWorkspaceTree.and.resolveTo([openFile(4096)]);
    workspaceServiceSpy.getFileContent.and.resolveTo({
      content: 'recovered',
      type: 'text',
    });

    const workspaceRefresh = fixture.debugElement.query(By.css(WORKSPACE_REFRESH));
    expect(workspaceRefresh).withContext('navigator refresh').not.toBeNull();
    workspaceRefresh.triggerEventHandler('onClick', {});
    await settle();
    fixture.detectChanges();

    expect(component.treeError()).toBeNull();
    expect(component.fileError()).toBeNull();
    expect(component.content()?.body).toBe('recovered');
    expect(component.treeNodes().length).toBe(1);
    expect(tree()).withContext('navigator repainted by the manual refresh').not.toBeNull();
  });

  // --- FR3: a user gesture still reports its failure ------------------

  it('scenario 100 — a file the USER selects that fails to read still banners', async () => {
    spyOn(console, 'error');
    workspaceServiceSpy.getFileContent.and.rejectWith(new Error('403 Forbidden'));

    await component.onNodeSelect({ node: { data: openFile(10) } });
    fixture.detectChanges();

    // Selecting an unreadable file is the case the cheap fix silently deletes.
    expect(component.fileError()).toBe('403 Forbidden');
    expect(component.loadingContent()).toBe(false);
  });

  it('scenario 101 — the toolbar Refresh this file still banners when the BODY read fails', async () => {
    await openInPane();
    fixture.detectChanges();

    spyOn(console, 'error');
    workspaceServiceSpy.getFileContent.and.rejectWith(new Error('read failed'));

    const fileRefresh = fixture.debugElement.query(By.css(FILE_REFRESH));
    expect(fileRefresh).withContext('per-file refresh').not.toBeNull();
    fileRefresh.triggerEventHandler('onClick', {});
    await settle();

    // `loadFileContent(path, true)` reaches this loader with `refresh` SET, the
    // same as the invalidation route — which is why `refresh === true` cannot
    // be the gesture test.
    expect(component.fileError()).toBe('read failed');
  });

  it('scenario 102 — the toolbar Refresh this file still banners when the METADATA half fails', async () => {
    await openInPane();
    fixture.detectChanges();

    spyOn(console, 'error');
    workspaceServiceSpy.getFileContent.and.resolveTo({
      content: 'new body',
      type: 'text',
    });
    workspaceServiceSpy.getWorkspaceTree.and.rejectWith(new Error('listing failed'));

    const fileRefresh = fixture.debugElement.query(By.css(FILE_REFRESH));
    fileRefresh.triggerEventHandler('onClick', {});
    await settle();

    // The metadata half fetches a DIRECTORY listing but is issued on behalf of
    // the open file, so its failure is file-scoped: it must not cost the tree.
    expect(component.fileError()).toBe('listing failed');
    expect(component.treeError()).toBeNull();
  });

  it('scenario 103 — the navigator Refresh workspace still banners when the ROOT load fails', async () => {
    component.treeNodes.set([materializedTree()]);
    fixture.detectChanges();

    spyOn(console, 'error');
    workspaceServiceSpy.getWorkspaceTree.and.rejectWith(new Error('root failed'));

    const workspaceRefresh = fixture.debugElement.query(By.css(WORKSPACE_REFRESH));
    workspaceRefresh.triggerEventHandler('onClick', {});
    await settle();
    fixture.detectChanges();

    expect(component.treeError()).toBe('root failed');
  });

  it('scenario 104 — the navigator Refresh workspace still banners when the DELEGATED body read fails', async () => {
    await openInPane();
    fixture.detectChanges();

    spyOn(console, 'error');
    workspaceServiceSpy.getWorkspaceTree.and.resolveTo([openFile(2048)]);
    workspaceServiceSpy.getFileContent.and.rejectWith(new Error('body failed'));

    const workspaceRefresh = fixture.debugElement.query(By.css(WORKSPACE_REFRESH));
    workspaceRefresh.triggerEventHandler('onClick', {});
    await settle();

    // `refresh()` carries its origin to BOTH halves; the per-file half it
    // delegates to is a gesture too. It banners on the FILE half — the tree
    // half of the same activation succeeded, and must not be reported as failed.
    expect(component.fileError()).toBe('body failed');
    expect(component.treeError()).toBeNull();
  });
});

// --------------------------------------------------------------------
// The pane's state model (Epic 45, FR1-FR5 / FR9).
//
// `currentDirectory` + `openFile` + one kind-tagged `content` + one computed
// `viewMode` + two scoped error signals, replacing five signals, six
// hand-switched template branches and one synthetic root node.
//
// Every scenario in this block is a DOM or in-flight assertion, deliberately.
// The defects they guard are invisible to the signals: a `@switch` that
// subsumes a rendered body, two blocks rendering at once, a spinner raised for
// a load nobody asked for, and an error signal that gates the wrong half of
// the panel all leave the signal values a naive spec would check unchanged.
//
// The widened override is reused (`ButtonModule` + `ToolbarModule`) so the
// toolbar's `start`/`end` templates instantiate and `[disabled]` reaches a real
// inner <button>. The open file is a `.txt`: a `.md` renders through
// `<markdown>`, which has no dash and is therefore not resolvable under
// CUSTOM_ELEMENTS_SCHEMA (the constraint scenario 27 documents).
// --------------------------------------------------------------------

describe('WorkspaceExplorerComponent — the pane state model (Epic 45)', () => {
  const TEAM_ID = 'proc';
  const OPEN_PATH = 'docs/deep/a.txt';

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

  /** `docs` (materialized) → `deep` → `a.txt`, as ONE root entry. */
  function materializedTree(): TreeNode {
    const aTxt: TreeNode = { label: 'a.txt', data: openFile(10), leaf: true };
    const deep: TreeNode = {
      label: 'deep',
      data: fileNode({ name: 'deep', path: 'docs/deep', type: 'directory' }),
      leaf: false,
      children: [aTxt],
    };
    return {
      label: 'docs',
      data: fileNode({ name: 'docs', path: 'docs', type: 'directory' }),
      leaf: false,
      children: [deep],
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
  });

  /** Create and settle the component. Callers that need an in-flight window create it themselves. */
  async function create(): Promise<void> {
    fixture = TestBed.createComponent(WorkspaceExplorerComponent);
    component = fixture.componentInstance;
    await flushRootLoad(fixture);
  }

  /** Push instructions as ONE synchronous delta, then settle the fetches. */
  async function deliver(...batch: WorkspaceInvalidation[]): Promise<void> {
    for (const instruction of batch) {
      invalidations.invalidations$.next(instruction);
    }
    await flushMicrotasks();
    await flushMicrotasks();
  }

  function tree(): HTMLElement | null {
    return fixture.nativeElement.querySelector('p-tree') as HTMLElement | null;
  }

  function pane(): HTMLElement {
    return fixture.nativeElement.querySelector('.panel-content') as HTMLElement;
  }

  /**
   * The blocks `.panel-content` can render, as a set of selectors. Counting
   * MATCHED SELECTORS rather than child elements is what makes the exclusivity
   * assertion meaningful: `@switch` leaves comment anchors between cases, and a
   * child count would be satisfied by any single wrapper.
   *
   * The helper still means "exactly one VIEW-MODE block". The `'list'` case is
   * the one case that renders two of them — the scrolling list region and the
   * footer pinned under it are both part of that case (ADR-033 §D8) — so its
   * assertion names both and every other case still names exactly one.
   *
   * `.file-placeholder:not(.deleted-notice)` and `.folder-view` no longer have
   * markup: FR8 replaced the root placeholder and the folder view with the list
   * and the footer. They are KEPT rather than dropped, as guards — either one
   * matching again means a centred call-to-action came back into the list case.
   */
  const PANE_BLOCKS = [
    'p-progressspinner, p-progressSpinner',
    '.error-message',
    '.deleted-notice',
    '.file-placeholder:not(.deleted-notice)',
    '.folder-view',
    '.binary-card, p-card',
    '.file-content',
    '.markdown-content',
    '.directory-list',
    '.upload-footer',
  ];

  function renderedBlocks(): string[] {
    return PANE_BLOCKS.filter((selector) => pane().querySelector(selector) !== null);
  }

  // --- FR1 / FR2: the model starts at the root and the load writes no selection ---

  it("scenario 105 — currentDirectory starts '' and the root load populates the tree without writing a selection", async () => {
    workspaceServiceSpy.getWorkspaceTree.and.resolveTo([
      fileNode({ name: 'docs', path: 'docs', type: 'directory' }),
    ]);

    fixture = TestBed.createComponent(WorkspaceExplorerComponent);
    component = fixture.componentInstance;

    // Before the listing arrives: already AT the root, with an empty list.
    // There is no "unset" state to distinguish and no flag standing for one.
    expect(component.currentDirectory()).toBe('');
    expect(component.openFile()).toBeNull();

    await flushRootLoad(fixture);

    expect(component.treeNodes().length).toBe(1);
    // The load writes the TREE. It does not move the user (AC8).
    expect(component.currentDirectory()).toBe('');
    expect(component.openFile()).toBeNull();
    expect(component.viewMode()).toBe('list');
  });

  // --- AC8: applyRootLoad never navigates the user ---------------------

  it('scenario 106 — a background refresh with a file open deep in a subdirectory moves neither signal', async () => {
    await create();
    component.treeNodes.set([materializedTree()]);
    component.currentDirectory.set('docs/deep');
    await component.onNodeSelect({ node: { data: openFile(10) } });
    fixture.detectChanges();

    expect(component.currentDirectory()).toBe('docs/deep');
    expect(component.openFile()!.path).toBe(OPEN_PATH);

    workspaceServiceSpy.getWorkspaceTree.and.resolveTo([
      fileNode({ name: 'other', path: 'other', type: 'directory' }),
    ]);
    workspaceServiceSpy.getFileContent.and.resolveTo({
      content: 'body',
      type: 'text',
    });

    // A whole-tree instruction — an agent writing a file — routes to
    // `refresh(true)`, whose sink is `applyRootLoad`.
    await deliver(invalidation({ workspaceId: TEAM_ID, wholeTree: true }));

    // The tree was replaced; the user was NOT navigated. An `applyRootLoad`
    // that reset either signal "to keep the pane consistent with the fresh
    // tree" fails here, and only here.
    expect(component.treeNodes()[0].label).toBe('other');
    expect(component.currentDirectory()).toBe('docs/deep');
    expect(component.openFile()!.path).toBe(OPEN_PATH);
  });

  it('scenario 107 — a superseded root load writes neither treeNodes nor currentDirectory', async () => {
    fixture = TestBed.createComponent(WorkspaceExplorerComponent);
    component = fixture.componentInstance;

    // First (slow) fetch for ws-A: resolves LATE.
    const slow = deferred<FileNode[]>();
    workspaceServiceSpy.getWorkspaceTree.and.returnValue(slow.promise);
    fixture.componentRef.setInput('workspaceId', 'ws-A');
    fixture.detectChanges();

    // Second (fast) fetch for ws-B wins, and the user then navigates.
    workspaceServiceSpy.getWorkspaceTree.and.resolveTo([
      fileNode({ name: 'fromB', path: 'fromB', type: 'directory' }),
    ]);
    fixture.componentRef.setInput('workspaceId', 'ws-B');
    await flushRootLoad(fixture);
    component.currentDirectory.set('fromB');

    slow.resolve([fileNode({ name: 'fromA', path: 'fromA', type: 'directory' })]);
    await flushRootLoad(fixture);

    // switchMap cancelled ws-A, so it overwrites neither half — and the
    // second half is true BY CONSTRUCTION, because `applyRootLoad` has no
    // `currentDirectory` write to guard in the first place (NFR1).
    expect(component.treeNodes()[0].label).toBe('fromB');
    expect(component.currentDirectory()).toBe('fromB');
  });

  // --- FR3: binary && markdown is unrepresentable ----------------------

  it('scenario 108 — a markdown read then a binary read of the SAME path leave exactly one kind', async () => {
    await create();
    const mdPath = 'docs/a.md';
    component.openFile.set(
      fileNode({ name: 'a.md', path: mdPath, type: 'file', extension: '.md' }),
    );

    workspaceServiceSpy.getFileContent.and.resolveTo({
      content: '# Title',
      type: 'text',
    });
    await component.loadFileContent(mdPath);
    expect(component.content()).toEqual({ kind: 'markdown', body: '# Title' });

    workspaceServiceSpy.getFileContent.and.resolveTo({
      content: null,
      type: 'binary',
      message: 'Binary file cannot be displayed',
    });
    await component.loadFileContent(mdPath);

    // Under the three-flag model the second read set `isBinaryFile` while
    // `isMarkdownFile` was still true from the first — a state the template had
    // to order its conditions around. One signal cannot hold two kinds.
    expect(component.content()).toEqual({
      kind: 'binary',
      body: 'Binary file cannot be displayed',
    });
    expect(component.viewMode()).toBe('binary');
  });

  it('scenario 109 — a text result with a null body loads as an empty string, not as "nothing loaded"', async () => {
    await create();
    component.openFile.set(
      fileNode({ name: 'e.txt', path: 'docs/e.txt', type: 'file', extension: '.txt' }),
    );
    workspaceServiceSpy.getFileContent.and.resolveTo({
      content: null,
      type: 'text',
    });

    await component.loadFileContent('docs/e.txt');
    fixture.detectChanges();

    // "Loaded and empty" is a different fact from "nothing is loaded": the
    // former renders an empty document, the latter used to render nothing at
    // all because the template tested `fileContent() !== null`.
    expect(component.content()).toEqual({ kind: 'text', body: '' });
    expect(component.viewMode()).toBe('text');
    expect(pane().querySelector('.file-content pre')).not.toBeNull();
  });

  // --- FR4 / AC10: exactly one value, exactly one rendered block -------

  it('scenario 110 — the deleted-file case renders exactly ONE block in the pane', async () => {
    await create();
    await component.onNodeSelect({ node: { data: openFile(10) } });

    await deliver(
      invalidation({ workspaceId: TEAM_ID, deletions: [OPEN_PATH] }),
    );
    fixture.detectChanges();

    // The two blocks `component.html:159`/`:179` warned about by hand: with
    // `openFile` cleared, "Select a file to view its content" and "that file
    // was deleted" were both true and rendered together. `viewMode` returns
    // one value, so one block renders.
    expect(component.viewMode()).toBe('deleted');
    expect(renderedBlocks()).toEqual(['.deleted-notice']);
  });

  it('scenario 111 — the list case renders its two blocks in the pane and nothing else', async () => {
    await create();
    fixture.detectChanges();

    // FR8 replaced the centred "Workspace Root" placeholder with the list
    // region and the footer pinned beneath it. Both belong to the `'list'`
    // case, so "exactly one view-mode block" still holds — the case simply has
    // two parts, and no OTHER case's block may appear beside them.
    expect(component.viewMode()).toBe('list');
    expect(renderedBlocks()).toEqual(['.directory-list', '.upload-footer']);
  });

  // --- FR5 / AC7: the split, in both directions ------------------------

  it('scenario 112 — a failed FILE read leaves the navigator tree rendered', async () => {
    await create();
    component.treeNodes.set([materializedTree()]);
    fixture.detectChanges();
    expect(tree()).withContext('navigator tree before the failure').not.toBeNull();

    spyOn(console, 'error');
    workspaceServiceSpy.getFileContent.and.rejectWith(new Error('403 Forbidden'));

    // A USER gesture, so it must banner — and must banner on the half that
    // does not gate the tree. Against the single signal the tree disappears.
    await component.onNodeSelect({ node: { data: openFile(10) } });
    fixture.detectChanges();

    expect(component.fileError()).toBe('403 Forbidden');
    expect(component.treeError()).toBeNull();
    expect(tree()).withContext('navigator tree after the failed read').not.toBeNull();
  });

  it('scenario 113 — neither error half can clear or overwrite the other', async () => {
    await create();
    component.treeNodes.set([materializedTree()]);
    spyOn(console, 'error');

    // A file failure is on screen first.
    workspaceServiceSpy.getFileContent.and.rejectWith(new Error('403 Forbidden'));
    await component.onNodeSelect({ node: { data: openFile(10) } });
    expect(component.fileError()).toBe('403 Forbidden');

    // ...then a root load fails under it. Against the single signal the root
    // load's entry clear erases the file banner before its own write lands.
    workspaceServiceSpy.getWorkspaceTree.and.rejectWith(new Error('root failed'));
    component.refresh();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(component.treeError()).toBe('root failed');
    expect(component.fileError())
      .withContext('the file banner survives a tree failure')
      .not.toBeNull();

    // ...and the reverse: a file read succeeding does not erase the tree
    // banner, nor does a failing one overwrite it.
    workspaceServiceSpy.getFileContent.and.rejectWith(new Error('read failed'));
    await component.loadFileContent(OPEN_PATH);

    expect(component.fileError()).toBe('read failed');
    expect(component.treeError())
      .withContext('the tree banner survives a file failure')
      .toBe('root failed');
  });

  // --- AC5: the banner renders ABOVE a body that stays -----------------

  it('scenario 114 — a failed REFRESH keeps the body rendered, with the banner above it', async () => {
    await create();
    await component.onNodeSelect({ node: { data: openFile(10) } });
    fixture.detectChanges();
    expect(pane().querySelector('.file-content')).not.toBeNull();

    spyOn(console, 'error');
    workspaceServiceSpy.getFileContent.and.rejectWith(new Error('read failed'));
    workspaceServiceSpy.getWorkspaceTree.and.resolveTo([openFile(2048)]);

    await component.refreshSelectedFile();
    fixture.detectChanges();

    // A DOM assertion, because the signals cannot see this: a `@switch` whose
    // 'error' case subsumed the content leaves `fileError` and `content` at
    // exactly these values and still blanks the reader's document.
    const banner = pane().querySelector('.error-message');
    const body = pane().querySelector('.file-content');
    expect(banner).withContext('the failure is reported').not.toBeNull();
    expect(body).withContext('the readable body survives the failed re-read').not.toBeNull();
    expect(banner!.textContent).toContain('read failed');
    // ABOVE, not beside: the reader meets the warning before the stale bytes.
    expect(
      banner!.compareDocumentPosition(body!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  // --- FR9 / row 24: a background root load does not unmount the navigator ---

  it('scenario 115 — the tree stays rendered DURING a background root load', async () => {
    await create();
    component.treeNodes.set([materializedTree()]);
    fixture.detectChanges();
    expect(tree()).withContext('navigator tree before the load').not.toBeNull();

    const pending = deferred<FileNode[]>();
    workspaceServiceSpy.getWorkspaceTree.and.returnValue(pending.promise);

    invalidations.invalidations$.next(
      invalidation({ workspaceId: TEAM_ID, wholeTree: true }),
    );
    await flushMicrotasks();
    fixture.detectChanges();

    // IN FLIGHT — the assertion that matters, in scenario 98's shape. The
    // spinner is raised at subscribe time, so an implementation that calls
    // `loading.set(true)` above the `background` check has already unmounted
    // the tree by this point and an outcome-only assertion never sees it.
    expect(component.loading())
      .withContext('a gesture-less load raises no spinner')
      .toBe(false);
    expect(tree()).withContext('navigator tree DURING the load').not.toBeNull();

    pending.resolve([fileNode({ name: 'fresh', path: 'fresh', type: 'directory' })]);
    await flushMicrotasks();
    await flushMicrotasks();
    fixture.detectChanges();

    expect(component.loading()).toBe(false);
    expect(tree()).withContext('navigator tree after the load').not.toBeNull();
  });

  it('scenario 116 — a GESTURE root load still raises and lowers the spinner', async () => {
    await create();
    component.treeNodes.set([materializedTree()]);

    const pending = deferred<FileNode[]>();
    workspaceServiceSpy.getWorkspaceTree.and.returnValue(pending.promise);

    // The other half of row 24's guard: moving the write below the check must
    // not delete the spinner the navigator's own Refresh control depends on.
    component.refresh();
    fixture.detectChanges();
    expect(component.loading()).toBe(true);
    expect(tree()).withContext('the tree yields to the spinner on a gesture').toBeNull();

    pending.resolve([]);
    await flushMicrotasks();
    await flushMicrotasks();

    expect(component.loading()).toBe(false);
  });

  // --- AC13: the empty-workspace block becomes reachable ---------------

  it('scenario 117 — a genuinely empty workspace renders the empty-workspace block', async () => {
    workspaceServiceSpy.getWorkspaceTree.and.resolveTo([]);
    await create();
    fixture.detectChanges();

    // Dead code until FR2: `wrapRootTree` always returned a one-element array,
    // so `treeNodes().length === 0` was never true and this block never
    // rendered. It is the third user-visible change in this story.
    expect(component.treeNodes()).toEqual([]);
    const empty = fixture.nativeElement.querySelector(
      '.empty-workspace',
    ) as HTMLElement | null;
    expect(empty).withContext('empty-workspace block').not.toBeNull();
    expect(empty!.textContent).toContain('No files found');
    expect(tree()).withContext('no tree for an empty workspace').toBeNull();
  });
});

// --------------------------------------------------------------------
// The drill-down list and the pinned upload footer (Epic 45 / ADR-033 §D2,
// §D3, §D8).
//
// Its own TestBed and its own factories — the file's convention is per-block
// fixtures, never a helper reached across a `describe` boundary. The widened
// override (`ButtonModule` + `ToolbarModule`) is load-bearing twice over: Up,
// Back and "Upload here" live inside `<ng-template pTemplate="start|end">` and
// only PrimeNG's Toolbar instantiates those, and `[disabled]` has to reach a
// real inner <button> for the run-state assertions. `TooltipModule` stays out,
// so `[pTooltip]` remains an unclaimed binding readable off the p-button host.
//
// Every new control is driven by a REAL DOM event in at least one spec —
// `.directory-entry.click()`, and the inner <button> of Up / Back / the footer.
// A spec that calls the handler on the instance leaves the suite green while
// the binding is deleted and the control is inert in a browser, which is
// already recorded twice as `backlog.md` rows 8 and 18.
// --------------------------------------------------------------------

describe('WorkspaceExplorerComponent — drill-down list and pinned upload (Epic 45)', () => {
  const TEAM_ID = 'proc';
  const STOPPED_TOOLTIP = 'Process must be running to upload files';

  let component: WorkspaceExplorerComponent;
  let fixture: ComponentFixture<WorkspaceExplorerComponent>;
  let workspaceServiceSpy: jasmine.SpyObj<WorkspaceService>;
  let invalidations: FakeWorkspaceInvalidationService;
  let running: BehaviorSubject<boolean>;

  /**
   * The root listing, deliberately INTERLEAVED and not alphabetical: a file,
   * then a folder, then a file, then a folder. Folders-first is a stable
   * PARTITION, so the expected render order is `docs`, `assets`, `b.txt`,
   * `a.txt` — each group keeping the backend's own order. An alphabetical sort
   * anywhere would reorder both groups and fail.
   */
  function rootEntries(): FileNode[] {
    return [
      fileNode({ name: 'b.txt', path: 'b.txt', type: 'file', size: 2048, extension: '.txt' }),
      fileNode({ name: 'docs', path: 'docs', type: 'directory', size: 0 }),
      fileNode({ name: 'a.txt', path: 'a.txt', type: 'file', size: 10, extension: '.txt' }),
      fileNode({ name: 'assets', path: 'assets', type: 'directory', size: 0 }),
    ];
  }

  function docsEntries(): FileNode[] {
    return [
      fileNode({ name: 'a.txt', path: 'docs/a.txt', type: 'file', size: 10, extension: '.txt' }),
      fileNode({ name: 'deep', path: 'docs/deep', type: 'directory', size: 0 }),
    ];
  }

  function deepEntries(): FileNode[] {
    return [
      fileNode({ name: 'a.txt', path: 'docs/deep/a.txt', type: 'file', size: 10, extension: '.txt' }),
    ];
  }

  function nestedFile(): FileNode {
    return fileNode({
      name: 'a.txt',
      path: 'docs/deep/a.txt',
      type: 'file',
      size: 10,
      extension: '.txt',
    });
  }

  /** A listing resolver keyed by path, so a navigation and a root load can differ. */
  function listingsBy(byPath: Record<string, FileNode[]>): void {
    workspaceServiceSpy.getWorkspaceTree.and.callFake(
      async (_team: string, path?: string) => byPath[path ?? ''] ?? [],
    );
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
    running = new BehaviorSubject<boolean>(true);

    await TestBed.configureTestingModule({
      imports: [WorkspaceExplorerComponent, NoopAnimationsModule],
      providers: [
        { provide: WorkspaceService, useValue: workspaceServiceSpy },
        {
          provide: ContextService,
          useValue: {
            currentProcessId$: new BehaviorSubject<string>(TEAM_ID),
            currentTeamRunning$: running,
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
  });

  async function create(): Promise<void> {
    fixture = TestBed.createComponent(WorkspaceExplorerComponent);
    component = fixture.componentInstance;
    await flushRootLoad(fixture);
  }

  /** Push instructions as ONE synchronous delta, then settle the fetches. */
  async function deliver(...batch: WorkspaceInvalidation[]): Promise<void> {
    for (const instruction of batch) {
      invalidations.invalidations$.next(instruction);
    }
    await flushMicrotasks();
    await flushMicrotasks();
    fixture.detectChanges();
  }

  function pane(): HTMLElement {
    return fixture.nativeElement.querySelector('.panel-content') as HTMLElement;
  }

  function listRegion(): HTMLElement | null {
    return pane().querySelector('.directory-list') as HTMLElement | null;
  }

  function footer(): HTMLElement | null {
    return pane().querySelector('.upload-footer') as HTMLElement | null;
  }

  function rowEls(): HTMLButtonElement[] {
    return Array.from(pane().querySelectorAll('.directory-entry'));
  }

  function rowNames(): string[] {
    return rowEls().map((row) =>
      (row.querySelector('.directory-entry-name') as HTMLElement).textContent!.trim(),
    );
  }

  /** A REAL click on a rendered row — never the handler on the instance. */
  async function clickRow(name: string): Promise<void> {
    const row = rowEls().find(
      (el) =>
        (el.querySelector('.directory-entry-name') as HTMLElement).textContent!.trim() ===
        name,
    );
    expect(row).withContext(`list row "${name}" should be rendered`).toBeDefined();
    row!.click();
    await flushMicrotasks();
    fixture.detectChanges();
  }

  function toolbarHost(label: string): UploadControlEl | null {
    return fixture.nativeElement.querySelector(
      `p-toolbar p-button[label="${label}"]`,
    ) as UploadControlEl | null;
  }

  /** A REAL click on the inner <button> PrimeNG renders for a p-button. */
  async function clickToolbar(label: string): Promise<void> {
    const host = toolbarHost(label);
    expect(host).withContext(`toolbar control "${label}" should be rendered`).not.toBeNull();
    (host!.querySelector('button') as HTMLButtonElement).click();
    await flushMicrotasks();
    fixture.detectChanges();
  }

  /**
   * Which of the two navigation verbs is on screen. Deliberately reads ONLY
   * Up/Back: they vary on `openFile()` while the upload control varies on
   * `viewMode()`, and those differ in the 'deleted', 'error' and 'loading'
   * states — so satisfying this through the upload control would be asserting
   * the wrong thing (ADR-033 §D8, story 45-2 AC8).
   */
  function navVerbs(): string[] {
    return ['Up', 'Back'].filter((label) => toolbarHost(label) !== null);
  }

  /**
   * Every LABELLED upload control rendered in the preview panel. The
   * navigator header's upload button is icon-only — it carries no `label`
   * attribute at all — so it is excluded by construction rather than by a
   * hand-maintained blocklist. It is a different column and is not part of
   * this count.
   */
  function labelledUploadControls(): string[] {
    const panel = fixture.nativeElement.querySelector('.preview-panel') as HTMLElement;
    return Array.from(panel.querySelectorAll('p-button[label]'))
      .map((el) => el.getAttribute('label')!)
      .filter((label) => label.toLowerCase().includes('upload'));
  }

  // --- AC1 / AC3.2: the pane lists where it is, from the load it already made ---

  it('scenario 118 — the pane lists the root on entry, folders first, with each group in backend order', async () => {
    workspaceServiceSpy.getWorkspaceTree.and.resolveTo(rootEntries());
    await create();

    // Folders first as a stable PARTITION, not a sort: `docs` before `assets`
    // and `b.txt` before `a.txt` are the backend's order, preserved within each
    // group. Alphabetical sorting anywhere reorders both groups.
    expect(rowNames()).toEqual(['docs', 'assets', 'b.txt', 'a.txt']);
    expect(component.viewMode()).toBe('list');

    // A row reuses what already exists — `getFileIcon` and `formatFileSize`.
    // No second icon map, no second formatter.
    const folderRow = rowEls()[0];
    expect(folderRow.querySelector('.directory-entry-icon')!.className).toContain(
      'pi-folder',
    );
    expect(folderRow.querySelector('.directory-entry-size')).toBeNull();
    const fileRow = rowEls()[2];
    expect(
      fileRow.querySelector('.directory-entry-size')!.textContent!.trim(),
    ).toBe('2 KB');
  });

  it('scenario 119 — startup issues exactly ONE getWorkspaceTree(\'\'): the tree and the list come from it', async () => {
    workspaceServiceSpy.getWorkspaceTree.and.resolveTo(rootEntries());
    await create();

    // The root's tree fetch and its list fetch ARE the same request. A separate
    // `fetchTree('')` for the list would double every root load — including the
    // gesture-less ones — and move counts the rest of this file asserts on.
    expect(workspaceServiceSpy.getWorkspaceTree).toHaveBeenCalledOnceWith('proc', '');
    expect(component.listing()).toEqual({ path: '', entries: rootEntries() });
    expect(component.treeNodes().length).toBe(4);
  });

  // --- AC2: the list shares nothing with the tree but `currentDirectory` ---

  it('scenario 120 — a folder the navigator has NEVER expanded lists when navigated into', async () => {
    listingsBy({ '': rootEntries(), docs: docsEntries() });
    await create();

    // `docs` is materialized in the tree as a LAZY node: children undefined, so
    // `findTreeNodeByPath` finds the node but nothing under it. The list does
    // not consult the tree at all — that is what makes a flat list simpler than
    // the second `p-tree` §A1 rejected.
    expect(component.treeNodes()[1].label).toBe('docs');
    expect(component.treeNodes()[1].children).toBeUndefined();

    await clickRow('docs');

    expect(component.currentDirectory()).toBe('docs');
    expect(rowNames()).toEqual(['deep', 'a.txt']);
    // Still unmaterialized in the tree afterwards: the list took nothing from it
    // and gave nothing back.
    expect(component.treeNodes()[1].children).toBeUndefined();
  });

  // --- AC3.1: a background root load cannot repaint the user's directory ---

  it('scenario 121 — a background root load with the user deep in a subdirectory writes NO listing', async () => {
    listingsBy({ '': rootEntries(), 'docs/deep': deepEntries() });
    await create();

    await component.onNodeSelect({
      node: { data: fileNode({ name: 'deep', path: 'docs/deep', type: 'directory' }) },
    });
    await flushMicrotasks();
    fixture.detectChanges();
    expect(component.listing()).toEqual({ path: 'docs/deep', entries: deepEntries() });

    // An agent writes a file: a whole-tree instruction routes to `refresh(true)`,
    // whose sink is `applyRootLoad` — and, now, `applyRootListing` beside it.
    workspaceServiceSpy.getWorkspaceTree.and.resolveTo([
      fileNode({ name: 'other', path: 'other', type: 'directory' }),
    ]);
    await deliver(invalidation({ workspaceId: TEAM_ID, wholeTree: true }));

    // The TREE was replaced. The user's list was not: an applier without the
    // `currentDirectory() === ''` guard repaints `docs/deep` with the root's
    // entries, which is the same "an agent moved me" surprise `applyRootLoad`
    // already refuses for `currentDirectory` itself.
    expect(component.treeNodes()[0].label).toBe('other');
    expect(component.listing()).toEqual({ path: 'docs/deep', entries: deepEntries() });
    expect(rowNames()).toEqual(['a.txt']);
  });

  // --- AC4: a superseded listing is discarded, by path ------------------

  it('scenario 122 — a listing that resolves after the user has moved on is discarded, by path', async () => {
    listingsBy({ '': rootEntries() });
    await create();

    // Navigate into `docs`, whose listing resolves LATE.
    const slow = deferred<FileNode[]>();
    workspaceServiceSpy.getWorkspaceTree.and.returnValue(slow.promise);
    await clickRow('docs');
    expect(component.currentDirectory()).toBe('docs');

    // ...and on into `assets` from the navigator before `docs` resolves. The
    // point is only that the pane has moved on while a listing is in flight.
    workspaceServiceSpy.getWorkspaceTree.and.resolveTo([
      fileNode({ name: 'logo.png', path: 'assets/logo.png', type: 'file', size: 4 }),
    ]);
    await component.onNodeSelect({
      node: { data: fileNode({ name: 'assets', path: 'assets', type: 'directory' }) },
    });
    await flushMicrotasks();
    fixture.detectChanges();
    expect(component.listing()).toEqual({
      path: 'assets',
      entries: [
        fileNode({ name: 'logo.png', path: 'assets/logo.png', type: 'file', size: 4 }),
      ],
    });

    slow.resolve(docsEntries());
    await flushMicrotasks();
    fixture.detectChanges();

    // `applyFileContent`'s rule, applied to the list: without it `docs`'s
    // entries render under `assets`'s name — a listing and the directory it
    // describes disagreeing, which the path tag exists to prevent.
    expect(component.currentDirectory()).toBe('assets');
    expect(component.listing()!.path).toBe('assets');
    expect(rowNames()).toEqual(['logo.png']);
  });

  // --- AC5 / AC6: three verbs, one place --------------------------------

  it('scenario 123 — a folder click descends and clears the open file, from the list AND from the navigator', async () => {
    listingsBy({ '': rootEntries(), docs: docsEntries(), assets: [] });
    await create();

    // Seed an open file so the descent's clears are observable.
    component.openFile.set(nestedFile());
    component.content.set({ kind: 'text', body: 'stale' });
    component.fileError.set('stale failure');
    fixture.detectChanges();

    // Entry point 1 — the NAVIGATOR.
    await component.onNodeSelect({
      node: { data: fileNode({ name: 'docs', path: 'docs', type: 'directory' }) },
    });
    await flushMicrotasks();
    fixture.detectChanges();

    expect(component.currentDirectory()).toBe('docs');
    expect(component.openFile()).toBeNull();
    expect(component.content()).toBeNull();
    // Without the `fileError` clear the pane returns `viewMode === 'error'` and
    // the navigation appears to do nothing — a file-scoped banner has nothing
    // left to describe once its file is closed.
    expect(component.fileError()).toBeNull();
    expect(component.viewMode()).toBe('list');
    expect(rowNames()).toEqual(['deep', 'a.txt']);

    // Entry point 2 — the LIST, through a real DOM click. Both doorways go
    // through the one descent method: two copies of the rule is how the panel
    // and the pane end up pointing at different places (§D3).
    await clickRow('deep');
    expect(component.currentDirectory()).toBe('docs/deep');
    expect(component.openFile()).toBeNull();
  });

  it('scenario 124 — Up ascends through the DOM and is disabled at the root', async () => {
    listingsBy({ '': rootEntries(), docs: docsEntries(), 'docs/deep': deepEntries() });
    await create();

    // At the root Up is rendered and DISABLED — there is nowhere above `''`.
    const atRoot = toolbarHost('Up')!;
    expect((atRoot.querySelector('button') as HTMLButtonElement).disabled).toBe(true);

    await clickRow('docs');
    await clickRow('deep');
    expect(component.currentDirectory()).toBe('docs/deep');

    const inDeep = toolbarHost('Up')!;
    expect((inDeep.querySelector('button') as HTMLButtonElement).disabled).toBe(false);

    await clickToolbar('Up');
    expect(component.currentDirectory()).toBe('docs');
    expect(rowNames()).toEqual(['deep', 'a.txt']);

    await clickToolbar('Up');
    expect(component.currentDirectory()).toBe('');
    expect(rowNames()).toEqual(['docs', 'assets', 'b.txt', 'a.txt']);
    expect(
      (toolbarHost('Up')!.querySelector('button') as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('scenario 125 — Back closes the file, leaves currentDirectory, and re-lists nothing it already has', async () => {
    listingsBy({ '': rootEntries(), docs: docsEntries() });
    await create();
    await clickRow('docs');

    // Open a file IN the directory the pane is already showing.
    await clickRow('a.txt');
    expect(component.openFile()!.path).toBe('docs/a.txt');
    expect(component.currentDirectory()).toBe('docs');

    const listings = workspaceServiceSpy.getWorkspaceTree.calls.count();
    await clickToolbar('Back');

    expect(component.openFile()).toBeNull();
    expect(component.content()).toBeNull();
    // Back stays put — that is the whole distinction from Up.
    expect(component.currentDirectory()).toBe('docs');
    expect(rowNames()).toEqual(['deep', 'a.txt']);
    // ...and costs no request, because the entries already describe `docs`.
    expect(workspaceServiceSpy.getWorkspaceTree.calls.count()).toBe(listings);
  });

  it('scenario 126 — exactly one of Up / Back is rendered in every reachable state', async () => {
    listingsBy({ '': rootEntries(), docs: docsEntries() });
    await create();

    // 1. the list, at the root
    expect(navVerbs()).toEqual(['Up']);

    // 2. the list, in a subdirectory
    await clickRow('docs');
    expect(navVerbs()).toEqual(['Up']);

    // 3. a file open with its body rendered
    await clickRow('a.txt');
    expect(component.viewMode()).toBe('text');
    expect(navVerbs()).toEqual(['Back']);

    // 4. a read in flight — Back keys on `openFile()`, not on `viewMode()`
    component.loadingContent.set(true);
    fixture.detectChanges();
    expect(component.viewMode()).toBe('loading');
    expect(navVerbs()).toEqual(['Back']);
    component.loadingContent.set(false);

    // 5. a failure with nothing to fall back on
    component.content.set(null);
    component.fileError.set('403 Forbidden');
    fixture.detectChanges();
    expect(component.viewMode()).toBe('error');
    expect(navVerbs()).toEqual(['Back']);

    // 6. the deleted-file notice, which clears `openFile`
    component.fileError.set(null);
    component.openFile.set(null);
    component.deletedNotice.set('docs/a.txt');
    fixture.detectChanges();
    expect(component.viewMode()).toBe('deleted');
    expect(navVerbs()).toEqual(['Up']);
  });

  it("scenario 127 — Back from a file opened in the NAVIGATOR lands in that file's directory and lists it", async () => {
    listingsBy({ '': rootEntries(), 'docs/deep': deepEntries() });
    await create();
    expect(component.currentDirectory()).toBe('');

    // Opened from the tree, three levels down, while the pane is at the root.
    await component.onNodeSelect({ node: { data: nestedFile() } });
    fixture.detectChanges();

    // §D3 as amended: opening a file MOVES the pane to that file's directory,
    // which is what makes "Back stays put" and "Back from a nested file lands
    // in that file's directory" the same sentence. No listing is fetched here.
    expect(component.currentDirectory()).toBe('docs/deep');
    expect(component.listing()!.path).toBe('');

    await clickToolbar('Back');

    // Not the root — the directory the file came from, listed.
    expect(component.currentDirectory()).toBe('docs/deep');
    expect(component.openFile()).toBeNull();
    expect(rowNames()).toEqual(['a.txt']);
    expect(workspaceServiceSpy.getWorkspaceTree).toHaveBeenCalledWith('proc', 'docs/deep');
  });

  // --- AC7 / AC8: one upload affordance, pinned outside the scroll ------

  it('scenario 128 — the footer sits OUTSIDE the scrolling list region, gated and tooltipped', async () => {
    running.next(false);
    workspaceServiceSpy.getWorkspaceTree.and.resolveTo(rootEntries());
    await create();

    const list = listRegion();
    const foot = footer();
    expect(list).withContext('the scrolling list region').not.toBeNull();
    expect(foot).withContext('the pinned upload footer').not.toBeNull();

    // The structural relationship, not a pixel: the SCSS is invisible to Karma,
    // so containment is the only thing that can be pinned. A footer inside the
    // scrolling region scrolls away on a long listing — the exact failure the
    // pinning exists to prevent.
    expect(list!.contains(foot!))
      .withContext('the footer must not be a descendant of the scrolling region')
      .toBe(false);
    expect(foot!.parentElement).toBe(pane());
    expect(list!.parentElement).toBe(pane());

    // The run-state gate and its tooltip, verbatim.
    const control = foot!.querySelector('p-button[label="Upload to Root"]') as UploadControlEl;
    expect(control).not.toBeNull();
    expect((control.querySelector('button') as HTMLButtonElement).disabled).toBe(true);
    expect(control.pTooltip).toBe(STOPPED_TOOLTIP);

    running.next(true);
    fixture.detectChanges();
    expect((control.querySelector('button') as HTMLButtonElement).disabled).toBe(false);

    // And it actually uploads: a REAL click on the rendered control.
    (control.querySelector('button') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(component.uploadModalVisible).toBe(true);
    expect(component.uploadTargetPath).toBe('');
  });

  it('scenario 129 — exactly ONE labelled upload control is rendered in each view', async () => {
    listingsBy({ '': rootEntries(), docs: docsEntries() });
    await create();

    // The list, at the root: the footer, and only the footer.
    expect(labelledUploadControls()).toEqual(['Upload to Root']);

    // The list, in a subdirectory: still one. This is the case that catches
    // "Upload here" back on its old `!openFile() && currentDirectory() !== ''`
    // condition — two identical affordances ~200px apart in the same view.
    await clickRow('docs');
    expect(labelledUploadControls()).toEqual(['Upload Files']);

    // A file open: no footer, and "Upload here" doing the job — which after
    // §D3's file-open rule already targets the file's own directory.
    await clickRow('a.txt');
    expect(labelledUploadControls()).toEqual(['Upload here']);

    (toolbarHost('Upload here')!.querySelector('button') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(component.uploadTargetPath).toBe('docs');
  });

  // --- AC9: an empty folder, and a listing that does not describe the pane ---

  it('scenario 130 — an empty folder renders the empty-directory element and the footer, not an empty shell', async () => {
    listingsBy({ '': rootEntries(), assets: [] });
    await create();

    await clickRow('assets');

    expect(rowEls().length).toBe(0);
    const empty = pane().querySelector('.empty-directory') as HTMLElement | null;
    expect(empty).withContext('an explicit empty-directory element').not.toBeNull();
    expect(empty!.textContent).toContain('This folder is empty');
    expect(footer()!.querySelector('p-button[label="Upload Files"]')).not.toBeNull();
  });

  it('scenario 131 — a listing that does not describe the pane renders neither entries nor the empty-state', async () => {
    listingsBy({ '': rootEntries() });
    await create();
    expect(rowNames()).toEqual(['docs', 'assets', 'b.txt', 'a.txt']);

    const pending = deferred<FileNode[]>();
    workspaceServiceSpy.getWorkspaceTree.and.returnValue(pending.promise);
    await clickRow('docs');

    // IN FLIGHT. The root's entries are still in `listing`, and they must not
    // render under `docs` — nor may the empty-state flash, which is what an
    // implementation with a `listingLoading` flag gets wrong on the frame
    // between the navigation and the flag being raised. The path tag answers
    // both with one comparison and no flag.
    expect(component.currentDirectory()).toBe('docs');
    expect(component.listing()!.path).toBe('');
    expect(rowEls().length).toBe(0);
    expect(pane().querySelector('.empty-directory')).toBeNull();
    expect(footer()).withContext('the footer still renders').not.toBeNull();

    pending.resolve(docsEntries());
    await flushMicrotasks();
    fixture.detectChanges();
    expect(rowNames()).toEqual(['deep', 'a.txt']);
  });

  // --- AC10: the directory on screen stays current, at zero extra cost ---

  it('scenario 132 — an invalidation naming the current directory updates the list with no extra call', async () => {
    listingsBy({ '': rootEntries(), docs: docsEntries() });
    await create();
    await clickRow('docs');
    expect(rowNames()).toEqual(['deep', 'a.txt']);

    workspaceServiceSpy.getWorkspaceTree.calls.reset();
    workspaceServiceSpy.getWorkspaceTree.and.resolveTo([
      ...docsEntries(),
      fileNode({ name: 'new.txt', path: 'docs/new.txt', type: 'file', size: 3, extension: '.txt' }),
    ]);

    await deliver(invalidation({ workspaceId: TEAM_ID, directories: ['docs'] }));

    // The listing `refreshDirectory` already fetched is reused — this AC issues
    // no fetch of its own, so the directory pass costs exactly what it did
    // before this story.
    expect(rowNames()).toEqual(['deep', 'a.txt', 'new.txt']);
    expect(workspaceServiceSpy.getWorkspaceTree).toHaveBeenCalledOnceWith('proc', 'docs');
  });
});
