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


def admin_cancel_order_by_public_code(public_code: str) -> None:
    # Não existe DELETE /api/admin/orders/:id no servidor (fora do escopo
    # desta suíte alterar). Como fallback documentado, neutralizamos o
    # impacto do pedido de teste marcando-o como CANCELADO — o dashboard
    # admin já exclui pedidos CANCELADO das métricas de receita e
    # "aguardando". O registro continua existindo no armazenamento, mas fica
    # identificável e não afeta a operação real.
    req = urllib.request.Request(f"{BASE}/api/admin/bootstrap", headers=ADMIN_HEADERS)
    store = json.loads(urllib.request.urlopen(req).read())
    order = next((o for o in store["orders"] if o.get("publicCode") == public_code), None)
    if order is None:
        return
    put_req = urllib.request.Request(
        f"{BASE}/api/admin/orders/{order['id']}",
        data=json.dumps({
            "status": "CANCELADO",
            "internalNotes": "Pedido criado por tests/routing_smoke.py — cancelado automaticamente ao final da suíte.",
        }).encode("utf-8"),
        method="PUT",
        headers={"Content-Type": "application/json", **ADMIN_HEADERS},
    )
    urllib.request.urlopen(put_req).read()


ORDER_TAG = "[SMOKE routing_smoke]"
order_code_to_cancel = None

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()

    # Este teste precisa de um estado inicial previsível (sem horários) para
    # o fluxo de checkout que exercita — captura o valor real que já estava
    # configurado (não assume que é []) para poder restaurá-lo exatamente ao
    # final, mesmo se o teste falhar.
    original_slots = admin_get_business().get("pickupSlots", [])
    admin_put_business({"pickupSlots": []})

    try:
        page.goto(BASE, wait_until="networkidle")
        page.get_by_role("button", name="Ver cardápio").first.click()
        page.wait_for_timeout(200)
        assert "/cardapio" in page.url

        page.locator(".add-icon:not([disabled])").first.click()
        page.get_by_label("Abrir pedido").click()
        page.wait_for_timeout(200)
        assert "/carrinho" in page.url

        # Deep link direto para o carrinho (compartilhamento de URL)
        page.goto(f"{BASE}/carrinho", wait_until="networkidle")
        assert page.locator("text=Sua caixa está quase pronta.").count() == 1

        # Botão Voltar do navegador funciona dentro do app
        page.goto(BASE, wait_until="networkidle")
        page.get_by_role("button", name="Ver cardápio").first.click()
        page.wait_for_timeout(200)
        page.go_back()
        page.wait_for_timeout(200)
        assert page.url.rstrip("/") == BASE

        # Refresh na tela de confirmação não deve perder o pedido (bug que este plano corrige)
        page.goto(f"{BASE}/cardapio", wait_until="networkidle")
        page.locator(".add-icon:not([disabled])").first.click()
        page.get_by_label("Abrir pedido").click()
        page.wait_for_timeout(200)
        page.get_by_role("button", name="Continuar pedido").click()
        page.wait_for_timeout(200)
        assert "/finalizar" in page.url

        page.get_by_label("Seu nome").fill(f"{ORDER_TAG} Maria Silva")
        page.get_by_label("Seu WhatsApp").fill("(85) 90000-0000")
        # Fluxo atual: só existe retirada (pessoal ou via Uber Moto solicitado pelo
        # cliente) — não há mais opção de entrega pela Brownieria nem campo de
        # endereço. "Vou retirar pessoalmente" já vem selecionado por padrão;
        # clicamos explicitamente para deixar a intenção do teste clara.
        page.get_by_role("button", name="Vou retirar pessoalmente").click()
        page.get_by_role("button", name="Confirmar pedido").click()
        page.wait_for_url("**/pedido/**", timeout=10000)
        page.locator("text=Que delícia, está confirmado.").wait_for(timeout=10000)

        assert "/pedido/" in page.url
        assert page.locator("text=PEDIDO RECEBIDO").count() == 1
        assert page.locator("text=Que delícia, está confirmado.").count() == 1
        confirmation_url = page.url
        order_code_to_cancel = page.locator(".code strong").inner_text().strip()

        # O bug original: recarregar a página perdia o pedido (voltava para a Home vazia).
        # Task 4 corrigiu isso com um fallback de busca via GET /api/public/orders/:publicCode.
        page.reload(wait_until="networkidle")
        page.locator("text=Que delícia, está confirmado.").wait_for(timeout=10000)
        assert page.url == confirmation_url
        assert page.locator("text=PEDIDO RECEBIDO").count() == 1
        assert page.locator("text=Que delícia, está confirmado.").count() == 1
    finally:
        # cleanup: restaura exatamente o pickupSlots que estava configurado
        # antes deste teste (não necessariamente []) e cancela (não há
        # endpoint para excluir) o pedido criado por este teste, identificado
        # pelo publicCode capturado no momento da criação — nunca um pedido
        # de outra origem. Tudo isso roda mesmo se alguma asserção acima
        # tiver falhado, inclusive se o pedido nunca chegou a ser criado.
        browser.close()
        admin_put_business({"pickupSlots": original_slots})
        if order_code_to_cancel:
            admin_cancel_order_by_public_code(order_code_to_cancel)
print("routing smoke: ok")
