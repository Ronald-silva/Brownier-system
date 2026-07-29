import crypto from "node:crypto";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { createServer as createViteServer } from "vite";
import { type PricingProduct } from "./src/lib/pricing.ts";
import { ORDER_STATUSES } from "./src/lib/orderStatuses.ts";
import { resolveStorePath, loadStoreFile, saveStoreFile } from "./src/lib/store.ts";
import { createOrder, OrderCreationError, type Order } from "./src/lib/orders.ts";

type Product = PricingProduct & {
  id: string; slug: string; description: string; category: string; imageUrl: string;
  isActive: boolean; isAvailable: boolean; isFeatured: boolean; isDay?: boolean; displayOrder: number;
  ingredients?: string; allergens?: string; updatedAt: string;
};
type Store = {
  business: Record<string, unknown>;
  products: Product[];
  orders: Order[];
};

const storePath = resolveStorePath();
const orderStatuses = ORDER_STATUSES;
const limitedRequests = new Map<string, { count: number; started: number }>();

const IS_PRODUCTION = process.env.NODE_ENV === "production";
const INSECURE_DEFAULT_ADMIN_CODE = "brownies-demo";
const ADMIN_SESSION_TTL_MS = Number(process.env.ADMIN_SESSION_TTL_MS) > 0 ? Number(process.env.ADMIN_SESSION_TTL_MS) : 4 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = Number(process.env.ADMIN_LOGIN_WINDOW_MS) > 0 ? Number(process.env.ADMIN_LOGIN_WINDOW_MS) : 10 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;
const loginAttempts = new Map<string, { count: number; started: number }>();
const adminSessionSecret = crypto.randomBytes(32);
let resolvedAdminAccessCode: string;

// Falha alto e explicitamente em produção em vez de aceitar o código de demo
// conhecido publicamente — chamada uma única vez, antes do app.listen, para
// que um ADMIN_ACCESS_CODE ausente ou inseguro impeça o servidor de subir.
function initializeAdminAuth() {
  const configured = process.env.ADMIN_ACCESS_CODE?.trim() || "";
  if (IS_PRODUCTION) {
    if (!configured) throw new Error("ADMIN_ACCESS_CODE precisa estar definido em produção. Defina uma variável de ambiente forte antes de iniciar o servidor.");
    if (configured === INSECURE_DEFAULT_ADMIN_CODE) throw new Error("ADMIN_ACCESS_CODE não pode usar o valor padrão de demonstração em produção. Defina um código forte e exclusivo.");
    resolvedAdminAccessCode = configured;
  } else {
    resolvedAdminAccessCode = configured || INSECURE_DEFAULT_ADMIN_CODE;
  }
}
function secureCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a); const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
function loginAttemptRecord(ip: string) {
  const now = Date.now(); const entry = loginAttempts.get(ip);
  return !entry || now - entry.started > LOGIN_WINDOW_MS ? { count: 0, started: now } : entry;
}
// Token opaco assinado (HMAC) contendo apenas um timestamp de expiração — nunca
// o código administrativo — e verificado com comparação de tempo constante.
function signSessionPayload(payload: string): string {
  return crypto.createHmac("sha256", adminSessionSecret).update(payload).digest("base64url");
}
function createAdminSessionToken(): string {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + ADMIN_SESSION_TTL_MS }), "utf8").toString("base64url");
  return `${payload}.${signSessionPayload(payload)}`;
}
function verifyAdminSessionToken(token: string | undefined): boolean {
  if (!token) return false;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return false;
  if (!secureCompare(signature, signSessionPayload(payload))) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: number };
    return typeof data.exp === "number" && Date.now() < data.exp;
  } catch { return false; }
}

const demoStore: Store = {
  business: {
    name: "Brownieria Fortal", tagline: "Brownies artesanais para tornar seu dia mais doce", description: "Veja os sabores disponíveis hoje e monte seu pedido em poucos minutos.",
    phone: "", whatsapp: "", address: "", hours: "", instagram: "", pickupEnabled: true, deliveryEnabled: true,
    pickupSlots: [],
    paymentMethods: ["PIX", "DINHEIRO", "A_COMBINAR"], deliveryFee: 0,
    receivedMessage: "Recebemos seu pedido! A equipe vai confirmar os detalhes em breve.",
    availabilityNotice: "Os sabores podem variar conforme a disponibilidade.",
    isDemo: true,
  },
  products: [
    ["brigadeiro", "Brownie de Brigadeiro", "Brownie artesanal finalizado com brigadeiro cremoso.", 5, true, "Chocolate, brigadeiro, farinha, ovos e manteiga", "Contém glúten, leite e ovos"],
    ["ninho", "Brownie de Ninho", "Brownie de chocolate com cobertura de leite em pó.", 5, true, "Chocolate, leite em pó, farinha, ovos e manteiga", "Contém glúten, leite e ovos"],
    ["oreo", "Brownie de Oreo", "Brownie com pedaços de biscoito de chocolate.", 5, true, "Chocolate, biscoito, farinha, ovos e manteiga", "Contém glúten, leite e ovos"],
    ["prestigio", "Brownie de Prestígio", "Chocolate e coco em uma combinação clássica.", 5, true, "Chocolate, coco, farinha, ovos e manteiga", "Contém glúten, leite e ovos"],
    ["ovomaltine", "Brownie de Ovomaltine", "Brownie de chocolate com cobertura crocante de Ovomaltine.", 5, true, "Chocolate, Ovomaltine, farinha, ovos e manteiga", "Contém glúten, leite, ovos e amendoim"],
    ["doce-de-leite", "Brownie de Doce de Leite", "Brownie macio com doce de leite cremoso.", 5, true, "Chocolate, doce de leite, farinha, ovos e manteiga", "Contém glúten, leite e ovos"],
  ].map(([slug, name, description, basePrice, available, ingredients, allergens], index) => ({
    id: `demo-${slug}`, slug: String(slug), name: String(name), description: String(description), category: "Brownies", imageUrl: "",
    basePrice: Number(basePrice), promotionalPrice: 3, minimumPromotionalQuantity: 20,
    isActive: true, isAvailable: Boolean(available), isFeatured: index < 3, isDay: slug === "brigadeiro", displayOrder: index + 1,
    ingredients: String(ingredients), allergens: String(allergens), updatedAt: new Date().toISOString(),
  })),
  orders: [],
};

async function loadStore(): Promise<Store> { return loadStoreFile(storePath, () => demoStore); }
async function saveStore(store: Store) { return saveStoreFile(storePath, store); }
function publicProduct(product: Product) {
  const { id, slug, name, description, category, imageUrl, basePrice, promotionalPrice, minimumPromotionalQuantity, isAvailable, isFeatured, displayOrder, ingredients, allergens, updatedAt } = product;
  return { id, slug, name, description, category, imageUrl, basePrice, promotionalPrice, minimumPromotionalQuantity, isAvailable, isFeatured, displayOrder, ingredients, allergens, updatedAt };
}
function validText(value: unknown, max: number) { return typeof value === "string" && value.trim().length > 0 && value.trim().length <= max; }
function admin(req: Request, res: Response, next: NextFunction) {
  const header = req.header("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
  if (!verifyAdminSessionToken(token)) return res.status(401).json({ error: "Sessão administrativa inválida ou expirada." });
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
  initializeAdminAuth();
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    if (req.path === "/api/admin/products" || req.path.startsWith("/api/admin/products/")) return next();
    express.json({ limit: "64kb" })(req, res, next);
  });
  const adminProductBody = express.json({ limit: "8mb" });

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "brownier", timestamp: new Date().toISOString() });
  });

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
    const store = await loadStore();
    try {
      const { order, replayed } = createOrder({
        store,
        payload: req.body ?? {},
        idempotencyKey: req.header("Idempotency-Key"),
        generatePublicCode: publicCode,
      });
      if (!replayed) await saveStore(store);
      res.setHeader("Idempotency-Replayed", replayed ? "true" : "false");
      res.status(replayed ? 200 : 201).json(order);
    } catch (error) {
      if (error instanceof OrderCreationError) return res.status(error.status).json({ error: error.message });
      console.error(error);
      res.status(500).json({ error: "Não foi possível criar o pedido." });
    }
  });

  app.post("/api/admin/login", (req, res) => {
    const ip = req.ip || "unknown";
    const record = loginAttemptRecord(ip);
    if (record.count >= LOGIN_MAX_ATTEMPTS) { loginAttempts.set(ip, record); return res.status(429).json({ error: "Muitas tentativas. Tente novamente mais tarde." }); }
    const code = typeof req.body?.code === "string" ? req.body.code : "";
    if (!code || !secureCompare(code, resolvedAdminAccessCode)) { record.count += 1; loginAttempts.set(ip, record); return res.status(401).json({ error: "Código de acesso inválido." }); }
    loginAttempts.delete(ip);
    res.json({ token: createAdminSessionToken(), expiresIn: ADMIN_SESSION_TTL_MS });
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

  let closeVite: (() => Promise<void>) | undefined;
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
    closeVite = () => vite.close();
    app.use(vite.middlewares);
  }
  else { const distPath = path.join(process.cwd(), "dist"); app.use(express.static(distPath)); app.get("*", (_req, res) => res.sendFile(path.join(distPath, "index.html"))); }
  const port = Number(process.env.PORT) || 3000;
  const server = app.listen(port, "0.0.0.0", () => console.log(`Brownies Fortal em http://0.0.0.0:${port}`));
  let shuttingDown = false;
  const shutdown = (signal: "SIGTERM" | "SIGINT") => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Recebido ${signal}; encerrando servidor HTTP.`);
    const closeHttpServer = new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    void Promise.all([closeHttpServer, closeVite?.() ?? Promise.resolve()])
      .then(() => console.log("Servidor HTTP encerrado."))
      .catch((error: unknown) => {
        console.error("Falha ao encerrar o servidor HTTP.", error);
        process.exitCode = 1;
      });
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
  return server;
}
startServer().catch(error => { console.error(error); process.exitCode = 1; });
