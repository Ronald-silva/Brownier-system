import assert from "node:assert/strict";
import test from "node:test";
import { getOperatingStatus } from "../src/agent/operating-status.ts";
import { INITIAL_OPERATING_HOURS, type StructuredWeeklyHours } from "../src/lib/business-hours.ts";

// 2026-08-03 é uma segunda-feira; 2026-08-04 terça; 2026-08-01 sábado;
// 2026-08-02 domingo (confirmado via `date -d`). America/Fortaleza é
// UTC-03:00 fixo (sem horário de verão), então strings ISO com o offset
// "-03:00" já representam diretamente o horário local desejado, sem
// aritmética manual de fuso.
const at = (iso: string) => new Date(iso);

test("dia útil aberto: segunda-feira 10:00 está aberta, fecha às 18:00", () => {
  const status = getOperatingStatus({ now: at("2026-08-03T10:00:00-03:00"), hours: INITIAL_OPERATING_HOURS });
  assert.equal(status.known, true);
  if (!status.known) return;
  assert.equal(status.isOpenNow, true);
  assert.equal(status.weekday, "MON");
  assert.equal(status.currentClose, "18:00");
  assert.equal(status.closedReason, null);
});

test("1h da madrugada: fechado, com próxima abertura hoje às 08:00", () => {
  const status = getOperatingStatus({ now: at("2026-08-04T01:00:00-03:00"), hours: INITIAL_OPERATING_HOURS });
  assert.equal(status.known, true);
  if (!status.known) return;
  assert.equal(status.isOpenNow, false);
  assert.equal(status.weekday, "TUE");
  assert.equal(status.closedReason, "OUTSIDE_HOURS");
  assert.deepEqual(status.nextOpen, { weekday: "TUE", time: "08:00", sameDay: true });
});

test("antes da abertura (07:59) está fechado, abre hoje às 08:00", () => {
  const status = getOperatingStatus({ now: at("2026-08-03T07:59:00-03:00"), hours: INITIAL_OPERATING_HOURS });
  assert.equal(status.known, true);
  if (!status.known) return;
  assert.equal(status.isOpenNow, false);
  assert.deepEqual(status.nextOpen, { weekday: "MON", time: "08:00", sameDay: true });
});

test("exatamente no minuto de abertura (08:00) já está aberto", () => {
  const status = getOperatingStatus({ now: at("2026-08-03T08:00:00-03:00"), hours: INITIAL_OPERATING_HOURS });
  assert.equal(status.known, true);
  if (!status.known) return;
  assert.equal(status.isOpenNow, true);
  assert.equal(status.currentClose, "18:00");
});

test("exatamente no minuto de encerramento (18:00) já está fechado", () => {
  const status = getOperatingStatus({ now: at("2026-08-03T18:00:00-03:00"), hours: INITIAL_OPERATING_HOURS });
  assert.equal(status.known, true);
  if (!status.known) return;
  assert.equal(status.isOpenNow, false);
  assert.equal(status.closedReason, "OUTSIDE_HOURS");
  // Segunda não tem mais intervalos hoje; próxima abertura é terça 08:00.
  assert.deepEqual(status.nextOpen, { weekday: "TUE", time: "08:00", sameDay: false });
});

test("depois do encerramento (18:30) está fechado, próxima abertura é outro dia", () => {
  const status = getOperatingStatus({ now: at("2026-08-03T18:30:00-03:00"), hours: INITIAL_OPERATING_HOURS });
  assert.equal(status.known, true);
  if (!status.known) return;
  assert.equal(status.isOpenNow, false);
  assert.deepEqual(status.nextOpen, { weekday: "TUE", time: "08:00", sameDay: false });
});

test("sábado: aberto 08:00-12:00 conforme horário inicial", () => {
  const open = getOperatingStatus({ now: at("2026-08-01T09:00:00-03:00"), hours: INITIAL_OPERATING_HOURS });
  assert.equal(open.known, true);
  if (open.known) { assert.equal(open.isOpenNow, true); assert.equal(open.currentClose, "12:00"); }

  // Sábado à tarde, fechado — próxima abertura pula domingo (fechado) e cai em segunda.
  const afternoon = getOperatingStatus({ now: at("2026-08-01T13:00:00-03:00"), hours: INITIAL_OPERATING_HOURS });
  assert.equal(afternoon.known, true);
  if (!afternoon.known) return;
  assert.equal(afternoon.isOpenNow, false);
  assert.deepEqual(afternoon.nextOpen, { weekday: "MON", time: "08:00", sameDay: false });
});

test("domingo: fechado o dia inteiro (DAY_CLOSED), próxima abertura segunda 08:00", () => {
  const status = getOperatingStatus({ now: at("2026-08-02T10:00:00-03:00"), hours: INITIAL_OPERATING_HOURS });
  assert.equal(status.known, true);
  if (!status.known) return;
  assert.equal(status.isOpenNow, false);
  assert.equal(status.weekday, "SUN");
  assert.equal(status.closedReason, "DAY_CLOSED");
  assert.deepEqual(status.nextOpen, { weekday: "MON", time: "08:00", sameDay: false });
});

test("dois intervalos no mesmo dia: almoço fechado entre os dois", () => {
  const hours: StructuredWeeklyHours = { ...INITIAL_OPERATING_HOURS, TUE: [{ open: "09:00", close: "12:00" }, { open: "14:00", close: "18:00" }] };

  const morning = getOperatingStatus({ now: at("2026-08-04T10:00:00-03:00"), hours });
  assert.equal(morning.known, true);
  if (morning.known) { assert.equal(morning.isOpenNow, true); assert.equal(morning.currentClose, "12:00"); }

  const lunchGap = getOperatingStatus({ now: at("2026-08-04T13:00:00-03:00"), hours });
  assert.equal(lunchGap.known, true);
  if (!lunchGap.known) return;
  assert.equal(lunchGap.isOpenNow, false);
  assert.deepEqual(lunchGap.nextOpen, { weekday: "TUE", time: "14:00", sameDay: true });

  const afternoon = getOperatingStatus({ now: at("2026-08-04T15:00:00-03:00"), hours });
  assert.equal(afternoon.known, true);
  if (afternoon.known) { assert.equal(afternoon.isOpenNow, true); assert.equal(afternoon.currentClose, "18:00"); }
});

test("intervalo atravessando meia-noite: aberto na noite de segunda e na madrugada de terça", () => {
  const hours: StructuredWeeklyHours = { ...INITIAL_OPERATING_HOURS, MON: [{ open: "23:50", close: "00:20" }] };

  const mondayNight = getOperatingStatus({ now: at("2026-08-03T23:55:00-03:00"), hours });
  assert.equal(mondayNight.known, true);
  if (mondayNight.known) { assert.equal(mondayNight.isOpenNow, true); assert.equal(mondayNight.currentClose, "00:20"); assert.equal(mondayNight.weekday, "MON"); }

  const tuesdayEarly = getOperatingStatus({ now: at("2026-08-04T00:10:00-03:00"), hours });
  assert.equal(tuesdayEarly.known, true);
  if (tuesdayEarly.known) { assert.equal(tuesdayEarly.isOpenNow, true); assert.equal(tuesdayEarly.currentClose, "00:20"); assert.equal(tuesdayEarly.weekday, "TUE"); }
});

// Requisito explícito: não basta olhar só os intervalos do dia atual — às
// 00:20 de terça também é preciso checar o intervalo iniciado segunda.
test("dia anterior: intervalo de segunda que cruza a meia-noite cobre a madrugada de terça até o fechamento, não depois", () => {
  const hours: StructuredWeeklyHours = { ...INITIAL_OPERATING_HOURS, MON: [{ open: "23:50", close: "00:20" }], TUE: [] };

  const stillOpenFromMonday = getOperatingStatus({ now: at("2026-08-04T00:19:00-03:00"), hours });
  assert.equal(stillOpenFromMonday.known, true);
  if (stillOpenFromMonday.known) assert.equal(stillOpenFromMonday.isOpenNow, true);

  const exactlyAtCarryoverClose = getOperatingStatus({ now: at("2026-08-04T00:20:00-03:00"), hours });
  assert.equal(exactlyAtCarryoverClose.known, true);
  if (!exactlyAtCarryoverClose.known) return;
  assert.equal(exactlyAtCarryoverClose.isOpenNow, false);
  // Terça não tem ranges próprios, mas segunda cruzava meia-noite: o motivo é
  // "fora do horário", não "dia fechado" — havia cobertura, só já terminou.
  assert.equal(exactlyAtCarryoverClose.closedReason, "OUTSIDE_HOURS");

  // Quarta de madrugada não tem nenhuma relação com o intervalo de segunda —
  // confirma que só o dia IMEDIATAMENTE anterior é considerado como carryover.
  const wednesdayEarly = getOperatingStatus({ now: at("2026-08-05T00:10:00-03:00"), hours: { ...hours, WED: [] } });
  assert.equal(wednesdayEarly.known, true);
  if (!wednesdayEarly.known) return;
  assert.equal(wednesdayEarly.isOpenNow, false);
  assert.equal(wednesdayEarly.closedReason, "DAY_CLOSED");
});

test("timezone correto mesmo com o relógio do servidor calculado como instante UTC", () => {
  // 2026-08-03T13:00:00Z é exatamente 2026-08-03T10:00:00-03:00 em Fortaleza
  // — o mesmo instante absoluto de "dia útil aberto" acima, só que construído
  // a partir de um sufixo "Z" (o formato que Date.now()/JSON usam), nunca de
  // horário local do processo. O cálculo não pode depender de TZ do host.
  const original = process.env.TZ;
  process.env.TZ = "UTC";
  try {
    const status = getOperatingStatus({ now: new Date("2026-08-03T13:00:00Z"), hours: INITIAL_OPERATING_HOURS });
    assert.equal(status.known, true);
    if (!status.known) return;
    assert.equal(status.weekday, "MON");
    assert.equal(status.isOpenNow, true);
    assert.equal(status.currentClose, "18:00");
    assert.equal(status.nowLocal, "2026-08-03T10:00:00-03:00");
    assert.equal(status.timezone, "America/Fortaleza");
  } finally {
    if (original === undefined) delete process.env.TZ; else process.env.TZ = original;
  }
});

test("configuração ausente: known é false quando não há horário estruturado cadastrado", () => {
  const status = getOperatingStatus({ now: at("2026-08-03T10:00:00-03:00"), hours: undefined });
  assert.deepEqual(status, { known: false });
});

test("todos os dias fechados: nextOpen é null e não lança erro", () => {
  const hours: StructuredWeeklyHours = { MON: [], TUE: [], WED: [], THU: [], FRI: [], SAT: [], SUN: [] };
  const status = getOperatingStatus({ now: at("2026-08-03T10:00:00-03:00"), hours });
  assert.equal(status.known, true);
  if (!status.known) return;
  assert.equal(status.isOpenNow, false);
  assert.equal(status.closedReason, "DAY_CLOSED");
  assert.equal(status.nextOpen, null);
});
