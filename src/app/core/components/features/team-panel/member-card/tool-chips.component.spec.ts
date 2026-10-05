import { ComponentFixture, TestBed } from '@angular/core/testing';

import { shortToolName, ToolChipsComponent } from './tool-chips.component';
import {
  provideTranslateTesting,
  setTestTranslations,
} from '../../../../../../testing/i18n-testing';

/**
 * The tools section.
 *
 * Two behaviours carry it: one chip per tool, and NOTHING at all when the team
 * has none — header included. A stranded header is the failure mode this
 * component is shaped to avoid.
 */
describe('ToolChipsComponent', () => {
  let fixture: ComponentFixture<ToolChipsComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ToolChipsComponent],
      providers: [provideTranslateTesting()],
    }).compileComponents();

    fixture = TestBed.createComponent(ToolChipsComponent);
  });

  function render(tools: readonly string[]): void {
    fixture.componentRef.setInput('tools', tools);
    fixture.detectChanges();
  }

  function chipTexts(): string[] {
    return Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('.tool-chip'),
    ).map((chip) => (chip.textContent ?? '').trim());
  }

  it('renders one chip per tool, in the order it was given', () => {
    // Order is the selector's first-seen order; re-sorting here would make the
    // chip row shuffle as tools start.
    render(['KnowledgeGraphTool', 'VectorStore']);

    expect(chipTexts()).toEqual(['KnowledgeGraphTool', 'VectorStore']);
  });

  it('renders the section header through the translation layer', () => {
    setTestTranslations({ inspector: { tools: '<<tools>>' } });
    render(['KnowledgeGraphTool']);

    expect(
      (fixture.nativeElement as HTMLElement)
        .querySelector('.tools-label')
        ?.textContent?.trim(),
    ).toBe('<<tools>>');
  });

  it('renders nothing — header included — when the team has no tools', () => {
    render([]);

    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('.tools-label')).toBeNull();
    expect(host.querySelector('.tool-chips')).toBeNull();
  });

  describe('a workspace named by a UUID', () => {
    const FULL = 'Workspace/fb7f2dda-68a6-4e1f-b2c7-f96c258b19b8';

    it('shortToolName keeps the first UUID segment', () => {
      expect(shortToolName(FULL)).toBe('Workspace/fb7f2dda');
    });

    it('shortToolName leaves a suffix that is not a UUID alone', () => {
      expect(shortToolName('Workspace/folder-Documents')).toBe('Workspace/folder-Documents');
      expect(shortToolName('Workspace/fb7f2dda-68a6')).toBe('Workspace/fb7f2dda-68a6');
    });

    it('shortToolName leaves a name without a slash alone', () => {
      expect(shortToolName('KnowledgeGraphTool')).toBe('KnowledgeGraphTool');
    });

    it('the chip shows the short name and carries the full one as its title', () => {
      render([FULL, 'VectorStore']);
      expect(chipTexts()).toEqual(['Workspace/fb7f2dda', 'VectorStore']);
      const chips = (fixture.nativeElement as HTMLElement).querySelectorAll('.tool-chip');
      expect(chips[0].getAttribute('title')).toBe(FULL);
      expect(chips[1].getAttribute('title')).toBeNull();
    });
  });

  it('gives every chip its tool mark', () => {
    render(['A', 'B']);

    expect(
      (fixture.nativeElement as HTMLElement).querySelectorAll('.tool-chip-dot')
        .length,
    ).toBe(2);
  });
});
