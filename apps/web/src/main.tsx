import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AppProvider } from './app-context';
import { PopoverProvider } from './components/Popover';
import { WindowsProvider } from './windows/manager';
import './styles/app.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    {/* The workbench sits inside the app context: it reads the route, the
        settings store and the plugin registry, and installs itself back into
        both of them once it is up. */}
    <AppProvider>
      <WindowsProvider>
        {/* Popovers are tethered to points anywhere in the app — a status bar
            button, a navigator row, the editor caret — so the host has to be
            outside all of them and inside both contexts. */}
        <PopoverProvider>
          <App />
        </PopoverProvider>
      </WindowsProvider>
    </AppProvider>
  </StrictMode>,
);
