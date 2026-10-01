import { AUTO_SCROLLING_KEY, TranscriptScroll } from './transcript-scroll';

/**
 * The scroll model's rules that do not need the panel: echo detection against
 * the send baseline, the jump-to-latest and manual-scroll cancellations, and
 * the re-pin on a moved anchor. A real DOM, positioned like `.chat-container`.
 */
describe('TranscriptScroll', () => {
  let root: HTMLElement;
  let container: HTMLElement;
  let spacer: HTMLElement;
  let scroll: TranscriptScroll;

  function bubble(id: string, height = 60): HTMLElement {
    const el = document.createElement('div');
    el.setAttribute('data-message-id', id);
    el.style.height = `${height}px`;
    container.insertBefore(el, spacer);
    return el;
  }

  beforeEach(() => {
    spyOn(window, 'matchMedia').and.returnValue({ matches: true } as MediaQueryList);
    root = document.createElement('div');
    root.style.position = 'relative';
    container = document.createElement('div');
    container.style.height = '300px';
    container.style.overflowY = 'auto';
    spacer = document.createElement('div');
    container.appendChild(spacer);
    root.appendChild(container);
    document.body.appendChild(root);
    scroll = new TranscriptScroll({
      container: () => container,
      spacer: () => spacer,
      teamRunning: () => true,
    });
  });

  afterEach(() => root.remove());

  function pinnedOffset(id: string): number {
    const el = container.querySelector<HTMLElement>(`[data-message-id="${id}"]`)!;
    return el.offsetTop - container.offsetTop - container.scrollTop;
  }

  it('anchors the echo, not the message of yours that was already there', () => {
    for (let i = 0; i < 6; i++) bubble('a' + i);
    const scrollTo = spyOn(container, 'scrollTo').and.callThrough();
    scroll.armOnSend('a5');
    scroll.onEmission('a5', 6);
    scroll.afterViewChecked();
    expect(scrollTo).not.toHaveBeenCalled();

    bubble('echo');
    scroll.onEmission('echo', 7);
    scroll.afterViewChecked();
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(pinnedOffset('echo')).toBe(TranscriptScroll.TOP_PAD);
  });

  it('re-pins when the anchor is re-created elsewhere, then only resizes', () => {
    for (let i = 0; i < 6; i++) bubble('a' + i);
    scroll.armOnSend(null);
    const first = bubble('echo');
    scroll.onEmission('echo', 7);
    scroll.afterViewChecked();

    // The bubble moves: destroyed, and re-created with more content above it.
    first.remove();
    bubble('above', 90);
    bubble('echo');
    scroll.afterViewChecked();
    expect(pinnedOffset('echo')).toBe(TranscriptScroll.TOP_PAD);

    const scrollTo = spyOn(container, 'scrollTo').and.callThrough();
    scroll.afterViewChecked();
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('jump-to-latest follows and cancels the anchor', () => {
    for (let i = 0; i < 6; i++) bubble('a' + i);
    scroll.armOnSend(null);
    bubble('echo');
    scroll.onEmission('echo', 7);
    scroll.jumpToLatest();
    expect(scroll.indicatorLabel).toBe(AUTO_SCROLLING_KEY);
    expect(scroll.indicatorIcon).toBe('pi-sync');

    const scrollTo = spyOn(container, 'scrollTo').and.callThrough();
    bubble('above', 90);
    scroll.afterViewChecked();
    // Following scrolls to the bottom; it never pins the old anchor.
    const tops = scrollTo.calls.allArgs().map(([opts]) => (opts as ScrollToOptions).top);
    expect(tops).toEqual([container.scrollHeight]);
  });

  it('a manual scroll above the pinned position cancels the anchor', () => {
    for (let i = 0; i < 8; i++) bubble('a' + i);
    scroll.armOnSend(null);
    bubble('echo');
    scroll.onEmission('echo', 9);
    scroll.afterViewChecked();
    scroll.onScroll();

    container.scrollTop = 0;
    scroll.onScroll();

    const scrollTo = spyOn(container, 'scrollTo').and.callThrough();
    container.insertBefore(document.createElement('div'), container.firstChild).style.height =
      '40px';
    scroll.afterViewChecked();
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
