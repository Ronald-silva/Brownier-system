import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter, Routes, Route} from 'react-router-dom';
import App, {HomeRoute, MenuRoute, ProductRoute, CartRoute, CheckoutRoute, ConfirmationRoute, AdminRoute} from './App.tsx';
import './index.css';
import './experience.css';
import './admin.css';
import './admin-sprint4.css';
import './polish.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="equipe" element={<AdminRoute />} />
        <Route element={<App />}>
          <Route index element={<HomeRoute />} />
          <Route path="cardapio" element={<MenuRoute />} />
          <Route path="cardapio/:slug" element={<ProductRoute />} />
          <Route path="carrinho" element={<CartRoute />} />
          <Route path="finalizar" element={<CheckoutRoute />} />
          <Route path="pedido/:publicCode" element={<ConfirmationRoute />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
