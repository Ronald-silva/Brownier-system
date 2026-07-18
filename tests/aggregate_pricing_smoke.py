from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()

    page.goto("http://localhost:3000/cardapio", wait_until="networkidle")

    # Adiciona 10 unidades do primeiro sabor disponível e 10 do segundo — 20 no total, sabores diferentes
    add_buttons = page.locator(".add-icon:not([disabled])")
    add_buttons.nth(0).click()
    for _ in range(9):
        add_buttons.nth(0).click()
    add_buttons.nth(1).click()
    for _ in range(9):
        add_buttons.nth(1).click()
    page.wait_for_timeout(300)

    page.get_by_label("Abrir pedido").click()
    page.wait_for_load_state("networkidle")

    # Sem a dica de "faltam X" — o total de 20 já atingiu o mínimo
    assert page.locator("text=Faltam").count() == 0, "não deve mostrar a dica de desconto quando o total já atingiu o mínimo"

    # Cada linha deve mostrar o preço promocional (R$ 3,00 cada), não o preço base (R$ 5,00 cada)
    assert page.locator("text=R$ 3,00 cada").count() == 2, "as duas linhas devem exibir o preço promocional, mesmo com apenas 10 unidades cada"
    assert page.locator("text=R$ 5,00 cada").count() == 0, "nenhuma linha deve mostrar o preço base quando o total do pedido atinge o mínimo"

    browser.close()
print("aggregate pricing smoke: ok")
