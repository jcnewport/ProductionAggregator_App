/**
 * App Entry Point
 *
 * Renders the root React component into the DOM.
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
// Global CSS (keyframes, hover-lift utility, form/button classes). See index.css
// for the "chosen UI direction" context — Enterprise Confident + Option A's
// hover lift + Option B's LIVE pulse.
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
