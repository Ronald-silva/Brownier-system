import json
import urllib.request

from playwright.sync_api import sync_playwright

from _admin_auth import admin_headers

BASE = "http://localhost:3000"
ADMIN_CODE = "brownies-demo"
ADMIN_HEADERS = admin_headers(BASE, ADMIN_CODE)


def admin_get_product(slug: str) -> dict:
    req = urllib.request.Request(f"{BASE}/api/admin/bootstrap", headers=ADMIN_HEADERS)
    store = json.loads(urllib.request.urlopen(req).read())
    return next(p for p in store["products"] if p["slug"] == slug)


def admin_put_product(product_id: str, body: dict) -> None:
    req = urllib.request.Request(
        f"{BASE}/api/admin/products/{product_id}",
        data=json.dumps(body).encode("utf-8"),
        method="PUT",
        headers={"Content-Type": "application/json", **ADMIN_HEADERS},
    )
    urllib.request.urlopen(req).read()


# Este teste edita um sabor real (Ovomaltine) pela UI — a mesma entrada exibida
# na vitrine pública. Capturamos o estado original antes de qualquer alteração
# para poder restaurá-lo depois, mesmo se alguma asserção abaixo falhar.
original = admin_get_product("ovomaltine")

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

        row = page.locator(".op-product", has_text="Ovomaltine")
        row.get_by_text("Editar").click()
        page.wait_for_timeout(200)

        row.get_by_label("Nome").fill("Ovomaltine Crocante")
        row.get_by_label("Descrição").fill("Descrição editada via teste de aceite.")
        row.get_by_label("Preço-base (R$)").fill("8.50")
        row.get_by_label("Ordem de exibição").fill("2")
        row.get_by_text("Salvar alterações").click()
        page.wait_for_timeout(500)
        page.wait_for_load_state("networkidle")

        assert page.locator("text=Produto atualizado.").count() == 1, "toast 'Produto atualizado.' deve aparecer"

        # Reload admin, confirm persistence — a sessão (token assinado) persiste
        # em sessionStorage entre reloads, não é preciso reenviar o código.
        page.reload(wait_until="networkidle")
        page.wait_for_selector(".admin.operations", state="visible")
        page.get_by_role("button", name="Sabores", exact=True).click()
        page.wait_for_timeout(300)

        row = page.locator(".op-product", has_text="Ovomaltine Crocante")
        assert row.count() == 1, "nome editado deve persistir após reload"
        assert row.locator("text=R$ 8,50").count() == 1, "preço editado deve persistir após reload"
        row.get_by_text("Editar").click()
        page.wait_for_timeout(200)
        assert row.get_by_label("Descrição").input_value() == "Descrição editada via teste de aceite.", "descrição deve persistir"
        assert row.get_by_label("Ordem de exibição").input_value() == "2", "ordem de exibição deve persistir"

        # Confirm change on the public storefront
        storefront = browser.new_page()
        storefront.goto(f"{BASE}/cardapio", wait_until="networkidle")
        assert storefront.locator("text=Ovomaltine Crocante").count() == 1, "vitrine pública deve refletir o nome atualizado"
        assert storefront.locator("text=R$ 8,50").count() >= 1, "vitrine pública deve refletir o preço atualizado"
    finally:
        # Restaura o produto ao estado original, mesmo se alguma asserção acima
        # falhar — este teste não pode deixar dado de teste na vitrine pública.
        admin_put_product(original["id"], original)
        browser.close()

print("product full edit smoke: ok")
