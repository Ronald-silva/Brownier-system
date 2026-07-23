from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()

    page.goto("http://localhost:3000/cardapio", wait_until="networkidle")

    add_button = page.locator(".add-icon:not([disabled])").first
    add_button.click()

    # 1) Feedback imediato no próprio botão: ícone vira check por ~800ms.
    assert "added" in (add_button.get_attribute("class") or "")

    # 2) Toast de confirmação aparece, é não bloqueante e some sozinho.
    toast = page.locator(".added-toast")
    toast.wait_for(state="visible", timeout=1000)
    assert "adicionado ao pedido" in toast.inner_text()
    assert toast.evaluate("el => getComputedStyle(el).pointerEvents") == "none"

    # 3) Contador do carrinho já reflete a adição imediatamente.
    assert page.locator(".cart-button b").inner_text() == "1"

    # 4) O botão volta ao normal (ícone +) depois de ~800ms.
    page.wait_for_timeout(1000)
    assert "added" not in (add_button.get_attribute("class") or "")

    # 5) O toast some sozinho depois de ~2.6s, sem interação do usuário.
    toast.wait_for(state="detached", timeout=4000)

    # 6) Cliques rápidos repetidos continuam contabilizando corretamente
    #    e não empilham toasts (sempre no máximo um .added-toast na tela).
    for _ in range(5):
        add_button.click()
    assert page.locator(".cart-button b").inner_text() == "6"
    assert page.locator(".added-toast").count() <= 1

    # 7) O botão "Adicionar ao pedido" da página de detalhe também dá feedback.
    page.goto("http://localhost:3000/cardapio/brigadeiro", wait_until="networkidle")
    # Locate by stable CSS class rather than accessible name: the button's
    # text mutates to "✓ Adicionado" on click, so a role+name locator loses
    # its match mid-assertion (Playwright's auto-retry then masks the
    # transient state instead of asserting it).
    detail_button = page.locator("button.primary.wide")
    detail_button.click()
    assert "✓ Adicionado" in detail_button.inner_text()
    page.wait_for_timeout(1000)
    assert "Adicionar ao pedido" in detail_button.inner_text()

    # 8) prefers-reduced-motion: reduce — a confirmação ainda funciona,
    #    só sem movimento perceptível (a regra global corta a duração da animação).
    page.emulate_media(reduced_motion="reduce")
    page.goto("http://localhost:3000/cardapio", wait_until="networkidle")
    reduced_add_button = page.locator(".add-icon:not([disabled])").first
    reduced_add_button.click()
    assert "added" in (reduced_add_button.get_attribute("class") or "")
    page.locator(".added-toast").wait_for(state="visible", timeout=1000)

    print("cart_add_feedback_smoke: OK")
    browser.close()
