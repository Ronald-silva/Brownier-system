import json
import urllib.request

from playwright.sync_api import sync_playwright

from _admin_auth import admin_headers

BASE = "http://localhost:3000"
ADMIN_CODE = "brownies-demo"
# Um único token é obtido no início da suíte e reutilizado em todas as
# chamadas diretas à API admin (login autenticado corretamente não conta
# para o rate limit de tentativas inválidas do endpoint de login).
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


def admin_cancel_order_by_public_code(public_code: str) -> None:
    # Não existe DELETE /api/admin/orders/:id no servidor (fora do escopo desta
    # suíte alterar). Como fallback documentado, neutralizamos o impacto do
    # pedido de teste marcando-o como CANCELADO — o dashboard admin já exclui
    # pedidos CANCELADO das métricas de receita e "aguardando" (ver
    # AdminOperations.tsx). O registro continua existindo no armazenamento,
    # mas fica identificável e não afeta a operação real.
    req = urllib.request.Request(f"{BASE}/api/admin/bootstrap", headers=ADMIN_HEADERS)
    store = json.loads(urllib.request.urlopen(req).read())
    order = next((o for o in store["orders"] if o.get("publicCode") == public_code), None)
    if order is None:
        return
    put_req = urllib.request.Request(
        f"{BASE}/api/admin/orders/{order['id']}",
        data=json.dumps({
            "status": "CANCELADO",
            "internalNotes": "Pedido criado por tests/pickup_time_smoke.py — cancelado automaticamente ao final da suíte.",
        }).encode("utf-8"),
        method="PUT",
        headers={"Content-Type": "application/json", **ADMIN_HEADERS},
    )
    urllib.request.urlopen(put_req).read()


def add_item_and_go_to_checkout(page):
    page.goto(f"{BASE}/cardapio", wait_until="networkidle")
    page.locator(".add-icon:not([disabled])").first.click()
    page.goto(f"{BASE}/carrinho", wait_until="networkidle")
    page.locator("button.primary.wide").click()
    page.wait_for_url("**/finalizar")
    # wait_for_url only waits for the URL to change, not for the checkout form
    # to finish mounting — without this, .count() checks right after can race
    # against React's render and flakily read the DOM before it's ready.
    page.locator("fieldset", has_text="Escolha o horário de retirada").wait_for(state="visible")


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)

    # Marcador para identificar pedidos criados por esta suíte (não há como
    # excluí-los via API — ver admin_cancel_order_by_public_code acima).
    ORDER_TAG = "[SMOKE pickup_time_smoke]"
    order_codes_to_cancel = []

    # Este teste precisa passar pelos dois cenários (sem horário / com
    # horário configurado), então captura o valor real de pickupSlots que já
    # estava configurado antes de qualquer alteração — não assume que é [] —
    # para poder restaurá-lo exatamente ao final, mesmo se o teste falhar.
    original_slots = admin_get_business().get("pickupSlots", [])

    try:
        # --- Scenario: no pickup slots configured (the real current default) ---
        admin_put_business({"pickupSlots": []})
        page = browser.new_page()
        add_item_and_go_to_checkout(page)

        fieldset_no_slots = page.locator("fieldset", has_text="Escolha o horário de retirada")
        assert "ainda não estão disponíveis" in fieldset_no_slots.inner_text()
        assert fieldset_no_slots.locator("button.choice").count() == 0

        # Submitting without any configured slots must NOT be blocked by pickup-time
        # validation (there is nothing to choose) — the order still needs the
        # required name/phone fields, which we fill here to isolate this check.
        page.fill('input[name="name"]', f"{ORDER_TAG} Maria Sem Horário")
        page.fill('input[name="phone"]', "85999990000")
        page.locator("button.primary.wide").click()
        page.wait_for_url("**/pedido/**", timeout=5000)
        assert "Horário de retirada:" not in page.locator(".next-steps").inner_text()
        order_codes_to_cancel.append(page.locator(".code strong").inner_text().strip())
        page.close()

        # --- Scenario: pickup slots configured ---
        admin_put_business({"pickupSlots": ["14:00", "15:00", "16:00"]})
        page = browser.new_page()
        add_item_and_go_to_checkout(page)

        title = page.locator("fieldset legend", has_text="Escolha o horário de retirada")
        assert title.count() == 1

        slots = page.locator("fieldset", has_text="Escolha o horário de retirada").locator("button.choice")
        assert slots.count() == 3

        # 5) Tentar enviar sem horário selecionado -> mensagem objetiva, sem navegar.
        page.fill('input[name="name"]', f"{ORDER_TAG} Joana Retirada")
        page.fill('input[name="phone"]', "85988887777")
        page.locator("button.primary.wide").click()
        error = page.locator(".error")
        error.wait_for(state="visible", timeout=1000)
        assert error.inner_text().strip() == "Escolha um horário para retirar seu pedido."
        assert "/finalizar" in page.url

        # 2) Selecionar um horário -> destaque visual evidente.
        slots.filter(has_text="15:00").click()
        assert "active" in (slots.filter(has_text="15:00").get_attribute("class") or "")

        # 3) Trocar o horário selecionado.
        slots.filter(has_text="16:00").click()
        assert "active" in (slots.filter(has_text="16:00").get_attribute("class") or "")
        assert "active" not in (slots.filter(has_text="15:00").get_attribute("class") or "")

        # 4) A seleção permanece ao preencher os demais campos (payment/notes).
        page.locator(".checkout-form fieldset", has_text="Como você prefere pagar?").locator(
            "button.choice", has_text="DINHEIRO"
        ).click()
        page.fill('textarea[name="notes"]', "Sem noz, por favor")
        assert "active" in (slots.filter(has_text="16:00").get_attribute("class") or "")

        # 6) Concluir com horário selecionado.
        page.locator("button.primary.wide").click()
        page.wait_for_url("**/pedido/**", timeout=5000)

        # 8) O horário aparece na tela de confirmação.
        assert "Horário de retirada: 16:00" in page.locator(".next-steps").inner_text()

        public_code = page.locator(".code strong").inner_text().strip()
        order_codes_to_cancel.append(public_code)

        # 7) Confirmar o horário no pedido salvo (via API, contorna o campo local-only "safe").
        with urllib.request.urlopen(f"{BASE}/api/public/orders/{public_code}") as resp:
            saved_order = json.loads(resp.read())
        assert saved_order["pickupTime"] == "16:00"

        # 10) Sem overflow em 320px, 390px e desktop, na página de checkout.
        add_item_and_go_to_checkout(page)
        for width, height in [(320, 720), (390, 844), (1440, 900)]:
            page.set_viewport_size({"width": width, "height": height})
            overflow = page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
            assert overflow <= 1, f"horizontal overflow at {width}px: {overflow}px"

        page.close()
    finally:
        # cleanup: restaura exatamente o valor de pickupSlots que estava
        # configurado antes deste teste (não necessariamente []), e cancela
        # (não há endpoint para excluir) os pedidos criados por este teste,
        # identificados pelo publicCode capturado no momento da criação —
        # nunca pedidos de outra origem. Tudo isso roda mesmo se alguma
        # asserção acima tiver falhado.
        admin_put_business({"pickupSlots": original_slots})
        for code in order_codes_to_cancel:
            admin_cancel_order_by_public_code(code)

    print("pickup_time_smoke: OK")
    browser.close()
