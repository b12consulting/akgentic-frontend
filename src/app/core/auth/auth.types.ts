export type AuthProvider = 'azure' | 'google' | 'apikey' | 'default' | (string & {});

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
  userInputEnterKeySubmit: boolean;
  favicon: string;
}
