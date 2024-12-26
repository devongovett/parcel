import React from 'react';
import {createRoot} from 'react-dom/client';
import App from './App';

createRoot(document.getElementById('root')).render(
  <>
    <h1>Toplevel has {Math.random()}</h1>
    <App />
  </>,
);
