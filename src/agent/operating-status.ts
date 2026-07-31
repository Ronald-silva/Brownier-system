// Cálculo determinístico de "está aberto agora" — a única fonte de verdade
// sobre horário de funcionamento/retirada. Nunca é o modelo (NVIDIA) quem
// decide isso: este módulo só lê um relógio real (`now`, sempre um Date
// injetado) e o horário estruturado cadastrado, nunca infere nem hardcoda
// hora nenhuma. Conversão de timezone via Intl nativo do Node — sem
// dependência nova — para que o cálculo seja correto mesmo quando o processo
// roda em UTC (ex.: Railway).
import {
  type StructuredWeeklyHours,
  type TimeRange,
  type Weekday,
  shiftWeekday,
  timeToMinutes,
} from "../lib/business-hours.ts";

export const OPERATING_STATUS_TIMEZONE = "America/Fortaleza" as const;

export type OperatingStatus =
  | { known: false }
  | {
      known: true;
      isOpenNow: boolean;
      nowLocal: string; // ISO 8601 com offset, ex. "2026-07-31T01:00:00-03:00"
      weekday: Weekday;
      timezone: typeof OPERATING_STATUS_TIMEZONE;
      currentClose: string | null; // "HH:mm" do intervalo em que estamos agora, só quando isOpenNow
      nextOpen: { weekday: Weekday; time: string; sameDay: boolean } | null;
      closedReason: "DAY_CLOSED" | "OUTSIDE_HOURS" | null;
    };

const WEEKDAY_FROM_SHORT_EN: Record<string, Weekday> = {
  Sun: "SUN", Mon: "MON", Tue: "TUE", Wed: "WED", Thu: "THU", Fri: "FRI", Sat: "SAT",
};

// Resolve dia da semana, minutos desde meia-noite e um ISO 8601 com offset —
// tudo a partir das partes já calculadas pelo Intl no timezone alvo, nunca a
// partir do relógio/fuso do processo. `timeZoneName: "longOffset"` devolve
// algo como "GMT-03:00", de onde extraímos o offset real (evita hardcodar
// "-03:00", embora América/Fortaleza não observe horário de verão hoje).
function fortalezaSnapshot(now: Date): { weekday: Weekday; minutes: number; nowLocal: string } {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: OPERATING_STATUS_TIMEZONE,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  });
  const parts = formatter.formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)?.value ?? "";

  const weekday = WEEKDAY_FROM_SHORT_EN[get("weekday")] ?? "SUN";
  const hour = Number(get("hour"));
  const minute = Number(get("minute"));
  const minutes = hour * 60 + minute;

  const offsetMatch = /GMT([+-]\d{2}:\d{2})/.exec(get("timeZoneName"));
  const offset = offsetMatch ? offsetMatch[1]! : "-03:00";
  const nowLocal = `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}${offset}`;

  return { weekday, minutes, nowLocal };
}

// Cobertura pelo próprio dia: intervalos normais checam [open, close);
// intervalos que cruzam meia-noite (close <= open) cobrem só a parte da
// noite desse mesmo dia, [open, 24:00) — a madrugada seguinte pertence ao dia
// seguinte, resolvida por `coveredByCarryover`.
function coveredByOwnDay(minutes: number, range: TimeRange): boolean {
  const open = timeToMinutes(range.open);
  const close = timeToMinutes(range.close);
  if (close <= open) return minutes >= open;
  return minutes >= open && minutes < close;
}

// Cobertura pelo dia anterior: só se aplica quando o intervalo de ONTEM
// cruzava a meia-noite — nesse caso a madrugada de HOJE, até `close`, ainda
// faz parte daquele intervalo. É a correção explícita para não analisar só
// os intervalos do dia atual (ex.: 00:20 de terça também precisa checar o
// intervalo iniciado segunda às 23h).
function coveredByCarryover(minutes: number, range: TimeRange): boolean {
  const open = timeToMinutes(range.open);
  const close = timeToMinutes(range.close);
  if (close <= open) return minutes < close;
  return false;
}

function findNextOpen(hours: StructuredWeeklyHours, weekday: Weekday, minutes: number): { weekday: Weekday; time: string; sameDay: boolean } | null {
  const todayRanges = [...(hours[weekday] ?? [])].sort((a, b) => timeToMinutes(a.open) - timeToMinutes(b.open));
  for (const range of todayRanges) {
    if (timeToMinutes(range.open) > minutes) return { weekday, time: range.open, sameDay: true };
  }
  // offset 1..7 cobre toda a semana seguinte, incluindo o "wrap around" de
  // volta ao próprio dia (offset 7) — necessário quando só esse dia tem
  // horário cadastrado e o horário de hoje já passou: a próxima abertura real
  // é o mesmo dia da semana que vem, não "nunca".
  for (let offset = 1; offset <= 7; offset += 1) {
    const targetDay = shiftWeekday(weekday, offset);
    const ranges = [...(hours[targetDay] ?? [])].sort((a, b) => timeToMinutes(a.open) - timeToMinutes(b.open));
    if (ranges.length > 0) return { weekday: targetDay, time: ranges[0]!.open, sameDay: false };
  }
  return null;
}

export function getOperatingStatus(input: {
  now: Date;
  hours: StructuredWeeklyHours | undefined;
}): OperatingStatus {
  const { now, hours } = input;
  if (!hours) return { known: false };

  const { weekday, minutes, nowLocal } = fortalezaSnapshot(now);
  const yesterday = shiftWeekday(weekday, -1);
  const todayRanges = hours[weekday] ?? [];
  const yesterdayRanges = hours[yesterday] ?? [];

  let currentClose: string | null = null;
  for (const range of todayRanges) {
    if (coveredByOwnDay(minutes, range)) { currentClose = range.close; break; }
  }
  if (currentClose === null) {
    for (const range of yesterdayRanges) {
      if (coveredByCarryover(minutes, range)) { currentClose = range.close; break; }
    }
  }

  const isOpenNow = currentClose !== null;
  let closedReason: "DAY_CLOSED" | "OUTSIDE_HOURS" | null = null;
  if (!isOpenNow) {
    const yesterdayHasCrossingRange = yesterdayRanges.some(range => timeToMinutes(range.close) <= timeToMinutes(range.open));
    closedReason = todayRanges.length === 0 && !yesterdayHasCrossingRange ? "DAY_CLOSED" : "OUTSIDE_HOURS";
  }

  return {
    known: true,
    isOpenNow,
    nowLocal,
    weekday,
    timezone: OPERATING_STATUS_TIMEZONE,
    currentClose,
    nextOpen: findNextOpen(hours, weekday, minutes),
    closedReason,
  };
}
