import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { provideMarkdown } from 'ngx-markdown';

import en from '../../../../platform/i18n/locales/en.json';
import { MANAGER, SUPPORT, at } from '../../../../../../testing/run-log-builders';
import {
  provideTranslateTesting,
  setTestTranslations,
} from '../../../../../../testing/i18n-testing';
import { RunMessage } from '../../../../services/process/selectors/run-graph.selector';
import { SeatAnswer, SeatAnswerDialogComponent } from './seat-answer-dialog.component';

const QUESTION: RunMessage = {
  id: 'S',
  sender: MANAGER,
  recipient: SUPPORT,
  parent_id: 'U1',
  timestamp: at(4),
  content: 'Can we **refund** this order?',
  absorbed_by: null,
};

describe('SeatAnswerDialogComponent', () => {
  let fixture: ComponentFixture<SeatAnswerDialogComponent>;
  let sent: SeatAnswer[];
  let visibility: boolean[];

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SeatAnswerDialogComponent, NoopAnimationsModule],
      providers: [provideMarkdown(), provideTranslateTesting()],
    }).compileComponents();
    setTestTranslations(en);
    fixture = TestBed.createComponent(SeatAnswerDialogComponent);
    sent = [];
    visibility = [];
    fixture.componentInstance.send.subscribe((a) => sent.push(a));
    fixture.componentInstance.visibleChange.subscribe((v) => visibility.push(v));
  });

  afterEach(() => {
    fixture.componentRef.setInput('visible', false);
    fixture.detectChanges();
  });

  async function open(): Promise<void> {
    fixture.componentRef.setInput('seat', SUPPORT);
    fixture.componentRef.setInput('question', QUESTION);
    fixture.componentRef.setInput('visible', true);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function dialog(): HTMLElement {
    const el = document.querySelector<HTMLElement>('.p-dialog');
    if (el === null) throw new Error('no dialog');
    return el;
  }

  function text(node: Element | null): string {
    return (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
  }

  async function type(value: string): Promise<void> {
    const area = dialog().querySelector<HTMLTextAreaElement>('textarea')!;
    area.value = value;
    area.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function sendButton(): HTMLButtonElement {
    return dialog().querySelector<HTMLButtonElement>('.seat-send')!;
  }

  it('heads "Answer as @X" and shows the asker, the send time and the question', async () => {
    await open();
    expect(text(dialog().querySelector('.p-dialog-title'))).toBe('Answer as @Support');
    const time = new Date(at(4)).toTimeString().slice(0, 5);
    expect(text(dialog().querySelector('.seat-asked'))).toBe(`@Manager asked at ${time}`);
    expect(dialog().querySelector('.seat-question-content strong')?.textContent).toBe('refund');
  });

  it('Send answer emits the trimmed text keyed by the question\'s inner id, then closes', async () => {
    await open();
    await type('  yes, refund it  ');
    sendButton().click();
    expect(sent).toEqual([{ content: 'yes, refund it', messageId: 'S' }]);
    expect(visibility).toEqual([false]);
    expect(fixture.componentInstance.draft).toBe('');
  });

  it('an empty or whitespace-only answer sends nothing, by click or Ctrl/⌘+Enter', async () => {
    await open();
    await type('   ');
    expect(sendButton().disabled).toBeTrue();
    sendButton().click();
    const area = dialog().querySelector<HTMLTextAreaElement>('textarea')!;
    area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true }));
    area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true }));
    expect(sent).toEqual([]);
    expect(visibility).toEqual([]);
  });

  it('Ctrl+Enter sends a non-empty answer', async () => {
    await open();
    await type('yes');
    const area = dialog().querySelector<HTMLTextAreaElement>('textarea')!;
    area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true }));
    expect(sent).toEqual([{ content: 'yes', messageId: 'S' }]);
  });

  it('Cancel closes without sending and clears the draft', async () => {
    await open();
    await type('draft');
    dialog().querySelector<HTMLButtonElement>('.seat-cancel')!.click();
    expect(sent).toEqual([]);
    expect(visibility).toEqual([false]);
    expect(fixture.componentInstance.draft).toBe('');
  });

  it('the close button closes without sending', async () => {
    await open();
    await type('draft');
    dialog().querySelector<HTMLButtonElement>('.p-dialog-close-button')!.click();
    expect(sent).toEqual([]);
    expect(visibility).toEqual([false]);
    expect(fixture.componentInstance.draft).toBe('');
  });

  it('a click on the scrim closes without sending', async () => {
    await open();
    await type('draft');
    const mask = document.querySelector<HTMLElement>('.p-dialog-mask')!;
    mask.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(sent).toEqual([]);
    expect(visibility).toEqual([false]);
  });

  it('Escape closes without sending', async () => {
    await open();
    await type('draft');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(sent).toEqual([]);
    expect(visibility).toEqual([false]);
  });
});
