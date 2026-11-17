// 今天吃什麼 — 附近餐廳轉盤
// 位置：瀏覽器 Geolocation（或 Nominatim 地址搜尋）
// 店家：有金鑰用 Google Places API (New)，沒有就用 OpenStreetMap Overpass API
// 轉盤來源：附近的店，或自己存的清單（口袋名單）

const GOOGLE_KEY = ((window.FOOD_WHEEL_CONFIG || {}).googleApiKey || "").trim();
const USE_GOOGLE = GOOGLE_KEY !== "";

// 類型 → Google Places 類型（Table A）
const GOOGLE_TYPES = {
  restaurant: ["restaurant"],
  fast_food: ["fast_food_restaurant", "meal_takeaway"],
  cafe: ["cafe", "coffee_shop", "tea_house"],
  dessert: ["bakery", "dessert_shop", "ice_cream_shop"],
};
// 會混進餐廳結果、但不是專門去吃飯的地方
const GOOGLE_EXCLUDED = ["hotel", "lodging", "resort_hotel", "motel", "hostel", "convenience_store"];
const GOOGLE_FIELDS = [
  "places.id",
  "places.displayName",
  "places.location",
  "places.primaryTypeDisplayName",
  "places.rating",
  "places.userRatingCount",
  "places.priceLevel",
  "places.currentOpeningHours.openNow",
  "places.googleMapsUri",
].join(",");
const PRICE_LABELS = {
  PRICE_LEVEL_FREE: "免費",
  PRICE_LEVEL_INEXPENSIVE: "$",
  PRICE_LEVEL_MODERATE: "$$",
  PRICE_LEVEL_EXPENSIVE: "$$$",
  PRICE_LEVEL_VERY_EXPENSIVE: "$$$$",
};

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
const MAX_SLICES = 12;
const SPIN_MS = 4500;
const TAU = Math.PI * 2;
const DAY_MS = 86400000;
const RECENT_DAYS = 3;          // 「最近吃過」算幾天
const HISTORY_MAX = 30;
const CACHE_MS = 10 * 60 * 1000; // 同一個地點的搜尋結果留 10 分鐘，不重複花 API 額度
// 轉盤每格的 [底色, 字色]
const COLORS = [
  ["#f55a3a", "#fff"],
  ["#ffb347", "#4a2c0a"],
  ["#ffe08a", "#4a2c0a"],
  ["#7ed6a5", "#0f3d2a"],
  ["#22a39a", "#fff"],
  ["#3b8bf0", "#fff"],
  ["#8f7cf7", "#fff"],
  ["#f0569b", "#fff"],
];
const RIM_COLOR = "#3b2a1e";
const PEG_COLOR = "#ffe2b8";

// 類型 → Overpass 篩選條件
const TYPE_FILTERS = {
  restaurant: ['nwr["amenity"~"^(restaurant|food_court)$"]'],
  fast_food: ['nwr["amenity"="fast_food"]'],
  cafe: ['nwr["amenity"="cafe"]', 'nwr["shop"~"^(beverages|tea|coffee)$"]'],
  dessert: ['nwr["shop"~"^(bakery|pastry|confectionery)$"]', 'nwr["amenity"="ice_cream"]'],
};

const TYPE_LABELS = {
  restaurant: "餐廳", food_court: "美食街", fast_food: "小吃/速食", cafe: "咖啡廳",
  beverages: "飲料店", tea: "茶飲", coffee: "咖啡", bakery: "麵包店", pastry: "甜點",
  confectionery: "甜點", ice_cream: "冰品",
};

const CUISINE_LABELS = {
  chinese: "中式", taiwanese: "台式", japanese: "日式", korean: "韓式", thai: "泰式",
  vietnamese: "越式", indian: "印度", italian: "義式", american: "美式", french: "法式",
  noodle: "麵食", ramen: "拉麵", sushi: "壽司", burger: "漢堡", pizza: "披薩",
  hot_pot: "火鍋", breakfast: "早餐", chicken: "炸雞", fried_chicken: "炸雞",
  dumpling: "水餃", dumplings: "水餃", barbecue: "燒烤", seafood: "海鮮",
  vegetarian: "素食", vegan: "蔬食", sandwich: "三明治", cake: "蛋糕",
  coffee_shop: "咖啡", bubble_tea: "手搖飲", tea: "茶飲", beef_bowl: "丼飯",
  curry: "咖哩", steak: "牛排", rice: "飯類", beef_noodle: "牛肉麵",
};

// ---------- 存在瀏覽器的資料 ----------
function loadJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}
function saveJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

function manualItem(name) {
  return { id: "c:" + name, name, meta: "自己加的" };
}

function loadLists() {
  const lists = loadJson("food-wheel-lists", null);
  if (Array.isArray(lists)) return lists;
  // 第一次使用：把舊版「自己加的」選項搬進預設清單
  return [{ id: "fav", name: "口袋名單", items: loadJson("food-wheel-custom", []).map(manualItem) }];
}

// ---------- 狀態 ----------
const saved = loadJson("food-wheel-settings", {});
const savedTypes = (saved.types || []).filter((t) => t in TYPE_FILTERS);
const lists = loadLists();

const state = {
  mode: lists.some((l) => l.id === saved.mode) ? saved.mode : "nearby", // "nearby" 或清單的 id
  lists,                  // [{ id, name, items: [{ id, name, meta, lat, lon, mapUrl }] }]
  center: null,           // { lat, lon }
  label: "",              // 位置的名字（「目前位置」或搜尋的地址）
  radius: saved.radius || 500,
  types: savedTypes.length ? savedTypes : ["restaurant", "fast_food"],
  openOnly: saved.openOnly ?? true,
  minRating: saved.minRating || 0,
  avoidRecent: saved.avoidRecent ?? true,
  sound: saved.sound ?? true,
  lastPlace: saved.lastPlace || null,   // 上次用地址搜尋的位置 { lat, lon, label }
  history: loadJson("food-wheel-history", []),  // [{ id, name, at }]
  disabled: new Set(),    // 這次使用中被取消勾選的店名
  places: [],             // 附近的店 { id, name, meta, lat, lon, dist, rating, openNow, mapUrl }
  slices: [],             // 目前在轉盤上的項目
  rotation: 0,            // 轉盤目前角度（弧度）
  spinning: false,
  winner: null,           // 轉完後中獎的那一格
  lastPick: null,
  searchSeq: 0,
};

function saveSettings() {
  const { mode, radius, types, openOnly, minRating, avoidRecent, sound, lastPlace } = state;
  saveJson("food-wheel-settings", { mode, radius, types, openOnly, minRating, avoidRecent, sound, lastPlace });
}

const $ = (sel) => document.querySelector(sel);
const canvas = $("#wheel");
const ctx = canvas.getContext("2d");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

let toastTimer;
function toast(msg) {
  const box = $("#toast");
  box.textContent = msg;
  // popover 會蓋在對話框上面；不支援的瀏覽器就當一般浮動提示
  try {
    box.hidePopover?.();
    box.showPopover?.();
  } catch {}
  box.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    box.classList.remove("show");
    try {
      box.hidePopover?.();
    } catch {}
  }, 1800);
}

// ---------- 清單 ----------
const isNearby = () => state.mode === "nearby";
const currentList = () => state.lists.find((l) => l.id === state.mode) || null;
const samePlace = (a, b) => a.id === b.id || a.name === b.name;
const inList = (list, p) => list.items.some((it) => samePlace(it, p));
const isSaved = (p) => state.lists.some((l) => inList(l, p));

function saveLists() {
  saveJson("food-wheel-lists", state.lists);
}

function toggleInList(list, p) {
  if (inList(list, p)) {
    list.items = list.items.filter((it) => !samePlace(it, p));
  } else {
    list.items.push({ id: p.id, name: p.name, meta: p.meta, lat: p.lat, lon: p.lon, mapUrl: p.mapUrl });
  }
  saveLists();
}

function createList(name) {
  const list = { id: "l" + Date.now().toString(36), name, items: [] };
  state.lists.push(list);
  saveLists();
  return list;
}

// 目前轉盤來源的所有項目
function items() {
  const list = currentList();
  if (!list) return state.places;
  return list.items.map((it) => ({
    ...it,
    dist: state.center && it.lat != null ? distance(state.center, it) : null,
  }));
}

function setMode(mode) {
  state.mode = mode;
  saveSettings();
  document.body.dataset.mode = isNearby() ? "nearby" : "list";
  renderTabs();
  refresh(true);
  if (isNearby() && !state.center) autoStart();
}

function renderTabs() {
  const tabs = $("#tabs");
  tabs.innerHTML = "";
  const tab = (mode, label, count) => {
    const btn = el("button", "tab" + (state.mode === mode ? " on" : ""), label);
    if (count != null) btn.append(el("span", "n", count));
    btn.addEventListener("click", () => setMode(mode));
    return btn;
  };
  tabs.append(tab("nearby", "📍 附近"));
  for (const l of state.lists) tabs.append(tab(l.id, l.name, l.items.length));
  const add = el("button", "tab add", "＋ 新清單");
  add.addEventListener("click", async () => {
    const name = await askName("新清單的名字");
    if (name) setMode(createList(name).id);
  });
  tabs.append(add);
  tabs.querySelector(".on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

// 問一個名字（新清單、改名）。取消會回傳 null
let finishName = null;

function askName(title, initial = "") {
  return new Promise((resolve) => {
    const dialog = $("#name-dialog");
    const input = $("#name-input");
    $("#name-title").textContent = title;
    input.value = initial;
    finishName = (value) => {
      finishName = null;
      if (dialog.open) dialog.close();
      resolve(value);
    };
    dialog.showModal();
    input.select();
  });
}

// 存到清單：只有一個清單就直接切換，多個清單才跳出選單
let pickerPlace = null;

function onSaveClick(p) {
  if (state.lists.length !== 1) {
    pickerPlace = p;
    renderPicker();
    $("#picker").showModal();
    return;
  }
  const list = state.lists[0];
  toggleInList(list, p);
  toast(inList(list, p) ? `已加入「${list.name}」` : `已從「${list.name}」移除`);
  afterSaveChange();
}

function renderPicker() {
  $("#picker-name").textContent = pickerPlace.name;
  const box = $("#picker-lists");
  box.innerHTML = "";
  if (!state.lists.length) box.append(el("li", "empty", "還沒有清單，先建一個"));
  for (const list of state.lists) {
    const li = el("li");
    const cb = el("input", "check");
    cb.type = "checkbox";
    cb.id = "pick-" + list.id;
    cb.checked = inList(list, pickerPlace);
    cb.addEventListener("change", () => {
      toggleInList(list, pickerPlace);
      afterSaveChange();
    });
    const info = el("label", "info");
    info.htmlFor = cb.id;
    info.append(el("div", "name", list.name));
    li.append(cb, info);
    box.append(li);
  }
}

function afterSaveChange() {
  renderTabs();
  if (isNearby()) renderList();
  else refresh(true);
  renderSaveButton();
}

function renderSaveButton() {
  const p = state.lastPick;
  if (p) $("#r-save").textContent = isSaved(p) ? "★ 已在清單裡" : "☆ 存到清單";
}

// ---------- 最近吃過 ----------
function eatenRecently(p) {
  const cutoff = Date.now() - RECENT_DAYS * DAY_MS;
  return state.history.some((h) => h.at > cutoff && samePlace(h, p));
}

function recordPick(p) {
  state.history = [
    { id: p.id, name: p.name, at: Date.now() },
    ...state.history.filter((h) => h.name !== p.name),
  ].slice(0, HISTORY_MAX);
  saveJson("food-wheel-history", state.history);
  renderHistory();
}

function dayLabel(at) {
  const startOfDay = (t) => new Date(t).setHours(0, 0, 0, 0);
  const days = Math.round((startOfDay(Date.now()) - startOfDay(at)) / DAY_MS);
  return days <= 0 ? "今天" : days === 1 ? "昨天" : `${days} 天前`;
}

function renderHistory() {
  $("#history-card").hidden = !state.history.length;
  const list = $("#history");
  list.innerHTML = "";
  for (const h of state.history) {
    const li = el("li");
    const info = el("div", "info");
    info.append(el("div", "name", h.name), el("div", "meta", dayLabel(h.at)));
    const del = el("button", "act del", "✕");
    del.title = "刪除這筆紀錄";
    del.addEventListener("click", () => {
      state.history = state.history.filter((x) => x !== h);
      saveJson("food-wheel-history", state.history);
      renderHistory();
      refresh(true);
    });
    li.append(info, del);
    list.append(li);
  }
}

// ---------- 定位 ----------
function setStatus(msg) {
  $("#loc-status").textContent = msg;
}

function locate() {
  if (!navigator.geolocation) {
    setStatus("這個瀏覽器不支援定位，請用地址搜尋");
    $("#manual-loc").open = true;
    return;
  }
  setStatus("定位中…");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      state.center = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      state.label = "目前位置";
      state.lastPlace = null;
      saveSettings();
      searchPlaces();
    },
    (err) => {
      setStatus(err.code === 1 ? "沒有定位權限，請用地址搜尋" : "定位失敗，請用地址搜尋");
      $("#manual-loc").open = true;
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
  );
}

async function geocode(query) {
  setStatus("搜尋地址中…");
  try {
    const url = "https://nominatim.openstreetmap.org/search?format=json&limit=1&accept-language=zh-TW&q=" +
      encodeURIComponent(query);
    const res = await fetch(url);
    const data = await res.json();
    if (!data.length) {
      setStatus("找不到這個地址，換個寫法試試");
      return;
    }
    state.center = { lat: +data[0].lat, lon: +data[0].lon };
    state.label = `「${query}」`;
    state.lastPlace = { ...state.center, label: state.label };
    saveSettings();
    searchPlaces();
  } catch {
    setStatus("地址搜尋失敗，請稍後再試");
  }
}

// ---------- 抓附近店家 ----------
function buildQuery({ lat, lon }, radius, types) {
  const around = `(around:${radius},${lat.toFixed(6)},${lon.toFixed(6)});`;
  const parts = types.flatMap((t) => TYPE_FILTERS[t]).map((f) => f + around).join("");
  return `[out:json][timeout:25];(${parts});out center tags 400;`;
}

// 公開 Overpass 伺服器常常忙線，所以同時問全部，誰先回就用誰
async function fetchOverpass(query) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 45000);
  try {
    return await Promise.any(
      OVERPASS_ENDPOINTS.map(async (endpoint) => {
        const res = await fetch(endpoint, {
          method: "POST",
          body: "data=" + encodeURIComponent(query),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          signal: abort.signal,
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
    );
  } finally {
    clearTimeout(timer);
    abort.abort(); // 取消其他還在跑的請求
  }
}

function distance(a, b) {
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function describe(tags) {
  const kind = tags.amenity || tags.shop;
  const cuisines = (tags.cuisine || "").split(";").map((c) => c.trim()).filter(Boolean);
  const labels = cuisines.map((c) => CUISINE_LABELS[c]).filter(Boolean);
  return [...new Set([...labels, TYPE_LABELS[kind]].filter(Boolean))].slice(0, 3).join("・");
}

function osmPlace(e) {
  const tags = e.tags || {};
  const name = tags["name:zh-Hant"] || tags["name:zh"] || tags.name;
  const lat = e.lat ?? e.center?.lat;
  const lon = e.lon ?? e.center?.lon;
  if (!name || lat == null) return null;
  return { id: e.type + e.id, name, meta: describe(tags), lat, lon };
}

async function fetchOsm(center, radius, types) {
  const data = await fetchOverpass(buildQuery(center, radius, types));
  return data.elements.map(osmPlace).filter(Boolean);
}

// Google Nearby Search 一次最多 20 筆，所以每個類型各查一次（依熱門度排序）
async function fetchGoogle(center, radius, types) {
  const requests = types.map(async (t) => {
    const res = await fetch("https://places.googleapis.com/v1/places:searchNearby", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": GOOGLE_KEY,
        "X-Goog-FieldMask": GOOGLE_FIELDS,
      },
      body: JSON.stringify({
        includedTypes: GOOGLE_TYPES[t],
        excludedPrimaryTypes: GOOGLE_EXCLUDED,
        maxResultCount: 20,
        rankPreference: "POPULARITY",
        languageCode: "zh-TW",
        locationRestriction: {
          circle: { center: { latitude: center.lat, longitude: center.lon }, radius },
        },
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || "HTTP " + res.status);
    return data.places || [];
  });
  return (await Promise.all(requests)).flat().map(googlePlace).filter(Boolean);
}

function googlePlace(g) {
  const name = g.displayName?.text;
  if (!name || !g.location) return null;
  return {
    id: g.id,
    name,
    meta: g.primaryTypeDisplayName?.text || "",
    lat: g.location.latitude,
    lon: g.location.longitude,
    rating: g.rating,
    ratingCount: g.userRatingCount,
    price: PRICE_LABELS[g.priceLevel],
    openNow: g.currentOpeningHours?.openNow,
    mapUrl: g.googleMapsUri,
  };
}

const searchCache = new Map(); // key → { at, places }

async function fetchPlaces(center, radius, types) {
  const key = [center.lat.toFixed(3), center.lon.toFixed(3), radius, [...types].sort().join(",")].join("|");
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.places;
  const places = USE_GOOGLE
    ? await fetchGoogle(center, radius, types)
    : await fetchOsm(center, radius, types);
  searchCache.set(key, { at: Date.now(), places });
  return places;
}

async function searchPlaces() {
  if (!state.center) return;
  if (!state.types.length) {
    setStatus("至少選一種類型");
    return;
  }
  const seq = ++state.searchSeq;
  const center = state.center;
  setStatus(USE_GOOGLE ? "找附近的店…" : "找附近的店…（可能要 10–30 秒）");
  try {
    const raw = await fetchPlaces(center, state.radius, state.types);
    if (seq !== state.searchSeq) return; // 已經有更新的搜尋了
    // 同名的店（連鎖分店）只留最近的一家
    const seen = new Set();
    state.places = raw
      .map((p) => ({ ...p, dist: distance(center, p) }))
      .sort((a, b) => a.dist - b.dist)
      .filter((p) => !seen.has(p.name) && seen.add(p.name));
    setStatus(state.places.length
      ? `${state.label}附近找到 ${state.places.length} 家`
      : "這個範圍沒找到店，試試放大範圍");
    if (isNearby()) refresh(true);
  } catch (e) {
    if (seq !== state.searchSeq) return;
    setStatus(USE_GOOGLE
      ? `Google 查詢失敗（確認金鑰正確、已啟用 Places API (New)）：${e.message}`
      : "店家資料暫時抓不到，稍後再試（或先自己加選項）");
  }
}

// ---------- 名單 ----------
function formatDist(m) {
  return m < 1000 ? `${Math.round(m / 10) * 10}m` : `${(m / 1000).toFixed(1)}km`;
}

const isEnabled = (p) => !state.disabled.has(p.name);

function belowRating(p) {
  return isNearby() && USE_GOOGLE && state.minRating > 0 && (p.rating ?? 0) < state.minRating;
}

// 有勾選，而且沒被「營業中 / 評分 / 最近吃過」篩掉
function isCandidate(p) {
  return isEnabled(p) &&
    !(state.openOnly && p.openNow === false) &&
    !belowRating(p) &&
    !(state.avoidRecent && eatenRecently(p));
}

function ratingText(p) {
  return `★${p.rating.toFixed(1)}${p.ratingCount ? ` (${p.ratingCount.toLocaleString()})` : ""}`;
}

function placeMeta(p) {
  return [p.dist != null ? formatDist(p.dist) : null, p.rating ? ratingText(p) : null, p.price, p.meta]
    .filter(Boolean).join("・");
}

function metaRow(p) {
  const meta = el("div", "meta");
  if (p.dist != null) meta.append(el("span", "", formatDist(p.dist)));
  if (p.rating) meta.append(el("span", "star", ratingText(p)));
  if (p.price) meta.append(el("span", "", p.price));
  if (p.meta) meta.append(el("span", "", p.meta));
  if (p.openNow != null) meta.append(el("span", "badge " + (p.openNow ? "open" : "shut"), p.openNow ? "營業中" : "休息中"));
  if (eatenRecently(p)) meta.append(el("span", "badge eaten", "最近吃過"));
  return meta;
}

function renderList() {
  const list = currentList();
  const all = items();
  const box = $("#list");
  box.innerHTML = "";
  $("#list-title").textContent = list ? list.name : "候選名單";
  $("#count").textContent = all.length ? `${all.filter(isCandidate).length} / ${all.length}` : "";
  if (!all.length) {
    box.append(el("li", "empty", list
      ? "這個清單還是空的。在上面輸入店名，或到「附近」按 ☆ 收藏"
      : "還沒有候選，按上面「用我的位置找」"));
    return;
  }
  // 被篩掉的店（休息中、評分不夠、最近吃過）排到最後
  const skipped = (p) => isEnabled(p) && !isCandidate(p);
  const ordered = [...all.filter((p) => !skipped(p)), ...all.filter(skipped)];
  ordered.forEach((p, i) => {
    const li = el("li", !isEnabled(p) ? "off" : skipped(p) ? "skip" : "");

    const cb = el("input", "check");
    cb.type = "checkbox";
    cb.id = "place-" + i;
    cb.checked = isEnabled(p);
    cb.addEventListener("change", () => setEnabled(p, cb.checked));

    const info = el("label", "info");
    info.htmlFor = cb.id;
    info.append(el("div", "name", p.name), metaRow(p));

    let act;
    if (list) {
      act = el("button", "act del", "✕");
      act.title = "從清單移除";
      act.addEventListener("click", () => {
        toggleInList(list, p);
        afterSaveChange();
      });
    } else {
      const on = isSaved(p);
      act = el("button", "act" + (on ? " on" : ""), on ? "★" : "☆");
      act.title = on ? "已在清單裡" : "存到清單";
      act.setAttribute("aria-label", `${act.title}：${p.name}`);
      act.addEventListener("click", () => onSaveClick(p));
    }
    li.append(cb, info, act);
    box.append(li);
  });
}

function setEnabled(p, on) {
  if (on) state.disabled.delete(p.name);
  else state.disabled.add(p.name);
  refresh(true);
}

// ---------- 音效 ----------
let audioCtx = null;

function unlockAudio() {
  if (!state.sound) return;
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    audioCtx.resume();
  } catch {}
}

function beep(freq, delay, duration, volume) {
  if (!state.sound || !audioCtx) return;
  const t = audioCtx.currentTime + delay;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = "triangle";
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(volume, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(t);
  osc.stop(t + duration + 0.02);
}

const tick = () => beep(1100, 0, 0.03, 0.08);
function chime() {
  beep(784, 0, 0.18, 0.12);
  beep(1175, 0.13, 0.3, 0.12);
}

function renderSoundButton() {
  $("#btn-sound").textContent = state.sound ? "🔊" : "🔇";
  $("#btn-sound").setAttribute("aria-pressed", String(state.sound));
}

// ---------- 轉盤 ----------
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickSlices() {
  const all = items();
  const pool = all.filter(isCandidate);
  state.slices = pool.length > MAX_SLICES ? shuffle(pool).slice(0, MAX_SLICES) : pool;
  state.winner = null;
  const note = $("#wheel-note");
  if (!all.length) note.textContent = isNearby() ? "先找附近的店，才有東西可以轉" : "這個清單還是空的，先加幾家店";
  else if (!pool.length) note.textContent = "篩選後沒有店了，放寬條件試試";
  else if (pool.length === 1) note.textContent = "只有一個選項…那就是它了吧";
  else if (pool.length > MAX_SLICES) note.textContent = `從 ${pool.length} 家隨機抽 ${MAX_SLICES} 家上轉盤`;
  else note.textContent = `${pool.length} 個選項，點轉盤開轉`;
  $("#btn-shuffle").hidden = pool.length <= MAX_SLICES;
  $("#btn-spin").disabled = pool.length < 1;
}

function sizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const size = canvas.clientWidth;
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function fitText(text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + "…").width > maxWidth) t = t.slice(0, -1);
  return t + "…";
}

// 一行放不下、而且格子夠寬時，拆成兩行
function wrapLabel(text, maxWidth, maxLines) {
  if (maxLines < 2 || ctx.measureText(text).width <= maxWidth) return [fitText(text, maxWidth)];
  // 先試著從中間平均拆，第一行還是太長才往前縮
  let cut = Math.ceil(text.length / 2);
  while (cut > 1 && ctx.measureText(text.slice(0, cut)).width > maxWidth) cut--;
  return [text.slice(0, cut).trim(), fitText(text.slice(cut).trim(), maxWidth)];
}

function slicePath(c, r, start, step) {
  ctx.beginPath();
  ctx.moveTo(c, c);
  ctx.arc(c, c, r, start, start + step);
  ctx.closePath();
}

function sliceColor(i, n) {
  // 片數除以顏色數餘 1 時，最後一片會跟第一片同色，換一個
  const k = i === n - 1 && i > 0 && i % COLORS.length === 0 ? 4 : i % COLORS.length;
  return COLORS[k];
}

function drawWheel() {
  const size = canvas.clientWidth;
  if (size < 40) return; // 還沒排版（例如分頁在背景）
  const c = size / 2;
  const rim = c - 2;   // 外框
  const r = rim - 9;   // 色塊
  ctx.clearRect(0, 0, size, size);

  ctx.beginPath();
  ctx.arc(c, c, rim, 0, TAU);
  ctx.fillStyle = RIM_COLOR;
  ctx.fill();

  const slices = state.slices;
  const n = slices.length || 8;
  const step = TAU / n;
  // 0 度在正上方（指針位置），順時針排
  const base = state.rotation - Math.PI / 2;

  if (!slices.length) {
    // 還沒有選項：畫空白的格子
    const tones = [cssVar("--wheel-empty-a"), cssVar("--wheel-empty-b")];
    for (let i = 0; i < n; i++) {
      slicePath(c, r, base + i * step, step);
      ctx.fillStyle = tones[i % 2];
      ctx.fill();
    }
  } else {
    const fontSize = Math.max(12, Math.min(16, size / 23));
    ctx.font = `700 ${fontSize}px system-ui, "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", sans-serif`;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(255,255,255,0.85)";

    slices.forEach((item, i) => {
      const start = base + i * step;
      const [bg, fg] = sliceColor(i, n);
      slicePath(c, r, start, step);
      ctx.fillStyle = bg;
      ctx.fill();
      if (n > 1) ctx.stroke();

      // 左半邊的字轉 180 度，避免上下顛倒
      const mid = start + step / 2;
      const norm = ((mid % TAU) + TAU) % TAU;
      const flip = norm > Math.PI / 2 && norm < (Math.PI * 3) / 2;
      const lines = wrapLabel(item.name, r - 68, n <= 8 ? 2 : 1);
      const lineHeight = fontSize * 1.2;
      ctx.save();
      ctx.translate(c, c);
      ctx.rotate(flip ? mid + Math.PI : mid);
      ctx.textAlign = flip ? "left" : "right";
      ctx.textBaseline = "middle";
      ctx.fillStyle = fg;
      lines.forEach((line, k) => {
        ctx.fillText(line, flip ? -(r - 14) : r - 14, (k - (lines.length - 1) / 2) * lineHeight);
      });
      ctx.restore();
    });

    // 轉完後把沒中的格子調淡，凸顯中獎那格
    if (state.winner != null && n > 1) {
      ctx.fillStyle = cssVar("--wheel-dim");
      slices.forEach((_, i) => {
        if (i === state.winner) return;
        slicePath(c, r, base + i * step, step);
        ctx.fill();
      });
      slicePath(c, r, base + state.winner * step, step);
      ctx.lineWidth = 4;
      ctx.strokeStyle = "#fff";
      ctx.stroke();
    }
  }

  // 一點立體感：中間亮、邊緣暗
  const shade = ctx.createRadialGradient(c, c, r * 0.2, c, c, r);
  shade.addColorStop(0, "rgba(255,255,255,0.12)");
  shade.addColorStop(0.6, "rgba(255,255,255,0)");
  shade.addColorStop(1, "rgba(0,0,0,0.12)");
  ctx.beginPath();
  ctx.arc(c, c, r, 0, TAU);
  ctx.fillStyle = shade;
  ctx.fill();

  // 外框上的小圓釘
  ctx.fillStyle = PEG_COLOR;
  for (let i = 0; i < n; i++) {
    const a = base + i * step;
    ctx.beginPath();
    ctx.arc(c + Math.cos(a) * (rim - 4.5), c + Math.sin(a) * (rim - 4.5), 2.4, 0, TAU);
    ctx.fill();
  }
}

// 指針（正上方）現在指到第幾格
function indexAtPointer() {
  const n = state.slices.length;
  const angle = (((-state.rotation) % TAU) + TAU) % TAU;
  return Math.floor(angle / (TAU / n)) % n;
}

function kickPointer() {
  $("#pointer").animate(
    [{ transform: "translateX(-50%) rotate(-18deg)" }, { transform: "translateX(-50%) rotate(0deg)" }],
    { duration: 110, easing: "ease-out" }
  );
}

// 轉盤停下時從中心噴出的彩色紙片
function confetti() {
  if (reducedMotion) return;
  const cv = $("#confetti");
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = window.innerWidth;
  const h = window.innerHeight;
  cv.width = w * dpr;
  cv.height = h * dpr;
  const c2 = cv.getContext("2d");
  c2.scale(dpr, dpr);
  const box = canvas.getBoundingClientRect();
  const ox = box.left + box.width / 2;
  const oy = box.top + box.height / 2;
  const parts = Array.from({ length: 70 }, () => {
    const angle = Math.random() * TAU;
    const speed = 4 + Math.random() * 9;
    return {
      x: ox, y: oy,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 4,
      size: 5 + Math.random() * 6,
      color: COLORS[Math.floor(Math.random() * COLORS.length)][0],
      rot: Math.random() * TAU,
      vr: (Math.random() - 0.5) * 0.4,
    };
  });
  const t0 = performance.now();
  function frame(now) {
    const t = (now - t0) / 1600;
    c2.clearRect(0, 0, w, h);
    if (t >= 1) return;
    for (const p of parts) {
      p.vy += 0.35;
      p.vx *= 0.99;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      c2.save();
      c2.globalAlpha = 1 - t * t;
      c2.translate(p.x, p.y);
      c2.rotate(p.rot);
      c2.fillStyle = p.color;
      c2.fillRect(-p.size / 2, -p.size / 3, p.size, p.size * 0.66);
      c2.restore();
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function spin() {
  if (state.spinning || !state.slices.length) return;
  unlockAudio();
  const n = state.slices.length;
  const target = Math.floor(Math.random() * n);
  const step = TAU / n;
  // 讓 target 片的中間（加一點隨機偏移）停在正上方
  const jitter = (Math.random() - 0.5) * step * 0.7;
  const want = -(target * step + step / 2 + jitter);
  const delta = (((want - state.rotation) % TAU) + TAU) % TAU;
  const total = delta + TAU * (5 + Math.floor(Math.random() * 3));

  const from = state.rotation;
  const duration = reducedMotion ? 1200 : SPIN_MS;
  const t0 = performance.now();
  let lastIndex = indexAtPointer();
  state.spinning = true;
  state.winner = null;
  $("#btn-spin").disabled = true;

  const easeOut = (t) => 1 - Math.pow(1 - t, 4);
  function frame(now) {
    const t = Math.min(1, (now - t0) / duration);
    state.rotation = from + total * easeOut(t);
    const index = indexAtPointer();
    if (index !== lastIndex) {
      lastIndex = index;
      tick();
      if (!reducedMotion) kickPointer();
    }
    if (t < 1) {
      drawWheel();
      requestAnimationFrame(frame);
      return;
    }
    state.spinning = false;
    state.winner = indexAtPointer();
    drawWheel();
    chime();
    confetti();
    navigator.vibrate?.(40);
    $("#btn-spin").disabled = false;
    const picked = state.slices[state.winner];
    setTimeout(() => showResult(picked), 600);
  }
  requestAnimationFrame(frame);
}

function mapUrlFor(p) {
  if (p.mapUrl) return p.mapUrl;
  if (p.lat != null) return `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lon}`;
  const near = state.center ? `&center=${state.center.lat},${state.center.lon}` : "";
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.name)}${near}`;
}

function showResult(p) {
  state.lastPick = p;
  $("#r-name").textContent = p.name;
  $("#r-meta").textContent = placeMeta(p);
  $("#r-map").href = mapUrlFor(p);
  $("#r-drop").hidden = items().filter(isCandidate).length <= 1;
  $("#r-share").hidden = !navigator.share;
  renderSaveButton();
  $("#result").showModal();
}

function refresh(reshuffle) {
  if (reshuffle) pickSlices();
  renderList();
  drawWheel();
}

// ---------- 事件 ----------
function bindSeg(sel, current, onPick) {
  const buttons = [...document.querySelectorAll(`${sel} button`)];
  const mark = (v) => buttons.forEach((b) => b.classList.toggle("on", b.dataset.v === String(v)));
  mark(current);
  $(sel).addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    mark(btn.dataset.v);
    onPick(+btn.dataset.v);
    saveSettings();
  });
}

function bindToggle(sel, key, onChange) {
  const input = $(sel);
  input.checked = state[key];
  input.addEventListener("change", () => {
    state[key] = input.checked;
    saveSettings();
    onChange();
  });
}

// 點對話框外面的暗色區域就關掉
function closeOnBackdrop(sel) {
  $(sel).addEventListener("click", (e) => {
    if (e.target === e.currentTarget) e.currentTarget.close();
  });
}

$("#btn-locate").addEventListener("click", locate);

$("#addr-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("#addr-input").value.trim();
  if (q) geocode(q);
  $("#addr-input").blur();
});

bindSeg("#radius-seg", state.radius, (v) => {
  state.radius = v;
  searchPlaces();
});
bindSeg("#rating-seg", state.minRating, (v) => {
  state.minRating = v;
  refresh(true);
});
bindToggle("#open-only", "openOnly", () => refresh(true));
bindToggle("#avoid-recent", "avoidRecent", () => refresh(true));

const typeInputs = [...document.querySelectorAll("#type-chips input")];
typeInputs.forEach((input) => (input.checked = state.types.includes(input.value)));
$("#type-chips").addEventListener("change", () => {
  state.types = typeInputs.filter((i) => i.checked).map((i) => i.value);
  saveSettings();
  searchPlaces();
});

$("#btn-sound").addEventListener("click", () => {
  state.sound = !state.sound;
  saveSettings();
  renderSoundButton();
  unlockAudio();
  tick();
});

// 清單：加店、改名、刪除
$("#custom-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const list = currentList();
  const input = $("#custom-input");
  const name = input.value.trim();
  if (!list || !name) return;
  if (list.items.some((it) => it.name === name)) {
    toast("清單裡已經有這家了");
    return;
  }
  list.items.push(manualItem(name));
  input.value = "";
  saveLists();
  afterSaveChange();
});

$("#btn-rename").addEventListener("click", async () => {
  const list = currentList();
  const name = list && (await askName("清單改名", list.name));
  if (!name) return;
  list.name = name;
  saveLists();
  renderTabs();
  renderList();
});

$("#btn-delete-list").addEventListener("click", () => {
  const list = currentList();
  if (!list) return;
  const extra = list.items.length ? `裡面的 ${list.items.length} 家店也會一起刪掉。` : "";
  if (!confirm(`刪除「${list.name}」？${extra}`)) return;
  state.lists = state.lists.filter((l) => l !== list);
  saveLists();
  setMode("nearby");
});

$("#name-dialog form").addEventListener("submit", (e) => {
  e.preventDefault();
  finishName?.($("#name-input").value.trim() || null);
});
$("#name-cancel").addEventListener("click", () => finishName?.(null));
$("#name-dialog").addEventListener("close", () => finishName?.(null)); // 按 Esc 關掉

$("#picker-new").addEventListener("click", async () => {
  const name = await askName("新清單的名字");
  if (!name) return;
  toggleInList(createList(name), pickerPlace);
  renderPicker();
  afterSaveChange();
});
$("#picker-done").addEventListener("click", () => $("#picker").close());

$("#btn-all").addEventListener("click", () => {
  items().forEach((p) => state.disabled.delete(p.name));
  refresh(true);
});
$("#btn-none").addEventListener("click", () => {
  items().forEach((p) => state.disabled.add(p.name));
  refresh(true);
});
$("#btn-shuffle").addEventListener("click", () => refresh(true));
$("#btn-spin").addEventListener("click", spin);
canvas.addEventListener("click", spin);

$("#r-map").addEventListener("click", () => {
  if (state.lastPick) recordPick(state.lastPick);
});
$("#r-again").addEventListener("click", () => {
  $("#result").close();
  spin();
});
$("#r-drop").addEventListener("click", () => {
  $("#result").close();
  if (state.lastPick) setEnabled(state.lastPick, false);
  spin();
});
$("#r-save").addEventListener("click", () => {
  if (state.lastPick) onSaveClick(state.lastPick);
});
$("#r-share").addEventListener("click", () => {
  const p = state.lastPick;
  if (!p) return;
  navigator.share({ title: "今天吃什麼", text: `今天吃「${p.name}」！`, url: mapUrlFor(p) }).catch(() => {});
});
closeOnBackdrop("#result");
closeOnBackdrop("#picker");

$("#btn-clear-history").addEventListener("click", () => {
  state.history = [];
  saveJson("food-wheel-history", state.history);
  renderHistory();
  refresh(true);
});

new ResizeObserver(() => {
  sizeCanvas();
  drawWheel();
}).observe(canvas);
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", drawWheel);

// ---------- 啟動 ----------
// 上次用地址搜尋就回到那個地址；否則如果已經允許過定位，就直接找
async function autoStart() {
  if (state.lastPlace) {
    state.center = { lat: state.lastPlace.lat, lon: state.lastPlace.lon };
    state.label = state.lastPlace.label;
    searchPlaces();
    return;
  }
  try {
    const perm = await navigator.permissions.query({ name: "geolocation" });
    if (perm.state === "granted") locate();
  } catch {}
}

$("#rating-field").hidden = !USE_GOOGLE;
$("#open-field").hidden = !USE_GOOGLE;
$("#source-note").textContent = USE_GOOGLE
  ? "店家資料來自 Google 地圖。按 ☆ 可以把店存到自己的清單。"
  : "店家資料來自 © OpenStreetMap 貢獻者，可能不完整。（在 config.js 填 Google API 金鑰可改用 Google 地圖資料）";
document.body.dataset.mode = isNearby() ? "nearby" : "list";
renderTabs();
renderSoundButton();
renderHistory();
sizeCanvas();
refresh(true);
if (isNearby()) autoStart();
