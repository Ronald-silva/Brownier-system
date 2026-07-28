import json
import urllib.error
import urllib.request

from playwright.sync_api import sync_playwright

from _admin_auth import admin_headers

BASE = "http://localhost:3000"
ADMIN_CODE = "brownies-demo"
TEST_PRODUCT_NAME = "Brownie Smoke Test"
ADMIN_HEADERS = admin_headers(BASE, ADMIN_CODE)


def admin_find_product_id(name: str) -> str | None:
    req = urllib.request.Request(f"{BASE}/api/admin/bootstrap", headers=ADMIN_HEADERS)
    store = json.loads(urllib.request.urlopen(req).read())
    match = next((p for p in store["products"] if p["name"] == name), None)
    return match["id"] if match else None


def admin_delete_product(product_id: str) -> None:
    req = urllib.request.Request(
        f"{BASE}/api/admin/products/{product_id}",
        method="DELETE",
        headers=ADMIN_HEADERS,
    )
    try:
        urllib.request.urlopen(req)
    except urllib.error.HTTPError as e:
        if e.code != 404:
            raise


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()

    try:
        page.goto(f"{BASE}/equipe", wait_until="networkidle")
        page.get_by_label("Código de acesso").fill(ADMIN_CODE)
        page.get_by_text("Entrar no painel").click()
        page.wait_for_load_state("networkidle")
        page.get_by_role("button", name="Sabores", exact=True).click()
        page.wait_for_timeout(300)

        # Criar
        page.get_by_text("+ Novo sabor").click()
        page.wait_for_timeout(200)
        page.locator(".admin-content > .editor").get_by_label("Nome").fill(TEST_PRODUCT_NAME)
        page.locator(".admin-content > .editor").get_by_label("Preço-base (R$)").fill("9.90")
        page.locator(".admin-content > .editor").get_by_text("Criar sabor").click()
        page.wait_for_timeout(1000)
        page.wait_for_load_state("networkidle")
        assert page.locator(".op-product", has_text=TEST_PRODUCT_NAME).count() == 1, "sabor criado deve aparecer na lista"

        # Editar
        row = page.locator(".op-product", has_text=TEST_PRODUCT_NAME)
        row.get_by_text("Editar").click()
        page.wait_for_timeout(200)
        row.get_by_label("Preço-base (R$)").fill("12.50")
        row.get_by_text("Salvar alterações").click()
        page.wait_for_timeout(1000)
        page.wait_for_load_state("networkidle")
        row = page.locator(".op-product", has_text=TEST_PRODUCT_NAME)
        assert row.locator("text=R$ 12,50").count() == 1, "preço deve refletir a edição"

        # Toggle de disponibilidade persiste após reload (não é só otimismo visual)
        switch = row.locator(".switch")
        class_before = switch.get_attribute("class")
        switch.click()
        page.wait_for_timeout(300)
        assert switch.get_attribute("class") != class_before, "toggle deve mudar visualmente ao clicar"
        # A sessão (token assinado) persiste em sessionStorage entre reloads —
        # não é preciso reenviar o código de acesso, só aguardar o painel
        # recarregar a partir do token já armazenado.
        page.reload(wait_until="networkidle")
        page.wait_for_selector(".admin.operations", state="visible")
        page.get_by_role("button", name="Sabores", exact=True).click()
        page.wait_for_timeout(300)
        row = page.locator(".op-product", has_text=TEST_PRODUCT_NAME)
        assert row.locator(".switch").get_attribute("class") != class_before, "mudança deve persistir após reload"

        # Excluir
        row.get_by_text("Editar").click()
        page.wait_for_timeout(200)
        row.get_by_text("Excluir sabor").click()
        page.wait_for_timeout(200)
        row.get_by_text("Sim, excluir").click()
        page.wait_for_timeout(1000)
        page.wait_for_load_state("networkidle")
        assert page.locator(f"text={TEST_PRODUCT_NAME}").count() == 0, "sabor excluído não deve mais aparecer"
    finally:
        # Este teste cria um sabor temporário só para si. Se alguma asserção
        # acima falhar antes da exclusão pela UI (linhas "Excluir"), o sabor de
        # teste ficaria permanentemente na vitrine pública — então garantimos a
        # limpeza por API aqui, independente de onde o teste tenha parado.
        leftover_id = admin_find_product_id(TEST_PRODUCT_NAME)
        if leftover_id:
            admin_delete_product(leftover_id)
        browser.close()

print("admin product editor smoke: ok")
