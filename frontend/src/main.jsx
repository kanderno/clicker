import React from 'react';
import ReactDOM from 'react-dom/client';
import WebApp from '@twa-dev/sdk';
import App from './App.jsx';
import './index.css';

WebApp.ready();
WebApp.expand();

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
