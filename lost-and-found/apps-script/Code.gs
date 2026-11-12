/**
 * 臺北中山國小臺北市中山國小遺失物招領系統 — Google Apps Script 後端
 *
 * 使用方式（詳見 README.md）：
 * 1. 建立一份新的 Google 試算表 → 擴充功能 → Apps Script，把本檔內容貼上並儲存。
 * 2. 在編輯器上方選擇函式「setup」→ 執行，授權後到「執行記錄」查看管理者帳號與臨時密碼。
 * 3. 部署 → 新增部署作業 → 類型「網頁應用程式」，執行身分「我」，存取權「所有人」。
 * 4. 把網頁應用程式網址貼到網站的 config.js。
 */

const SHEET_ITEMS = '物品清冊';
const SHEET_USERS = '帳號';
const SHEET_SETTINGS = '設定';
const SESSION_SECONDS = 6 * 60 * 60;      // 登入有效 6 小時
const MAX_LOGIN_FAILS = 5;                 // 連續失敗 5 次鎖定
const LOCK_SECONDS = 10 * 60;              // 鎖定 10 分鐘
const HASH_ROUNDS = 200;
const TZ = 'Asia/Taipei';                  // 台灣時間，不受專案時區設定影響

// [欄位代號, 試算表標題]
const COLS = [
  ['id', 'ID'], ['code', '編號'], ['name', '物品名稱'], ['category', '類別'],
  ['color', '顏色外觀'], ['brand', '品牌型號'], ['desc', '公開描述'],
  ['foundDate', '拾獲日期'], ['location', '拾獲地點'], ['storage', '存放位置'],
  ['handler', '經辦人'], ['photoId', '照片ID'], ['status', '狀態'], ['retentionDays', '保管期限'],
  ['claimedDate', '認領日期'], ['createdAt', '建立時間'], ['updatedAt', '更新時間'],
  ['finder', '拾獲人'], ['finderContact', '拾獲人聯絡'], ['secret', '辨識特徵'],
  ['claimName', '認領人'], ['claimSid', '學號身分'], ['claimCls', '班級'],
  ['claimPhone', '認領人電話'], ['claimHandler', '認領經辦'], ['claimNote', '認領備註'],
  ['disposeMethod', '處置方式'], ['disposeDate', '處置日期'], ['disposeNote', '處置備註'],
];
// 學生、訪客（未登入）看得到的欄位
const PUBLIC_KEYS = ['id', 'code', 'name', 'category', 'color', 'brand', 'desc',
  'foundDate', 'location', 'photoId', 'status', 'retentionDays', 'claimedDate', 'createdAt'];
const ITEM_INPUT_KEYS = ['name', 'category', 'color', 'brand', 'desc', 'foundDate',
  'location', 'storage', 'handler', 'finder', 'finderContact', 'secret', 'retentionDays'];
const RETENTION_CHOICES = ['7', '14', '30', '60', '120', '180'];

const DEFAULT_SETTINGS = {
  office: '學務處｜週一至週五 08:00–16:30',
  notice: '遺失物品者請攜帶學生證至學務處，說明物品特徵後即可認領。保管期滿未認領之物品，將依規定處理。',
  retentionDays: '14',
  locations: '教室,走廊,操場,體育館,圖書館,福利社,廁所,校門口,司令台,停車場',
};
const SETTING_NOTES = {
  office: '顯示在網站標題下方',
  notice: '招領公告頁上方的說明文字',
  retentionDays: '保管期限（天），超過即標示逾期',
  locations: '常用拾獲地點，以逗號分隔',
};

/* ===================== 初始化（請先執行這個） ===================== */

/** 第一次使用：在 Apps Script 編輯器執行這個函式 */
function setup() {
  itemsSheet_();
  const st = settingsSheet_();
  if (st.getLastRow() < 2) saveSettings_({});
  photoFolder_();
  const { sh, users } = readUsers_();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const blank = ss.getSheetByName('工作表1') || ss.getSheetByName('Sheet1');
  if (blank && blank.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(blank);
  usersSheet_().hideSheet();

  if (!users.length) {
    const password = randomPassword_();
    const salt = Utilities.getUuid();
    sh.getRange(2, 1, 1, 6).setNumberFormat('@').setValues([['admin', '系統管理者', 'admin', salt, hash_(salt, password), now_()]]);
    const msg = '初始化完成！\n管理者帳號：admin\n臨時密碼：' + password + '\n登入網站後請到「設定」變更密碼。';
    Logger.log(msg);
    try { SpreadsheetApp.getUi().alert(msg); } catch (e) {}
  } else {
    Logger.log('初始化完成（已有帳號，未建立新的管理者）。');
  }
}

/* ===================== 進入點 ===================== */

function doGet() {
  return json_({ ok: true, message: '失物招領 API 運作中' });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: '請求格式錯誤' });
  }
  try {
    const result = handle_(req) || {};
    result.ok = true;
    return json_(result);
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err), auth: !!(err && err.auth) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function handle_(req) {
  const action = String(req.action || '');
  if (action === 'list') {
    const s = getSession_(req.token, false);   // 自動更新不延長登入時間
    return { items: s ? listItems_(true) : publicListCached_(), settings: getSettings_(), me: s ? publicMe_(s) : null };
  }
  if (action === 'login') return login_(req.username, req.password);

  const s = getSession_(req.token);
  if (!s) { const e = new Error('請先登入，或登入已逾時'); e.auth = true; throw e; }

  switch (action) {
    case 'logout':
      CacheService.getScriptCache().remove('s_' + req.token);
      return {};
    case 'saveItem': return withLock_(() => saveItem_(req, s));
    case 'claim': return withLock_(() => claim_(req, s));
    case 'dispose': return withLock_(() => dispose_(req));
    case 'reopen': return withLock_(() => reopen_(req));
    case 'deleteItem': requireAdmin_(s); return withLock_(() => deleteItem_(req));
    case 'saveSettings': requireAdmin_(s); return withLock_(() => saveSettings_(req.settings || {}));
    case 'changePassword': return withLock_(() => changePassword_(s, req.oldPassword, req.newPassword));
    case 'listUsers': requireAdmin_(s); return { users: listUsers_() };
    case 'addUser': requireAdmin_(s); return withLock_(() => addUser_(req));
    case 'resetPassword': requireAdmin_(s); return withLock_(() => ({ password: resetPassword_(req.username) }));
    case 'deleteUser': requireAdmin_(s); return withLock_(() => deleteUser_(req.username, s));
    default: throw new Error('未知的動作：' + action);
  }
}

/* ===================== 物品 ===================== */

function itemsSheet_() {
  const sh = sheet_(SHEET_ITEMS, COLS.map(c => c[1]));
  // 舊版試算表自動補上新欄位（例如「保管期限」）
  const header = sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0];
  const missing = COLS.map(c => c[1]).filter(t => header.indexOf(t) < 0);
  if (missing.length) {
    sh.getRange(1, header.filter(h => h !== '').length + 1, 1, missing.length)
      .setValues([missing]).setFontWeight('bold').setBackground('#e3efee');
  }
  return sh;
}

function headerMap_(sh) {
  const header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const byTitle = {};
  COLS.forEach(c => byTitle[c[1]] = c[0]);
  const map = {};
  header.forEach((h, i) => { if (byTitle[h]) map[byTitle[h]] = i; });
  return { map, width: header.length };
}

function cell_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  return v === null || v === undefined ? '' : String(v);
}

function readItems_() {
  const sh = itemsSheet_();
  const last = sh.getLastRow();
  if (last < 2) return { sh, rows: [], hm: headerMap_(sh) };
  const hm = headerMap_(sh);
  const values = sh.getRange(2, 1, last - 1, hm.width).getValues();
  const rows = values.map((r, i) => {
    const o = { _row: i + 2 };
    Object.keys(hm.map).forEach(k => o[k] = cell_(r[hm.map[k]]));
    return o;
  }).filter(o => o.id);
  return { sh, rows, hm };
}

function listItems_(staff) {
  return readItems_().rows.map(o => {
    const out = {};
    (staff ? COLS.map(c => c[0]) : PUBLIC_KEYS).forEach(k => out[k] = o[k] || '');
    // 未登入者看不到已處置的物品
    return out;
  }).filter(o => staff || o.status !== '已處置');
}

function publicListCached_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('pub_list');
  if (hit) return JSON.parse(hit);
  const items = listItems_(false);
  try { cache.put('pub_list', JSON.stringify(items), 30); } catch (e) {}   // 超過快取上限就不快取
  return items;
}

function clearPublicCache_() { CacheService.getScriptCache().remove('pub_list'); }

function writeRow_(ctx, obj) {
  const { sh, hm } = ctx;
  const row = obj._row || sh.getLastRow() + 1;
  const range = sh.getRange(row, 1, 1, hm.width);
  const cur = obj._row ? range.getValues()[0] : new Array(hm.width).fill('');
  Object.keys(hm.map).forEach(k => { if (k in obj) cur[hm.map[k]] = obj[k] === undefined ? '' : String(obj[k]); });
  range.setNumberFormat('@').setValues([cur]);
  clearPublicCache_();
}

function findItem_(ctx, id) {
  const it = ctx.rows.find(r => r.id === String(id));
  if (!it) throw new Error('找不到這筆物品，可能已被刪除');
  return it;
}

function clean_(v, max) { return String(v === undefined || v === null ? '' : v).trim().slice(0, max || 300); }
function now_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'); }
function isDate_(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s); }

function saveItem_(req, s) {
  const ctx = readItems_();
  const input = req.item || {};
  const data = {};
  ITEM_INPUT_KEYS.forEach(k => data[k] = clean_(input[k]));
  if (!data.name) throw new Error('請填寫物品名稱');
  if (!data.location) throw new Error('請填寫拾獲地點');
  if (!isDate_(data.foundDate)) throw new Error('拾獲日期格式不正確');
  if (!data.category) data.category = '其他';
  if (data.retentionDays && RETENTION_CHOICES.indexOf(data.retentionDays) < 0) throw new Error('保管期限不正確');
  if (!data.handler) data.handler = s.name;

  let it;
  if (input.id) {
    it = findItem_(ctx, input.id);
  } else {
    const ymd = data.foundDate.replace(/-/g, '').slice(2);
    const prefix = 'L' + ymd + '-';
    const seq = ctx.rows.filter(r => (r.code || '').indexOf(prefix) === 0).length + 1;
    it = { id: Utilities.getUuid().replace(/-/g, '').slice(0, 16), code: prefix + ('00' + seq).slice(-3),
      status: '待認領', createdAt: now_() };
  }
  Object.assign(it, data, { updatedAt: now_() });

  if (req.removePhoto && it.photoId) { trashFile_(it.photoId); it.photoId = ''; }
  if (req.photoData) {
    if (it.photoId) trashFile_(it.photoId);
    it.photoId = savePhoto_(req.photoData, it.code);
  }
  writeRow_(ctx, it);
  return { id: it.id, code: it.code };
}

function claim_(req, s) {
  const ctx = readItems_();
  const it = findItem_(ctx, req.id);
  const c = req.claim || {};
  if (!clean_(c.name)) throw new Error('請填寫認領人姓名');
  const date = clean_(c.date);
  if (!isDate_(date)) throw new Error('認領日期格式不正確');
  Object.assign(it, {
    status: '已認領', claimedDate: date,
    claimName: clean_(c.name, 40), claimSid: clean_(c.sid, 40), claimCls: clean_(c.cls, 20),
    claimPhone: clean_(c.phone, 30), claimHandler: clean_(c.handler, 40) || s.name, claimNote: clean_(c.note),
    updatedAt: now_(),
  });
  writeRow_(ctx, it);
  return {};
}

function dispose_(req) {
  const ctx = readItems_();
  const it = findItem_(ctx, req.id);
  const d = req.dispose || {};
  if (!isDate_(clean_(d.date))) throw new Error('處置日期格式不正確');
  Object.assign(it, { status: '已處置', disposeMethod: clean_(d.method, 40), disposeDate: clean_(d.date),
    disposeNote: clean_(d.note), updatedAt: now_() });
  writeRow_(ctx, it);
  return {};
}

function reopen_(req) {
  const ctx = readItems_();
  const it = findItem_(ctx, req.id);
  ['claimedDate', 'claimName', 'claimSid', 'claimCls', 'claimPhone', 'claimHandler', 'claimNote',
    'disposeMethod', 'disposeDate', 'disposeNote'].forEach(k => it[k] = '');
  it.status = '待認領';
  it.updatedAt = now_();
  writeRow_(ctx, it);
  return {};
}

function deleteItem_(req) {
  const ctx = readItems_();
  const it = findItem_(ctx, req.id);
  if (it.photoId) trashFile_(it.photoId);
  ctx.sh.deleteRow(it._row);
  clearPublicCache_();
  return {};
}

/* ===================== 照片 ===================== */

function photoFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('PHOTO_FOLDER');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  const folder = DriveApp.createFolder('失物招領照片');
  props.setProperty('PHOTO_FOLDER', folder.getId());
  return folder;
}

function savePhoto_(dataUrl, code) {
  const m = String(dataUrl).match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
  if (!m) throw new Error('照片格式不正確');
  if (m[2].length > 2 * 1024 * 1024) throw new Error('照片太大');
  const blob = Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], code + '.jpg');
  const file = photoFolder_().createFile(blob);
  try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) {
    // 部分學校網域禁止對外分享，照片仍會保存，但網站上可能無法顯示
  }
  return file.getId();
}

function trashFile_(id) { try { DriveApp.getFileById(id).setTrashed(true); } catch (e) {} }

/* ===================== 設定 ===================== */

function settingsSheet_() { return sheet_(SHEET_SETTINGS, ['項目', '內容', '說明']); }

function getSettings_() {
  const sh = settingsSheet_();
  const out = Object.assign({}, DEFAULT_SETTINGS);
  if (sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(r => { if (r[0] in DEFAULT_SETTINGS) out[r[0]] = cell_(r[1]); });
  }
  return out;
}

function saveSettings_(input) {
  const s = getSettings_();
  Object.keys(DEFAULT_SETTINGS).forEach(k => { if (k in input) s[k] = clean_(input[k], 500); });
  const days = parseInt(s.retentionDays, 10);
  s.retentionDays = String(days > 0 && days < 3650 ? days : 180);
  const sh = settingsSheet_();
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 3).clearContent();
  const rows = Object.keys(DEFAULT_SETTINGS).map(k => [k, s[k], SETTING_NOTES[k] || '']);
  sh.getRange(2, 1, rows.length, 3).setNumberFormat('@').setValues(rows);
  return { settings: s };
}

/* ===================== 帳號與登入 ===================== */

function usersSheet_() { return sheet_(SHEET_USERS, ['帳號', '姓名', '角色', 'salt', 'hash', '建立時間']); }

function readUsers_() {
  const sh = usersSheet_();
  if (sh.getLastRow() < 2) return { sh, users: [] };
  const users = sh.getRange(2, 1, sh.getLastRow() - 1, 6).getValues().map((r, i) => ({
    _row: i + 2, username: cell_(r[0]).trim(), name: cell_(r[1]), role: cell_(r[2]) === 'admin' ? 'admin' : 'staff',
    salt: cell_(r[3]), hash: cell_(r[4]), createdAt: cell_(r[5]),
  })).filter(u => u.username);
  return { sh, users };
}

function hash_(salt, password) {
  let h = salt + ':' + password;
  for (let i = 0; i < HASH_ROUNDS; i++) {
    h = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h, Utilities.Charset.UTF_8)
      .map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
  }
  return h;
}

function randomPassword_() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let p = '';
  for (let i = 0; i < 10; i++) p += chars.charAt(Math.floor(Math.random() * chars.length));
  return p;
}

function setPassword_(sh, user, password) {
  const salt = Utilities.getUuid();
  sh.getRange(user._row, 4, 1, 2).setNumberFormat('@').setValues([[salt, hash_(salt, password)]]);
}

function findUser_(users, username) {
  const u = String(username || '').trim().toLowerCase();
  return users.find(x => x.username.toLowerCase() === u);
}

function login_(username, password) {
  const cache = CacheService.getScriptCache();
  const key = 'fail_' + String(username || '').trim().toLowerCase();
  const fails = parseInt(cache.get(key) || '0', 10);
  if (fails >= MAX_LOGIN_FAILS) throw new Error('嘗試次數過多，請 10 分鐘後再試');
  const user = findUser_(readUsers_().users, username);
  if (!user || !password || hash_(user.salt, String(password)) !== user.hash) {
    cache.put(key, String(fails + 1), LOCK_SECONDS);
    Utilities.sleep(500);
    throw new Error('帳號或密碼錯誤');
  }
  cache.remove(key);
  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  const s = { username: user.username, name: user.name || user.username, role: user.role };
  cache.put('s_' + token, JSON.stringify(s), SESSION_SECONDS);
  return { token, me: publicMe_(s) };
}

function getSession_(token, extend) {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const cache = CacheService.getScriptCache();
  const raw = cache.get('s_' + token);
  if (!raw) return null;
  const s = JSON.parse(raw);
  // 確認帳號仍存在且角色未變
  const user = findUser_(readUsers_().users, s.username);
  if (!user) { cache.remove('s_' + token); return null; }
  s.role = user.role; s.name = user.name || user.username;
  if (extend !== false) cache.put('s_' + token, JSON.stringify(s), SESSION_SECONDS);   // 有操作才延長
  return s;
}

function publicMe_(s) { return { username: s.username, name: s.name, role: s.role }; }

function requireAdmin_(s) {
  if (s.role !== 'admin') throw new Error('只有管理者可以執行這個動作');
}

function changePassword_(s, oldPw, newPw) {
  const { sh, users } = readUsers_();
  const user = findUser_(users, s.username);
  if (!user || hash_(user.salt, String(oldPw || '')) !== user.hash) throw new Error('目前密碼不正確');
  if (String(newPw || '').length < 8) throw new Error('新密碼至少需要 8 個字元');
  setPassword_(sh, user, String(newPw));
  return {};
}

function listUsers_() {
  return readUsers_().users.map(u => ({ username: u.username, name: u.name, role: u.role, createdAt: u.createdAt }));
}

function addUser_(req) {
  const { sh, users } = readUsers_();
  const username = clean_(req.username, 30);
  if (!/^[A-Za-z0-9_.-]{3,30}$/.test(username)) throw new Error('帳號需為 3–30 個英數字（可含 _ . -）');
  if (findUser_(users, username)) throw new Error('這個帳號已經存在');
  const role = req.role === 'admin' ? 'admin' : 'staff';
  const password = randomPassword_();
  const salt = Utilities.getUuid();
  const row = sh.getLastRow() + 1;
  sh.getRange(row, 1, 1, 6).setNumberFormat('@')
    .setValues([[username, clean_(req.name, 40) || username, role, salt, hash_(salt, password), now_()]]);
  return { password };
}

function resetPassword_(username) {
  const { sh, users } = readUsers_();
  const user = findUser_(users, username);
  if (!user) throw new Error('找不到這個帳號');
  const password = randomPassword_();
  setPassword_(sh, user, password);
  return password;
}

function deleteUser_(username, s) {
  const { sh, users } = readUsers_();
  const user = findUser_(users, username);
  if (!user) throw new Error('找不到這個帳號');
  if (user.username.toLowerCase() === s.username.toLowerCase()) throw new Error('不能刪除自己的帳號');
  if (user.role === 'admin' && users.filter(u => u.role === 'admin').length <= 1) throw new Error('至少要保留一位管理者');
  sh.deleteRow(user._row);
  return {};
}

/* ===================== 共用工具 ===================== */

function sheet_(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#e3efee');
    sh.setFrozenRows(1);
    sh.getRange(2, 1, Math.max(1, sh.getMaxRows() - 1), headers.length).setNumberFormat('@');
  }
  return sh;
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('系統忙碌中，請稍後再試');
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ===================== 初始化與選單 ===================== */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('失物招領')
    .addItem('初始化系統', 'setup')
    .addItem('重設帳號密碼…', 'menuResetPassword')
    .addToUi();
}

function menuResetPassword() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt('重設密碼', '請輸入要重設的帳號：', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  try {
    const pw = resetPassword_(r.getResponseText());
    ui.alert('已重設。新的臨時密碼：' + pw);
  } catch (e) {
    ui.alert(e.message);
  }
}
