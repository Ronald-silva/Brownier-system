import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { createServer as createViteServer } from "vite";
import { calculateLinePrice, type PricingProduct } from "./src/lib/pricing.ts";
import { ORDER_STATUSES } from "./src/lib/orderStatuses.ts";

type Product = PricingProduct & {
  id: string; slug: string; description: string; category: string; imageUrl: string;
  isActive: boolean; isAvailable: boolean; isFeatured: boolean; isDay?: boolean; displayOrder: number;
  ingredients?: string; allergens?: string; updatedAt: string;
};
type Store = {
  business: Record<string, unknown>;
  products: Product[];
  orders: Array<Record<string, unknown>>;
};

const storePath = path.join(process.cwd(), "data", "brownies-fortal.demo.json");
const orderStatuses = ORDER_STATUSES;
const limitedRequests = new Map<string, { count: number; started: number }>();

const demoStore: Store = {
  business: {
    name: "Brownieria Fortal", tagline: "Brownies artesanais para tornar seu dia mais doce", description: "Veja os sabores disponíveis hoje e monte seu pedido em poucos minutos.",
    phone: "", whatsapp: "", address: "", hours: "", instagram: "", pickupEnabled: true, deliveryEnabled: true,
    paymentMethods: ["PIX", "DINHEIRO", "A_COMBINAR"], deliveryFee: 0,
    receivedMessage: "Recebemos seu pedido! A equipe vai confirmar os detalhes em breve.",
    availabilityNotice: "Os sabores podem variar conforme a disponibilidade.",
    isDemo: true,
  },
  products: [
    ["tradicional", "Brownie Tradicional", "Massa intensa de chocolate com casquinha delicada.", 700, true, "Chocolate meio amargo, farinha, ovos e manteiga", "Contém glúten, leite e ovos"],
    ["brigadeiro", "Brownie de Brigadeiro", "Brownie artesanal finalizado com brigadeiro cremoso.", 800, true, "Chocolate, brigadeiro, farinha, ovos e manteiga", "Contém glúten, leite e ovos"],
    ["ninho", "Brownie de Ninho", "Brownie de chocolate com cobertura de leite em pó.", 800, true, "Chocolate, leite em pó, farinha, ovos e manteiga", "Contém glúten, leite e ovos"],
    ["oreo", "Brownie de Oreo", "Brownie com pedaços de biscoito de chocolate.", 850, false, "Chocolate, biscoito, farinha, ovos e manteiga", "Contém glúten, leite e ovos"],
    ["doce-de-leite", "Brownie de Doce de Leite", "Brownie macio com doce de leite cremoso.", 850, true, "Chocolate, doce de leite, farinha, ovos e manteiga", "Contém glúten, leite e ovos"],
    ["prestigio", "Brownie de Prestígio", "Chocolate e coco em uma combinação clássica.", 850, true, "Chocolate, coco, farinha, ovos e manteiga", "Contém glúten, leite e ovos"],
  ].map(([slug, name, description, basePrice, available, ingredients, allergens], index) => ({
    id: `demo-${slug}`, slug: String(slug), name: String(name), description: String(description), category: "Brownies", imageUrl: "",
    basePrice: Number(basePrice), promotionalPrice: index < 2 ? 600 : null, minimumPromotionalQuantity: index < 2 ? 4 : null,
    isActive: true, isAvailable: Boolean(available), isFeatured: index < 3, isDay: slug === "brigadeiro", displayOrder: index + 1,
    ingredients: String(ingredients), allergens: String(allergens), updatedAt: new Date().toISOString(),
  })),
  orders: [],
};

async function loadStore(): Promise<Store> {
  try { return JSON.parse(await fs.readFile(storePath, "utf8")) as Store; }
  catch { await saveStore(demoStore); return structuredClone(demoStore); }
}
async function saveStore(store: Store) {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify(store, null, 2) + "\n", "utf8");
}
function publicProduct(product: Product) {
  const { id, slug, name, description, category, imageUrl, basePrice, promotionalPrice, minimumPromotionalQuantity, isAvailable, isFeatured, displayOrder, ingredients, allergens, updatedAt } = product;
  return { id, slug, name, description, category, imageUrl, basePrice, promotionalPrice, minimumPromotionalQuantity, isAvailable, isFeatured, displayOrder, ingredients, allergens, updatedAt };
}
function validText(value: unknown, max: number) { return typeof value === "string" && value.trim().length > 0 && value.trim().length <= max; }
function admin(req: Request, res: Response, next: NextFunction) {
  const configured = process.env.ADMIN_ACCESS_CODE;
  const expected = configured || "brownies-demo";
  if (req.header("x-admin-code") !== expected) return res.status(401).json({ error: "Acesso administrativo não autorizado." });
  next();
}
function publicRateLimit(req: Request, res: Response, next: NextFunction) {
  const key = req.ip || "unknown"; const now = Date.now(); const entry = limitedRequests.get(key);
  const current = !entry || now - entry.started > 60_000 ? { count: 1, started: now } : { ...entry, count: entry.count + 1 };
  limitedRequests.set(key, current);
  if (current.count > 20) return res.status(429).json({ error: "Muitas tentativas. Aguarde um instante." });
  next();
}
function publicCode() { return `BF-${crypto.randomBytes(4).toString("hex").toUpperCase()}`; }

async function startServer() {
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    if (req.path === "/api/admin/products" || req.path.startsWith("/api/admin/products/")) return next();
    express.json({ limit: "64kb" })(req, res, next);
  });
  const adminProductBody = express.json({ limit: "8mb" });

  app.get("/api/public/business", async (_req, res) => res.json((await loadStore()).business));
  app.get("/api/public/menu", async (_req, res) => {
    const store = await loadStore();
    res.json(store.products.filter(p => p.isActive).sort((a, b) => a.displayOrder - b.displayOrder).map(publicProduct));
  });
  app.get("/api/public/products/:id", async (req, res) => {
    const product = (await loadStore()).products.find(p => (p.id === req.params.id || p.slug === req.params.id) && p.isActive);
    if (!product) return res.status(404).json({ error: "Produto não encontrado." });
    res.json(publicProduct(product));
  });
  app.get("/api/public/promotions", async (_req, res) => {
    const products = (await loadStore()).products.filter(p => p.isActive && p.promotionalPrice && p.minimumPromotionalQuantity).map(publicProduct);
    res.json(products);
  });
  app.get("/api/public/orders/:publicCode", publicRateLimit, async (req, res) => {
    const order = (await loadStore()).orders.find(o => o.publicCode === req.params.publicCode);
    if (!order) return res.status(404).json({ error: "Pedido não encontrado." });
    const { customerPhone, deliveryAddress, reference, customerNotes, internalNotes, ...safe } = order;
    res.json(safe);
  });
  app.post("/api/public/orders", publicRateLimit, async (req, res) => {
    const { items, customerName, customerPhone, fulfillmentType, deliveryAddress = "", reference = "", customerNotes = "", paymentMethod, changeFor } = req.body ?? {};
    if (!Array.isArray(items) || items.length === 0 || items.length > 30) return res.status(400).json({ error: "O pedido precisa ter pelo menos um item." });
    if (!validText(customerName, 100) || !validText(customerPhone, 30)) return res.status(400).json({ error: "Informe nome e telefone." });
    if (!["RETIRADA", "ENTREGA"].includes(fulfillmentType) || !["PIX", "DINHEIRO", "A_COMBINAR"].includes(paymentMethod)) return res.status(400).json({ error: "Recebimento ou pagamento inválido." });
    const store = await loadStore(); const business = store.business as { pickupEnabled?: boolean; deliveryEnabled?: boolean; deliveryFee?: number };
    if (fulfillmentType === "ENTREGA" && (!business.deliveryEnabled || !validText(deliveryAddress, 300))) return res.status(400).json({ error: "Informe o endereço de entrega." });
    if (fulfillmentType === "RETIRADA" && !business.pickupEnabled) return res.status(400).json({ error: "Retirada indisponível no momento." });
    const orderItems = [] as Array<Record<string, unknown>>; let subtotal = 0; let discount = 0;
    for (const item of items) {
      const quantity = Number(item?.quantity); const product = store.products.find(p => p.id === item?.productId && p.isActive && p.isAvailable);
      if (!product || !Number.isInteger(quantity) || quantity < 1 || quantity > 100) return res.status(400).json({ error: "Há um produto indisponível ou uma quantidade inválida." });
      const price = calculateLinePrice(product, quantity); subtotal += price.total; discount += price.discount;
      orderItems.push({ productId: product.id, productName: product.name, unitPrice: price.unitPrice, quantity, totalPrice: price.total });
    }
    const deliveryFee = fulfillmentType === "ENTREGA" ? Number(business.deliveryFee || 0) : 0;
    const order = { id: crypto.randomUUID(), publicCode: publicCode(), status: "NOVO", fulfillmentType, paymentMethod, subtotal, discount, deliveryFee, total: subtotal + deliveryFee, customerName: customerName.trim(), customerPhone: customerPhone.trim(), deliveryAddress: deliveryAddress.trim(), reference: reference.trim(), customerNotes: customerNotes.trim(), internalNotes: "", changeFor: typeof changeFor === "string" ? changeFor.trim() : "", items: orderItems, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    store.orders.unshift(order); await saveStore(store); res.status(201).json(order);
  });

  app.get("/api/admin/bootstrap", admin, async (_req, res) => res.json(await loadStore()));
  app.put("/api/admin/business", admin, async (req, res) => {
    const store = await loadStore(); store.business = { ...store.business, ...req.body, name: "Brownieria Fortal" }; await saveStore(store); res.json(store.business);
  });
  app.post("/api/admin/products", admin, adminProductBody, async (req, res) => {
    const store = await loadStore(); const body = req.body ?? {};
    if (!validText(body.name, 100)) return res.status(400).json({ error: "Nome do produto é obrigatório." });
    const id = crypto.randomUUID(); const product: Product = { id, slug: String(body.slug || body.name).toLowerCase().normalize("NFD").replace(/[\\u0300-\\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""), name: body.name.trim(), description: String(body.description || "").trim(), category: String(body.category || "Brownies").trim(), imageUrl: "", basePrice: Number(body.basePrice || 0), promotionalPrice: body.promotionalPrice === null || body.promotionalPrice === "" ? null : Number(body.promotionalPrice), minimumPromotionalQuantity: body.minimumPromotionalQuantity === null || body.minimumPromotionalQuantity === "" ? null : Number(body.minimumPromotionalQuantity), isActive: body.isActive !== false, isAvailable: body.isAvailable !== false, isFeatured: Boolean(body.isFeatured), displayOrder: Number(body.displayOrder || store.products.length + 1), ingredients: String(body.ingredients || ""), allergens: String(body.allergens || ""), updatedAt: new Date().toISOString() };
    store.products.push(product); await saveStore(store); res.status(201).json(product);
  });
  app.put("/api/admin/products/:id", admin, adminProductBody, async (req, res) => {
    const store = await loadStore(); const index = store.products.findIndex(p => p.id === req.params.id); if (index < 0) return res.status(404).json({ error: "Produto não encontrado." });
    const current = store.products[index]; const body = req.body ?? {}; const merged = { ...current, ...body, id: current.id, updatedAt: new Date().toISOString() } as Product;
    if (!validText(merged.name, 100) || !Number.isFinite(Number(merged.basePrice)) || Number(merged.basePrice) < 0) return res.status(400).json({ error: "Dados do produto inválidos." });
    store.products[index] = merged; await saveStore(store); res.json(merged);
  });
  app.delete("/api/admin/products/:id", admin, async (req, res) => { const store = await loadStore(); const before = store.products.length; store.products = store.products.filter(p => p.id !== req.params.id); if (before === store.products.length) return res.status(404).json({ error: "Produto não encontrado." }); await saveStore(store); res.status(204).end(); });
  app.put("/api/admin/orders/:id", admin, async (req, res) => { const store = await loadStore(); const order = store.orders.find(o => o.id === req.params.id); if (!order) return res.status(404).json({ error: "Pedido não encontrado." }); if (req.body.status && !orderStatuses.includes(req.body.status)) return res.status(400).json({ error: "Status inválido." }); Object.assign(order, { status: req.body.status ?? order.status, internalNotes: typeof req.body.internalNotes === "string" ? req.body.internalNotes.slice(0, 1000) : order.internalNotes, updatedAt: new Date().toISOString() }); await saveStore(store); res.json(order); });

  if (process.env.NODE_ENV !== "production") { const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" }); app.use(vite.middlewares); }
  else { const distPath = path.join(process.cwd(), "dist"); app.use(express.static(distPath)); app.get("*", (_req, res) => res.sendFile(path.join(distPath, "index.html"))); }
  app.listen(Number(process.env.PORT || 3000), "0.0.0.0", () => console.log("Brownies Fortal em http://localhost:3000"));
}
startServer().catch(error => { console.error(error); process.exitCode = 1; });
