import assert from "node:assert/strict";
import test from "node:test";
import {
  INITIAL_OPERATING_HOURS,
  formatTimeBR,
  isStructuredWeeklyHours,
  validateStructuredWeeklyHours,
  type StructuredWeeklyHours,
} from "../src/lib/business-hours.ts";

test("horário inicial: seg-sex 14:00-22:00, sábado e domingo fechados", () => {
  assert.deepEqual(INITIAL_OPERATING_HOURS.MON, [{ open: "14:00", close: "22:00" }]);
  assert.deepEqual(INITIAL_OPERATING_HOURS.FRI, [{ open: "14:00", close: "22:00" }]);
  assert.deepEqual(INITIAL_OPERATING_HOURS.SAT, []);
  assert.deepEqual(INITIAL_OPERATING_HOURS.SUN, []);
  assert.deepEqual(validateStructuredWeeklyHours(INITIAL_OPERATING_HOURS), []);
});

test("formatTimeBR converte HH:mm para o estilo informal usado nas respostas", () => {
  assert.equal(formatTimeBR("08:00"), "8h");
  assert.equal(formatTimeBR("18:00"), "18h");
  assert.equal(formatTimeBR("09:30"), "9h30");
  assert.equal(formatTimeBR("00:20"), "0h20");
});

test("validação: configuração ausente/formato inválido não é um StructuredWeeklyHours", () => {
  assert.equal(isStructuredWeeklyHours(undefined), false);
  assert.equal(isStructuredWeeklyHours(null), false);
  assert.equal(isStructuredWeeklyHours("Seg a Sex, 8h às 18h"), false);
  assert.equal(isStructuredWeeklyHours({ MON: [] }), false); // faltam os outros dias
});

test("validação: horário fora do formato HH:mm é rejeitado", () => {
  const hours = { ...INITIAL_OPERATING_HOURS, MON: [{ open: "8:00", close: "18:00" }] };
  const errors = validateStructuredWeeklyHours(hours);
  assert.ok(errors.some(e => e.weekday === "MON" && e.code === "INVALID_FORMAT"));
});

test("validação: campos incompletos (open ou close vazio) são rejeitados", () => {
  const hours = { ...INITIAL_OPERATING_HOURS, TUE: [{ open: "09:00", close: "" }] };
  const errors = validateStructuredWeeklyHours(hours);
  assert.ok(errors.some(e => e.weekday === "TUE" && e.code === "INCOMPLETE"));
});

test("validação: horário de abertura igual ao de encerramento é rejeitado", () => {
  const hours = { ...INITIAL_OPERATING_HOURS, WED: [{ open: "09:00", close: "09:00" }] };
  const errors = validateStructuredWeeklyHours(hours);
  assert.ok(errors.some(e => e.weekday === "WED" && e.code === "EQUAL_TIMES"));
});

test("validação: intervalos sobrepostos no mesmo dia são rejeitados", () => {
  const hours: StructuredWeeklyHours = { ...INITIAL_OPERATING_HOURS, THU: [{ open: "09:00", close: "13:00" }, { open: "12:00", close: "18:00" }] };
  const errors = validateStructuredWeeklyHours(hours);
  assert.ok(errors.some(e => e.weekday === "THU" && e.code === "OVERLAP"));
});

test("validação: intervalos adjacentes (sem sobreposição) são aceitos", () => {
  const hours: StructuredWeeklyHours = { ...INITIAL_OPERATING_HOURS, THU: [{ open: "09:00", close: "12:00" }, { open: "12:00", close: "18:00" }] };
  assert.deepEqual(validateStructuredWeeklyHours(hours), []);
});

test("validação: intervalo cruzando meia-noite é aceito (não é 'horários iguais')", () => {
  const hours: StructuredWeeklyHours = { ...INITIAL_OPERATING_HOURS, FRI: [{ open: "18:00", close: "00:30" }] };
  assert.deepEqual(validateStructuredWeeklyHours(hours), []);
});

test("validação: intervalo cruzando meia-noite que se sobrepõe a outro é rejeitado", () => {
  // 22:00-01:00 (cruza meia-noite) se sobrepõe a 00:30-02:00 no início da madrugada.
  const hours: StructuredWeeklyHours = { ...INITIAL_OPERATING_HOURS, FRI: [{ open: "22:00", close: "01:00" }, { open: "00:30", close: "02:00" }] };
  const errors = validateStructuredWeeklyHours(hours);
  assert.ok(errors.some(e => e.weekday === "FRI" && e.code === "OVERLAP"));
});
