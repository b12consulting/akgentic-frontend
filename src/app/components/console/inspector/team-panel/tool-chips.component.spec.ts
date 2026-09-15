import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ToolChipsComponent } from './tool-chips.component';
import {
  provideTranslateTesting,
  setTestTranslations,
} from '../../../../../testing/i18n-testing';

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

  it('gives every chip its tool mark', () => {
    render(['A', 'B']);

    expect(
      (fixture.nativeElement as HTMLElement).querySelectorAll('.tool-chip-dot')
        .length,
    ).toBe(2);
  });
});
