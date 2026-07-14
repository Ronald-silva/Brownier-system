from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    for width, height in [(360, 800), (390, 844), (430, 900), (768, 1000), (1024, 1000), (1280, 1000), (1440, 1000)]:
        page = browser.new_page(viewport={"width": width, "height": height}, device_scale_factor=1)
        errors = []
        page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
        page.goto("http://localhost:3000", wait_until="networkidle")
        page.screenshot(path=f"/tmp/brownieria-home-{width}.png", full_page=True)
        assert page.locator("img[alt='Brownieria Fortal']").count() == 1
        assert page.locator("text=O brownie que conquista na primeira mordida.").count() == 1
        assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
        page.get_by_role("button", name="Ver cardápio").first.click()
        page.wait_for_timeout(200)
        assert page.locator("text=Escolha seu momento doce.").count() == 1
        assert page.locator("text=Brownie do Dia").count() == 1
        assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
        page.goto("http://localhost:3000", wait_until="networkidle")
        page.get_by_text("Área da equipe").click()
        page.get_by_label("Código de acesso").fill("brownies-demo")
        page.get_by_role("button", name="Entrar no painel").click()
        page.get_by_text("O que precisa da sua atenção.").wait_for()
        for label in ["Sabores", "Promoções", "Pedidos", "Produção", "Ajustes"]:
            page.get_by_role("button", name=label).click()
            page.wait_for_timeout(80)
            assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
        assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
        assert not errors, errors
        page.close()
    browser.close()
