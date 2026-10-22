// The page's entry, bundled by Vite. The server writes the page for its
// address: <html lang>, and on <body> the screen and what the shell draws
// first (the project, the signed-in name, the data source), or the sign-in
// page with the server's sentence when it refused one.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { catalogOf, isLanguage } from '@/lib/catalogs.ts';
import { translator } from '@/lib/i18n.ts';
import { App } from '@/shell/App.tsx';
import type { ShellScreen } from '@/shell/Header.tsx';
import { Login } from '@/shell/Login.tsx';
import './styles/app.css';

const SCREENS: readonly ShellScreen[] = ['tower', 'inbox', 'session', 'lead'];
const data = document.body.dataset;
const lang = document.documentElement.lang;
const language = isLanguage(lang) ? lang : 'en';
const root = createRoot(document.getElementById('root')!);
const screen = SCREENS.find((name) => name === data.screen);

root.render(
  <StrictMode>
    {screen
      ? <App start={{ screen, language, project: data.project ?? '', userName: data.user ?? '', source: data.source === 'fixtures' ? 'fixtures' : 'service' }} />
      : <Login t={translator(catalogOf('shell', language))} error={data.error} />}
  </StrictMode>,
);
