import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './ui/App';
import './ui/styles.css';
import { flushPendingSave, useGame } from './ui/store';

const stored = localStorage.getItem('octagon-theme');
if (stored === 'light') document.documentElement.setAttribute('data-theme', 'light');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>
);

// A change made in the last three quarters of a second before the tab closes was simply lost to
// the debounce. This writes it before the page goes away.
window.addEventListener('beforeunload', () => {
  flushPendingSave(useGame.getState().save);
});
