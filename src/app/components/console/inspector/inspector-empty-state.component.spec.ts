import { ComponentFixture, TestBed } from '@angular/core/testing';

import { InspectorEmptyStateComponent } from './inspector-empty-state.component';
import {
  provideTranslateTesting,
  setTestTranslations,
} from '../../../../testing/i18n-testing';

/**
 * The shared empty state.
 *
 * Two things are worth pinning: that the copy arrives through the translation
 * layer rather than as literals, and that an absent blurb removes the ELEMENT.
 * The second one is the defect this component was written to avoid — the mock
 * empties the text of an optional line and leaves the node, so the gap it sat
 * in stays behind as a hole.
 */
describe('InspectorEmptyStateComponent', () => {
  let fixture: ComponentFixture<InspectorEmptyStateComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [InspectorEmptyStateComponent],
      providers: [provideTranslateTesting()],
    }).compileComponents();

    fixture = TestBed.createComponent(InspectorEmptyStateComponent);
  });

  function host(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  it('renders the title through the translation layer, not as a literal', () => {
    // Synthetic templates: asserting the shipped English would pin the copy,
    // which is the thing the key indirection exists to prevent.
    setTestTranslations({
      panels: { noAgentsTitle: '<<title>>', noAgentsDesc: '<<blurb>>' },
    });
    fixture.componentRef.setInput('titleKey', 'panels.noAgentsTitle');
    fixture.detectChanges();

    expect(host().querySelector('.empty-title')?.textContent?.trim()).toBe(
      '<<title>>',
    );
  });

  it('omits the blurb ELEMENT when no blurb key is given', () => {
    fixture.componentRef.setInput('titleKey', 'panels.noAgentsTitle');
    fixture.detectChanges();

    // Not "renders empty" — absent. An empty node keeps its margin.
    expect(host().querySelector('.empty-blurb')).toBeNull();
  });

  it('renders the blurb when a key is given', () => {
    setTestTranslations({
      panels: { noAgentsTitle: '<<title>>', noAgentsDesc: '<<blurb>>' },
    });
    fixture.componentRef.setInput('titleKey', 'panels.noAgentsTitle');
    fixture.componentRef.setInput('blurbKey', 'panels.noAgentsDesc');
    fixture.detectChanges();

    expect(host().querySelector('.empty-blurb')?.textContent?.trim()).toBe(
      '<<blurb>>',
    );
  });

  it('hides the glyph from assistive technology, because the sentence is the message', () => {
    fixture.componentRef.setInput('titleKey', 'panels.noAgentsTitle');
    fixture.detectChanges();

    const glyph = host().querySelector('.empty-glyph');
    expect(glyph).not.toBeNull();
    expect(glyph?.getAttribute('aria-hidden')).toBe('true');
  });
});
