import { FormEvent, useEffect, useMemo, useState } from "react";
import { ORDER_STATUSES } from "./lib/orderStatuses";
import { formatCurrency } from "./lib/format";

type Product = { id: string; slug: string; name: string; description: string; category: string; ingredients: string; allergens: string; basePrice: number; promotionalPrice: number | null; minimumPromotionalQuantity: number | null; isAvailable: boolean; isFeatured: boolean; isDay?: boolean; imageUrl: string; displayOrder: number };
type Order = { id: string; publicCode: string; status: string; customerName: string; customerPhone: string; fulfillmentType: string; paymentMethod: string; total: number; createdAt: string; items: { productName: string; quantity: number }[]; customerNotes?: string };
type Store = { business: Record<string, unknown>; products: Product[]; orders: Order[] };
const statuses = ORDER_STATUSES;

export function AdminOperations({ onExit }: { onExit: () => void }) {
  const [code, setCode] = useState(""); const [token, setToken] = useState(() => sessionStorage.getItem("bf-admin-token") || ""); const [store, setStore] = useState<Store | null>(null); const [tab, setTab] = useState("dashboard"); const [feedback, setFeedback] = useState(""); const [search, setSearch] = useState(""); const [creatingProduct, setCreatingProduct] = useState(false); const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  const notify = (message: string) => { setFeedback(message); window.setTimeout(() => setFeedback(""), 2200); };
  const load = async (authToken = token) => { const r = await fetch("/api/admin/bootstrap", { headers: { Authorization: `Bearer ${authToken}` } }); if (!r.ok) { setToken(""); sessionStorage.removeItem("bf-admin-token"); throw new Error("Sessão expirada. Entre novamente."); } setStore(await r.json()); };
  const login = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    try {
      const r = await fetch("/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || "Código de acesso inválido.");
      sessionStorage.setItem("bf-admin-token", data.token);
      setToken(data.token);
      await load(data.token);
    } catch (err) { notify(err instanceof Error ? err.message : "Código de acesso inválido."); }
  };
  useEffect(() => { if (token && !store) load().catch(() => {}); }, []);
  const product = async (item: Product, patch: Partial<Product>, message: string) => { const r = await fetch(`/api/admin/products/${item.id}`, { method: "PUT", headers, body: JSON.stringify({ ...item, ...patch }) }); if (!r.ok) return notify("Não foi possível salvar. Tente de novo."); await load(); notify(message); };
  const order = async (item: Order, status: string) => { const r = await fetch(`/api/admin/orders/${item.id}`, { method: "PUT", headers, body: JSON.stringify({ status }) }); if (!r.ok) return notify("Não foi possível atualizar o pedido."); await load(); notify("Pedido atualizado."); };
  const uploadPhoto = (item: Product, file?: File) => { if (!file) return; if (!file.type.startsWith("image/")) return notify("Escolha uma imagem válida."); const reader = new FileReader(); reader.onload = () => product(item, { imageUrl: String(reader.result) }, "Foto atualizada."); reader.readAsDataURL(file); };
  const deleteProduct = async (item: Product) => {
    const r = await fetch(`/api/admin/products/${item.id}`, { method: "DELETE", headers });
    if (!r.ok) return notify("Não foi possível excluir o sabor. Tente de novo.");
    await load(); notify("Sabor removido.");
  };
  const createProduct = async (fields: ProductFormFields) => {
    const r = await fetch("/api/admin/products", { method: "POST", headers, body: JSON.stringify(fields) });
    if (!r.ok) return notify("Não foi possível criar o sabor. Tente de novo.");
    setCreatingProduct(false); await load(); notify("Sabor criado.");
  };
  if (!store) return <main className="admin-login"><button className="back" onClick={onExit}>← Sair</button><img className="brand-logo" src="/brand/brownieria-fortal-logo.png" alt="Brownieria Fortal" /><p className="eyebrow">OPERAÇÃO DIÁRIA</p><h1>Tudo pronto para produzir.</h1><p>Entre para atualizar sabores, acompanhar pedidos e manter o cardápio certo.</p><form onSubmit={login}><input aria-label="Código de acesso" autoComplete="off" spellCheck={false} value={code} onChange={e => setCode(e.target.value)} placeholder="Código de acesso" /><button className="primary">Entrar no painel</button></form>{feedback && <p className="error">{feedback}</p>}</main>;
  const today = store.orders.filter(o => new Date(o.createdAt).toDateString() === new Date().toDateString()); const active = store.orders.filter(o => !["CONCLUIDO", "CANCELADO"].includes(o.status)); const revenue = today.filter(o => o.status !== "CANCELADO").reduce((s,o) => s + o.total, 0); const avg = today.length ? revenue / today.length : 0; const day = store.products.find(p => p.isDay) || store.products.find(p => p.isFeatured);
  const toggleAvailability = (item: Product) => {
    const previous = store.products;
    setStore({ ...store, products: previous.map(p => p.id === item.id ? { ...p, isAvailable: !p.isAvailable } : p) });
    fetch(`/api/admin/products/${item.id}`, { method: "PUT", headers, body: JSON.stringify({ ...item, isAvailable: !item.isAvailable }) }).then(r => {
      if (!r.ok) { setStore({ ...store, products: previous }); return notify("Não foi possível salvar. Tente de novo."); }
      notify("Disponibilidade atualizada.");
    });
  };
  const toggleDay = (item: Product) => {
    const previous = store.products;
    const next = previous.map(p => p.id === item.id ? { ...p, isDay: true } : p.isDay ? { ...p, isDay: false } : p);
    setStore({ ...store, products: next });
    const others = previous.filter(p => p.isDay && p.id !== item.id);
    Promise.all<Response>([
      ...others.map(p => fetch(`/api/admin/products/${p.id}`, { method: "PUT", headers, body: JSON.stringify({ ...p, isDay: false }) })),
      fetch(`/api/admin/products/${item.id}`, { method: "PUT", headers, body: JSON.stringify({ ...item, isDay: true }) }),
    ]).then(responses => {
      if (responses.some(r => !r.ok)) { setStore({ ...store, products: previous }); return notify("Não foi possível salvar. Tente de novo."); }
      notify("Brownie do Dia atualizado.");
    });
  };
  return <main className="admin operations">{feedback && <div className="admin-toast" role="status">{feedback}</div>}<header><img className="brand-logo compact" src="/brand/brownieria-fortal-logo.png" alt="Brownieria Fortal" /><button className="text-button" onClick={onExit}>Sair</button></header><nav className="admin-tabs">{[["dashboard","Hoje"],["products","Sabores"],["promotions","Promoções"],["orders","Pedidos"],["production","Produção"],["settings","Ajustes"]].map(([id,label]) => <button className={tab===id?"active":""} onClick={() => setTab(id)} key={id}>{label}</button>)}</nav>
  {tab === "dashboard" && <section className="admin-content"><p className="eyebrow">OPERAÇÃO DE HOJE</p><h1>O que precisa da sua atenção.</h1><div className="metrics"><Metric label="Chegaram hoje" value={String(today.length)} /><Metric label="Aguardando" value={String(active.length)} /><Metric label="Receita estimada" value={formatCurrency(revenue)} /><Metric label="Ticket médio" value={formatCurrency(avg)} /></div><div className="op-card"><p>🍫 BROWNIE DO DIA</p><h2>{day?.name || "Escolha o destaque de hoje"}</h2><button className="primary" onClick={() => setTab("products")}>Alterar em segundos</button></div><div className="quick-actions"><button onClick={() => { setTab("products"); setCreatingProduct(true); }}>＋<span>Novo produto</span></button><button onClick={() => setTab("orders")}>📦<span>Pedidos</span></button><button onClick={() => setTab("production")}>◷<span>Produção</span></button><button onClick={() => setTab("settings")}>⚙<span>Ajustes</span></button></div><p className="subtle">Última atualização: agora. Indisponíveis: {store.products.filter(p => !p.isAvailable).map(p => p.name).join(", ") || "nenhum"}.</p></section>}
  {tab === "products" && <section className="admin-content"><p className="eyebrow">CARDÁPIO DE HOJE</p><h1>Disponibilidade em um toque.</h1><p className="subtle">As mudanças aparecem imediatamente para o cliente.</p><h2 className="sr-only">Lista de sabores</h2><button className="secondary" onClick={() => setCreatingProduct(v => !v)}>{creatingProduct ? "Cancelar novo sabor" : "+ Novo sabor"}</button>{creatingProduct && <ProductEditor product={null} onCancel={() => setCreatingProduct(false)} onSave={createProduct} />}<div className="admin-list">{store.products.map(p => <article className="op-product" key={p.id}><label className="photo-upload"><img src={p.imageUrl || "/images/brownie-hero-demo.png"} alt={`Foto de ${p.name}`} /><input type="file" accept="image/*" onChange={e => uploadPhoto(p, e.target.files?.[0])} /></label><div><h3>{p.name}</h3><p>{formatCurrency(p.basePrice)}{p.promotionalPrice && ` · ${formatCurrency(p.promotionalPrice)} a partir de ${p.minimumPromotionalQuantity}`}</p><div className="product-flags">{p.isDay && <b>Brownie do Dia</b>}{p.isFeatured && <b>Destaque</b>}</div></div><div className="availability-control"><span className={p.isAvailable ? "avail-label" : "avail-label off"}>{p.isAvailable ? "Disponível" : "Indisponível"}</span><button className={p.isAvailable?"switch on":"switch"} aria-label={`Marcar ${p.name} como ${p.isAvailable ? "indisponível" : "disponível"}`} onClick={() => toggleAvailability(p)}><i /></button></div><button className="day-toggle" onClick={() => toggleDay(p)}>☆ Dia</button><details><summary>Editar</summary><ProductEditor product={p} onCancel={() => {}} onSave={async fields => { await product(p, fields, "Produto atualizado."); }} onDelete={() => deleteProduct(p)} /></details></article>)}</div></section>}
  {tab === "promotions" && <Promotions products={store.products} onSave={product} />}
  {tab === "orders" && <OrderList orders={store.orders} search={search} setSearch={setSearch} onStatus={order} />}
  {tab === "production" && <section className="admin-content production"><p className="eyebrow">MODO PRODUÇÃO</p><h1>O que está na bancada.</h1>{active.length ? active.map(o => <article className="production-card" key={o.id}><span>{o.status.replaceAll("_"," ")}</span><h2>{o.publicCode}</h2><strong>{o.items.map(i => `${i.quantity} ${i.productName}`).join(" · ")}</strong><p>{o.fulfillmentType === "RETIRADA" ? "Retirada" : "Entrega"} · {new Date(o.createdAt).toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"})}</p>{o.customerNotes && <p>Obs.: {o.customerNotes}</p>}<select value={o.status} onChange={e => order(o,e.target.value)}>{statuses.map(s => <option key={s}>{s}</option>)}</select></article>) : <div className="empty"><h2>Nenhum pedido em produção.</h2><p>Quando chegarem, eles aparecem aqui em cartões grandes.</p></div>}</section>}
  {tab === "settings" && <Settings business={store.business} headers={headers} onSaved={message => { load(); notify(message || "Configurações salvas."); }} />}</main>;
}
function Metric({ label, value }: { label: string; value: string }) { return <div className="metric"><span>{label}</span><b>{value}</b></div> }
type ProductFormFields = { name: string; category: string; basePrice: number; description: string; ingredients: string; allergens: string; displayOrder?: number };
function ProductEditor({ product, onSave, onCancel, onDelete }: { product: Product | null; onSave: (fields: ProductFormFields) => Promise<void>; onCancel: () => void; onDelete?: () => void }) {
  const [name, setName] = useState(product?.name || "");
  const [category, setCategory] = useState(product?.category || "Brownies");
  const [price, setPrice] = useState(product ? String(product.basePrice) : "");
  const [description, setDescription] = useState(product?.description || "");
  const [ingredients, setIngredients] = useState(product?.ingredients || "");
  const [allergens, setAllergens] = useState(product?.allergens || "");
  const [displayOrder, setDisplayOrder] = useState(product ? String(product.displayOrder) : "");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const submit = (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); onSave({ name, category, basePrice: Number(price), description, ingredients, allergens, ...(product ? { displayOrder: Number(displayOrder) } : {}) }); };
  return <form className="editor" onSubmit={submit}>
    <label>Nome<input required value={name} onChange={e => setName(e.target.value)} /></label>
    <label>Categoria<input value={category} onChange={e => setCategory(e.target.value)} /></label>
    <label>Preço-base (R$)<input required type="number" step=".01" min="0" value={price} onChange={e => setPrice(e.target.value)} /></label>
    <label>Descrição<textarea value={description} onChange={e => setDescription(e.target.value)} /></label>
    <label>Ingredientes<input value={ingredients} onChange={e => setIngredients(e.target.value)} /></label>
    <label>Alergênicos<input value={allergens} onChange={e => setAllergens(e.target.value)} /></label>
    {product && <label>Ordem de exibição<input required type="number" step="1" min="1" value={displayOrder} onChange={e => setDisplayOrder(e.target.value)} /></label>}
    <div className="choice-row">
      <button type="button" className="secondary" onClick={e => { onCancel(); e.currentTarget.closest("details")?.removeAttribute("open"); }}>Cancelar</button>
      <button className="primary">{product ? "Salvar alterações" : "Criar sabor"}</button>
    </div>
    {onDelete && (confirmingDelete
      ? <p className="clear-confirm"><span>Excluir {product?.name}?</span><button type="button" className="link-danger" onClick={onDelete}>Sim, excluir</button><button type="button" className="text-button" onClick={() => setConfirmingDelete(false)}>Cancelar</button></p>
      : <button type="button" className="link-danger" onClick={() => setConfirmingDelete(true)}>Excluir sabor</button>)}
  </form>;
}
function Promotions({ products, onSave }: { products: Product[]; onSave: (p: Product, patch: Partial<Product>, m: string) => void }) { return <section className="admin-content"><p className="eyebrow">PROMOÇÕES</p><h1>Preço por quantidade.</h1><p className="subtle">Ative somente condições reais que a equipe consegue cumprir.</p><div className="admin-list">{products.map(p => <article className="promo-editor" key={p.id}><b>{p.name}</b><label>Quantidade mínima<input type="number" value={p.minimumPromotionalQuantity || ""} onChange={e => onSave(p,{minimumPromotionalQuantity:e.target.value?Number(e.target.value):null},"Promoção atualizada.")} /></label><label>Preço promocional (R$)<input type="number" step=".01" value={p.promotionalPrice ?? ""} onChange={e => onSave(p,{promotionalPrice:e.target.value?Number(e.target.value):null},"Promoção atualizada.")} /></label></article>)}</div></section> }
function Settings({ business, headers, onSaved }: { business: Record<string, unknown>; headers: Record<string,string>; onSaved: (message?: string) => void }) {
  const [draft,setDraft] = useState(business);
  const [pickupSlots, setPickupSlots] = useState<string[]>(Array.isArray(business.pickupSlots) ? business.pickupSlots as string[] : []);
  const [newSlot, setNewSlot] = useState("");
  const [savingSlots, setSavingSlots] = useState(false);
  const [rangeStart, setRangeStart] = useState("09:00");
  const [rangeEnd, setRangeEnd] = useState("18:00");
  const [rangeInterval, setRangeInterval] = useState(30);
  const [rangeError, setRangeError] = useState("");
  const addSlot = () => { const value = newSlot.trim(); if (!value || pickupSlots.includes(value)) return; setPickupSlots([...pickupSlots, value]); setNewSlot(""); };
  const generateSlots = () => {
    const [startH, startM] = rangeStart.split(":").map(Number);
    const [endH, endM] = rangeEnd.split(":").map(Number);
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;
    if (!Number.isFinite(startMinutes) || !Number.isFinite(endMinutes) || endMinutes <= startMinutes) {
      setRangeError("O horário de fechamento precisa ser depois do horário de abertura.");
      return;
    }
    if ((endMinutes - startMinutes) / rangeInterval > 100) {
      setRangeError("Intervalo muito pequeno para esse período. Escolha um intervalo maior.");
      return;
    }
    setRangeError("");
    const generated: string[] = [];
    for (let minutes = startMinutes; minutes < endMinutes; minutes += rangeInterval) {
      generated.push(`${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`);
    }
    setPickupSlots(generated);
  };
  const removeSlot = (index: number) => setPickupSlots(pickupSlots.filter((_, i) => i !== index));
  const moveSlot = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= pickupSlots.length) return;
    const next = [...pickupSlots];
    [next[index], next[target]] = [next[target], next[index]];
    setPickupSlots(next);
  };
  const saveSlots = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSavingSlots(true);
    try { await fetch("/api/admin/business", { method: "PUT", headers, body: JSON.stringify({ pickupSlots }) }); onSaved("Horários atualizados."); }
    finally { setSavingSlots(false); }
  };
  return <section className="admin-content"><p className="eyebrow">CONFIGURAÇÕES</p><h1>Informações da Brownieria.</h1><form className="checkout-form" onSubmit={async e => { e.preventDefault(); await fetch("/api/admin/business",{method:"PUT",headers,body:JSON.stringify(draft)}); onSaved(); }}><label>Instagram<input value={String(draft.instagram||"")} onChange={e=>setDraft({...draft,instagram:e.target.value})} /></label><label>WhatsApp<input value={String(draft.whatsapp||"")} onChange={e=>setDraft({...draft,whatsapp:e.target.value})} /></label><label>Horário de funcionamento (texto informativo)<input placeholder="Ex.: Seg a Sáb, 9h às 18h" value={String(draft.hours||"")} onChange={e=>setDraft({...draft,hours:e.target.value})} /></label><label>Endereço<input value={String(draft.address||"")} onChange={e=>setDraft({...draft,address:e.target.value})} /></label><label>Mensagem após pedido<textarea value={String(draft.receivedMessage||"")} onChange={e=>setDraft({...draft,receivedMessage:e.target.value})} /></label><button className="primary">Salvar configurações</button></form>
    <form className="checkout-form" onSubmit={saveSlots}>
      <fieldset>
        <legend>Horários de retirada</legend>
        <p className="subtle">Esses horários aparecem para o cliente escolher no checkout. Sem nenhum horário aqui, o cliente só vê um link para falar com você pelo WhatsApp.</p>
        <div className="quick-schedule">
          <label>Abre às<input aria-label="Abre às" type="time" value={rangeStart} onChange={e => setRangeStart(e.target.value)} /></label>
          <label>Fecha às<input aria-label="Fecha às" type="time" value={rangeEnd} onChange={e => setRangeEnd(e.target.value)} /></label>
          <label>A cada<select aria-label="Intervalo entre horários" value={rangeInterval} onChange={e => setRangeInterval(Number(e.target.value))}><option value={15}>15 minutos</option><option value={30}>30 minutos</option><option value={60}>1 hora</option></select></label>
          <button type="button" className="secondary" onClick={generateSlots}>Gerar horários automaticamente</button>
        </div>
        {rangeError && <p className="error">{rangeError}</p>}
        <p className="subtle">Ou adicione um horário específico por vez:</p>
        <div className="choice-row">
          <input aria-label="Novo horário de retirada" type="time" value={newSlot} onChange={e => setNewSlot(e.target.value)} />
          <button type="button" className="secondary" onClick={addSlot}>+ Adicionar horário</button>
        </div>
        {pickupSlots.length === 0
          ? <p className="subtle">Nenhum horário configurado ainda.</p>
          : <div className="admin-list">
              {pickupSlots.map((slot, index) => (
                <article className="order-card" key={slot}>
                  <div><h3>{slot}</h3></div>
                  <div className="choice-row">
                    <button type="button" className="choice" aria-label={`Mover ${slot} para cima`} disabled={index === 0} onClick={() => moveSlot(index, -1)}>↑</button>
                    <button type="button" className="choice" aria-label={`Mover ${slot} para baixo`} disabled={index === pickupSlots.length - 1} onClick={() => moveSlot(index, 1)}>↓</button>
                    <button type="button" className="text-button" aria-label={`Remover ${slot}`} onClick={() => removeSlot(index)}>Remover</button>
                  </div>
                </article>
              ))}
            </div>}
      </fieldset>
      <button className="primary" disabled={savingSlots}>{savingSlots ? "Salvando…" : "Salvar horários"}</button>
    </form>
  </section> }
function OrderList({ orders, search, setSearch, onStatus }: { orders: Order[]; search: string; setSearch: (v:string)=>void; onStatus: (o: Order, s: string) => void }) { const found = useMemo(() => orders.filter(o => `${o.publicCode} ${o.customerName} ${o.customerPhone}`.toLowerCase().includes(search.toLowerCase())), [orders,search]); return <section className="admin-content"><p className="eyebrow">PEDIDOS</p><h1>Organize sem procurar.</h1><input className="order-search" aria-label="Buscar pedidos" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Buscar por código, nome ou telefone" /><h2 className="sr-only">Lista de pedidos</h2><div className="admin-list">{found.length === 0 ? <div className="empty"><h2>Nenhum pedido encontrado.</h2><p>Tente buscar por outro código, nome ou telefone.</p></div> : found.map(o => <article className="order-card order-card-status" key={o.id}><div><span className="status">{o.status.replaceAll("_"," ")}</span><h3>{o.publicCode} · {o.customerName}</h3><p>{o.customerPhone} · {o.items.map(i=>`${i.quantity}× ${i.productName}`).join(", ")}</p><strong>{formatCurrency(o.total)}</strong></div><select aria-label={`Status do pedido ${o.publicCode}`} value={o.status} onChange={e => onStatus(o,e.target.value)}>{statuses.map(s => <option key={s}>{s}</option>)}</select></article>)}</div></section> }
