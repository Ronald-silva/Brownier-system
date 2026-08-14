import { FormEvent, Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Outlet, useLocation, useNavigate, useOutletContext, useParams } from "react-router-dom";
import { ArrowLeft, Check, ChevronRight, Clipboard, GiftBox, MessageCircle, Minus, Plus, RotateCcw, Send } from "lucide-react";
import { calculateLinePrice, type PricingProduct } from "./lib/pricing";
import { productImageSrc } from "./lib/media";
import { formatCurrency } from "./lib/format";
import { AdminOperations } from "./AdminOperations";
import { buildWhatsappLink } from "./lib/whatsapp";

type Product = PricingProduct & { id: string; slug: string; name: string; description: string; category: string; imageUrl: string; isActive: boolean; isAvailable: boolean; isFeatured: boolean; isDay?: boolean; displayOrder: number; ingredients?: string; allergens?: string; updatedAt: string };
type Business = { name: string; tagline: string; description: string; phone: string; whatsapp: string; address: string; hours: string; instagram: string; pickupEnabled: boolean; deliveryEnabled: boolean; pickupSlots: string[]; paymentMethods: string[]; deliveryFee: number; receivedMessage: string; availabilityNotice: string; isDemo: boolean };
type CartLine = { product: Product; quantity: number };
type Order = { id: string; publicCode: string; status: string; subtotal: number; discount: number; deliveryFee: number; total: number; items: { productName: string; quantity: number; unitPrice: number; totalPrice: number }[]; createdAt: string; fulfillmentType: string; paymentMethod: string; pickupTime: string };
async function api<T>(url: string, options?: RequestInit): Promise<T> { const response = await fetch(url, { headers: { "Content-Type": "application/json", ...(options?.headers || {}) }, ...options }); const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || "Não foi possível concluir a ação."); return data; }
function BrandLogo({ compact = false }: { compact?: boolean }) { return <img className={compact ? "brand-logo compact" : "brand-logo"} src="/brand/brownieria-fortal-logo.png" alt="Brownieria Fortal" />; }

// O atendimento pode enviar um link oficial wa.me. Mensagens de chat são
// texto puro; este renderer promove somente URLs do WhatsApp a links seguros
// e clicáveis, preservando o restante literalmente (sem HTML injetado).
function renderChatText(text: string): ReactNode[] {
  const parts = text.split(/(https:\/\/wa\.me\/[^\s]+)/g);
  return parts.map((part, index) => part.startsWith("https://wa.me/")
    ? <a key={`link-${index}`} className="agent-chat-link" href={part} target="_blank" rel="noopener noreferrer">Abrir WhatsApp</a>
    : <Fragment key={`text-${index}`}>{part}</Fragment>);
}

export type AppContext = { business: Business; products: Product[]; cart: CartLine[]; add: (p: Product, q?: number) => void; change: (id: string, q: number) => void; clearCart: () => void; summary: { subtotal: number; discount: number } };

export default function App() {
  const [business, setBusiness] = useState<Business | null>(null); const [products, setProducts] = useState<Product[]>([]); const [cart, setCart] = useState<CartLine[]>(() => { try { const raw = sessionStorage.getItem("bf-cart"); return raw ? JSON.parse(raw) : []; } catch { return []; } }); const [notice, setNotice] = useState(""); const [addedNotice, setAddedNotice] = useState<{ id: number; text: string } | null>(null);
  const addedNoticeId = useRef(0);
  const navigate = useNavigate();
  const refresh = async () => { const [b, p] = await Promise.all([api<Business>("/api/public/business"), api<Product[]>("/api/public/menu")]); setBusiness(b); setProducts(p); };
  useEffect(() => { refresh().catch(error => setNotice(error.message)); }, []);
  useEffect(() => { try { sessionStorage.setItem("bf-cart", JSON.stringify(cart)); } catch { /* ignore storage failures (quota exceeded, private browsing) — cart still works in-memory for this session */ } }, [cart]);
  useEffect(() => { if (!addedNotice) return; const timer = setTimeout(() => setAddedNotice(null), 2600); return () => clearTimeout(timer); }, [addedNotice]);
  const add = (product: Product, quantity = 1) => { if (!product.isAvailable) return; setCart(lines => { const found = lines.find(line => line.product.id === product.id); return found ? lines.map(line => line.product.id === product.id ? { ...line, quantity: line.quantity + quantity } : line) : [...lines, { product, quantity }]; }); addedNoticeId.current += 1; setAddedNotice({ id: addedNoticeId.current, text: `✓ ${product.name} adicionado ao pedido` }); };
  const change = (id: string, quantity: number) => setCart(lines => quantity < 1 ? lines.filter(line => line.product.id !== id) : lines.map(line => line.product.id === id ? { ...line, quantity } : line));
  const clearCart = () => setCart([]);
  const summary = useMemo(() => { const totalQuantity = cart.reduce((sum, line) => sum + line.quantity, 0); return cart.reduce((acc, line) => { const price = calculateLinePrice(line.product, line.quantity, totalQuantity); return { subtotal: acc.subtotal + price.total, discount: acc.discount + price.discount }; }, { subtotal: 0, discount: 0 }); }, [cart]);
  if (!business) return <main className="loading">Carregando cardápio…</main>;
  const context: AppContext = { business, products, cart, add, change, clearCart, summary };
  return <main className="app-shell"><header className="public-header"><button className="brand" onClick={() => navigate("/")} aria-label="Ir para o início"><BrandLogo compact /></button><button className="cart-button" onClick={() => navigate("/carrinho")} aria-label="Abrir pedido"><GiftBox size={19} aria-hidden="true" />{cart.length > 0 && <b key={cart.reduce((n, l) => n + l.quantity, 0)}>{cart.reduce((n, l) => n + l.quantity, 0)}</b>}</button></header>{notice && <div className="toast" role="status">{notice}<button onClick={() => setNotice("")}>×</button></div>}{addedNotice && <div key={addedNotice.id} className="added-toast" role="status">{addedNotice.text}</div>}<Outlet context={context} /></main>;
}

function HomeRoute() {
  const { business, products, cart, add } = useOutletContext<AppContext>();
  const navigate = useNavigate();
  return <Home business={business} products={products} cart={cart} onMenu={() => navigate("/cardapio")} onProduct={p => navigate(`/cardapio/${p.slug}`)} onAdd={add} onAgent={() => navigate("/assistente")} />;
}
function MenuRoute() {
  const { products, cart, add } = useOutletContext<AppContext>();
  const navigate = useNavigate();
  return <Menu products={products} cart={cart} onBack={() => navigate("/")} onProduct={p => navigate(`/cardapio/${p.slug}`)} onAdd={add} />;
}
function ProductRoute() {
  const { products, add, cart } = useOutletContext<AppContext>();
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const product = products.find(p => p.slug === slug);
  if (!product) return <main className="loading">Produto não encontrado.</main>;
  const recommendations = products.filter(p => p.isFeatured && p.id !== product.id && p.isAvailable).slice(0, 2);
  return <ProductDetail product={product} recommendations={recommendations} cart={cart} onBack={() => navigate("/cardapio")} onAdd={add} />;
}
function CartRoute() {
  const { cart, summary, change } = useOutletContext<AppContext>();
  const navigate = useNavigate();
  return <Cart lines={cart} subtotal={summary.subtotal} discount={summary.discount} onBack={() => navigate("/cardapio")} onChange={change} onCheckout={() => navigate("/finalizar")} />;
}
function CheckoutRoute() {
  const { business, cart, summary, clearCart } = useOutletContext<AppContext>();
  const navigate = useNavigate();
  return <Checkout business={business} lines={cart} summary={summary} onBack={() => navigate("/carrinho")} onDone={order => { clearCart(); navigate(`/pedido/${order.publicCode}`, { state: { order } }); }} />;
}
function ConfirmationRoute() {
  const { business } = useOutletContext<AppContext>();
  const { publicCode } = useParams<{ publicCode: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const stateOrder = (location.state as { order?: Order } | null)?.order;
  const [order, setOrderState] = useState<Order | null>(stateOrder ?? null);
  const [notFound, setNotFound] = useState(false);
  useEffect(() => {
    if (stateOrder || !publicCode) return;
    api<Order>(`/api/public/orders/${publicCode}`).then(setOrderState).catch(() => setNotFound(true));
  }, [stateOrder, publicCode]);
  if (notFound) return <main className="loading">Pedido não encontrado.</main>;
  if (!order) return <main className="loading">Carregando pedido…</main>;
  return <Confirmation order={order} message={business.receivedMessage} onMenu={() => navigate("/cardapio")} />;
}
function AdminRoute() {
  const navigate = useNavigate();
  return <AdminOperations onExit={() => navigate("/")} />;
}
function AgentDemoRoute() {
  const navigate = useNavigate();
  return <AgentDemo onBack={() => navigate("/")} />;
}
export { HomeRoute, MenuRoute, ProductRoute, CartRoute, CheckoutRoute, ConfirmationRoute, AdminRoute, AgentDemoRoute };

function Home({ business, products, cart, onMenu, onProduct, onAdd, onAgent }: { business: Business; products: Product[]; cart: CartLine[]; onMenu: () => void; onProduct: (p: Product) => void; onAdd: (p: Product) => void; onAgent: () => void }) { const day = products.find(p => p.slug === "brigadeiro") || products[0]; const quantityOf = (id: string) => cart.find(l => l.product.id === id)?.quantity ?? 0; const whatsappLink = buildWhatsappLink(business.whatsapp); return <><section className="hero"><div><p className="eyebrow">PREPARADOS ARTESANALMENTE HOJE</p><h1>O brownie que conquista na primeira mordida.</h1><p>Feitos em pequenos lotes para garantir casquinha, recheio e muito chocolate de verdade.</p><div className="hero-actions"><button className="primary" onClick={onMenu}>Escolher meus brownies <ChevronRight size={18} aria-hidden="true" /></button><button className="secondary" onClick={onMenu}>Ver cardápio</button></div></div><figure className="hero-photo"><img src={productImageSrc(day ?? {})} alt="Foto demonstrativa de brownie de chocolate com recheio cremoso" /><figcaption>Imagem demonstrativa — aguardando foto oficial</figcaption></figure></section><section className="agent-invite"><div><p className="eyebrow">ATENDIMENTO INTELIGENTE</p><h2>Converse com a assistente da Brownieria.</h2><p>Ela consulta o cardápio real, monta pedidos e orienta cada etapa.</p></div><button className="primary" onClick={onAgent}>Testar a assistente <MessageCircle size={18} aria-hidden="true" /></button></section><section className="day-feature"><p>🍫 BROWNIE DO DIA</p><h2>Hoje o destaque é {day?.name}</h2><span>Produzido nesta manhã · quantidade limitada</span><button onClick={() => day && onProduct(day)}>Conhecer o sabor</button></section><section className="section story"><p className="eyebrow">A NOSSA RECEITA DE TODO DIA</p><h2>Chocolate de verdade. Feito com carinho.</h2><p>Ingredientes selecionados, produção diária e aquela pausa gostosa que melhora o dia inteiro.</p></section><section className="section"><div className="section-title"><div><p className="eyebrow">MAIS PEDIDOS HOJE</p><h2>Quem experimenta volta.</h2></div><button className="text-button" onClick={onMenu}>Ver todos</button></div><div className="product-grid">{products.filter(p => p.isFeatured).slice(0, 3).map(p => <ProductCard key={p.id} product={p} quantity={quantityOf(p.id)} onClick={() => onProduct(p)} onAdd={() => onAdd(p)} />)}</div></section><section className="collections"><p className="eyebrow">PARA CADA VONTADE</p><h2>Uma caixa para dividir. Ou não.</h2><p>Em breve, monte combinações para presentear, compartilhar ou guardar só para você.</p><button className="secondary" onClick={onMenu}>Explorar sabores</button></section><section className="social-proof"><strong>Feitos em pequenos lotes, todos os dias.</strong><span>Números e avaliações reais serão exibidos aqui após validação da Brownieria.</span></section><section className="how"><p className="eyebrow">É MUITO SIMPLES ❤️</p><h2>Seu momento doce está a poucos passos.</h2><ol className="how-steps"><li>Escolha seus brownies.</li><li>Monte seu pedido.</li><li>Receba fresquinho.</li></ol></section><footer><span>Brownieria&nbsp;Fortal</span>{whatsappLink && <a className="footer-whatsapp" href={whatsappLink} target="_blank" rel="noopener noreferrer">Falar com a Brownieria pelo WhatsApp</a>}</footer></> }

type DemoChatMessage = { id: string; author: "agent" | "visitor"; text: string; metadata?: { pixKey?: string } };
function newDemoSessionId() { return crypto.randomUUID().replaceAll("-", ""); }
function AgentDemo({ onBack }: { onBack: () => void }) {
  const [sessionId, setSessionId] = useState(newDemoSessionId);
  const [messages, setMessages] = useState<DemoChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copiedPixKey, setCopiedPixKey] = useState<string | null>(null);
  const messagesViewportRef = useRef<HTMLDivElement | null>(null);
  const composerInputRef = useRef<HTMLInputElement | null>(null);
  const shouldStickToBottomRef = useRef(true);
  const initializedSessionRef = useRef("");
  const copiedPixTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const send = async (rawText: string) => {
    const text = rawText.trim();
    if (!text || loading) return;
    shouldStickToBottomRef.current = true;
    setError(""); setDraft(""); setLoading(true);
    setMessages(current => [...current, { id: `visitor-${crypto.randomUUID()}`, author: "visitor", text }]);
    try {
      const response = await api<{ messages: { id: string; text: string; metadata?: { pixKey?: string } }[] }>("/api/public/agent/messages", { method: "POST", body: JSON.stringify({ sessionId, text }) });
      setMessages(current => [...current, ...response.messages.map(message => ({ ...message, author: "agent" as const }))]);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Não foi possível falar com a assistente."); }
    finally { setLoading(false); }
  };
  const copyPixKey = async (pixKey: string) => {
    try {
      await navigator.clipboard.writeText(pixKey);
      setCopiedPixKey(pixKey);
      if (copiedPixTimerRef.current) clearTimeout(copiedPixTimerRef.current);
      copiedPixTimerRef.current = setTimeout(() => setCopiedPixKey(current => current === pixKey ? null : current), 1_800);
    } catch {
      setError("Não foi possível copiar a chave PIX. Tente selecionar e copiar o texto.");
    }
  };
  useEffect(() => () => { if (copiedPixTimerRef.current) clearTimeout(copiedPixTimerRef.current); }, []);
  useEffect(() => {
    const viewport = messagesViewportRef.current;
    if (!viewport || !shouldStickToBottomRef.current) return;
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: messages.length <= 1 ? "auto" : "smooth" });
  }, [messages, loading]);
  useEffect(() => {
    if (loading) return;
    requestAnimationFrame(() => composerInputRef.current?.focus({ preventScroll: true }));
  }, [loading, sessionId]);
  const handleMessagesScroll = () => {
    const viewport = messagesViewportRef.current;
    if (!viewport) return;
    shouldStickToBottomRef.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 56;
  };
  const restart = () => { const nextSession = newDemoSessionId(); setSessionId(nextSession); setMessages([]); setError(""); setDraft(""); };
  useEffect(() => {
    if (initializedSessionRef.current === sessionId) return;
    initializedSessionRef.current = sessionId;
    void send("Olá");
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps
  return <section className="section page agent-demo-page"><Back onClick={onBack} /><div className="agent-demo-heading"><div><p className="eyebrow">DEMONSTRAÇÃO AO VIVO</p><h1>A assistente que atende enquanto você produz.</h1><p className="subtle">Este chat usa o mesmo cérebro do atendimento. É uma simulação segura: nenhum pedido é enviado para a produção.</p></div><button className="secondary agent-reset" onClick={restart} disabled={loading}><RotateCcw size={16} aria-hidden="true" /> Recomeçar</button></div><div className="agent-chat" aria-label="Conversa com a assistente"><div className="agent-chat-top"><span className="agent-status"><i /> Assistente Brownieria</span><small>online para demonstração</small></div><div className="agent-messages" ref={messagesViewportRef} onScroll={handleMessagesScroll} aria-live="polite">{messages.map(message => <div className={`agent-message ${message.author}`} key={message.id}><div><span>{renderChatText(message.text)}</span>{message.author === "agent" && message.metadata?.pixKey && <button className="agent-copy-pix" type="button" onClick={() => void copyPixKey(message.metadata!.pixKey!)}>{copiedPixKey === message.metadata.pixKey ? "Copiado!" : "Copiar chave PIX"}</button>}</div></div>)}{loading && <div className="agent-message agent typing" aria-label="Assistente digitando"><span><i /><i /><i /></span></div>}</div><form className="agent-composer" onSubmit={event => { event.preventDefault(); void send(draft); }} aria-busy={loading}><input ref={composerInputRef} value={draft} onChange={event => setDraft(event.target.value)} placeholder="Escreva sua mensagem…" maxLength={1500} aria-label="Sua mensagem" autoComplete="off" autoFocus /><button className="primary" disabled={loading || !draft.trim()} aria-label="Enviar mensagem"><Send size={18} aria-hidden="true" /></button></form></div>{error && <p className="error">{error}</p>}<div className="agent-prompts"><span>Experimente:</span>{["Quais sabores vocês têm?", "Quero 2 brownies de brigadeiro", "Como posso pagar?"].map(prompt => <button key={prompt} className="choice" onClick={() => void send(prompt)} disabled={loading}>{prompt}</button>)}</div></section>;
}
function Menu({ products, cart, onBack, onProduct, onAdd }: { products: Product[]; cart: CartLine[]; onBack: () => void; onProduct: (p: Product) => void; onAdd: (p: Product) => void }) { const ordered = [...products].sort((a,b) => Number(b.slug === "brigadeiro") - Number(a.slug === "brigadeiro") || Number(b.isFeatured) - Number(a.isFeatured) || Number(b.isAvailable) - Number(a.isAvailable) || a.displayOrder - b.displayOrder); const quantityOf = (id: string) => cart.find(l => l.product.id === id)?.quantity ?? 0; return <section className="section page menu-page"><Back onClick={onBack} /><p className="eyebrow">CARDÁPIO ATUALIZADO</p><h1>Escolha seu momento doce.</h1><p className="subtle">Produzidos em pequenos lotes. Sabores disponíveis aparecem primeiro.</p><h2 className="sr-only">Sabores disponíveis</h2><div className="product-grid menu-grid">{ordered.map(p => <ProductCard key={p.id} product={p} isDay={p.slug === "brigadeiro"} quantity={quantityOf(p.id)} onClick={() => onProduct(p)} onAdd={() => onAdd(p)} />)}</div></section> }
function ProductCard({ product, isDay = false, quantity = 0, onClick, onAdd }: { key?: string; product: Product; isDay?: boolean; quantity?: number; onClick: () => void; onAdd?: () => void }) {
  const promo = product.promotionalPrice && product.minimumPromotionalQuantity;
  const inCart = quantity > 0;
  const [justAdded, setJustAdded] = useState(false);
  const addedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (addedTimer.current) clearTimeout(addedTimer.current); }, []);
  const handleAdd = () => { onAdd?.(); setJustAdded(true); if (addedTimer.current) clearTimeout(addedTimer.current); addedTimer.current = setTimeout(() => setJustAdded(false), 800); };
  return <article className={`product-card ${!product.isAvailable ? "sold-out" : ""}${inCart ? " in-cart" : ""}`}><button className="product-main" onClick={onClick}><div className="product-photo"><img loading="lazy" decoding="async" src={productImageSrc(product)} alt={`Imagem demonstrativa de ${product.name}`} />{isDay && <span className="day-badge">Brownie do Dia</span>}</div><div className="product-copy"><p className="product-category">{product.category}</p><h3>{product.name}</h3><p>{product.description}</p>{promo && <small className="promo">{formatCurrency(product.promotionalPrice!)} cada a partir de {product.minimumPromotionalQuantity} un. no pedido</small>}<strong>{formatCurrency(product.basePrice)}</strong></div></button><div className="product-footer"><span className={product.isAvailable ? "available" : "unavailable"}>{product.isAvailable ? "Disponível hoje" : "Indisponível hoje"}{inCart && <b className="in-cart-count"> · {quantity} no pedido<span className="sr-only"> — Este brownie já faz parte do seu pedido.</span></b>}</span>{onAdd && <button disabled={!product.isAvailable} className={`add-icon${justAdded ? " added" : inCart ? " in-cart-icon" : ""}`} onClick={handleAdd} aria-label={justAdded ? `${product.name} adicionado` : `Adicionar ${product.name}`}>{product.isAvailable ? (justAdded ? <Check size={18} aria-hidden="true" /> : <Plus size={18} aria-hidden="true" />) : "—"}</button>}</div></article>;
}
function ProductDetail({ product, recommendations, cart, onBack, onAdd }: { product: Product; recommendations: Product[]; cart: CartLine[]; onBack: () => void; onAdd: (p: Product, q: number) => void }) {
  const [quantity, setQuantity] = useState(1);
  const [justAdded, setJustAdded] = useState(false);
  const addedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (addedTimer.current) clearTimeout(addedTimer.current); }, []);
  const cartQuantity = cart.reduce((sum, line) => sum + line.quantity, 0);
  const price = calculateLinePrice(product, quantity, cartQuantity + quantity);
  const handleAdd = () => { onAdd(product, quantity); setJustAdded(true); if (addedTimer.current) clearTimeout(addedTimer.current); addedTimer.current = setTimeout(() => setJustAdded(false), 800); };
  return <section className="section page product-page"><Back onClick={onBack} /><figure className="product-hero-photo"><img src={productImageSrc(product)} alt={`Imagem demonstrativa de ${product.name}`} /><figcaption>Imagem demonstrativa — aguardando foto oficial</figcaption></figure><p className="eyebrow">FEITO ARTESANALMENTE</p><h1>{product.name}</h1>{!product.isAvailable && <span className="unavailable">Indisponível hoje</span>}<p className="detail-description">{product.description}</p><strong className="big-price">{formatCurrency(price.unitPrice)}</strong>{product.promotionalPrice && <p className="promo">Quanto mais brownies no pedido — de qualquer sabor —, melhor o preço: {formatCurrency(product.promotionalPrice)} cada a partir de {product.minimumPromotionalQuantity} unidades.</p>}<Info label="Ingredientes" value={product.ingredients} /><Info label="Alergênicos" value={product.allergens} /><div className="quantity"><button aria-label="Diminuir quantidade" onClick={() => setQuantity(q => Math.max(1, q - 1))}><Minus size={18} aria-hidden="true" /></button><b>{quantity}</b><button aria-label="Aumentar quantidade" onClick={() => setQuantity(q => q + 1)}><Plus size={18} aria-hidden="true" /></button></div><button disabled={!product.isAvailable} className="primary wide" onClick={handleAdd}>{!product.isAvailable ? "Indisponível hoje" : justAdded ? "✓ Adicionado" : `Adicionar ao pedido · ${formatCurrency(price.total)}`}</button><RelatedProducts products={recommendations} /></section>;
}
function RelatedProducts({ products }: { products: Product[] }) { return products.length ? <section className="related"><p className="eyebrow">COMBINA COM</p><h2>Outros favoritos da Brownieria</h2><div>{products.map(product => <span key={product.id}>{product.name}</span>)}</div></section> : null }
function Cart({ lines, subtotal, discount, onBack, onChange, onCheckout }: { lines: CartLine[]; subtotal: number; discount: number; onBack: () => void; onChange: (id: string, q: number) => void; onCheckout: () => void }) { const [confirmingClear, setConfirmingClear] = useState(false); const totalQuantity = lines.reduce((sum, line) => sum + line.quantity, 0); const promoLine = lines.find(line => line.product.minimumPromotionalQuantity !== null); const promotionHint = promoLine && totalQuantity < promoLine.product.minimumPromotionalQuantity! ? promoLine.product.minimumPromotionalQuantity! - totalQuantity : null; return <section className="section page cart-page"><Back onClick={onBack} /><p className="eyebrow">SEU PEDIDO</p><h1>Sua caixa está quase pronta.</h1>{lines.length === 0 ? <div className="empty"><GiftBox aria-hidden="true" /><h2>Ainda não tem brownie por aqui.</h2><p>Escolha seus sabores favoritos no cardápio.</p><button className="primary" onClick={onBack}>Ver sabores</button></div> : <>{promotionHint !== null && <p className="cart-nudge">Faltam {promotionHint} brownies para aproveitar o preço por quantidade.</p>}<h2 className="sr-only">Itens do pedido</h2><div className="cart-list">{lines.map(line => { const price = calculateLinePrice(line.product, line.quantity, totalQuantity); return <article className="cart-line" key={line.product.id}><img src={productImageSrc(line.product)} alt="Imagem demonstrativa" /><div><h3>{line.product.name}</h3><p>{formatCurrency(price.unitPrice)} cada</p><div className="quantity small"><button aria-label="Diminuir" onClick={() => onChange(line.product.id, line.quantity - 1)}><span className="qty-dot"><Minus size={14} aria-hidden="true" /></span></button><b>{line.quantity}</b><button aria-label="Aumentar" onClick={() => onChange(line.product.id, line.quantity + 1)}><span className="qty-dot"><Plus size={14} aria-hidden="true" /></span></button></div></div><strong>{formatCurrency(price.total)}</strong></article>; })}</div><Totals subtotal={subtotal} discount={discount} deliveryFee={0} /><button className="primary wide" onClick={onCheckout}>Continuar pedido <ChevronRight size={18} aria-hidden="true" /></button>{confirmingClear ? <p className="clear-confirm"><span>Remover todos os itens?</span><button className="link-danger" onClick={() => { lines.forEach(l => onChange(l.product.id, 0)); setConfirmingClear(false); }}>Sim, limpar</button><button className="text-button" onClick={() => setConfirmingClear(false)}>Cancelar</button></p> : <button className="link-danger" onClick={() => setConfirmingClear(true)}>Limpar pedido</button>}</>}</section> }
function Checkout({ business, lines, summary, onBack, onDone }: { business: Business; lines: CartLine[]; summary: { subtotal: number; discount: number }; onBack: () => void; onDone: (order: Order) => void }) { const [pickupMethod, setPickupMethod] = useState<"PESSOAL" | "UBER_MOTO">("PESSOAL"); const [payment, setPayment] = useState("PIX"); const [pickupTime, setPickupTime] = useState(""); const [loading, setLoading] = useState(false); const [error, setError] = useState("");
 const pickupSlots = Array.isArray(business.pickupSlots) ? business.pickupSlots.filter(slot => typeof slot === "string" && slot.trim().length > 0) : [];
 const whatsappLink = buildWhatsappLink(business.whatsapp);
 const submit = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); if (pickupSlots.length > 0 && !pickupTime) { setError("Escolha um horário para retirar seu pedido."); return; } setLoading(true); setError(""); const form = new FormData(event.currentTarget); try { const created = await api<Order>("/api/public/orders", { method: "POST", body: JSON.stringify({ items: lines.map(l => ({ productId: l.product.id, quantity: l.quantity })), customerName: form.get("name"), customerPhone: form.get("phone"), fulfillmentType: "RETIRADA", customerNotes: form.get("notes"), paymentMethod: payment, changeFor: form.get("change"), pickupTime }) }); onDone(created); } catch (e) { setError(e instanceof Error ? e.message : "Erro ao criar pedido."); } finally { setLoading(false); } };
 return <section className="section page checkout-page"><Back onClick={onBack} /><p className="eyebrow">FINALIZAR PEDIDO</p><h1>Para quem é essa delícia?</h1><p className="subtle">Só pedimos o necessário para preparar seu pedido com cuidado.</p><form className="checkout-form" onSubmit={submit}><label>Seu nome<input required name="name" autoComplete="name" maxLength={100} placeholder="Ex.: Maria Silva" /></label><label>Seu WhatsApp<input required name="phone" type="tel" autoComplete="tel" inputMode="tel" maxLength={30} placeholder="(85) 9 0000-0000" /></label><fieldset><legend>Como você vai retirar seu pedido?</legend><div className="choice-row"><button type="button" aria-pressed={pickupMethod === "PESSOAL"} className={pickupMethod === "PESSOAL" ? "choice active" : "choice"} onClick={() => setPickupMethod("PESSOAL")}>Vou retirar pessoalmente</button><button type="button" aria-pressed={pickupMethod === "UBER_MOTO"} className={pickupMethod === "UBER_MOTO" ? "choice active" : "choice"} onClick={() => setPickupMethod("UBER_MOTO")}>Vou solicitar Uber Moto</button></div>{pickupMethod === "UBER_MOTO" && <p className="cart-nudge">A Brownieria não realiza entregas. Depois que o pedido estiver pronto, você poderá solicitar um Uber Moto para fazer a retirada.</p>}</fieldset><fieldset><legend>Escolha o horário de retirada</legend>{pickupSlots.length === 0 ? (whatsappLink ? <p className="cart-nudge">Os horários de retirada ainda não estão disponíveis. <a href={whatsappLink} target="_blank" rel="noopener noreferrer">Fale com a Brownieria pelo WhatsApp</a></p> : <p className="cart-nudge">Os horários de retirada ainda não estão disponíveis. Entre em contato com a Brownieria.</p>) : <div className="choice-row" role="radiogroup" aria-label="Horário de retirada">{pickupSlots.map(slot => <button type="button" key={slot} aria-pressed={pickupTime === slot} className={pickupTime === slot ? "choice active" : "choice"} onClick={() => setPickupTime(slot)}>{slot}</button>)}</div>}</fieldset><fieldset><legend>Como você prefere pagar?</legend><div className="choice-row">{business.paymentMethods.map(method => <button type="button" key={method} aria-pressed={payment === method} className={payment === method ? "choice active" : "choice"} onClick={() => setPayment(method)}>{method === "A_COMBINAR" ? "A combinar" : method}</button>)}</div></fieldset>{payment === "DINHEIRO" && <label>Troco para qual valor?<input name="change" autoComplete="off" inputMode="decimal" placeholder="Opcional — ex.: 50" /></label>}<label>Algum detalhe importante?<textarea name="notes" autoComplete="off" maxLength={1000} placeholder="Opcional" /></label><Totals subtotal={summary.subtotal} discount={summary.discount} deliveryFee={0} />{error && <p className="error">{error}</p>}<button className="primary wide" disabled={loading}>{loading ? "Enviando…" : "Confirmar pedido"}</button></form></section> }
function Confirmation({ order, message, onMenu }: { order: Order; message: string; onMenu: () => void }) { const copy = () => navigator.clipboard?.writeText(`${order.publicCode} — ${formatCurrency(order.total)}`); return <section className="section page confirmation"><div className="check"><Check aria-hidden="true" /></div><p className="eyebrow">PEDIDO RECEBIDO</p><h1>Que delícia, está confirmado.</h1><p>{message || "Nossa equipe irá preparar seu pedido com todo cuidado."}</p><div className="code"><span>Número do pedido</span><strong>{order.publicCode}</strong><button onClick={copy}><Clipboard size={15} aria-hidden="true" /> Copiar código</button></div><div className="next-steps"><b>Próximos passos</b><p>Você escolheu {order.fulfillmentType === "RETIRADA" ? "retirada" : "entrega"} e pagamento {order.paymentMethod === "A_COMBINAR" ? "a combinar" : order.paymentMethod}. A equipe confirmará os detalhes em breve.</p>{order.pickupTime && <p>Horário de retirada: <b>{order.pickupTime}</b></p>}</div><Totals subtotal={order.subtotal} discount={order.discount} deliveryFee={order.deliveryFee} /><button className="primary wide" onClick={onMenu}>Voltar ao cardápio</button></section> }
function Totals({ subtotal, discount, deliveryFee }: { subtotal: number; discount: number; deliveryFee: number }) { return <div className="totals"><p><span>Subtotal</span><b>{formatCurrency(subtotal + discount)}</b></p>{discount > 0 && <p className="saving"><span>Economia</span><b>− {formatCurrency(discount)}</b></p>}{deliveryFee > 0 && <p><span>Entrega</span><b>{formatCurrency(deliveryFee)}</b></p>}<p className="total"><span>Total</span><b>{formatCurrency(subtotal + deliveryFee)}</b></p></div> }
function Info({ label, value }: { label: string; value?: string }) { return value ? <div className="info"><b>{label}</b><p>{value}</p></div> : null; }
function Back({ onClick }: { onClick: () => void }) { return <button className="back" onClick={onClick}><ArrowLeft size={18} aria-hidden="true" /> Voltar</button> }
