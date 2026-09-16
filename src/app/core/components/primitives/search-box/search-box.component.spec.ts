import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';

import { provideTranslateTesting } from '../../../../../testing/i18n-testing';
import { SearchBoxComponent } from './search-box.component';

describe('SearchBoxComponent', () => {
  let fixture: ComponentFixture<SearchBoxComponent>;
  let component: SearchBoxComponent;

  const input = (): HTMLInputElement =>
    fixture.debugElement.query(By.css('input')).nativeElement as HTMLInputElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SearchBoxComponent],
      providers: [provideTranslateTesting()],
    }).compileComponents();

    fixture = TestBed.createComponent(SearchBoxComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('renders the input with the value it was given', () => {
    // `setInput`, not a field write: this OnPush component is the fixture's
    // ROOT, so a plain assignment leaves the view clean and repaints nothing.
    fixture.componentRef.setInput('value', 'payroll');
    fixture.detectChanges();
    expect(input().value).toBe('payroll');
  });

  it('labels and prompts from the SAME key, so the two can never drift', () => {
    // The no-op loader echoes the key back, which is exactly what is asserted.
    expect(input().getAttribute('aria-label')).toBe('rail.search');
    expect(input().getAttribute('placeholder')).toBe('rail.search');
  });

  it('emits every keystroke untrimmed — the trim belongs to the matcher', () => {
    const seen: string[] = [];
    component.valueChange.subscribe((v) => seen.push(v));

    input().value = ' al';
    input().dispatchEvent(new Event('input'));
    input().value = ' alpha';
    input().dispatchEvent(new Event('input'));

    expect(seen).toEqual([' al', ' alpha']);
  });

  it('does not write its own input — the parent owns the value', () => {
    // One-way in: typing without the parent echoing the value back must leave
    // `value` alone, or the component and its owner hold two truths.
    input().value = 'typed';
    input().dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(component.value).toBe('');
  });

  it('carries the focus ring on the FIELD, not on the bare input', () => {
    // The mock removes the outline and replaces it with nothing. The ring is a
    // token on the well so a keyboard user can see the whole control.
    const field = fixture.debugElement.query(By.css('.rail-search__field'));
    expect(field).not.toBeNull();
    expect(field.nativeElement.contains(input())).toBeTrue();
  });
});
