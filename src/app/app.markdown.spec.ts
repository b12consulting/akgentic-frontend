import { MarkedRenderer } from 'ngx-markdown';

import { markedOptionsFactory } from './app.markdown';

/**
 * The renderer's first spec. It had none for as long as it lived in
 * `shared/util/util.ts`, which is part of why nothing noticed that the file it
 * sat in was the one edge contradicting that tier's declared purity.
 *
 * What is pinned is the BEHAVIOUR the override exists for — a markdown link
 * opens in a new tab — rather than the exact string it builds, which is the
 * renderer's own business and would pin a template instead of a promise.
 */
describe('the markdown options', () => {
  /** `renderer.link` takes a full marked `Tokens.Link`; only these two fields
   *  are read, so the cast is narrowing the call site rather than the type. */
  function renderLink(href: string, text: string): string {
    const renderer = markedOptionsFactory().renderer as MarkedRenderer;
    return renderer.link({ href, text } as Parameters<MarkedRenderer['link']>[0]);
  }

  it('opens a link in a new tab', () => {
    // THE WHOLE REASON THE OVERRIDE EXISTS. Without it marked emits a plain
    // anchor and a link in a chat message navigates the console away from the
    // team the user is watching.
    expect(renderLink('https://example.com', 'docs')).toContain('target="_blank"');
  });

  it('keeps the href and the text it was given', () => {
    const html = renderLink('https://example.com/a?b=1', 'the docs');
    expect(html).toContain('https://example.com/a?b=1');
    expect(html).toContain('the docs');
  });

  it('renders an anchor', () => {
    expect(renderLink('https://example.com', 'docs')).toMatch(/^<a\b.*<\/a>$/);
  });

  it('carries the three flags the app renders markdown under', () => {
    const options = markedOptionsFactory();
    expect(options.gfm).toBeTrue();
    expect(options.breaks).toBeTrue();
    expect(options.pedantic).toBeFalse();
  });
});
