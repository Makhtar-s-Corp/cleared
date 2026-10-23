// The page's entry, bundled by Vite. The server writes the same page for
// every screen's address (lane 34): <html lang>, and on <body> what the
// shell draws first (the project, the signed-in name, the data source); or
// the sign-in page, with the server's sentence when it refused one. The
// router names the screen from the address (shell/App.tsx).
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { catalogOf, isLanguage } from '@/lib/catalogs.ts';
import { translator } from '@/lib/i18n.ts';
import { placeOf } from '@/lib/routes.ts';
import { sheetsReady } from '@/lib/sheets.ts';
import { App } from '@/shell/App.tsx';
import { Login } from '@/shell/Login.tsx';
import './styles/app.css';

const data = document.body.dataset;
const lang = document.documentElement.lang;
const language = isLanguage(lang) ? lang : 'fr';
const root = createRoot(document.getElementById('root')!);
const app = data.screen === 'app';
// The first screen's sheets, on and loaded before anything is drawn (review of 248, F1).
const ready = app ? sheetsReady(placeOf(location.pathname)?.screen ?? 'tower') : Promise.resolve();

void ready.then(() => root.render(
  <StrictMode>
    {app
      ? <App start={{ language, project: data.project ?? '', userName: data.user ?? '', source: data.source === 'fixtures' ? 'fixtures' : 'service' }} />
      : <Login t={translator(catalogOf('shell', language))} error={data.error} />}
  </StrictMode>,
));
