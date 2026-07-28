import json
import urllib.request

from playwright.sync_api import sync_playwright

from _admin_auth import admin_headers

BASE = "http://localhost:3000"
ADMIN_CODE = "brownies-demo"
ADMIN_HEADERS = admin_headers(BASE, ADMIN_CODE)


def admin_put_business(body: dict) -> None:
    req = urllib.request.Request(
        f"{BASE}/api/admin/business",
        data=json.dumps(body).encode("utf-8"),
        method="PUT",
        headers={"Content-Type": "application/json", **ADMIN_HEADERS},
    )
    urllib.request.urlopen(req).read()


def admin_get_business() -> dict:
    req = urllib.request.Request(f"{BASE}/api/admin/bootstrap", headers=ADMIN_HEADERS)
    return json.loads(urllib.request.urlopen(req).read())["business"]


def login(page):
    page.goto(f"{BASE}/equipe", wait_until="networkidle")
    page.get_by_label("Código de acesso").fill(ADMIN_CODE)
    page.get_by_text("Entrar no painel").click()
    page.wait_for_load_state("networkidle")
    page.get_by_role("button", name="Ajustes", exact=True).click()
    page.wait_for_timeout(300)


def slot_labels(page):
    return page.locator(".order-card h3").all_inner_texts()


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)

    # Este teste precisa começar do estado "nenhum horário configurado" — é o
    # próprio cenário testado (configurar horários do zero). Capturamos o
    # valor real que já estava configurado (não assumimos que é []) para
    # poder devolvê-lo exatamente como estava, mesmo se o teste falhar.
    original_slots = admin_get_business().get("pickupSlots", [])
    admin_put_business({"pickupSlots": []})

    page = browser.new_page()
    try:
        login(page)

        fieldset = page.locator("fieldset", has_text="Horários de retirada")
        assert "Nenhum horário configurado ainda." in fieldset.inner_text()

        # 1) Adicionar horários.
        time_input = fieldset.get_by_label("Novo horário de retirada")
        for value in ["09:00", "09:30", "10:00"]:
            time_input.fill(value)
            fieldset.get_by_text("+ Adicionar horário").click()
            page.wait_for_timeout(150)
        assert slot_labels(page) == ["09:00", "09:30", "10:00"]

        # 2) Alterar a ordem: mover 10:00 para cima, ficando entre 09:00 e 09:30.
        row_10 = page.locator(".order-card", has_text="10:00")
        row_10.get_by_label("Mover 10:00 para cima").click()
        page.wait_for_timeout(150)
        assert slot_labels(page) == ["09:00", "10:00", "09:30"]

        # 3) Remover um horário.
        page.locator(".order-card", has_text="09:30").get_by_label("Remover 09:30").click()
        page.wait_for_timeout(150)
        assert slot_labels(page) == ["09:00", "10:00"]

        # 4) Salvar -> confirmação discreta.
        page.get_by_text("Salvar horários", exact=True).click()
        toast = page.locator(".admin-toast")
        toast.wait_for(state="visible", timeout=1500)
        assert toast.inner_text().strip() == "Horários atualizados."

        # 5) Persistência após recarregar a página (não apenas em memória).
        # A sessão (token assinado) persiste em sessionStorage entre reloads —
        # não é preciso reenviar o código de acesso.
        page.reload(wait_until="networkidle")
        page.wait_for_selector(".admin.operations", state="visible")
        page.get_by_role("button", name="Ajustes", exact=True).click()
        page.wait_for_timeout(300)
        assert slot_labels(page) == ["09:00", "10:00"]

        # 6) O checkout usa imediatamente os horários configurados, na mesma ordem.
        page.goto(f"{BASE}/cardapio", wait_until="networkidle")
        page.locator(".add-icon:not([disabled])").first.click()
        page.goto(f"{BASE}/carrinho", wait_until="networkidle")
        page.locator("button.primary.wide").click()
        page.wait_for_url("**/finalizar")
        checkout_fieldset = page.locator("fieldset", has_text="Escolha o horário de retirada")
        # wait_for_url only waits for the URL to change, not for the checkout
        # form to finish mounting — without this, .count() right after can
        # race against React's render and flakily read the DOM too early.
        checkout_fieldset.wait_for(state="visible")
        checkout_slots = checkout_fieldset.locator("button.choice")
        assert [checkout_slots.nth(i).inner_text() for i in range(checkout_slots.count())] == ["09:00", "10:00"]
    finally:
        # cleanup: restaura exatamente o valor que estava configurado antes
        # deste teste (não necessariamente []), mesmo se alguma asserção
        # falhar acima, para não deixar os testes seguintes — nem o painel
        # real — dependentes desta execução.
        page.close()
        admin_put_business({"pickupSlots": original_slots})

    print("pickup_slots_admin_smoke: OK")
    browser.close()
