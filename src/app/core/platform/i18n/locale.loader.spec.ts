import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';

import { LOCALE_ASSET_PREFIX, LocaleAssetLoader } from './locale.loader';

describe('LocaleAssetLoader', () => {
  let loader: LocaleAssetLoader;
  let fetchSpy: jasmine.Spy;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    loader = TestBed.inject(LocaleAssetLoader);
    fetchSpy = spyOn(window, 'fetch');
  });

  function respond(body: unknown, ok = true): void {
    fetchSpy.and.resolveTo({
      ok,
      json: () => Promise.resolve(body),
    } as Response);
  }

  it('asks for the language file next to the document base href', async () => {
    respond({});

    await firstValueFrom(loader.getTranslation('fr'));

    const requested = new URL(fetchSpy.calls.mostRecent().args[0] as string);
    expect(requested.href).toBe(new URL(`${LOCALE_ASSET_PREFIX}fr.json`, document.baseURI).href);
  });

  it('returns the dictionary a locale file resolves to', async () => {
    respond({ common: { save: 'Enregistrer' } });

    const dictionary: unknown = await firstValueFrom(loader.getTranslation('fr'));

    expect(dictionary).toEqual({ common: { save: 'Enregistrer' } });
  });

  // The three degradations below all resolve to {} rather than rejecting. That
  // is what keeps a missing or broken locale file a cosmetic problem: the
  // fallback language still resolves every key, and the app initializer that
  // awaits this never sees a rejection.

  it('resolves to an empty dictionary when the locale file is absent', async () => {
    respond({}, false);

    const dictionary: unknown = await firstValueFrom(loader.getTranslation('fr'));

    expect(dictionary).toEqual({});
  });

  it('resolves to an empty dictionary when the request itself fails', async () => {
    fetchSpy.and.rejectWith(new TypeError('network down'));

    const dictionary: unknown = await firstValueFrom(loader.getTranslation('fr'));

    expect(dictionary).toEqual({});
  });

  it('resolves to an empty dictionary when the locale file is not a JSON object', async () => {
    respond(['not', 'a', 'dictionary']);

    const dictionary: unknown = await firstValueFrom(loader.getTranslation('fr'));

    expect(dictionary).toEqual({});
  });
});
