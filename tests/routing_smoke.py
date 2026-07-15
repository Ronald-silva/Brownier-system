from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()

    page.goto("http://localhost:3000", wait_until="networkidle")
    page.get_by_role("button", name="Ver cardápio").first.click()
    page.wait_for_timeout(200)
    assert "/cardapio" in page.url

    page.locator(".add-icon:not([disabled])").first.click()
    page.get_by_label("Abrir pedido").click()
    page.wait_for_timeout(200)
    assert "/carrinho" in page.url

    # Deep link direto para o carrinho (compartilhamento de URL)
    page.goto("http://localhost:3000/carrinho", wait_until="networkidle")
    assert page.locator("text=Sua caixa está quase pronta.").count() == 1

    # Botão Voltar do navegador funciona dentro do app
    page.goto("http://localhost:3000", wait_until="networkidle")
    page.get_by_role("button", name="Ver cardápio").first.click()
    page.wait_for_timeout(200)
    page.go_back()
    page.wait_for_timeout(200)
    assert page.url.rstrip("/") == "http://localhost:3000"

    browser.close()
print("routing smoke: ok")
