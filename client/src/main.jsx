import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AppProvider } from './store.jsx';
import App from './App.jsx';
import './styles.css';

try { document.documentElement.dataset.theme = localStorage.getItem('ob_theme') || 'light'; } catch { /* ignore */ }

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <AppProvider>
        <App />
      </AppProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
