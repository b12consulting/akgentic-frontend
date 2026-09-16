import { MarkedOptions, MarkedRenderer } from 'ngx-markdown';

/**
 * The app's markdown rendering options, at the composition root.
 *
 * It lived in `shared/util/util.ts`, which is declared PURE — and an
 * `ngx-markdown` import was the one edge contradicting that. Every other
 * importer of that file takes only `makeAgentNameUserFriendly`; this factory's
 * sole caller in the repository is `app.config.ts`, one file away.
 *
 * So it lands beside `app.theme.ts` rather than being parameterised. Both are
 * the same species of file — third-party UI configuration that the composition
 * root supplies — and the root already names this library, so nothing new
 * crosses a boundary here. Inverting it instead (the caller supplies the
 * renderer) would leave a factory in `shared/` whose only argument is always the
 * same object, constructed by its only caller: more moving parts, the same
 * import count, no gain.
 */

// Open Markdown links in new tab.
export const markedOptionsFactory = (): MarkedOptions => {
  const renderer = new MarkedRenderer();

  renderer.link = ({ href, text }): string => {
    return `<a target="_blank" href="${href}">${text}</a>`;
  };

  return {
    renderer: renderer,
    gfm: true,
    breaks: true,
    pedantic: false,
  };
};
