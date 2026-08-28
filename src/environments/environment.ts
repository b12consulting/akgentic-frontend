import { AuthProvider } from '../app/core/auth/auth.types';

export const environment = {
  production: true,
  api: 'http://localhost:8000',
  logo: 'akgent_logo.png',
  autoRedirectContext: 'Business team',
  welcomeMessage: 'Welcome to the Akgentic Framework',
  hideHome: false,
  hideLogin: true,
  hideAgentNames: false,
  initRightPanelCollapsed: false,
  userInputEnterKeySubmit: false,
  favicon: 'favicon.png',
  loginProviders: ['google', 'apikey'] as AuthProvider[] // Array, ordered by preference
};
