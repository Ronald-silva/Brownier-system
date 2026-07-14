import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter, Routes, Route} from 'react-router-dom';
import App, {HomeRoute, MenuRoute, ProductRoute} from './App.tsx';
import './index.css';
import './experience.css';
import './admin.css';
import './admin-sprint4.css';
import './polish.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route element={<App />}>
          <Route index element={<HomeRoute />} />
          <Route path="cardapio" element={<MenuRoute />} />
          <Route path="cardapio/:slug" element={<ProductRoute />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
