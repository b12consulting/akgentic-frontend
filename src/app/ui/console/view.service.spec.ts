import { TestBed } from '@angular/core/testing';

import { ConfigService } from '../../core/platform/config/config.service';
import { ViewService } from './view.service';

/**
 * Epic 56 — the two collapse states.
 *
 * Worth a spec despite being four lines of code, for two reasons that are not
 * about the toggling: the panes must be INDEPENDENT (the reason there are two
 * subjects rather than one object), and each must be SEEDED from the
 * deployment's config rather than from a literal — which is exactly the kind of
 * wiring that is easy to add for one pane and forget for the other.
 */
describe('ViewService (Epic 56)', () => {
  function make(config: Partial<ConfigService>): ViewService {
    TestBed.configureTestingModule({
      providers: [{ provide: ConfigService, useValue: config }],
    });
    return TestBed.inject(ViewService);
  }

  it('seeds both panes from the deployment config, not from a literal', () => {
    const service = make({
      initRightPanelCollapsed: true,
      initRailCollapsed: true,
    });

    expect(service.isRailCollapsed$.value).toBeTrue();
    expect(service.isRightColumnCollapsed$.value).toBeTrue();
  });

  it('seeds the two panes SEPARATELY', () => {
    // The copy-paste bug this exists to catch: seeding the rail from
    // `initRightPanelCollapsed`. With both flags set the same way it is
    // invisible, so they are set opposite here.
    const service = make({
      initRightPanelCollapsed: true,
      initRailCollapsed: false,
    });

    expect(service.isRightColumnCollapsed$.value).toBeTrue();
    expect(service.isRailCollapsed$.value).toBeFalse();
  });

  it('starts both panes expanded when the deployment configures neither', () => {
    // `ConfigService` defaults `initRailCollapsed` to false for a config.json
    // written before the key existed; this pins the resulting UX, which is
    // that an un-upgraded deployment keeps its navigation.
    const service = make({
      initRightPanelCollapsed: false,
      initRailCollapsed: false,
    });

    expect(service.isRailCollapsed$.value).toBeFalse();
    expect(service.isRightColumnCollapsed$.value).toBeFalse();
  });

  it('toggleRail flips the rail and leaves the inspector alone', () => {
    const service = make({
      initRightPanelCollapsed: false,
      initRailCollapsed: false,
    });

    service.toggleRail();
    expect(service.isRailCollapsed$.value).toBeTrue();
    expect(service.isRightColumnCollapsed$.value).toBeFalse();

    service.toggleRail();
    expect(service.isRailCollapsed$.value).toBeFalse();
  });

  it('toggleRightColumn flips the inspector and leaves the rail alone', () => {
    const service = make({
      initRightPanelCollapsed: false,
      initRailCollapsed: false,
    });

    service.toggleRightColumn();
    expect(service.isRightColumnCollapsed$.value).toBeTrue();
    expect(service.isRailCollapsed$.value).toBeFalse();
  });

  it('notifies every subscriber of a pane, so two controls stay in step', () => {
    // The reason the state is root-scoped: the rail's own toggle and the
    // header's must not each hold half of it.
    const service = make({
      initRightPanelCollapsed: false,
      initRailCollapsed: false,
    });

    const controlA: boolean[] = [];
    const controlB: boolean[] = [];
    service.isRailCollapsed$.subscribe((v) => controlA.push(v));
    service.isRailCollapsed$.subscribe((v) => controlB.push(v));

    service.toggleRail();

    // BehaviorSubject replays the seed, so each control sees the current state
    // on subscribe and then the change.
    expect(controlA).toEqual([false, true]);
    expect(controlB).toEqual([false, true]);
  });

  it('is a singleton, so a pane opened in one view is open in the next', () => {
    const service = make({
      initRightPanelCollapsed: false,
      initRailCollapsed: false,
    });
    service.toggleRail();

    expect(TestBed.inject(ViewService)).toBe(service);
    expect(TestBed.inject(ViewService).isRailCollapsed$.value).toBeTrue();
  });
});
