const DEFAULT_MESSAGE = "Olá! Vim pelo cardápio da Brownieria Fortal e gostaria de tirar uma dúvida.";

export function normalizeWhatsappNumber(raw: string | undefined | null): string {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("55") && digits.length >= 12) return digits;
  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  return digits;
}

export function buildWhatsappLink(raw: string | undefined | null, message: string = DEFAULT_MESSAGE): string | null {
  const number = normalizeWhatsappNumber(raw);
  if (!number) return null;
  return `https://wa.me/${number}?text=${encodeURIComponent(message)}`;
}
