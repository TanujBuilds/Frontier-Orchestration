import React from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

// The overnight worker implements the requested task board here.
function App() {
  return <main><h1>Night Shift starter</h1><p>The approved staged job will build this app.</p></main>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
