import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { AuthProvider } from './auth/AuthContext';
import { ConfigError, loadConfig } from './config';
import './styles.css';

const root = createRoot(document.getElementById('root')!);

// The app only starts once its settings (/config.json) have loaded.
loadConfig()
  .then(() => {
    root.render(
      <StrictMode>
        <BrowserRouter>
          <AuthProvider>
            <App />
          </AuthProvider>
        </BrowserRouter>
      </StrictMode>,
    );
  })
  .catch((err: unknown) => {
    const message = err instanceof ConfigError ? err.message : 'The app could not start. Please reload the page.';
    root.render(
      <div className="container">
        <div className="panel panel-error" role="alert">
          <h1>The app can't start</h1>
          <p>{message}</p>
          <button type="button" className="btn" onClick={() => window.location.reload()}>Reload</button>
        </div>
      </div>,
    );
  });
