export type AuthProvider = 'azure_ad' | 'google' | 'apikey' | 'default' | (string & {});

export interface Environment {
  production: boolean;
  api: string;
  logo: string;
  welcomeMessage: string;
  loginProviders: AuthProvider[];
  providerLabels?: Record<AuthProvider, string>;
  autoRedirectContext: string;
  hideHome: boolean;
  hideLogin: boolean;
  /**
   * Hide the agent identity on chat bubbles.
   *
   * The framework SHOWS agent names: in a multi-agent team, who said a thing is
   * usually the most important part of it. This exists because a deployment can
   * present the team as one assistant rather than a cast — the agents are an
   * implementation detail there, and naming them invites questions the product
   * does not want to answer.
   *
   * Hides the identity only. Alignment, colour and threading are untouched, so a
   * conversation stays readable without it.
   */
  hideAgentNames: boolean;
  initRightPanelCollapsed: boolean;
  /**
   * Start with the team rail collapsed.
   *
   * OPTIONAL, unlike its counterpart above, and that asymmetry is deliberate:
   * `initRightPanelCollapsed` has been in every `config.json` since before
   * those files were written, and this key has not. `ConfigService` supplies
   * the default (expanded), so a deployment that upgrades without touching its
   * config keeps the navigation it already had rather than booting with its
   * only route between teams hidden behind a control the user has not met.
   */
  initRailCollapsed?: boolean;
  /**
   * Inspector tabs this deployment does not want, by their `value`
   * ('team', 'hierarchy', 'member', 'knowledge-graph', 'workspace',
   * 'messages' — the ids in `inspector-tabs.registry.ts`).
   *
   * The framework ships every tab, because the framework does not know which
   * ones a product wants to stand behind: sdworx presents a team as one
   * assistant (see `hideAgentNames`), and a raw message log or a member-by-member
   * inspector is a developer's view of that, not a customer's.
   *
   * OPTIONAL, like `initRailCollapsed` and for the same reason: it post-dates
   * every `config.json` in the field, so its absence has to mean "show them
   * all" rather than "show none". An id nobody recognises is ignored, and a
   * list that would hide EVERY tab is ignored wholesale — see
   * `visibleInspectorTabs`, which owns both rules so this is a declaration and
   * not a second implementation of them.
   */
  hiddenInspectorTabs?: string[];
  userInputEnterKeySubmit: boolean;
  favicon: string;
  /**
   * The languages this deployment offers, as bare language tags ('en', 'fr').
   *
   * Defaults to the built-in language alone. Widening it is what makes another
   * language reachable: a candidate the browser or a link asks for is only
   * honoured if it appears here, so a half-shipped locale cannot be selected by
   * accident.
   */
  languages: string[];
  /**
   * The language a key falls back to when the active one does not define it.
   *
   * Not the same thing as the active language: this is the safety net, and it
   * is per key, not per file. A locale that translates 80% of the app renders
   * the other 20% in this language rather than blank.
   */
  defaultLanguage: string;
}
