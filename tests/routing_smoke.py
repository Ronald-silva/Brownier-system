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

    # Refresh na tela de confirmação não deve perder o pedido (bug que este plano corrige)
    page.goto("http://localhost:3000/cardapio", wait_until="networkidle")
    page.locator(".add-icon:not([disabled])").first.click()
    page.get_by_label("Abrir pedido").click()
    page.wait_for_timeout(200)
    page.get_by_role("button", name="Continuar pedido").click()
    page.wait_for_timeout(200)
    assert "/finalizar" in page.url

    page.get_by_label("Seu nome").fill("Maria Silva")
    page.get_by_label("Seu WhatsApp").fill("(85) 90000-0000")
    # business.pickupEnabled pode deixar "Retirada" pré-selecionado, que tem um bug
    # pré-existente e não relacionado no servidor quando o endereço fica vazio.
    # Selecionamos "Entrega" explicitamente e preenchemos o endereço para evitá-lo.
    page.get_by_role("button", name="Entrega").click()
    page.get_by_label("Onde entregamos?").fill("Rua das Flores, 123, Aldeota")
    page.get_by_role("button", name="Confirmar pedido").click()
    page.wait_for_url("**/pedido/**", timeout=10000)
    page.locator("text=Que delícia, está confirmado.").wait_for(timeout=10000)

    assert "/pedido/" in page.url
    assert page.locator("text=PEDIDO RECEBIDO").count() == 1
    assert page.locator("text=Que delícia, está confirmado.").count() == 1
    confirmation_url = page.url

    # O bug original: recarregar a página perdia o pedido (voltava para a Home vazia).
    # Task 4 corrigiu isso com um fallback de busca via GET /api/public/orders/:publicCode.
    page.reload(wait_until="networkidle")
    page.locator("text=Que delícia, está confirmado.").wait_for(timeout=10000)
    assert page.url == confirmation_url
    assert page.locator("text=PEDIDO RECEBIDO").count() == 1
    assert page.locator("text=Que delícia, está confirmado.").count() == 1

    browser.close()
print("routing smoke: ok")
