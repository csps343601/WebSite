/* 學務處失物招領系統 — 前端程式 */
(() => {
'use strict';

const CATS = [
  {n:'證件卡片', e:'🪪'}, {n:'3C 電子', e:'🎧'}, {n:'錢包鑰匙', e:'👛'},
  {n:'水壺餐具', e:'🥤'}, {n:'衣物配件', e:'🧥'}, {n:'書籍文具', e:'📚'},
  {n:'運動用品', e:'⚽'}, {n:'雨具', e:'☂️'}, {n:'其他', e:'📦'},
];
const CAT = Object.fromEntries(CATS.map(c => [c.n, c]));
const catIcon = n => (CAT[n] || CAT['其他']).e;
const DEFAULT_SETTINGS = {
  office: '學務處生活輔導組｜週一至週五 07:30–16:30',
  notice: '遺失物品者請攜帶學生證至學務處，說明物品特徵後即可認領。保管期滿未認領之物品，將依規定處理。',
  retentionDays: '180',
  locations: '教室,走廊,操場,體育館,圖書館,福利社,廁所,校門口,司令台,停車場',
};
const API_URL = ((window.LF_CONFIG || {}).apiUrl || '').trim();
const DEMO = !API_URL;
const REFRESH_MS = 60000;

const S = {
  items: [], settings: {...DEFAULT_SETTINGS}, me: null, loaded: false,
  cat: 'all', editId: null, photoNew: null, photoExisting: null, photoRemoved: false,
  knownIds: null, newIds: new Set(), onlyNew: false, unseen: 0,
};
const BASE_TITLE = document.title;

/* ---------- 小工具 ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0,10); };
const daysSince = ds => ds ? Math.max(0, Math.floor((Date.parse(today()) - Date.parse(ds)) / 864e5)) : 0;
const addDays = (ds, n) => { if (!ds) return ''; const d = new Date(Date.parse(ds) + n * 864e5); return d.toISOString().slice(0,10); };
const fmtDate = ds => ds ? String(ds).slice(0,10).replace(/-/g, '/') : '—';
const isStaff = () => !!S.me;
const isAdmin = () => S.me?.role === 'admin';
const store = {
  get(k){ try { return localStorage.getItem(k); } catch { return null; } },
  set(k,v){ try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};
function toast(msg){ document.querySelectorAll('.toast').forEach(x => x.remove()); const t = document.createElement('div'); t.className='toast'; t.textContent=msg; document.body.appendChild(t); setTimeout(()=>t.remove(), 2800); }
const RET_CHOICES = [7, 14, 30, 60, 120];
const RET_HINT = {7:'雨傘、餐具', 14:'衣物、文具', 30:'一般物品', 60:'較貴重', 120:'證件、3C、錢包'};
const retOf = it => +it.retentionDays || +S.settings.retentionDays || 180;
const soonDays = it => Math.min(14, Math.max(2, Math.round(retOf(it) * 0.2)));   // 7天→剩2天提醒、30天→剩6天、≥70天→剩14天
function statusOf(it){
  if (it.status === '已認領') return 'done';
  if (it.status === '已處置') return 'gone';
  if (daysSince(it.foundDate) > retOf(it)) return 'over';
  return 'wait';
}
const ST_LABEL = {wait:'待認領', done:'已認領', over:'已逾保管期', gone:'已處置'};
const badge = st => `<span class="badge b-${st}">${ST_LABEL[st]}</span>`;
function photoSrc(it){
  const p = it.photoId; if (!p) return '';
  return p.startsWith('data:') ? p : `https://drive.google.com/thumbnail?id=${encodeURIComponent(p)}&sz=w800`;
}
// 完整顯示照片（不裁切），背後用同一張照片模糊填滿
function imgFit(it){
  const src = photoSrc(it);
  if (!src) return catIcon(it.category);
  const e = esc(src);
  return `<div class="fitbox"><div class="bg" style="background-image:url('${e}')"></div><img src="${e}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentNode.replaceWith(document.createTextNode('${catIcon(it.category)}'))"></div>`;
}
function imgTag(it, cls){
  const src = photoSrc(it);
  if (!src) return catIcon(it.category);
  return `<img src="${esc(src)}" alt="" class="${cls||''}" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(document.createTextNode('${catIcon(it.category)}'))">`;
}

/* ---------- API ---------- */
async function api(action, payload = {}){
  if (DEMO) return demoApi(action, payload);
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {'Content-Type': 'text/plain;charset=utf-8'},   // 避免 CORS 預檢
    body: JSON.stringify({action, token: store.get('lf_token') || '', ...payload}),
  });
  if (!res.ok) throw new Error('伺服器沒有回應（' + res.status + '）');
  const data = await res.json();
  if (!data.ok){
    if (data.auth){ store.set('lf_token', null); S.me = null; applyRole(); route(); }
    throw new Error(data.error || '發生錯誤');
  }
  return data;
}

async function load(quiet){
  try {
    const d = await api('list');
    detectNew(d.items || []);
    S.items = d.items || [];
    S.settings = {...DEFAULT_SETTINGS, ...(d.settings || {})};
    const hadMe = !!S.me;
    S.me = d.me || null;
    if (!S.me && store.get('lf_token')) store.set('lf_token', null);
    S.loaded = true;
    if (hadMe !== !!S.me) { applyRole(); route(); }
    fillLocs(); if (!S.editId) paintRet(); render();
    if (!DEMO) setBanner('');
  } catch (e){
    console.error(e);
    if (!quiet) setBanner('無法讀取資料：' + esc(e.message) + '　<button class="btn sm" onclick="location.reload()">重新載入</button>', 'warn');
    if (!S.loaded){ $('#grid').innerHTML = '<div class="empty" style="grid-column:1/-1">資料讀取失敗，請稍後再試。</div>'; }
  }
}
setInterval(() => { if (document.visibilityState === 'visible' && !$('#modalRoot').innerHTML) load(true); }, REFRESH_MS);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') load(true); });

/* ---------- 新物品偵測與提示 ---------- */
const isOpenItem = it => it.status !== '已認領' && it.status !== '已處置';
const maxCreated = items => items.reduce((m, i) => (i.createdAt || '') > m ? i.createdAt : m, '');
function detectNew(items){
  if (!S.knownIds){                       // 第一次載入：和上次造訪比較
    const last = store.get('lf_last_seen');
    if (last){
      const since = items.filter(i => isOpenItem(i) && (i.createdAt || '') > last);
      since.forEach(i => S.newIds.add(i.id));
      if (since.length) showNewsbar(since.length);
    }
  } else {                                 // 自動更新時：找出剛出現的物品
    const fresh = items.filter(i => !S.knownIds.has(i.id) && isOpenItem(i));
    if (fresh.length) onFresh(fresh);
  }
  S.knownIds = new Set(items.map(i => i.id));
  const m = maxCreated(items); if (m) store.set('lf_last_seen', m);
}
function onFresh(fresh){
  fresh.forEach(i => S.newIds.add(i.id));
  const names = fresh.slice(0, 3).map(i => i.name).join('、') + (fresh.length > 3 ? ` 等 ${fresh.length} 件` : '');
  toast('🆕 新拾獲：' + names);
  if (document.visibilityState !== 'visible'){
    S.unseen += fresh.length;
    document.title = `(${S.unseen}) ${BASE_TITLE}`;
  }
  if (notifyOn() && document.visibilityState !== 'visible'){
    try {
      const n = new Notification('失物招領：有新拾獲物品', {body: names, tag: 'lf-new'});
      n.onclick = () => { window.focus(); location.hash = '#board'; n.close(); };
    } catch {}
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible'){ S.unseen = 0; document.title = BASE_TITLE; }
});
function showNewsbar(n){
  $('#newsbar').innerHTML = `<div class="newsbar"><span style="font-size:22px">🆕</span>
    <div class="t">自你上次造訪後，新增了 <b>${n}</b> 件拾獲物品</div>
    <button class="btn sm" id="nbOnly">只看這些</button><button class="btn sm" id="nbClose">知道了</button></div>`;
  $('#nbOnly').onclick = () => { S.onlyNew = true; $('#newsbar').innerHTML = ''; location.hash = '#board'; renderBoard(); };
  $('#nbClose').onclick = () => { $('#newsbar').innerHTML = ''; };
}
const isNew = it => isOpenItem(it) && (S.newIds.has(it.id) || daysSince(it.foundDate) <= 2);
function agoText(it){
  const d = daysSince(it.foundDate);
  return d === 0 ? '今天' : d === 1 ? '昨天' : `${d} 天前`;
}

/* 桌面通知 */
const notifyOn = () => store.get('lf_notify') === '1' && 'Notification' in window && Notification.permission === 'granted';
function paintBell(){ $('#bellBtn').classList.toggle('on', notifyOn()); $('#bellBtn').textContent = notifyOn() ? '🔔 通知已開啟' : '🔔 新物品通知'; }
$('#bellBtn').addEventListener('click', async () => {
  if (!('Notification' in window)) return toast('這個瀏覽器不支援通知');
  if (notifyOn()){ store.set('lf_notify', null); paintBell(); return toast('已關閉新物品通知'); }
  let perm = Notification.permission;
  if (perm === 'default') perm = await Notification.requestPermission();
  if (perm !== 'granted') return toast('瀏覽器拒絕了通知，請在網址列旁的設定中允許');
  store.set('lf_notify', '1'); paintBell();
  toast('已開啟：這個分頁開著時，有新物品會跳出通知');
});

/* ---------- 展示模式（未設定 API 時） ---------- */
const demo = { items: [], users: [{username:'admin', name:'系統管理者', role:'admin', createdAt: today()}], seq: 0 };
function demoApi(action, p){
  const find = id => { const it = demo.items.find(i => i.id === id); if (!it) throw new Error('找不到物品'); return it; };
  const now = () => new Date().toISOString().slice(0,19).replace('T',' ');
  switch (action){
    case 'list': return {items: demo.items.map(i => ({...i})), settings: S.settings, me: S.me};
    case 'login':
      if (!p.username || !p.password) throw new Error('請輸入帳號與密碼');
      store.set('lf_token', 'demo');
      return {token:'demo', me:{username:p.username, name:'展示管理者', role:'admin'}};
    case 'logout': return {};
    case 'saveItem': {
      const x = p.item; let it;
      if (x.id) it = find(x.id);
      else { const pre = 'L' + x.foundDate.replace(/-/g,'').slice(2) + '-';
        it = {id: 'd' + (++demo.seq), code: pre + String(demo.items.filter(i => i.code.startsWith(pre)).length + 1).padStart(3,'0'), status:'待認領', createdAt: now()};
        demo.items.push(it); }
      Object.assign(it, x, {id: it.id, handler: x.handler || S.me?.name || '', updatedAt: now()});
      if (p.removePhoto) it.photoId = '';
      if (p.photoData) it.photoId = p.photoData;
      return {id: it.id, code: it.code};
    }
    case 'claim': { const it = find(p.id); const c = p.claim;
      Object.assign(it, {status:'已認領', claimedDate:c.date, claimName:c.name, claimSid:c.sid, claimCls:c.cls, claimPhone:c.phone, claimHandler:c.handler || S.me?.name, claimNote:c.note}); return {}; }
    case 'dispose': { const it = find(p.id); const d = p.dispose;
      Object.assign(it, {status:'已處置', disposeMethod:d.method, disposeDate:d.date, disposeNote:d.note}); return {}; }
    case 'reopen': { const it = find(p.id);
      Object.assign(it, {status:'待認領', claimedDate:'', claimName:'', claimSid:'', claimCls:'', claimPhone:'', claimHandler:'', claimNote:'', disposeMethod:'', disposeDate:'', disposeNote:''}); return {}; }
    case 'deleteItem': demo.items = demo.items.filter(i => i.id !== p.id); return {};
    case 'saveSettings': return {settings: {...S.settings, ...p.settings}};
    case 'changePassword': return {};
    case 'listUsers': return {users: demo.users};
    case 'addUser': demo.users.push({username:p.username, name:p.name || p.username, role:p.role, createdAt: today()}); return {password:'Demo1234'};
    case 'resetPassword': return {password:'Demo5678'};
    case 'deleteUser': demo.users = demo.users.filter(u => u.username !== p.username); return {};
  }
  throw new Error('未知動作');
}

/* ---------- 路由與身分 ---------- */
const VIEWS = ['board','register','manage','stats','settings','kiosk'];
const STAFF_VIEWS = ['register','manage','settings'];
function route(){
  let v = (location.hash || '#board').slice(1);
  if (!VIEWS.includes(v)) v = 'board';
  if (STAFF_VIEWS.includes(v) && !isStaff()) v = 'board';
  VIEWS.forEach(x => $('#v-'+x).classList.toggle('hidden', x !== v));
  document.querySelectorAll('nav.tabs a').forEach(a => a.classList.toggle('on', a.dataset.v === v));
  if (v === 'register' && !S.editId) resetForm();
  if (v === 'settings') openSettings();
  v === 'kiosk' ? startKiosk() : stopKiosk();
  render();
}
window.addEventListener('hashchange', route);

function applyRole(){
  document.querySelectorAll('nav.tabs a.staff').forEach(a => a.classList.toggle('hide', !isStaff()));
  document.querySelectorAll('.admin-only').forEach(el => el.classList.toggle('hidden', !isAdmin()));
  const box = $('#userbox');
  if (S.me){
    box.innerHTML = `<span class="who">${esc(S.me.name)}（${isAdmin() ? '管理者' : '處室人員'}）</span><button class="hbtn" id="logoutBtn">登出</button>`;
    $('#logoutBtn').onclick = logout;
  } else {
    box.innerHTML = `<button class="hbtn" id="loginBtn">處室人員登入</button>`;
    $('#loginBtn').onclick = showLogin;
  }
}

function showLogin(){
  openModal(`
    <h2>處室人員登入</h2>
    <p class="meta" style="margin:0 0 16px">${DEMO ? '展示模式：輸入任意帳號密碼即可登入試用。' : '學生查詢失物不需要登入。'}</p>
    <form class="form" id="loginForm" style="grid-template-columns:1fr">
      <label class="f">帳號<input type="text" name="username" required autocomplete="username" autocapitalize="off"></label>
      <label class="f">密碼<input type="password" name="password" required autocomplete="current-password"></label>
      <div class="err" id="loginErr"></div>
      <div class="actions" style="margin-top:0"><button type="button" class="btn" data-close>取消</button><button type="submit" class="btn pri" id="loginGo">登入</button></div>
    </form>`);
  const f = $('#loginForm'); f.username.focus();
  f.addEventListener('submit', async e => {
    e.preventDefault();
    $('#loginGo').disabled = true; $('#loginErr').textContent = '';
    try {
      const d = await api('login', {username: f.username.value.trim(), password: f.password.value});
      store.set('lf_token', d.token); S.me = d.me;
      closeModal(); applyRole(); toast(`歡迎，${d.me.name}`);
      await load(); route();
    } catch (err){ $('#loginErr').textContent = err.message; $('#loginGo').disabled = false; }
  });
}
async function logout(){
  try { await api('logout'); } catch {}
  store.set('lf_token', null); S.me = null; applyRole();
  location.hash = '#board'; await load(); route(); toast('已登出');
}

/* ---------- 畫面 ---------- */
function render(){
  $('#officeLine').textContent = S.settings.office;
  $('#noticeText').textContent = S.settings.notice;
  if (!S.loaded) return;
  renderBoard(); renderManage(); renderStats();
  if (K.clock && !$('#kStage .k-info')) kShow();
}
function setBanner(html, cls){ $('#banner').innerHTML = html ? `<div class="banner ${cls||'info'}">${html}</div>` : (DEMO ? demoBanner() : ''); }
const demoBanner = () => `<div class="banner warn"><b>展示模式</b>：尚未設定 Google Apps Script 網址，資料只存在這個分頁中，重新整理就會消失。設定方式請見 README。</div>`;

function renderChips(){
  const counts = {};
  S.items.forEach(i => { const st = statusOf(i); if (st==='wait'||st==='over') counts[i.category]=(counts[i.category]||0)+1; });
  $('#catChips').innerHTML = [`<button class="chip ${S.cat==='all'?'on':''}" data-c="all">全部</button>`]
    .concat(CATS.map(c => `<button class="chip ${S.cat===c.n?'on':''}" data-c="${esc(c.n)}">${c.e} ${esc(c.n)}${counts[c.n]?` · ${counts[c.n]}`:''}</button>`)).join('');
}
$('#catChips').addEventListener('click', e => { const b = e.target.closest('.chip'); if(!b) return; S.cat = b.dataset.c; renderBoard(); });

function matchQ(it, q, extra){
  if (!q) return true;
  const hay = [it.name,it.color,it.brand,it.desc,it.location,it.code,it.category, ...(extra||[])].join(' ').toLowerCase();
  return q.toLowerCase().split(/\s+/).every(t => hay.includes(t));
}
const byNewest = (a,b) => (b.foundDate||'').localeCompare(a.foundDate||'') || (b.createdAt||'').localeCompare(a.createdAt||'');

function renderLatest(){
  const list = S.items.filter(isOpenItem).filter(i => daysSince(i.foundDate) <= 14)
    .sort((a,b) => (b.createdAt||'').localeCompare(a.createdAt||'')).slice(0, 12);
  $('#latest').classList.toggle('hidden', !list.length);
  if (!list.length) return;
  $('#latestSub').textContent = `近 14 天共 ${list.length} 件`;
  $('#strip').innerHTML = list.map(it => `<div class="mcard" data-id="${esc(it.id)}">
    <div class="mt">${imgTag(it)}</div>
    <div style="min-width:0"><div class="mn">${esc(it.name)}</div><div class="mm">📍 ${esc(it.location)}</div><div class="ago">${agoText(it)}拾獲</div></div>
    ${isNew(it) ? '<span class="newtag">NEW</span>' : ''}</div>`).join('');
}
$('#strip').addEventListener('click', e => { const c = e.target.closest('.mcard'); if (c) showDetail(c.dataset.id); });
document.querySelectorAll('.latest .arrow').forEach(b => b.addEventListener('click', () => $('#strip').scrollBy({left: +b.dataset.dir * 420, behavior: 'smooth'})));

function renderBoard(){
  renderChips(); renderLatest();
  const q = $('#q').value.trim(), fs = $('#fStatus').value, fr = $('#fRange').value;
  const list = S.items.filter(it => {
    const st = statusOf(it);
    if (st === 'gone') return false;
    if (fs === 'wait' && !(st==='wait'||st==='over')) return false;
    if (fs === 'done' && st !== 'done') return false;
    if (S.cat !== 'all' && (CAT[it.category] ? it.category : '其他') !== S.cat) return false;
    if (fr !== 'all' && daysSince(it.foundDate) > +fr) return false;
    if (S.onlyNew && !S.newIds.has(it.id)) return false;
    return matchQ(it, q);
  }).sort(byNewest);
  const onlyBar = S.onlyNew ? `<div class="banner info" style="grid-column:1/-1;display:flex;align-items:center;gap:10px;margin:0">🆕 只顯示你上次造訪後新增的物品<span style="flex:1"></span><button class="btn sm" id="clearOnly">顯示全部</button></div>` : '';
  if (!list.length){
    $('#grid').innerHTML = onlyBar + `<div class="empty" style="grid-column:1/-1">${S.items.length ? '找不到符合條件的物品，試試其他關鍵字或類別。' : '目前沒有招領中的物品。'}${isStaff() && !S.items.length ? '<br><br><a class="btn pri" href="#register" style="text-decoration:none">登記第一件拾獲物品</a>':''}</div>`;
    $('#clearOnly')?.addEventListener('click', () => { S.onlyNew = false; renderBoard(); });
    return;
  }
  $('#grid').innerHTML = onlyBar + list.map(it => {
    const st = statusOf(it);
    return `<div class="card ${S.newIds.has(it.id) && isOpenItem(it) ? 'fresh' : ''}" data-id="${esc(it.id)}">
      <div class="thumb">${imgFit(it)}<span class="st">${badge(st==='over'?'wait':st)}</span>${isNew(it) ? '<span class="newtag">NEW</span>' : ''}</div>
      <div class="body">
        <h3>${esc(it.name)}</h3>
        <div class="meta">${catIcon(it.category)} ${esc(it.category||'其他')}${it.color?' · '+esc(it.color):''}</div>
        <div class="meta">📍 ${esc(it.location)}　📅 ${fmtDate(it.foundDate)}</div>
        <div class="code">${esc(it.code)}</div>
      </div></div>`;
  }).join('');
  $('#clearOnly')?.addEventListener('click', () => { S.onlyNew = false; renderBoard(); });
}
$('#grid').addEventListener('click', e => { const c = e.target.closest('.card'); if (c) showDetail(c.dataset.id); });
['#q','#fStatus','#fRange'].forEach(s => $(s).addEventListener('input', renderBoard));

function manageList(){
  const q = $('#mq').value.trim(), fs = $('#mStatus').value, fc = $('#mCat').value;
  return S.items.filter(it => {
    const st = statusOf(it);
    if (fs === 'today'){ if ((it.createdAt||'').slice(0,10) !== today()) return false; }
    else if (fs === 'soon'){ if (!(st === 'wait' && remain(it) <= soonDays(it))) return false; }
    else if (fs !== 'all' && st !== fs) return false;
    if (fc !== 'all' && it.category !== fc) return false;
    const fr = $('#mRet').value; if (fr !== 'all' && retOf(it) !== +fr) return false;
    return matchQ(it, q, [it.finder, it.claimName, it.claimSid, it.storage]);
  }).sort(byNewest);
}
const remain = it => retOf(it) - daysSince(it.foundDate);
function keepCell(it, st){
  if (st === 'done' || st === 'gone') return '—';
  const d = daysSince(it.foundDate), r = remain(it), pct = Math.min(100, d / retOf(it) * 100);
  const cls = st === 'over' ? 'over' : r <= soonDays(it) ? 'soon' : '';
  const txt = (st === 'over' ? `逾期 ${-r} 天` : `第 ${d} 天・剩 ${r} 天`) + `<span class="retchip">${retOf(it)} 天${it.retentionDays ? '' : '・預設'}</span>`;
  return `<div class="keep ${cls}"><div class="track"><div class="fill" style="width:${pct}%"></div></div><span>${txt}</span></div>`;
}
function renderAlerts(){
  const over = S.items.filter(i => statusOf(i) === 'over').length;
  const soon = S.items.filter(i => statusOf(i) === 'wait' && remain(i) <= soonDays(i)).length;
  const td = S.items.filter(i => (i.createdAt||'').slice(0,10) === today()).length;
  const cur = $('#mStatus').value;
  const a = [];
  if (over) a.push(`<div class="alert a-over ${cur==='over'?'on':''}" data-f="over"><span class="n">${over}</span><span>件已逾保管期<br><small>請安排處置</small></span></div>`);
  if (soon) a.push(`<div class="alert a-soon ${cur==='soon'?'on':''}" data-f="soon"><span class="n">${soon}</span><span>件即將到期<br><small>可再公告提醒</small></span></div>`);
  a.push(`<div class="alert a-today ${cur==='today'?'on':''}" data-f="today"><span class="n">${td}</span><span>件今日登記<br><small>點擊查看</small></span></div>`);
  $('#alerts').innerHTML = a.join('');
}
$('#alerts').addEventListener('click', e => {
  const el = e.target.closest('.alert'); if (!el) return;
  $('#mStatus').value = $('#mStatus').value === el.dataset.f ? 'all' : el.dataset.f;
  renderManage();
});
function renderManage(){
  if (!isStaff()) return;
  renderAlerts();
  const list = manageList();
  $('#mBody').innerHTML = list.length ? list.map(it => {
    const st = statusOf(it);
    return `<tr data-id="${esc(it.id)}">
      <td><div class="mini">${imgTag(it, 'mini')}</div></td>
      <td class="code">${esc(it.code)}</td>
      <td class="wrap"><b>${esc(it.name)}</b>${it.color?`<div class="meta">${esc(it.color)}</div>`:''}</td>
      <td>${esc(it.category)}</td>
      <td>${fmtDate(it.foundDate)}</td>
      <td>${esc(it.location)}</td>
      <td>${esc(it.storage||'—')}</td>
      <td>${keepCell(it, st)}</td>
      <td>${badge(st)}</td>
      <td>${it.claimName?esc(it.claimName)+(it.claimSid?`<div class="meta">${esc(it.claimSid)}</div>`:''):'—'}</td>
      <td><div class="rowacts">
        ${st==='wait'||st==='over'?`<button class="btn sm ok" data-a="claim">認領</button>`:''}
        <button class="btn sm" data-a="view">詳情</button>
        <button class="btn sm" data-a="edit">編輯</button>
      </div></td></tr>`;
  }).join('') : `<tr><td colspan="11" style="text-align:center;padding:40px;color:var(--muted)">沒有符合的物品</td></tr>`;
  $('#mCount').textContent = `共 ${list.length} 筆（全部 ${S.items.length} 筆）`;
}
$('#mBody').addEventListener('click', e => {
  const b = e.target.closest('button[data-a]'); if (!b) return;
  const id = b.closest('tr').dataset.id;
  ({claim: showClaim, view: showDetail, edit: startEdit})[b.dataset.a](id);
});
['#mq','#mStatus','#mCat','#mRet'].forEach(s => $(s).addEventListener('input', renderManage));
$('#refreshBtn').addEventListener('click', async () => { await load(); toast('已更新'); });

function bars(el, rows, note){
  const max = Math.max(1, ...rows.map(r => r[1]));
  el.innerHTML = (rows.length ? rows.map(([l,v,v2]) => `<div class="bar"><span>${esc(l)}</span>
    <div class="track"><div class="fill" style="width:${v/max*100}%"></div></div><span class="v">${v}${v2!==undefined?` / ${v2}`:''}</span></div>`).join('')
    : '<div class="meta">尚無資料</div>') + (note ? `<div class="meta" style="margin-top:4px">${note}</div>` : '');
}
function renderStats(){
  const all = S.items, by = st => all.filter(i => statusOf(i)===st).length;
  const done = by('done');
  const rate = all.length ? Math.round(done / all.length * 100) : 0;
  const cd = all.filter(i => i.status==='已認領' && i.claimedDate && i.foundDate).map(i => Math.max(0,(Date.parse(i.claimedDate)-Date.parse(i.foundDate))/864e5));
  const avg = cd.length ? (cd.reduce((a,b)=>a+b,0)/cd.length).toFixed(1) : '—';
  const k = [[all.length,'累計登記'],[by('wait'),'待認領'],[by('over'),'已逾保管期'],[done,'已認領'],[rate+'%','認領率'],[avg,'平均認領天數']];
  $('#kpis').innerHTML = k.map(([n,l]) => `<div class="kpi"><div class="n">${n}</div><div class="l">${l}</div></div>`).join('');
  bars($('#barCat'), CATS.map(c => [c.e+' '+c.n, all.filter(i=>(CAT[i.category]?i.category:'其他')===c.n).length]).filter(r=>r[1]).sort((a,b)=>b[1]-a[1]));
  const loc = {}; all.forEach(i => { const x = (i.location||'').trim(); if (x) loc[x]=(loc[x]||0)+1; });
  bars($('#barLoc'), Object.entries(loc).sort((a,b)=>b[1]-a[1]).slice(0,8));
  const months = [], d = new Date();
  for (let m=5;m>=0;m--){ const x = new Date(d.getFullYear(), d.getMonth()-m, 1); months.push(`${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,'0')}`); }
  bars($('#barMonth'), months.map(m => [m.replace('-','/'), all.filter(i=>(i.foundDate||'').startsWith(m)).length, all.filter(i=>(i.foundDate||'').startsWith(m) && i.status==='已認領').length]), '數字為「登記件數 / 其中已認領」');
}

/* ---------- 登記 / 編輯 ---------- */
function fillSelects(){
  $('#catSelect').innerHTML = CATS.map(c => `<option value="${esc(c.n)}">${c.e} ${esc(c.n)}</option>`).join('');
  $('#mCat').innerHTML = '<option value="all">全部類別</option>' + CATS.map(c => `<option value="${esc(c.n)}">${esc(c.n)}</option>`).join('');
}
function fillLocs(){
  $('#locList').innerHTML = String(S.settings.locations||'').split(/[,，、]/).map(s=>s.trim()).filter(Boolean).map(s=>`<option value="${esc(s)}">`).join('');
}
function paintRet(){
  const v = $('#regForm').retentionDays.value, def = +S.settings.retentionDays || 180;
  $('#retSeg').innerHTML = `<button type="button" data-v="" class="${v===''?'on':''}">預設 ${def} 天<small>依系統設定</small></button>` +
    RET_CHOICES.map(d => `<button type="button" data-v="${d}" class="${v===String(d)?'on':''}">${d} 天<small>${RET_HINT[d]}</small></button>`).join('');
}
$('#retSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; $('#regForm').retentionDays.value = b.dataset.v; paintRet(); });
function showPhoto(src){
  $('#photoPrev').outerHTML = src ? `<img id="photoPrev" src="${esc(src)}" alt="" referrerpolicy="no-referrer">` : `<div class="ph" id="photoPrev">📷</div>`;
  $('#photoClear').classList.toggle('hidden', !src);
}
function resetForm(){
  S.editId = null; S.photoNew = null; S.photoExisting = null; S.photoRemoved = false;
  $('#regForm').reset(); showPhoto(null); $('#photoInput').value = '';
  $('#regForm').foundDate.value = today();
  $('#regForm').retentionDays.value = ''; paintRet();
  $('#regTitle').textContent = '登記拾獲物品'; $('#regSubmit').textContent = '登記物品'; $('#regReset').textContent = '清除';
}
function startEdit(id){
  const it = S.items.find(i => i.id===id); if (!it) return;
  closeModal();
  S.editId = id;
  location.hash = '#register';
  const f = $('#regForm');
  ['name','category','color','brand','desc','foundDate','location','storage','handler','finder','finderContact','secret','retentionDays'].forEach(k => f[k].value = it[k] || '');
  if (!CAT[it.category]) f.category.value = '其他';
  paintRet();
  S.photoNew = null; S.photoRemoved = false; S.photoExisting = it.photoId || null;
  showPhoto(photoSrc(it));
  $('#regTitle').textContent = `編輯物品　${it.code}`; $('#regSubmit').textContent = '儲存變更'; $('#regReset').textContent = '取消編輯';
}
$('#regReset').addEventListener('click', () => { const was = S.editId; resetForm(); if (was) location.hash = '#manage'; });

const drop = $('#photoDrop'), pin = $('#photoInput'), cin = $('#camInput');
drop.addEventListener('click', e => { if (!e.target.closest('button')) pin.click(); });
$('#camBtn').addEventListener('click', e => { e.stopPropagation(); cin.value = ''; cin.click(); });
$('#albumBtn').addEventListener('click', e => { e.stopPropagation(); pin.value = ''; pin.click(); });
cin.addEventListener('change', () => { if (cin.files[0]) loadPhoto(cin.files[0]); });
$('#photoClear').addEventListener('click', e => {
  e.stopPropagation(); S.photoNew = null; pin.value = ''; cin.value = '';
  if (S.photoExisting) S.photoRemoved = true;
  showPhoto(null);
});
drop.addEventListener('dragover', e => { e.preventDefault(); drop.style.borderColor='var(--brand-2)'; });
drop.addEventListener('dragleave', () => drop.style.borderColor='');
drop.addEventListener('drop', e => { e.preventDefault(); drop.style.borderColor=''; const f = e.dataTransfer.files[0]; if (f) loadPhoto(f); });
pin.addEventListener('change', () => { if (pin.files[0]) loadPhoto(pin.files[0]); });
async function loadPhoto(file){
  const looksImage = (file.type || '').startsWith('image/') || /\.(jpe?g|png|webp|heic|heif|gif|bmp)$/i.test(file.name || '');
  if (!looksImage) return toast('請選擇圖片檔');
  toast('照片處理中…');
  const M = 1200;
  let src = null, w = 0, h = 0, cleanup = () => {};
  try {
    // createImageBitmap 會依 EXIF 轉正方向，且較省記憶體（手機大照片不易失敗）
    if (window.createImageBitmap){
      const bmp = await createImageBitmap(file, {imageOrientation: 'from-image'});
      src = bmp; w = bmp.width; h = bmp.height; cleanup = () => bmp.close && bmp.close();
    }
  } catch {}
  if (!src){
    try {
      const url = URL.createObjectURL(file);
      const img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = url; });
      src = img; w = img.naturalWidth; h = img.naturalHeight; cleanup = () => URL.revokeObjectURL(url);
    } catch {
      return toast('無法讀取這張照片（若是 HEIC 格式，請在相機設定改用「最相容」格式）');
    }
  }
  const sc = Math.min(1, M / Math.max(w, h));
  const c = document.createElement('canvas'); c.width = Math.round(w * sc); c.height = Math.round(h * sc);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  cleanup();
  let q = .8, out = c.toDataURL('image/jpeg', q);
  while (out.length > 450000 && q > .35){ q -= .1; out = c.toDataURL('image/jpeg', q); }
  S.photoNew = out; S.photoRemoved = !!S.photoExisting; showPhoto(out);
  toast('照片已準備好，按「登記物品」即可上傳');
}

$('#regSubmit').addEventListener('click', async () => {
  const f = $('#regForm');
  if (!f.reportValidity()) return;
  const v = k => f[k].value.trim();
  const item = {id: S.editId || ''};
  ['name','category','color','brand','desc','foundDate','location','storage','handler','finder','finderContact','secret','retentionDays'].forEach(k => item[k] = v(k));
  const btn = $('#regSubmit'); btn.disabled = true; btn.textContent = '儲存中…';
  try {
    const d = await api('saveItem', {item, photoData: S.photoNew || '', removePhoto: S.photoRemoved && !S.photoNew});
    S.knownIds?.add(d.id);
    const wasEdit = !!S.editId;
    toast(wasEdit ? '已儲存變更' : `已登記，編號 ${d.code}`);
    resetForm(); await load();
    if (wasEdit) location.hash = '#manage';
  } catch(e){ toast(e.message); }
  finally { btn.disabled = false; btn.textContent = S.editId ? '儲存變更' : '登記物品'; }
});

/* ---------- 對話框 ---------- */
function openModal(html){
  $('#modalRoot').innerHTML = `<div class="modal-bg"><div class="modal">${html}</div></div>`;
  $('#modalRoot .modal-bg').addEventListener('click', e => { if (e.target.classList.contains('modal-bg') || e.target.closest('[data-close]')) closeModal(); });
}
function closeModal(){ $('#modalRoot').innerHTML = ''; }
document.addEventListener('keydown', e => { if (e.key==='Escape') closeModal(); });

async function act(btn, action, payload, msg){
  btn.disabled = true;
  try { await api(action, payload); closeModal(); toast(msg); await load(); }
  catch(e){ toast(e.message); btn.disabled = false; }
}

function showDetail(id){
  const it = S.items.find(i => i.id===id); if (!it) return;
  const st = statusOf(it);
  const row = (k,v) => v ? `<dt>${k}</dt><dd>${esc(v)}</dd>` : '';
  const src = photoSrc(it);
  let staff = '';
  if (isStaff()){
    staff = `<h3 style="margin:18px 0 8px;font-size:15px;color:var(--brand)">處室內部資訊</h3><dl class="kv">
      ${row('保管期限', `${retOf(it)} 天${it.retentionDays ? '' : '（系統預設）'}，到期日 ${fmtDate(addDays(it.foundDate, retOf(it)))}`)}
      ${row('存放位置',it.storage)}${row('經辦人',it.handler)}${row('拾獲人',it.finder)}${row('拾獲人聯絡',it.finderContact)}${row('辨識特徵',it.secret)}
      ${row('認領人',it.claimName)}${row('學號/身分',it.claimSid)}${row('班級',it.claimCls)}${row('聯絡電話',it.claimPhone)}
      ${it.claimName?row('認領日期',fmtDate(it.claimedDate)):''}${row('認領經辦',it.claimHandler)}${row('認領備註',it.claimNote)}
      ${row('處置方式',it.disposeMethod)}${it.disposeDate?row('處置日期',fmtDate(it.disposeDate)):''}${row('處置備註',it.disposeNote)}
      ${row('登記時間',it.createdAt)}${row('最後更新',it.updatedAt)}
    </dl>`;
  }
  openModal(`
    ${src?`<img class="detail-img" src="${esc(src)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">`:''}
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><h2>${esc(it.name)}</h2>${badge(isStaff()?st:(st==='over'?'wait':st))}</div>
    <div class="code" style="margin-bottom:14px">${esc(it.code)}</div>
    <dl class="kv">
      ${row('類別',catIcon(it.category)+' '+(it.category||''))}${row('顏色外觀',it.color)}${row('品牌型號',it.brand)}
      ${row('說明',it.desc)}${row('拾獲日期',fmtDate(it.foundDate))}${row('拾獲地點',it.location)}
    </dl>
    ${!isStaff() && (st==='wait'||st==='over') ? `<div class="banner info" style="margin-top:16px">這是你的物品嗎？請攜帶學生證到學務處，並提供編號 <b>${esc(it.code)}</b>，說明物品特徵後即可領回。</div>`:''}
    ${staff}
    <div class="actions">
      ${isStaff() ? `
        ${st==='wait'||st==='over'?`<button class="btn" id="dDispose">逾期處置</button><button class="btn ok" id="dClaim">登記認領</button>`:''}
        ${st==='done'||st==='gone'?`<button class="btn" id="dReopen">改回待認領</button>`:''}
        <button class="btn" id="dEdit">編輯</button>
        ${isAdmin()?`<button class="btn dan" id="dDel">刪除</button>`:''}`:''}
      <button class="btn" data-close>關閉</button>
    </div>`);
  $('#dClaim')?.addEventListener('click', () => showClaim(id));
  $('#dDispose')?.addEventListener('click', () => showDispose(id));
  $('#dEdit')?.addEventListener('click', () => startEdit(id));
  $('#dReopen')?.addEventListener('click', e => act(e.target, 'reopen', {id}, '已改回待認領'));
  $('#dDel')?.addEventListener('click', () => {
    openModal(`<h2>確定刪除？</h2><p>「${esc(it.name)}」（${esc(it.code)}）將被永久刪除，照片也會移到雲端硬碟垃圾桶。</p>
      <div class="actions"><button class="btn" data-close>取消</button><button class="btn pri" id="cYes" style="background:var(--danger);border-color:var(--danger)">確定刪除</button></div>`);
    $('#cYes').addEventListener('click', e => act(e.target, 'deleteItem', {id}, '已刪除'));
  });
}

function showClaim(id){
  const it = S.items.find(i => i.id===id); if (!it) return;
  openModal(`
    <h2>登記認領</h2>
    <p class="meta" style="margin:0 0 14px">${esc(it.code)}　${esc(it.name)}</p>
    ${it.secret?`<div class="banner warn">🔍 核對特徵：${esc(it.secret)}<br><small>請先請認領人口述物品特徵，相符後再交付。</small></div>`:''}
    <form class="form" id="claimForm">
      <label class="f">認領人姓名 <span class="req">*</span><input type="text" name="name" required maxlength="30"></label>
      <label class="f">學號 / 身分<input type="text" name="sid" maxlength="30" placeholder="例：1120345 或 教師"></label>
      <label class="f">班級<input type="text" name="cls" maxlength="20" placeholder="例：二年三班"></label>
      <label class="f">聯絡電話<input type="tel" name="phone" maxlength="20"></label>
      <label class="f">認領日期 <span class="req">*</span><input type="date" name="date" required value="${today()}"></label>
      <label class="f">經辦人<input type="text" name="handler" maxlength="30" value="${esc(S.me?.name||'')}"></label>
      <label class="f full">備註<textarea name="note" rows="2" maxlength="200" placeholder="例：已核對學生證、家長代領"></textarea></label>
      <label class="f full" style="flex-direction:row;align-items:center;gap:8px;font-weight:400"><input type="checkbox" name="verified" required> 已核對身分與物品特徵 <span class="req">*</span></label>
    </form>
    <div class="actions"><button class="btn" data-close>取消</button><button class="btn ok" id="cSave">確認交付</button></div>`);
  $('#cSave').addEventListener('click', e => {
    const f = $('#claimForm'); if (!f.reportValidity()) return;
    const v = k => f[k].value.trim();
    const claim = {name:v('name'), sid:v('sid'), cls:v('cls'), phone:v('phone'), date:v('date'), handler:v('handler'), note:v('note')};
    act(e.target, 'claim', {id, claim}, `${it.name} 已由 ${claim.name} 認領`);
  });
}

function showDispose(id){
  const it = S.items.find(i => i.id===id); if (!it) return;
  openModal(`
    <h2>逾期處置</h2>
    <p class="meta" style="margin:0 0 14px">${esc(it.code)}　${esc(it.name)}　已保管 ${daysSince(it.foundDate)} 天</p>
    <form class="form" id="dispForm">
      <label class="f">處置方式 <span class="req">*</span><select name="method" required>
        <option>移送警察機關</option><option>捐贈</option><option>歸拾得人所有</option><option>報廢銷毀</option><option>其他</option></select></label>
      <label class="f">處置日期 <span class="req">*</span><input type="date" name="date" required value="${today()}"></label>
      <label class="f full">備註<textarea name="note" rows="2" maxlength="200"></textarea></label>
    </form>
    <div class="actions"><button class="btn" data-close>取消</button><button class="btn pri" id="dpSave">確認處置</button></div>`);
  $('#dpSave').addEventListener('click', e => {
    const f = $('#dispForm'); if (!f.reportValidity()) return;
    act(e.target, 'dispose', {id, dispose:{method:f.method.value, date:f.date.value, note:f.note.value.trim()}}, '已記錄處置');
  });
}

function showPassword(title, username, pw){
  openModal(`<h2>${esc(title)}</h2><p>帳號 <b>${esc(username)}</b> 的臨時密碼：</p><div class="pwbox">${esc(pw)}</div>
    <p class="meta">這組密碼只會顯示這一次，請交給同仁，並提醒登入後到「設定」變更密碼。</p>
    <div class="actions"><button class="btn" id="pwCopy">複製密碼</button><button class="btn pri" data-close>完成</button></div>`);
  $('#pwCopy').addEventListener('click', async () => { try { await navigator.clipboard.writeText(pw); toast('已複製'); } catch { toast('請手動選取複製'); } });
}

/* ---------- 匯出 ---------- */
$('#copyCsv').addEventListener('click', async () => {
  const head = ['編號','物品名稱','類別','顏色外觀','品牌型號','拾獲日期','拾獲地點','存放位置','保管期限','到期日','狀態','拾獲人','認領人','學號','班級','認領日期','處置方式','處置日期'];
  const rows = manageList().map(it => [it.code,it.name,it.category,it.color,it.brand,it.foundDate,it.location,it.storage,retOf(it)+' 天',addDays(it.foundDate,retOf(it)),ST_LABEL[statusOf(it)],it.finder,it.claimName,it.claimSid,it.claimCls,it.claimedDate,it.disposeMethod,it.disposeDate]);
  const tsv = [head, ...rows].map(r => r.map(c => String(c??'').replace(/[\t\n\r]/g,' ')).join('\t')).join('\n');
  try { await navigator.clipboard.writeText(tsv); toast(`已複製 ${rows.length} 筆，可直接貼到 Excel 或 Google 試算表`); }
  catch { openModal(`<h2>複製清冊</h2><p class="meta">請全選下方內容後複製：</p><textarea rows="12" style="font-family:monospace;font-size:12px">${esc(tsv)}</textarea><div class="actions"><button class="btn" data-close>關閉</button></div>`); }
});

/* ---------- 設定 ---------- */
function openSettings(){
  $('#meLine').textContent = S.me ? `目前登入：${S.me.name}（帳號 ${S.me.username}）` : '';
  $('#pwForm').reset();
  $('#sOffice').value = S.settings.office; $('#sNotice').value = S.settings.notice;
  const sd = String(S.settings.retentionDays || 180);
  if (![...$('#sDays').options].some(o => o.value === sd)) $('#sDays').insertAdjacentHTML('beforeend', `<option value="${esc(sd)}">${esc(sd)} 天</option>`);
  $('#sDays').value = sd; $('#sLocs').value = S.settings.locations;
  if (isAdmin()) loadUsers();
}
$('#pwSave').addEventListener('click', async e => {
  const f = $('#pwForm'); if (!f.reportValidity()) return;
  if (f.new1.value !== f.new2.value) return toast('兩次輸入的新密碼不一致');
  e.target.disabled = true;
  try { await api('changePassword', {oldPassword: f.old.value, newPassword: f.new1.value}); f.reset(); toast('密碼已變更'); }
  catch(err){ toast(err.message); }
  finally { e.target.disabled = false; }
});
$('#sSave').addEventListener('click', async e => {
  const settings = {office: $('#sOffice').value.trim(), notice: $('#sNotice').value.trim(), retentionDays: $('#sDays').value, locations: $('#sLocs').value.trim()};
  e.target.disabled = true;
  try { const d = await api('saveSettings', {settings}); S.settings = {...S.settings, ...d.settings}; fillLocs(); paintRet(); render(); toast('設定已儲存'); }
  catch(err){ toast(err.message); }
  finally { e.target.disabled = false; }
});
async function loadUsers(){
  $('#uBody').innerHTML = '<tr><td colspan="5" class="meta">載入中…</td></tr>';
  try {
    const {users} = await api('listUsers');
    $('#uBody').innerHTML = users.map(u => `<tr data-u="${esc(u.username)}"><td><b>${esc(u.username)}</b></td><td>${esc(u.name)}</td>
      <td>${u.role==='admin'?'<span class="badge b-wait">管理者</span>':'<span class="badge b-gone">處室人員</span>'}</td><td class="meta">${esc(String(u.createdAt||'').slice(0,10))}</td>
      <td><div class="rowacts"><button class="btn sm" data-a="reset">重設密碼</button>${u.username.toLowerCase()!==S.me.username.toLowerCase()?'<button class="btn sm dan" data-a="del">刪除</button>':''}</div></td></tr>`).join('');
  } catch(e){ $('#uBody').innerHTML = `<tr><td colspan="5" class="meta">${esc(e.message)}</td></tr>`; }
}
$('#uBody').addEventListener('click', async e => {
  const b = e.target.closest('button[data-a]'); if (!b) return;
  const username = b.closest('tr').dataset.u;
  if (b.dataset.a === 'reset'){
    b.disabled = true;
    try { const d = await api('resetPassword', {username}); showPassword('密碼已重設', username, d.password); }
    catch(err){ toast(err.message); } finally { b.disabled = false; }
  } else {
    openModal(`<h2>刪除帳號？</h2><p>帳號 <b>${esc(username)}</b> 將無法再登入。</p><div class="actions"><button class="btn" data-close>取消</button><button class="btn pri" id="uDelYes" style="background:var(--danger);border-color:var(--danger)">確定刪除</button></div>`);
    $('#uDelYes').addEventListener('click', async ev => {
      ev.target.disabled = true;
      try { await api('deleteUser', {username}); closeModal(); toast('已刪除帳號'); loadUsers(); } catch(err){ toast(err.message); ev.target.disabled = false; }
    });
  }
});
$('#uForm').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target, btn = f.querySelector('button'); btn.disabled = true;
  const username = f.username.value.trim();
  try { const d = await api('addUser', {username, name: f.name.value.trim(), role: f.role.value}); f.reset(); loadUsers(); showPassword('帳號已建立', username, d.password); }
  catch(err){ toast(err.message); } finally { btn.disabled = false; }
});

/* ---------- 輪播看板 ---------- */
const K = {i: 0, timer: null, clock: null, paused: false, ms: 8000, qr: false};
const kList = () => S.items.filter(i => { const st = statusOf(i); return st === 'wait' || st === 'over'; })
  .sort((a,b) => (b.createdAt||'').localeCompare(a.createdAt||''));
function startKiosk(){
  document.body.style.overflow = 'hidden';
  if (K.clock) return;
  const tick = () => { const d = new Date(); $('#kClock').textContent = d.toLocaleDateString('zh-TW', {month:'long', day:'numeric', weekday:'short'}) + '　' + d.toLocaleTimeString('zh-TW', {hour:'2-digit', minute:'2-digit'}); };
  tick(); K.clock = setInterval(tick, 1000);
  if (!K.qr){
    if (window.QRCode){ new QRCode($('#kQrBox'), {text: location.href.split('#')[0], width: 160, height: 160}); K.qr = true; }
    else $('#kQr').style.display = 'none';
  }
  K.i = 0; kShow(); kPlay();
}
function stopKiosk(){
  if (!K.clock) return;
  document.body.style.overflow = '';
  clearInterval(K.clock); clearTimeout(K.timer); K.clock = K.timer = null;
  if (document.fullscreenElement) document.exitFullscreen?.().catch(()=>{});
}
function kShow(){
  const list = kList();
  if (!list.length){
    $('#kStage').innerHTML = `<div class="k-empty">${S.loaded ? '目前沒有招領中的物品 🎉' : '資料載入中…'}</div>`;
    $('#kCount').textContent = ''; return;
  }
  K.i = ((K.i % list.length) + list.length) % list.length;
  const it = list[K.i];
  $('#kStage').innerHTML = `<div class="k-photo k-anim">${imgFit(it)}</div>
    <div class="k-info k-anim">
      <div class="k-cat">${catIcon(it.category)} ${esc(it.category||'其他')}</div>
      <h2>${esc(it.name)}${isNew(it) ? '<span class="k-new">NEW</span>' : ''}</h2>
      ${it.color ? `<div class="k-row">🎨 ${esc(it.color)}</div>` : ''}
      <div class="k-row">📍 ${esc(it.location)}</div>
      <div class="k-row">📅 ${fmtDate(it.foundDate)}（${agoText(it)}）</div>
      ${it.desc ? `<div class="k-row" style="opacity:.8">${esc(it.desc)}</div>` : ''}
      <div class="k-code">認領編號 ${esc(it.code)}</div>
    </div>`;
  $('#kCount').textContent = `${K.i + 1} / ${list.length}`;
  const bar = $('#kBar'); bar.style.transition = 'none'; bar.style.width = '0';
  if (!K.paused){ void bar.offsetWidth; bar.style.transition = `width ${K.ms}ms linear`; bar.style.width = '100%'; }
}
function kPlay(){ clearTimeout(K.timer); if (!K.paused && K.clock) K.timer = setTimeout(() => { K.i++; kShow(); kPlay(); }, K.ms); }
function kStep(n){ K.i += n; kShow(); kPlay(); }
$('#kStage').addEventListener('click', () => kStep(1));
$('#kPause').addEventListener('click', () => { K.paused = !K.paused; $('#kPause').textContent = K.paused ? '▶ 播放' : '⏸ 暫停'; kShow(); kPlay(); });
$('#kFull').addEventListener('click', () => { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.().catch(() => toast('瀏覽器不允許全螢幕')); });
document.addEventListener('keydown', e => {
  if (!K.clock) return;
  if (e.key === 'ArrowRight') kStep(1);
  else if (e.key === 'ArrowLeft') kStep(-1);
  else if (e.key === ' '){ e.preventDefault(); $('#kPause').click(); }
});

/* ---------- 啟動 ---------- */
fillSelects(); fillLocs(); resetForm(); applyRole(); setBanner(''); paintBell(); route();
$('#footer').textContent = DEMO ? '展示模式' : '資料每分鐘自動更新';
load();
})();
