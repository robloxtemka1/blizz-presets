// Пресеты фильтров Blizz-бота. Пресеты приходят в адресе после «#» (p=z.<base64url(deflate-raw(JSON))>), изменения
// уходят боту через Telegram.WebApp.sendData. Сама страница ничего не хранит и никуда, кроме бота, не отправляет.
"use strict";
// в обычном браузере скрипт Telegram тоже есть, но platform = "unknown" — тогда вместо отправки показываем данные
const tg = window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.platform &&
  window.Telegram.WebApp.platform !== "unknown" ? window.Telegram.WebApp : null;
const SEP = "\u0000";   // разделитель «пресет␀поле» в ключах ошибок
const $ = (id) => document.getElementById(id);
const MAX_BYTES = 4096;
const HOLD_LABELS = (s) => s == null ? "∞" : s < 60 ? s + " с" : s < 3600 ? Math.round(s / 60) + " мин" :
  s < 86400 ? Math.round(s / 3600) + " ч" : Math.round(s / 86400) + " дн";

const S = {data: null, cur: null, work: {}, orig: {}, changed: new Set(), deleted: new Set(), reset: new Set(),
  active: null, errors: {}};

function b64urlBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function inflate(bytes) {
  if (!("DecompressionStream" in window)) throw new Error("старый Telegram — обнови приложение");
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return await new Response(stream).text();
}

function hashParam(name) {
  let h = location.hash.replace(/^#/, "");
  try { if (h.includes("p=")) sessionStorage.setItem("hash", h); else h = sessionStorage.getItem("hash") || h; } catch (e) {}
  for (const part of h.split("&")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1);
  }
  return null;
}

async function load() {
  const p = hashParam("p");
  if (!p) throw new Error("нет пресетов в адресе — открой страницу кнопкой «🎛 Пресеты» в боте");
  let text;
  if (p.startsWith("z.")) text = await inflate(b64urlBytes(p.slice(2)));
  else if (p.startsWith("j.")) text = new TextDecoder().decode(b64urlBytes(p.slice(2)));
  else throw new Error("непонятный формат адреса");
  const d = JSON.parse(text);
  if (d.v !== window.SCHEMA_V) throw new Error("версия страницы и бота разные — открой заново из бота");
  return d;
}

const clone = (x) => JSON.parse(JSON.stringify(x));
const full = (compact) => Object.assign(clone(window.DEFAULTS), clone(compact || {}));
const isBuiltin = (n) => S.data.builtin.includes(n);
const names = () => Object.keys(S.work);

function compact(p) {
  const out = {};
  for (const [k, v] of Object.entries(p)) {
    if (v === null || v === "" || (Array.isArray(v) && (v.length === 0 || (v.length === 2 && v[0] === null && v[1] === null)))) continue;
    out[k] = v;
  }
  return out;
}

// ---------- значения полей ----------
function num(s) {
  s = String(s).trim().replace(",", ".").replace(/\s/g, "");
  if (s === "") return null;
  const m = s.match(/^(-?\d*\.?\d+)([kкmм]?)$/i);
  if (!m) return NaN;
  const mult = {"k": 1e3, "к": 1e3, "m": 1e6, "м": 1e6}[m[2].toLowerCase()] || 1;
  return parseFloat(m[1]) * mult;
}
const fmt = (v, scale) => v == null ? "" : String(+(v * (scale || 1)).toFixed(6));
function inLim(v, lim) { return v === null || (Number.isFinite(v) && (!lim || (v >= lim[0] && v <= lim[1]))); }

function setVal(key, v) {
  const p = S.work[S.cur];
  if (JSON.stringify(p[key]) === JSON.stringify(v)) return;
  p[key] = v;
  S.changed.add(S.cur);
  S.reset.delete(S.cur);
  status();
}

// ---------- отрисовка ----------
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function input(val, ph, onChange, scale, lim, errEl) {
  const i = el("input", "in");
  i.placeholder = ph; i.inputMode = "decimal"; i.value = fmt(val, scale); i.autocomplete = "off";
  i.addEventListener("input", () => {
    const v = num(i.value);
    const real = v === null ? null : v / (scale || 1);
    const ok = !Number.isNaN(v) && inLim(real, lim);
    i.classList.toggle("bad", !ok);
    onChange(ok ? real : undefined);
    if (errEl) errEl();
  });
  return i;
}

function rangeCtl(f, box) {
  const key = f.keys[0], p = S.work[S.cur], cur = (p[key] || [null, null]).slice();
  const err = el("div", "err");
  const check = () => {
    const bad = cur[0] === undefined || cur[1] === undefined ? `вне пределов ${f.limits[0]}…${f.limits[1]}` :
      (cur[0] != null && cur[1] != null && cur[0] > cur[1]) ? "«от» больше «до»" : "";
    err.textContent = bad;
    S.errors[S.cur + SEP + f.id] = bad;
    if (!bad) setVal(key, [cur[0], cur[1]]);
  };
  const pair = el("div", "pair");
  pair.append(input(cur[0], "от", (v) => { cur[0] = v; }, f.scale, f.limits, check), el("span", "dash", "–"),
    input(cur[1], "до", (v) => { cur[1] = v; }, f.scale, f.limits, check));
  box.append(pair, err);
}

function fastPctCtl(f, box) {   // «Быстрых сделок, %»: от → fast_pct_min, до → fast_pct_max
  const p = S.work[S.cur], cur = [p.fast_pct_min, p.fast_pct_max];
  const err = el("div", "err");
  const check = () => {
    const bad = cur[0] === undefined || cur[1] === undefined ? "от 0 до 100" :
      (cur[0] != null && cur[1] != null && cur[0] > cur[1]) ? "«от» больше «до»" : "";
    err.textContent = bad; S.errors[S.cur + SEP + f.id] = bad;
    if (!bad) { setVal("fast_pct_min", cur[0]); setVal("fast_pct_max", cur[1]); }
  };
  const pair = el("div", "pair");
  pair.append(input(cur[0], "от", (v) => { cur[0] = v; }, 1, [0, 100], check), el("span", "dash", "–"),
    input(cur[1], "до", (v) => { cur[1] = v; }, 1, [0, 100], check));
  box.append(pair, err);
}

function oneCtl(f, box) {
  const key = f.keys[0], err = el("div", "err"), wrap = el("div", "one");
  let cur = S.work[S.cur][key];
  const check = () => {
    const bad = cur === undefined ? `вне пределов ${fmt(f.limits[0], f.scale)}…${fmt(f.limits[1], f.scale)}` : "";
    err.textContent = bad; S.errors[S.cur + SEP + f.id] = bad;
    if (!bad) setVal(key, cur);
  };
  wrap.append(input(cur, f.control === "min" ? "от" : "до", (v) => { cur = v; }, f.scale, f.limits, check));
  box.append(wrap, err);
}

function chipsCtl(f, box) {
  const key = f.keys[0], p = S.work[S.cur], wrap = el("div", "chips");
  const custom = f.custom ? input(f.options.some((o) => o[0] === p[key]) ? null : p[key], `своя сумма, ${f.unit || ""}`,
    (v) => { if (v !== undefined) { setVal(key, v); paint(); } }, 1, f.limits) : null;
  const paint = () => wrap.querySelectorAll(".chip").forEach((c, i) =>
    c.classList.toggle("on", JSON.stringify(f.options[i][0]) === JSON.stringify(S.work[S.cur][key])));
  f.options.forEach(([v, label]) => {
    const c = el("button", "chip", label);
    c.type = "button";
    c.onclick = () => { setVal(key, v); if (custom) custom.value = ""; paint(); };
    wrap.append(c);
  });
  paint();
  box.append(wrap);
  if (custom) { custom.style.marginTop = "8px"; custom.style.textAlign = "left"; box.append(custom); }
}

function multiCtl(f, box) {
  const grid = el("div", "multi"), err = el("div", "err");
  f.keys.forEach((key, i) => {
    const cell = el("div");
    cell.append(el("label", "", f.labels[i]));
    let cur = S.work[S.cur][key];
    cell.append(input(cur, "0", (v) => { cur = v; }, 1, f.limits, () => {
      const bad = cur === undefined ? "целое от 0" : "";
      err.textContent = bad; S.errors[S.cur + SEP + key] = bad;
      if (!bad) setVal(key, cur === 0 ? null : cur);
    }));
    grid.append(cell);
  });
  box.append(grid, err);
}

function holdCtl(f, box, valEl) {   // длительность: ползунки по шагам 10 с … 7 дн; крайние положения — без границы
  const steps = f.steps, key = f.keys[0];
  const pos = (v, isTo) => v == null ? (isTo ? steps.length + 1 : 0) :
    1 + steps.reduce((bi, s, i) => Math.abs(Math.log(s) - Math.log(v)) < Math.abs(Math.log(steps[bi]) - Math.log(v)) ? i : bi, 0);
  const val = (i) => (i <= 0 || i > steps.length) ? null : steps[i - 1];
  const cur = (S.work[S.cur][key] || [null, null]).slice();
  const show = () => { valEl.textContent = `${cur[0] == null ? "0" : HOLD_LABELS(cur[0])} — ${HOLD_LABELS(cur[1])}`; };
  const sliders = [];
  const mk = (label, isTo) => {
    const w = el("div", "slider"), r = el("input");
    r.type = "range"; r.min = isTo ? 1 : 0; r.max = isTo ? steps.length + 1 : steps.length; r.step = 1;
    r.value = pos(cur[isTo ? 1 : 0], isTo);
    const lab = el("label"); lab.append(el("span", "", label));
    r.oninput = () => {
      const me = isTo ? 1 : 0, other = 1 - me;
      cur[me] = val(+r.value);
      if (cur[0] != null && cur[1] != null && cur[0] > cur[1]) {   // ручки не перескакивают друг через друга
        cur[other] = cur[me];
        sliders[other].value = pos(cur[other], other === 1);
      }
      setVal(key, [cur[0], cur[1]]);
      show();
    };
    sliders[isTo ? 1 : 0] = r;
    w.append(lab, r);
    return w;
  };
  show();
  const sc = el("div", "scale"); sc.append(el("span", "", "10 с"), el("span", "", "1 ч"), el("span", "", "7 дн / ∞"));
  box.append(mk("от", false), mk("до", true), sc);
}

function toggleCtl(f, box) {
  const key = f.keys[0], t = el("span", "toggle" + (S.work[S.cur][key] ? " on" : "")), label = el("span", "muted");
  t.innerHTML = '<span class="knob"></span>';
  const paint = () => { t.classList.toggle("on", !!S.work[S.cur][key]); label.textContent = S.work[S.cur][key] ? "исключать" : "не исключать"; };
  t.onclick = () => { setVal(key, !S.work[S.cur][key]); paint(); };
  const row = el("div", "row between"); row.append(label, t);
  paint();
  box.append(row);
}

function rangesCtl(f, box) {
  [["entry_ranges", "Вход — капа при первой покупке"], ["exit_ranges", "Выход — капа при последней продаже"]].forEach(([key, title]) => {
    const side = el("div", "rside"), head = el("div", "rhead"), plus = el("button", "bt plus", "+");
    head.append(el("b", "", title), plus);
    side.append(head);
    const rows = clone(S.work[S.cur][key] || []);
    const err = el("div", "err");
    const save = () => {
      const bad = rows.some((r) => [...r.mcap, ...r.share].some((x) => x === undefined)) ? "числа вне пределов" :
        rows.some((r) => (r.mcap[0] != null && r.mcap[1] != null && r.mcap[0] > r.mcap[1]) ||
          (r.share[0] != null && r.share[1] != null && r.share[0] > r.share[1])) ? "«от» больше «до»" : "";
      err.textContent = bad; S.errors[S.cur + SEP + key] = bad;
      if (!bad) setVal(key, clone(rows));
    };
    const draw = () => {
      side.querySelectorAll(".rrow,.rcap,.rempty").forEach((x) => x.remove());
      if (!rows.length) side.append(el("div", "hint rempty", "Диапазонов нет — нажми +"));
      else { const cap = el("div", "rcap"); ["капа от $", "капа до $", "доля от %", "доля до %", ""].forEach((t) => cap.append(el("span", "", t))); side.append(cap); }
      rows.forEach((r, i) => {
        const line = el("div", "rrow");
        [["mcap", 0, [0, 1e11]], ["mcap", 1, [0, 1e11]], ["share", 0, [0, 100]], ["share", 1, [0, 100]]].forEach(([part, j, lim]) =>
          line.append(input(r[part][j], j ? "до" : "от", (v) => { r[part][j] = v; }, 1, lim, save)));
        const x = el("button", "bt plus", "×"); x.onclick = () => { rows.splice(i, 1); save(); draw(); };
        line.append(x);
        side.append(line);
      });
      side.append(err);
      plus.disabled = rows.length >= 4;
    };
    plus.onclick = () => { if (rows.length < 4) { rows.push({mcap: [null, null], share: [null, null]}); draw(); } };
    draw();
    box.append(side);
  });
}

function showExample(f) {
  $("mtitle").textContent = f.title;
  $("mtext").textContent = f.example;
  $("modal").classList.remove("hidden");
}

function render() {
  const g = $("groups");
  const scrollY = window.scrollY;
  g.innerHTML = "";
  let closed = {};
  try { closed = JSON.parse(localStorage.getItem("closed") || "{}"); } catch (e) {}
  window.GROUPS.forEach((grp, gi) => {
    const card = el("section", "card" + (closed[gi] ? " closed" : ""));
    if (grp.title) {
      const head = el("div", "ghead"), t = el("div");
      t.append(el("div", "gtitle", grp.title), el("div", "gsub", grp.sub));
      head.append(t, el("span", "chev", "⌃"));
      head.onclick = () => {
        card.classList.toggle("closed");
        closed[gi] = card.classList.contains("closed");
        try { localStorage.setItem("closed", JSON.stringify(closed)); } catch (e) {}
      };
      card.append(head);
    }
    const body = el("div", "gbody");
    grp.fields.forEach((f) => {
      const box = el("div", "field"), title = el("div", "ftitle"), val = el("span", "fval"), info = el("span", "info", "i");
      title.append(el("span", "", f.title), val, info);
      // описание с «показать пример» по умолчанию свёрнуто; «i» — открыть/закрыть (не запоминается)
      const desc = el("div", "box hidden");
      desc.append(document.createTextNode(f.desc));
      desc.append(document.createElement("br"));
      const ex = el("span", "ex", "показать пример →");
      ex.onclick = () => showExample(f);
      if (f.example) desc.append(ex);
      info.setAttribute("role", "button");
      info.setAttribute("aria-label", "описание поля");
      info.setAttribute("aria-expanded", "false");
      info.onclick = () => {
        const open = desc.classList.toggle("hidden") === false;
        info.classList.toggle("open", open);
        info.setAttribute("aria-expanded", String(open));
      };
      box.append(title, desc);
      const ctl = f.id === "fast_pct" ? fastPctCtl : ({range: rangeCtl, max: oneCtl, min: oneCtl, chips: chipsCtl,
        multi: multiCtl, hold: holdCtl, toggle: toggleCtl, ranges: rangesCtl}[f.control] || rangeCtl);
      ctl(f, box, val);
      body.append(box);
    });
    card.append(body);
    g.append(card);
  });
  window.scrollTo(0, scrollY);
}

function renderHead() {
  const sel = $("sel");
  sel.innerHTML = "";
  names().forEach((n) => {
    const o = el("option", "", n + (n === S.active ? " · ✓" : "") + (S.changed.has(n) ? " •" : ""));
    o.value = n; sel.append(o);
  });
  sel.value = S.cur;
  $("cnt").textContent = `${names().indexOf(S.cur) + 1} / ${names().length}`;
  $("name").value = S.cur;
  $("name").readOnly = isBuiltin(S.cur);
  $("namehint").textContent = isBuiltin(S.cur) ? "готовый пресет: имя не меняется — сделай копию" : "";
  $("bdel").textContent = isBuiltin(S.cur) ? "сбросить" : "удалить";
  $("tgl").classList.toggle("on", S.active === S.cur);
  $("headhint").textContent = S.reset.has(S.cur) ? "после сохранения вернётся к исходным значениям" : "";
}

function status() {
  const n = S.changed.size + S.deleted.size + S.reset.size + (S.active !== S.data.active ? 1 : 0);
  const st = $("status");
  st.className = "status";
  st.textContent = n ? `изменений: ${n} — бот проверит и сохранит` : "изменений нет";
  renderHeadLight();
}
function renderHeadLight() {
  const sel = $("sel");
  [...sel.options].forEach((o) => { const n = o.value; o.textContent = n + (n === S.active ? " · ✓" : "") + (S.changed.has(n) ? " •" : ""); });
}

function uniq(base) {
  let n = base, i = 2;
  while (S.work[n]) n = `${base} ${i++}`;
  return n.slice(0, 40);
}

function switchTo(n) { S.cur = n; renderHead(); render(); }

function bind() {
  $("sel").onchange = (e) => switchTo(e.target.value);
  $("bnew").onclick = () => { const n = uniq("Новый пресет"); S.work[n] = full({}); S.changed.add(n); switchTo(n); status(); };
  $("bcopy").onclick = () => { const n = uniq(`${S.cur} копия`); S.work[n] = clone(S.work[S.cur]); S.changed.add(n); switchTo(n); status(); };
  $("bdel").onclick = () => {
    const n = S.cur;
    if (isBuiltin(n)) {
      S.reset.add(n); S.changed.delete(n); S.work[n] = full(S.orig[n] || {});
      renderHead(); render(); status(); return;
    }
    if (names().length <= 1) return;
    if (S.orig[n]) S.deleted.add(n);
    S.changed.delete(n);
    delete S.work[n];
    if (S.active === n) S.active = S.data.active !== n && S.work[S.data.active] ? S.data.active : names()[0];
    switchTo(names()[0]); status();
  };
  $("name").onchange = (e) => {
    const old = S.cur, nn = e.target.value.trim().slice(0, 40);
    if (!nn || nn === old || isBuiltin(old)) { e.target.value = old; return; }
    if (S.work[nn]) { $("namehint").textContent = "такое имя уже есть"; e.target.value = old; return; }
    S.work[nn] = S.work[old]; delete S.work[old];
    if (S.orig[old]) S.deleted.add(old);
    S.changed.delete(old); S.changed.add(nn);
    if (S.active === old) S.active = nn;
    switchTo(nn); status();
  };
  $("tgl").onclick = () => {
    if (S.active === S.cur) { $("headhint").textContent = "чтобы выключить — включи другой пресет"; return; }
    S.active = S.cur; renderHead(); status();
  };
  $("mok").onclick = () => $("modal").classList.add("hidden");
  $("modal").onclick = (e) => { if (e.target.id === "modal") $("modal").classList.add("hidden"); };
  $("save").onclick = send;
}

function send() {
  const bad = Object.entries(S.errors).filter(([k, v]) => v && S.work[k.split(SEP)[0]]);
  const st = $("status");
  if (bad.length) {
    const [where] = bad[0][0].split(SEP);
    st.className = "status bad"; st.textContent = `исправь поля с ошибкой («${where}»)`;
    if (where !== S.cur) switchTo(where);
    return;
  }
  const ops = [];
  S.deleted.forEach((n) => { if (!S.work[n]) ops.push({op: "delete", name: n}); });
  S.reset.forEach((n) => ops.push({op: "reset", name: n}));
  S.changed.forEach((n) => { if (S.work[n]) ops.push({op: "save", name: n, p: compact(S.work[n])}); });
  if (S.active !== S.data.active) ops.push({op: "active", name: S.active});
  if (!ops.length) { st.className = "status"; st.textContent = "изменений нет"; return; }
  const text = JSON.stringify({v: window.SCHEMA_V, d: S.data.d, ops});
  const size = new TextEncoder().encode(text).length;
  if (size > MAX_BYTES) { st.className = "status bad"; st.textContent = `слишком много изменений (${size} байт из ${MAX_BYTES}) — сохрани по частям`; return; }
  if (tg) { tg.sendData(text); return; }   // Telegram закроет окно, бот ответит в чате
  $("debug").classList.remove("hidden");
  $("dbgtext").value = JSON.stringify(JSON.parse(text), null, 1);
  st.className = "status ok"; st.textContent = `готово к отправке: ${ops.length} изм., ${size} байт`;
}

(async function main() {
  if (tg) { tg.ready(); tg.expand(); try { tg.setHeaderColor("#0e0e0f"); tg.setBackgroundColor("#0e0e0f"); } catch (e) {} }
  try {
    S.data = await load();
  } catch (e) {
    $("err").textContent = "⚠️ " + e.message;
    $("err").classList.remove("hidden");
    $("head").classList.add("hidden"); $("save").disabled = true;
    return;
  }
  for (const [n, p] of Object.entries(S.data.presets)) { S.orig[n] = p; S.work[n] = full(p); }
  S.active = S.data.active;
  S.cur = S.work[S.active] ? S.active : names()[0];
  bind(); renderHead(); render(); status();
})();
