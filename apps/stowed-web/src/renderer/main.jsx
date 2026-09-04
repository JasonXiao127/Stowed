import React from 'react';
import ReactDOM from 'react-dom/client';
import { ThemeProvider } from '@stowed/shared-ui';
import App from './App';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </React.StrictMode>
);