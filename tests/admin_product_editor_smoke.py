from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()

    page.goto("http://localhost:3000/equipe", wait_until="networkidle")
    page.get_by_label("Código de acesso").fill("brownies-demo")
    page.get_by_text("Entrar no painel").click()
    page.wait_for_load_state("networkidle")
    page.get_by_role("button", name="Sabores", exact=True).click()
    page.wait_for_timeout(300)

    # Criar
    page.get_by_text("+ Novo sabor").click()
    page.wait_for_timeout(200)
    page.locator(".admin-content > .editor").get_by_label("Nome").fill("Brownie Smoke Test")
    page.locator(".admin-content > .editor").get_by_label("Preço-base (R$)").fill("9.90")
    page.locator(".admin-content > .editor").get_by_text("Criar sabor").click()
    page.wait_for_timeout(1000)
    page.wait_for_load_state("networkidle")
    assert page.locator(".op-product", has_text="Brownie Smoke Test").count() == 1, "sabor criado deve aparecer na lista"

    # Editar
    row = page.locator(".op-product", has_text="Brownie Smoke Test")
    row.get_by_text("Editar").click()
    page.wait_for_timeout(200)
    row.get_by_label("Preço-base (R$)").fill("12.50")
    row.get_by_text("Salvar sabor").click()
    page.wait_for_timeout(1000)
    page.wait_for_load_state("networkidle")
    row = page.locator(".op-product", has_text="Brownie Smoke Test")
    assert row.locator("text=R$ 12,50").count() == 1, "preço deve refletir a edição"

    # Toggle de disponibilidade persiste após reload (não é só otimismo visual)
    switch = row.locator(".switch")
    class_before = switch.get_attribute("class")
    switch.click()
    page.wait_for_timeout(300)
    assert switch.get_attribute("class") != class_before, "toggle deve mudar visualmente ao clicar"
    page.reload(wait_until="networkidle")
    page.get_by_label("Código de acesso").fill("brownies-demo")
    page.get_by_text("Entrar no painel").click()
    page.wait_for_load_state("networkidle")
    page.get_by_role("button", name="Sabores", exact=True).click()
    page.wait_for_timeout(300)
    row = page.locator(".op-product", has_text="Brownie Smoke Test")
    assert row.locator(".switch").get_attribute("class") != class_before, "mudança deve persistir após reload"

    # Excluir
    row.get_by_text("Editar").click()
    page.wait_for_timeout(200)
    row.get_by_text("Excluir sabor").click()
    page.wait_for_timeout(200)
    row.get_by_text("Sim, excluir").click()
    page.wait_for_timeout(1000)
    page.wait_for_load_state("networkidle")
    assert page.locator("text=Brownie Smoke Test").count() == 0, "sabor excluído não deve mais aparecer"

    browser.close()
print("admin product editor smoke: ok")
