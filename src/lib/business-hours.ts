// Modelo estruturado de horário semanal de funcionamento/retirada — aditivo
// em relação ao campo livre `business.hours` (que continua existindo como
// exibição/fallback). Puro: nenhuma função aqui lê relógio, Store ou rede —
// isso é responsabilidade de operating-status.ts.

export type Weekday = "MON" | "TUE" | "WED" | "THU" | "FRI" | "SAT" | "SUN";

// Ordem começando no domingo — bate com Date.prototype.getDay() (0 = domingo)
// e é a base para navegar "dia seguinte"/"dia anterior" por aritmética modular.
export const WEEKDAYS_BY_JS_DAY: readonly Weekday[] = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
export const WEEKDAYS: readonly Weekday[] = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

export function weekdayFromJsDay(day: number): Weekday {
  return WEEKDAYS_BY_JS_DAY[((day % 7) + 7) % 7]!;
}

// offset positivo anda para o futuro, negativo para o passado (ex.: -1 = dia anterior).
export function shiftWeekday(weekday: Weekday, offset: number): Weekday {
  const index = WEEKDAYS_BY_JS_DAY.indexOf(weekday);
  return WEEKDAYS_BY_JS_DAY[((index + offset) % 7 + 7) % 7]!;
}

export const WEEKDAY_LABELS_PT_BR: Record<Weekday, string> = {
  MON: "segunda-feira",
  TUE: "terça-feira",
  WED: "quarta-feira",
  THU: "quinta-feira",
  FRI: "sexta-feira",
  SAT: "sábado",
  SUN: "domingo",
};

export type TimeRange = { open: string; close: string };

// Um dia sem nenhum intervalo é um dia fechado — não existe flag `closed`
// separada para não abrir espaço para os dois campos se contradizerem.
export type StructuredWeeklyHours = Record<Weekday, TimeRange[]>;

// Horário inicial pedido: seg-sex 08:00–18:00, sáb 08:00–12:00, dom fechado.
export const INITIAL_OPERATING_HOURS: StructuredWeeklyHours = {
  MON: [{ open: "08:00", close: "18:00" }],
  TUE: [{ open: "08:00", close: "18:00" }],
  WED: [{ open: "08:00", close: "18:00" }],
  THU: [{ open: "08:00", close: "18:00" }],
  FRI: [{ open: "08:00", close: "18:00" }],
  SAT: [{ open: "08:00", close: "12:00" }],
  SUN: [],
};

const TIME_FORMAT = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidTimeFormat(value: unknown): value is string {
  return typeof value === "string" && TIME_FORMAT.test(value);
}

export function timeToMinutes(time: string): number {
  const [hours, minutes] = time.split(":").map(Number);
  return hours! * 60 + minutes!;
}

// "08:00" -> "8h"; "18:00" -> "18h"; "09:30" -> "9h30" — sem hora zero à
// esquerda, sem ":00", no mesmo estilo informal usado nos exemplos do produto.
export function formatTimeBR(time: string): string {
  const [hoursRaw, minutesRaw] = time.split(":");
  const hours = Number(hoursRaw);
  return minutesRaw === "00" ? `${hours}h` : `${hours}h${minutesRaw}`;
}

// Texto curto para atendimento. Fica junto do modelo estruturado para que a
// resposta ao cliente e o cálculo de "aberto agora" usem a mesma fonte.
export function formatWeeklyHoursBR(hours: StructuredWeeklyHours): string {
  const formatDay = (weekday: Weekday) => {
    const ranges = hours[weekday];
    if (!ranges.length) return `${WEEKDAY_LABELS_PT_BR[weekday]}: fechado`;
    return `${WEEKDAY_LABELS_PT_BR[weekday]}: ${ranges.map(range => `${formatTimeBR(range.open)} às ${formatTimeBR(range.close)}`).join(" e ")}`;
  };
  return WEEKDAYS.map(formatDay).join("\n");
}

// Um intervalo que cruza a meia-noite (close <= open) é dividido em dois
// segmentos absolutos dentro do dia — [open, 24:00) e [00:00, close) — para
// que sobreposição e "está dentro do intervalo agora" nunca façam a
// comparação ingênua "HH:mm" < "HH:mm" que quebra nesse caso.
function segmentsOfRange(range: TimeRange): Array<[number, number]> {
  const open = timeToMinutes(range.open);
  const close = timeToMinutes(range.close);
  if (close <= open) return [[open, 24 * 60], [0, close]];
  return [[open, close]];
}

function segmentsOverlap(a: [number, number], b: [number, number]): boolean {
  const [aStart, aEnd] = a;
  const [bStart, bEnd] = b;
  return aStart < bEnd && bStart < aEnd;
}

function rangesOverlap(a: TimeRange, b: TimeRange): boolean {
  const segmentsA = segmentsOfRange(a);
  const segmentsB = segmentsOfRange(b);
  return segmentsA.some(segA => segmentsB.some(segB => segmentsOverlap(segA, segB)));
}

export type BusinessHoursValidationError = {
  weekday: Weekday;
  index?: number;
  code: "INVALID_SHAPE" | "INCOMPLETE" | "INVALID_FORMAT" | "EQUAL_TIMES" | "OVERLAP";
  message: string;
};

// Validação completa e determinística do modelo estruturado — mesma função
// usada pelo backend (antes de salvar) e disponível para o painel usar como
// referência de validação client-side. Nunca lança: sempre devolve uma lista
// (vazia quando válido).
export function validateStructuredWeeklyHours(hours: unknown): BusinessHoursValidationError[] {
  if (!hours || typeof hours !== "object" || Array.isArray(hours)) {
    return [{ weekday: "MON", code: "INVALID_SHAPE", message: "Horário estruturado inválido: esperado um objeto por dia da semana." }];
  }
  const record = hours as Record<string, unknown>;
  const errors: BusinessHoursValidationError[] = [];

  for (const weekday of WEEKDAYS) {
    const ranges = record[weekday];
    if (ranges === undefined) {
      errors.push({ weekday, code: "INVALID_SHAPE", message: `Falta a lista de intervalos de ${WEEKDAY_LABELS_PT_BR[weekday]}.` });
      continue;
    }
    if (!Array.isArray(ranges)) {
      errors.push({ weekday, code: "INVALID_SHAPE", message: `Os intervalos de ${WEEKDAY_LABELS_PT_BR[weekday]} devem ser uma lista.` });
      continue;
    }

    const validRanges: Array<TimeRange & { index: number }> = [];
    ranges.forEach((raw, index) => {
      const candidate = (raw ?? {}) as Partial<TimeRange>;
      const { open, close } = candidate;
      if (open === undefined || open === null || open === "" || close === undefined || close === null || close === "") {
        errors.push({ weekday, index, code: "INCOMPLETE", message: "Informe o horário de abertura e de encerramento." });
        return;
      }
      if (!isValidTimeFormat(open) || !isValidTimeFormat(close)) {
        errors.push({ weekday, index, code: "INVALID_FORMAT", message: "Use o formato HH:mm (ex.: 08:00)." });
        return;
      }
      if (open === close) {
        errors.push({ weekday, index, code: "EQUAL_TIMES", message: "O horário de abertura e o de encerramento não podem ser iguais." });
        return;
      }
      validRanges.push({ open, close, index });
    });

    for (let i = 0; i < validRanges.length; i += 1) {
      for (let j = i + 1; j < validRanges.length; j += 1) {
        if (rangesOverlap(validRanges[i]!, validRanges[j]!)) {
          errors.push({
            weekday,
            index: validRanges[j]!.index,
            code: "OVERLAP",
            message: "Esse intervalo se sobrepõe a outro já cadastrado no mesmo dia.",
          });
        }
      }
    }
  }

  return errors;
}

export function isStructuredWeeklyHours(value: unknown): value is StructuredWeeklyHours {
  return validateStructuredWeeklyHours(value).length === 0;
}
