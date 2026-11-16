const Express = require('express');
const http = require('http');
const { Server} = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = Express();
app.use(Express.json({ limit: '100kb' }));
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 35e6, pingInterval: 25000, pingTimeout: 60000, connectionStateRecovery: { maxDisconnectionDuration: 2 * 60 * 1000, skipMiddlewares: true }});
/* Ver.2.3.0 変更点:
   1) 切断ログ/クライアントログを追加し、切断理由を記録する
   2) 切断後90秒は退室扱いにしない復帰猶予 (人数の増減フラッピング防止)
   3) join_room の入室通知は新規入室と明示退室後の復帰だけに限定
   4) 再同期は直近100件だけ・プライベート履歴は300件でローテーション
   5) クライアント再接続は無制限リトライ＋自動の静かな復帰入室
   6) プルリフレッシュの発動距離を 36px -> 80px に引き上げ
   7) 画像タップは同タブのモーダルではなく別タブの専用viewerで開く
   8) Ver.2.3.1: 保存済み部屋をサーバー存在チェックで自動掃除し、消えた部屋をトップに残さない */
const DISCONNECT_GRACE_MS = 90 * 1000;
const SYNC_MESSAGE_LIMIT = 100;
const PRIVATE_HISTORY_LIMIT = 300;
const disconnectTimers = {};
function shortId(v) { return v ? String(v).slice(0, 6) : '-'; }
function logEvent(event, fields) {
try { console.log(JSON.stringify(Object.assign({ t: new Date().toISOString(), event: event }, fields || {}))); } catch (e) { console.log('[log]', event); }
}
function memberTimerKey(roomId, sessionId) { return roomId + ':' + sessionId; }
function cancelPendingOffline(roomId, sessionId) {
if (!roomId || !sessionId) return;
const k = memberTimerKey(roomId, sessionId);
if (disconnectTimers[k]) { clearTimeout(disconnectTimers[k]); delete disconnectTimers[k]; }
}
function emitMemberCountGlobal(roomId) {
const room = rooms[roomId];
if (!room) return;
const active = getActiveMembers(room);
io.to(roomId).emit('update_members', { count: active.length, maxMembers: room.maxMembers, members: active.map(m => m.nickname) });
}
function scheduleMemberOffline(roomId, sessionId, socketId) {
cancelPendingOffline(roomId, sessionId);
const k = memberTimerKey(roomId, sessionId);
disconnectTimers[k] = setTimeout(() => {
delete disconnectTimers[k];
const room = rooms[roomId];
if (!room) return;
const member = room.members.find(m => m.sessionId === sessionId);
if (!member || member.id !== socketId || !member.awaySince) return;
member.id = null;
member.awaySince = null;
logEvent('member_offline_grace_expired', { room: roomId, sid: shortId(sessionId), count: getActiveMembers(room).length });
emitMemberCountGlobal(roomId);
}, DISCONNECT_GRACE_MS);
}
function trimPrivateHistory(room) {
if (room && !room.isPublic && room.messages && room.messages.length > PRIVATE_HISTORY_LIMIT) {
room.messages = room.messages.slice(-240);
}
}
function recentMessages(room) {
return (room.messages || []).slice(-SYNC_MESSAGE_LIMIT);
}

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
fs.mkdirSync(uploadDir);
}

const storage = multer.diskStorage({
destination: (req, file, cb) => cb(null, uploadDir),
filename: (req, file, cb) => {
const ext = path.extname(file.originalname);
const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1E9) + ext;
cb(null, uniqueName);
}
});
const upload = multer({ storage, limits: { fileSize: 30 * 1024 * 1024}});

app.use('/uploads', Express.static(uploadDir, { setHeaders: (res) => { res.setHeader('Cache-Control', 'no-store'); } }));

app.get('/api/ping', (req, res) => {
res.json({ ok: true, t: Date.now()});
});

const rooms = {};
const roomNameToId = {};

/* 公開ルーム（固定ID） */
const PUBLIC_ROOM_ID = 'public';
const PUBLIC_ROOM_NAME = '公開ルーム';
const PUBLIC_ROOM_MAX = 50;

function ensurePublicRoom() {
if (rooms[PUBLIC_ROOM_ID]) return rooms[PUBLIC_ROOM_ID];
rooms[PUBLIC_ROOM_ID] = {
id: PUBLIC_ROOM_ID,
name: PUBLIC_ROOM_NAME,
hostSessionId: null,
maxMembers: PUBLIC_ROOM_MAX,
imageDisplaySeconds: 5,
members: [],
messages: [],
lastActivityAt: Date.now(),
isPublic: true,
waitingMsg: '',
joinedSessionIds: []
};
roomNameToId[PUBLIC_ROOM_NAME] = PUBLIC_ROOM_ID;
return rooms[PUBLIC_ROOM_ID];
}
ensurePublicRoom();

function generateRoomId() {
const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
let id;
do {
id = '';
for (let i = 0; i < 6; i++) {
id += chars[Math.floor(Math.random() * chars.length)];
}
} while (rooms[id]);
return id;
}

function resolveRoomId(roomId, roomName) {
if (roomId && rooms[roomId]) return roomId;
if (roomName) {
const name = String(roomName).trim();
if (rooms[name]) return name;
if (roomNameToId[name] && rooms[roomNameToId[name]]) return roomNameToId[name];
}
return null;
}

function getActiveMembers(room) {
if (!room) return [];
return room.members.filter(m => m.id!== null);
}

function getMemberNames(room) {
return getActiveMembers(room).map(m => m.nickname);
}

function getPublicRoomCount() {
const room = rooms[PUBLIC_ROOM_ID];
if (!room) return 0;
return getActiveMembers(room).length;
}

app.get('/api/rooms', (req, res) => {
ensurePublicRoom();
const list = [];
for (const id of Object.keys(rooms)) {
if (id === PUBLIC_ROOM_ID) continue;
const r = rooms[id];
list.push({
id: r.id,
name: r.name,
maxMembers: r.maxMembers,
activeCount: getActiveMembers(r).length,
waitingMsg: r.waitingMsg || ''
});
}
res.json({ rooms: list});
});

/* Ver.2.3.1: 部屋の存在チェック。Ver.2.3.2以降クライアントからは定期ポーリングしない (手動確認用に残置)。
   サーバーが「無い」と断定した部屋だけを消す。通信失敗時はクライアント側で消さない。 */
function roomExistsMap(ids) {
ensurePublicRoom();
const out = {};
(Array.isArray(ids)? ids: []).slice(0, 50).forEach(raw => {
const id = String(raw || '').trim();
if (id) out[id] = !!rooms[id];
});
return out;
}
app.post('/api/rooms/check', (req, res) => {
const ids = (req.body && req.body.roomIds) || [];
res.json({ exists: roomExistsMap(ids) });
});
app.get('/api/rooms/check', (req, res) => {
const ids = String(req.query.ids || '').split(',').filter(Boolean);
res.json({ exists: roomExistsMap(ids) });
});

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
setInterval(() => {
const now = Date.now();
for (const roomId of Object.keys(rooms)) {
if (roomId === PUBLIC_ROOM_ID) continue;
const room = rooms[roomId];
if (!room) continue;
if (now - (room.lastActivityAt || 0) > THIRTY_DAYS_MS) {
(room.messages || []).forEach(msg => {
if (msg.image) {
const filename = path.basename(msg.image);
const filePath = path.join(uploadDir, filename);
if (fs.existsSync(filePath)) fs.unlink(filePath, () => {});
}
if (msg.thumbMid) {
const thumbPath = path.join(uploadDir, path.basename(msg.thumbMid));
if (fs.existsSync(thumbPath)) fs.unlink(thumbPath, () => {});
}
});
if (room.name && roomNameToId[room.name] === roomId) {
delete roomNameToId[room.name];
}
io.to(roomId).emit('room_deleted_by_host', { reason: 'inactivity'});
delete rooms[roomId];
}
}
}, 12 * 60 * 60 * 1000);

app.post('/api/upload', upload.single('image'), (req, res) => {
if (!req.file) return res.status(400).json({ error: 'ファイルがありません'});
const imageUrl = '/uploads/' + req.file.filename;
const filePath = req.file.path;
setTimeout(() => {
fs.unlink(filePath, (err) => {
if (err) return;
});
}, 60 * 60 * 1000);
res.json({ imageUrl});
});

/* Ver.2.2.0: サーバー上の画像削除は表示設定によらず一律1時間に固定 */
function scheduleImageDelete(imageUrl, displaySeconds) {
if (!imageUrl) return;
const filename = path.basename(imageUrl);
const filePath = path.join(uploadDir, filename);
setTimeout(() => {
fs.unlink(filePath, (err) => {
if (err) return;
});
}, 60 * 60 * 1000);
}

app.get('/api/public-count', (req, res) => {
ensurePublicRoom();
res.json({ count: getPublicRoomCount(), maxMembers: PUBLIC_ROOM_MAX});
});

const HTML_CONTENT = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content">
<meta name="robots" content="noindex, nofollow">
<title>SimpleChatee - Anonymous Chat</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.1.1/crypto-js.min.js"></script>
<style>
:root {
--bg-color: #0f172a;
--card-bg: #1e293b;
--accent-color: #38bdf8;
--text-color: #f8fafc;
--text-muted: #94a3b8;
--border-color: #334155;
}
* { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;}
html, body { height: 100%;}
body { background-color: var(--bg-color); color: var(--text-color); margin: 0; padding: 0; overflow: hidden;}
.container { position: fixed; top: 0; left: 0; right: 0; margin: 0 auto; width: 100%; max-width: 560px; background: var(--card-bg); overflow: hidden; display: flex; flex-direction: column; height: 100%; min-height: 0;}
.header { padding: 6px 8px 6px; border-bottom: 1px solid var(--border-color); background: #111827; display: flex; flex-direction: column; gap: 4px; flex-shrink: 0;}
.header-top { display: flex; align-items: center; gap: 6px; min-width: 0;}
.home-btn { width: 28px; height: 28px; margin: 0; padding: 0; border: none; border-radius: 6px; background: transparent; color: var(--text-color); font-size: 1rem; cursor: pointer; flex-shrink: 0;}
.header.room-name { color: var(--accent-color); font-weight: bold; cursor: default; white-space: nowrap; text-overflow: ellipsis; overflow: hidden; font-size: 0.95rem; max-width: 14em; min-width: 0; flex: 0 1 auto;}
.header-copy-btn { background: #334155; color: #f8fafc; border: none; padding: 3px 8px; border-radius: 12px; cursor: pointer; font-size: 0.66rem; line-height: 1.2; flex-shrink: 0; width: auto; margin: 0;}
.version-tag { font-size: 0.58rem; color: #64748b; flex-shrink: 0; margin-left: auto;}
.header-members { display: flex; align-items: flex-start; gap: 6px; min-width: 0;}
.member-block { flex: 1; min-width: 0;}
.member-count { font-size: 0.68rem; color: var(--text-muted); line-height: 1.2;}
.member-names { font-size: 0.68rem; color: #cbd5e1; line-height: 1.25; word-break: break-all;}
.member-line { white-space: nowrap; overflow: hidden; text-overflow: ellipsis;}
.btn-action-group { display: flex; gap: 4px; flex-shrink: 0; align-items: stretch;}
.btn-leave,.btn-host-action { width: 42px; min-width: 42px; margin: 0; padding: 4px 2px; border: none; border-radius: 4px; color: white; font-size: 0.62rem; font-weight: bold; line-height: 1.15; cursor: pointer; text-align: center;}
.btn-leave { background: #64748b; display: inline-flex; align-items: center; justify-content: center;}
.btn-host-action { background: #ef4444; display: none; align-items: center; justify-content: center;}
.btn-kick { background: #f59e0b; color: #111827;}
.view { display: none; padding: 20px; flex-direction: column; flex: 1; min-height: 0; overflow-y: auto;}
.view.active { display: flex;}
#view-chat { padding: 0; overflow: hidden; position: relative;}
label { font-size: 0.85rem; color: var(--text-muted); margin-top: 12px; display: block;}
input, textarea, select { width: 100%; padding: 12px; margin-top: 6px; border-radius: 8px; border: 1px solid var(--border-color); background: #0f172a; color: white; outline: none; font-size: 16px;}
input:focus, textarea:focus, select:focus { border-color: var(--accent-color);}
textarea { resize: none; height: 44px; font-size: 16px; line-height: 1.4;}
button { width: 100%; padding: 12px; margin-top: 18px; border-radius: 8px; border: none; background: var(--accent-color); color: #0f172a; font-weight: bold; cursor: pointer;}
.btn-secondary { background: #475569; color: white;}
.max-members-group { display: flex; gap: 8px; margin-top: 8px;}
.max-members-group label { margin: 0; flex: 1;}
.max-members-group input[type="radio"] { display: none;}
.max-members-group span { display: block; text-align: center; padding: 10px 0; border-radius: 8px; border: 1px solid var(--border-color); background: #0f172a; color: var(--text-muted); cursor: pointer; font-size: 0.9rem;}
.max-members-group input[type="radio"]:checked + span { border-color: var(--accent-color); background: #0c4a6e; color: white; font-weight: bold;}
.my-rooms-section { margin-bottom: 14px; display: none;}
.my-rooms-title { font-size: 0.85rem; color: var(--text-muted); margin-bottom: 8px; font-weight: bold;}
.room-card-list { display: flex; flex-direction: column; gap: 8px;}
.room-card { background: #0f172a; border: 1px solid var(--border-color); padding: 12px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; cursor: pointer;}
.room-card-info { display: flex; flex-direction: column; gap: 2px; min-width: 0;}
.room-card-name { font-weight: bold; font-size: 0.95rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;}
.room-card-meta { font-size: 0.72rem; color: var(--text-muted);}
.home-title { text-align: center; margin-bottom: 18px; font-size: 1.35rem;}
.section-card {
background: #0f172a;
border: 1px solid var(--border-color);
border-radius: 12px;
padding: 16px 14px;
margin-bottom: 14px;
}
.section-card h3 {
font-size: 0.95rem;
color: var(--accent-color);
margin-bottom: 8px;
display: flex;
align-items: center;
gap: 6px;
}
.section-desc {
font-size: 0.72rem;
color: var(--text-muted);
line-height: 1.45;
margin-bottom: 10px;
}
.home-subtitle {
text-align: center;
margin-top: -12px;
margin-bottom: 18px;
font-size: 0.78rem;
color: #94a3b8;
line-height: 1.5;
}
.public-status {
font-size: 0.8rem;
color: #cbd5e1;
margin-bottom: 10px;
display: flex;
align-items: center;
gap: 6px;
}
.public-status.dot {
width: 8px; height: 8px; border-radius: 50%;
background: #22c55e;
box-shadow: 0 0 6px #22c55e88;
flex-shrink: 0;
}
.section-card button { margin-top: 8px;}
.home-features {
margin-top: 8px;
padding: 12px 4px 4px;
border-top: 1px solid var(--border-color);
display: flex;
flex-direction: column;
gap: 6px;
}
.home-feature-item {
font-size: 0.62rem;
color: #64748b;
line-height: 1.4;
display: flex;
gap: 6px;
align-items: flex-start;
}
.home-feature-item.feat-label {
color: #94a3b8;
font-weight: 600;
white-space: nowrap;
flex-shrink: 0;
}
#chat-messages { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; display: flex; flex-direction: column; gap: 8px; padding: 36px 10px 48px;}
.pull-indicator { position: absolute; top: 6px; left: 0; right: 0; display: none; justify-content: center; z-index: 3; pointer-events: none;}
.pull-indicator.show { display: flex;}
.spinner { width: 18px; height: 18px; border: 2px solid #334155; border-top-color: var(--accent-color); border-radius: 50%; animation: spin 0.7s linear infinite;}
@keyframes spin { to { transform: rotate(360deg);}}
.message { display: flex; flex-direction: column; width: fit-content; max-width: 80%; padding: 6px 10px; border-radius: 12px; position: relative; word-break: break-word; align-self: flex-start; font-size: 0.85rem; line-height: 1.4;}
.message.self { align-self: flex-end; background: #0284c7; color: white;}
.message.self .sender { color: #e0f2fe;}
.message.user-color-0 { background: #334155; color: #f8fafc;}
.message.user-color-1 { background: #1e3a29; color: #f8fafc; border: 1px solid #2e5d40;}
.message.user-color-2 { background: #3b2f1e; color: #f8fafc; border: 1px solid #5d4a2e;}
.message.user-color-3 { background: #2e1e3b; color: #f8fafc; border: 1px solid #4a2e5d;}
.message .sender { font-size: 0.75rem; color: var(--text-muted); font-weight: bold; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;}
.message .text-content { white-space: pre-wrap;}
.message .del-btn { margin-left: auto; cursor: pointer; color: #fca5a5; font-size: 0.75rem; opacity: 0.85; flex-shrink: 0; padding-left: 8px;}
.system-notification { text-align: center; font-size: 0.75rem; color: var(--text-muted); margin: 4px 0; align-self: center;}
.chat-img { max-width: 100%; max-height: 200px; border-radius: 8px; margin-top: 6px; cursor: pointer; user-select: none; -webkit-user-drag: none; display: block;}
.chat-img-poster-thumb { width: 140px; height: auto; max-width: 100%; border-radius: 6px; margin-top: 6px; image-rendering: pixelated; border: 1px dashed #94a3b8; opacity: 0.85; display: block;}
.expired-img-note { font-size: 0.72rem; color: #f87171; font-style: italic; margin-top: 4px;}
.poster-only-note { font-size: 0.68rem; color: var(--text-muted); margin-top: 2px;}
.message-timestamp { font-size: 0.62rem; color: var(--text-muted); line-height: 1.2; white-space: nowrap;}
.msg-head { display: flex; align-items: baseline; gap: 6px; margin-bottom: 2px;}
.img-wrap { position: relative; display: inline-block; max-width: 100%; margin-top: 6px;}
.img-wrap .chat-img { margin-top: 0;}
.img-badge { position: absolute; top: 6px; left: 6px; background: rgba(2,6,23,0.72); color: #e2e8f0; font-size: 0.65rem; padding: 2px 7px; border-radius: 999px; pointer-events: none;}
.input-area { display: flex; flex-direction: column; gap: 4px; padding: 6px 8px calc(4px + env(safe-area-inset-bottom)); border-top: 1px solid var(--border-color); flex-shrink: 0; background: var(--card-bg);}
.typing-indicator { font-size: 0.75rem; color: var(--text-muted); font-style: italic; min-height: 0.2rem;}
.display-time-row { display: flex; align-items: center; gap: 6px; font-size: 0.68rem; color: var(--text-muted);}
.display-time-row select { width: auto; padding: 2px 6px; margin: 0; font-size: 0.72rem; border-radius: 8px;}
.input-row { display: flex; gap: 8px; align-items: flex-end;}
.file-btn { background: #475569; color: white; padding: 12px; border-radius: 8px; cursor: pointer; font-size: 0.9rem; margin: 0; width: 46px; height: 46px; display: flex; align-items: center; justify-content: center; flex-shrink: 0;}
.input-row textarea { margin: 0; min-height: 46px;}
.input-row button { margin: 0; width: 52px; height: 46px; padding: 0; flex-shrink: 0; line-height: 1.15;}
.security-disclaimer { font-size: 0.78rem; color: var(--text-muted); line-height: 1.45; margin-top: 2px; padding: 0 2px;}
#full-overlay { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(15, 23, 42, 0.85); backdrop-filter: blur(4px); z-index: 9999; display: none; justify-content: center; align-items: center;}
.toast-message { background: #ef4444; color: white; padding: 14px 28px; border-radius: 12px; font-weight: bold; font-size: 1rem; text-align: center;}
.modal-overlay { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(15, 23, 42, 0.75); z-index: 10000; display: none; justify-content: center; align-items: center;}
.modal-overlay.active { display: flex;}
.modal-box { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 12px; padding: 20px; width: 90%; max-width: 340px;}
.modal-box h3 { font-size: 1rem; margin-bottom: 12px;}
.modal-box p { font-size: 0.85rem; color: var(--text-muted); margin-bottom: 16px;}
.modal-actions { display: flex; gap: 8px;}
.modal-actions button { margin: 0; flex: 1; padding: 10px; font-size: 0.85rem;}
.modal-member-list { max-height: 200px; overflow-y: auto; margin-bottom: 12px;}
.modal-member-item { display: flex; justify-content: space-between; align-items: center; padding: 8px 10px; border-radius: 6px; background: #0f172a; margin-bottom: 6px; font-size: 0.85rem;}
.modal-member-item button { width: auto; margin: 0; padding: 4px 10px; font-size: 0.75rem; background: #f59e0b; color: #0f172a;}
#image-modal { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0,0,0,0.92); z-index: 10001; display: none; justify-content: center; align-items: center; padding: 12px;}
#image-modal.active { display: flex;}
#image-modal-img { max-width: 100vw; max-height: 100vh; object-fit: contain; border-radius: 4px; user-select: none; -webkit-user-drag: none;}
#image-modal-close { position: fixed; top: calc(12px + env(safe-area-inset-top)); right: 12px; width: 40px; height: 40px; border-radius: 50%; border: none; background: rgba(248,250,252,0.95); color: #0f172a; font-size: 1.4rem; font-weight: bold; cursor: pointer; z-index: 10002; margin: 0;}
#image-modal-note { color: var(--text-muted); font-size: 0.75rem; margin-top: 8px; text-align: center;}
.soft-toast { position: fixed; bottom: calc(24px + env(safe-area-inset-bottom)); left: 50%; transform: translateX(-50%); background: rgba(30,41,59,0.92); color: #e2e8f0; padding: 8px 16px; border-radius: 8px; font-size: 0.8rem; z-index: 10003; opacity: 0; transition: opacity 0.2s; pointer-events: none;}
.soft-toast.show { opacity: 1;}
.waiting-msg-banner { background: #0c4a6e; border: 1px solid #38bdf8; padding: 10px; border-radius: 8px; font-size: 0.8rem; color: #f8fafc; margin-bottom: 12px;}
</style>
</head>
<body>
<div id="full-overlay"><div class="toast-message" id="toast-text">現在満員です</div></div>
<div id="soft-toast" class="soft-toast">右クリックできません</div>
<div id="image-modal" onclick="closeImageModal(event)">
<button type="button" id="image-modal-close" onclick="closeImageModal(event)" aria-label="閉じる">×</button>
<div id="image-modal-inner">
<img id="image-modal-img" alt="画像" oncontextmenu="return false;" />
<div id="image-modal-note"></div>
</div>
</div>
<div id="kick-modal" class="modal-overlay">
<div class="modal-box">
<h3>強制退室</h3>
<p>退室させるメンバーを選んでください</p>
<div id="kick-member-list" class="modal-member-list"></div>
<div class="modal-actions"><button type="button" class="btn-secondary" onclick="closeKickModal()">キャンセル</button></div>
</div>
</div>
<div id="kick-confirm-modal" class="modal-overlay">
<div class="modal-box">
<h3>確認</h3>
<p id="kick-confirm-text">このメンバーを退室させますか？</p>
<div class="modal-actions">
<button type="button" class="btn-secondary" onclick="closeKickConfirmModal()">キャンセル</button>
<button type="button" id="kick-confirm-btn" style="background:#ef4444;color:white;">退室させる</button>
</div>
</div>
</div>
<div class="container">
<div class="header">
<div class="header-top">
<button type="button" class="home-btn" onclick="goHome()" aria-label="トップへ">🏠</button>
<span class="room-name" id="header-room-name">SimpleChatee</span>
<button type="button" class="header-copy-btn" id="header-copy-btn" onclick="copyRoomLink()" style="display:none;">🔗コピー</button>
<span class="version-tag">Ver. 2.3.7</span>
</div>
<div class="header-members" id="header-room-id-container" style="display:none;">
<div class="member-block">
<div class="member-count" id="member-count"></div>
<div class="member-names" id="member-names"></div>
</div>
<div class="btn-action-group" id="room-action-container">
<button type="button" id="btn-delete-room" class="btn-host-action" onclick="deleteRoom()">部屋<br>削除</button>
<button type="button" id="btn-kick" class="btn-host-action btn-kick" onclick="openKickModal()">強制<br>退室</button>
<button type="button" class="btn-leave" onclick="leaveRoom()">退室<br>する</button>
</div>
</div>
</div>
<div id="view-home" class="view active">
<h2 class="home-title">SimpleChatee</h2>
<p class="home-subtitle">画像の表示時間を選んで気軽に投稿</p>

<div class="section-card" id="public-room-section">
<h3>🌐 公開ルーム</h3>
<div class="public-status">
<span class="dot" aria-hidden="true"></span>
<span id="public-room-status">入室中: — 人</span>
</div>
<p class="section-desc">誰でもニックネームだけで自由に入れます。プライベートルームへの誘導や待ち合わせもOK。</p>
<button type="button" onclick="enterPublicRoom()">公開ルームに入室</button>
</div>

<div class="section-card" id="room-list-section">
<h3>🏠 作成された部屋一覧</h3>
<div class="room-card-list" id="home-room-list" style="max-height: 220px; overflow-y: auto; margin-top: 8px;">
<div style="font-size:0.75rem; color:var(--text-muted); text-align:center; padding:8px;">部屋がありません</div>
</div>
</div>

<div class="section-card" id="private-room-section">
<h3>🔒 プライベートルーム</h3>
<p class="section-desc">招待リンクで入室する、少人数向けの個室チャットです。</p>
<div id="my-rooms-section" class="my-rooms-section">
<div class="my-rooms-title">作成・参加した部屋</div>
<div id="my-rooms-list" class="room-card-list"></div>
</div>
<button type="button" onclick="showView('view-create')">部屋を作成・入室</button>
</div>

<div class="home-features">
<div class="home-feature-item"><span class="feat-label">E2E暗号化</span><span>チャット内容はブラウザ間で暗号化され、管理者も閲覧できません。</span></div>
<div class="home-feature-item"><span class="feat-label">画像の時限表示</span><span>1秒 / 3秒 / 5秒 / 10秒 などの時限表示。表示後はサーバーから自動削除されます。</span></div>
<div class="home-feature-item"><span class="feat-label">履歴の不保持</span><span>メッセージ履歴を長期保持しない、使い切り型の設計です。</span></div>
</div>
</div>
<div id="view-create" class="view">
<h3>部屋を作成</h3>
<label>部屋名</label>
<input type="text" id="create-room-name" placeholder="例: ひみつの部屋" maxlength="30">
<label>待機メッセージ（50文字以内）</label>
<input type="text" id="create-waiting-msg" placeholder="例: メンバー揃ったら開始します" maxlength="50">
<label>最大人数（部屋主含む）</label>
<div class="max-members-group">
<label><input type="radio" name="max-members" value="3" checked><span>3人</span></label>
<label><input type="radio" name="max-members" value="4"><span>4人</span></label>
<label><input type="radio" name="max-members" value="5"><span>5人</span></label>
</div>
<label>あなたのニックネーム</label>
<input type="text" id="create-nickname" placeholder="名無し" maxlength="20">
<button type="button" onclick="createRoom()">作成して入室</button>
<button type="button" class="btn-secondary" style="margin-top: 10px;" onclick="goHome()">キャンセル</button>
</div>
<div id="view-join" class="view">
<h3 id="join-target-room-title">部屋に入室</h3>
<div id="room-waiting-banner" class="waiting-msg-banner" style="display:none;"></div>
<label>あなたのニックネーム</label>
<input type="text" id="join-nickname" placeholder="名無し" maxlength="20">
<p id="join-key-warning" style="font-size:0.75rem; color:#f87171; margin-top:10px; display:none;">暗号化鍵が見つかりません。招待リンクから入室してください。</p>
<button type="button" onclick="joinRoom()">入室する</button>
<button type="button" class="btn-secondary" style="margin-top: 10px;" onclick="goHome()">トップに戻る</button>
</div>
<div id="view-chat" class="view">
<div id="pull-indicator" class="pull-indicator"><span class="spinner"></span></div>
<div id="chat-messages"></div>
<div class="input-area">
<div id="file-name-preview" style="font-size: 0.75rem; color: var(--accent-color); display: none;"></div>
<div id="typing-indicator" class="typing-indicator"></div>
<div class="display-time-row" id="display-time-control" style="display:none;">
<span>画像表示時間</span>
<select id="image-display-select" onchange="changeImageDisplayTime()">
<option value="0">粗サムネのみ</option>
<option value="1">1秒</option>
<option value="2">2秒</option>
<option value="3">3秒</option>
<option value="5">5秒</option>
<option value="10">10秒</option>
<option value="3600">1時間</option>
</select>
</div>
<div class="input-row">
<label class="file-btn">📷<input type="file" id="file-input" accept="image/*" style="display:none;" onchange="onFileSelected(this)"></label>
<textarea id="msg-input" placeholder="メッセージを入力..." oninput="handleTyping()" onkeydown="onKeyDown(event)"></textarea>
<button type="button" onclick="sendMessage()">送<br>信</button>
</div>
<div class="security-disclaimer">🔒 チャット内容はE2E暗号化により管理者も閲覧不可です。画像は表示時間経過後にサーバーからも削除されます。</div>
</div>
</div>
</div>
<script src="/socket.io/socket.io.js"></script>
<script>
const socket = io({ reconnection: true, reconnectionAttempts: Infinity, reconnectionDelay: 1000, reconnectionDelayMax: 10000, timeout: 20000});
let autoJoinPending = false;
let clientLogQueue = [];
function clientLog(eventName, detail) {
try {
const item = { event: eventName, detail: detail || '', roomId: currentRoomId || '' };
if (socket && socket.connected) socket.emit('client_log', item);
else if (clientLogQueue.length < 20) clientLogQueue.push(item);
} catch (e) {}
}
function flushClientLogs() {
try { while (clientLogQueue.length) { const item = clientLogQueue.shift(); socket.emit('client_log', item); } } catch (e) {}
}
let currentRoomId = '';
let currentRoomName = '';
let currentKey = '';
let myNickname = '';
let userSessionId = '';
let selectedFile = null;
let isHost = false;
let currentMaxMembers = 3;
let currentImageDisplaySeconds = 5;
let keepAliveTimer = null;
let lastChatActivityAt = Date.now();
let pendingKickSessionId = null;
let pendingKickNickname = null;
let typingTimeout = null;
let isTyping = false;
let refreshing = false;
let isPublicRoom = false;
let publicCountTimer = null;
let createRoomInFlight = false;
let roomListPollTimer = null;

const PUBLIC_ROOM_ID = 'public';
const PUBLIC_ROOM_KEY = 'SimpleChatee-Public-Room-Key-v1';

function getBannedRooms() {
try { return JSON.parse(localStorage.getItem('bannedRooms') || '[]');} catch(e) { return [];}
}
function addBannedRoom(roomId) {
try {
const list = getBannedRooms();
if (!list.includes(roomId)) {
list.push(roomId);
localStorage.setItem('bannedRooms', JSON.stringify(list));
}
} catch(e) {}
}
function isRoomBanned(roomId) {
return getBannedRooms().includes(roomId);
}

function noteActivity() { lastChatActivityAt = Date.now();}
function truncateLabel(str, max) {
const s = String(str || '');
return s.length > max? s.slice(0, max) + '…': s;
}
function setRoomTitle(name) {
const el = document.getElementById('header-room-name');
const full = name || 'SimpleChatee';
el.textContent = truncateLabel(full, 14);
el.title = full;
}
function renderMemberNames(names) {
const el = document.getElementById('member-names');
if (!el) return;
el.innerHTML = '';
const list = Array.isArray(names)? names: [];
for (let i = 0; i < list.length; i += 3) {
const line = document.createElement('div');
line.className = 'member-line';
line.textContent = list.slice(i, i + 3).map(function(n) { return truncateLabel(n, 9);}).join(' ');
el.appendChild(line);
}
}
function bindVisualViewport() {
const vv = window.visualViewport;
const shell = document.querySelector('.container');
if (!shell) return;
const sync = function() {
shell.style.height = (vv? vv.height: window.innerHeight) + 'px';
shell.style.top = (vv? (vv.offsetTop || 0): 0) + 'px';
};
if (vv) { vv.addEventListener('resize', sync); vv.addEventListener('scroll', sync);}
window.addEventListener('resize', sync);
sync();
const input = document.getElementById('msg-input');
if (!input) return;
const place = function() { window.scrollTo(0, 0); sync();};
input.addEventListener('focus', function() { place(); setTimeout(place, 60); setTimeout(place, 300);});
input.addEventListener('blur', function() { setTimeout(place, 80);});
}
function setupPullToRefresh() {
const scroller = document.getElementById('chat-messages');
const indicator = document.getElementById('pull-indicator');
if (!scroller || scroller.dataset.pullBound) return;
scroller.dataset.pullBound = '1';
let startY = 0;
let pulling = false;
scroller.addEventListener('touchstart', function(e) {
startY = e.touches[0].clientY;
pulling = scroller.scrollTop <= 2;
}, { passive: true});
scroller.addEventListener('touchmove', function(e) {
if (!pulling) return;
if (e.touches[0].clientY - startY > 80) indicator.classList.add('show');
}, { passive: true});
scroller.addEventListener('touchend', function() {
if (indicator.classList.contains('show') && pulling) refreshRoom();
else indicator.classList.remove('show');
pulling = false;
});
}
function refreshRoom() {
if (!currentRoomId ||!userSessionId) return;
clientLog('pull_refresh', '');
refreshing = true;
document.getElementById('pull-indicator').classList.add('show');
socket.emit('rejoin_room', { roomId: currentRoomId, sessionId: userSessionId, nickname: myNickname});
setTimeout(function() {
refreshing = false;
const ind = document.getElementById('pull-indicator');
if (ind) ind.classList.remove('show');
}, 4000);
}
function scrollMessageFully(el) {
const container = document.getElementById('chat-messages');
if (!el ||!container) return;
const run = function() {
const bottom = el.offsetTop + el.offsetHeight;
const viewBottom = container.scrollTop + container.clientHeight;
if (bottom > viewBottom - 8) container.scrollTop = bottom - container.clientHeight + 16;
};
run();
const img = el.querySelector('img');
if (img) {
if (!img.complete) img.addEventListener('load', run, { once: true});
setTimeout(run, 80);
setTimeout(run, 240);
}
}
function updatePublicRoomStatus() {
fetch('/api/public-count').then(function(r) { return r.json();}).then(function(data) {
const el = document.getElementById('public-room-status');
if (!el) return;
const c = (data && typeof data.count === 'number')? data.count: 0;
el.textContent = '入室中: ' + c + ' 人';
}).catch(function() {});
}
function fetchHomeRoomList() {
fetch('/api/rooms').then(function(r) { return r.json();}).then(function(data) {
const listEl = document.getElementById('home-room-list');
if (!listEl) return;
const rooms = (data && Array.isArray(data.rooms))? data.rooms: [];
/* Ver.2.3.1: サーバーの部屋一覧に無い保存済み部屋は消えた部屋として掃除する */
try {
if (!data || !Array.isArray(data.rooms)) throw new Error('no rooms array');
const serverIds = {};
rooms.forEach(function(r) { serverIds[r.id] = true; });
const savedIds = Object.keys(getSavedRooms()).filter(function(id) { return id !== PUBLIC_ROOM_ID; });
if (savedIds.length) {
const existsMap = {};
savedIds.forEach(function(id) { existsMap[id] = !!serverIds[id]; });
pruneSavedRoomsByExistsMap(existsMap);
}
} catch (e) {}
const validRooms = rooms.filter(r =>!isRoomBanned(r.id));
if (validRooms.length === 0) {
listEl.innerHTML = '<div style="font-size:0.75rem; color:var(--text-muted); text-align:center; padding:8px;">現在作成されている部屋はありません</div>';
return;
}
listEl.innerHTML = '';
validRooms.forEach(r => {
const card = document.createElement('div');
card.className = 'room-card';
card.onclick = function() { selectRoomFromList(r.id, r.name);};
card.innerHTML = \`
<div class="room-card-info">
<div class="room-card-name">\${escapeHtml(r.name)}</div>
<div class="room-card-meta">入室中: \${r.activeCount}/\${r.maxMembers}人\${r.waitingMsg? ' | ' + escapeHtml(r.waitingMsg): ''}</div>
</div>
<span style="font-size:0.8rem;color:var(--accent-color);flex-shrink:0;">参加 →</span>
\`;
listEl.appendChild(card);
});
}).catch(function() {});
}
function startHomePoll() {
stopHomePoll();
updatePublicRoomStatus();
fetchHomeRoomList();
roomListPollTimer = setInterval(() => {
updatePublicRoomStatus();
fetchHomeRoomList();
}, 4000);
}
function stopHomePoll() {
if (roomListPollTimer) { clearInterval(roomListPollTimer); roomListPollTimer = null;}
}
function selectRoomFromList(roomId, roomName) {
if (isRoomBanned(roomId)) {
alert('この部屋にはアクセスできません。');
goHome(true);
return;
}
currentRoomId = roomId;
currentRoomName = roomName;
const saved = getSavedRooms()[roomId];
if (saved && saved.key) {
currentKey = saved.key;
myNickname = saved.nickname || '';
isHost =!!saved.isHost;
} else {
currentKey = '';
}
socket.emit('get_room_info', { roomId: roomId}, function(res) {
if (res && res.exists === false) {
removeRoomFromStorage(roomId);
renderSavedRoomsList();
alert('この部屋はもう存在しません。一覧から削除しました。');
goHome(true);
return;
}
if (res && res.waitingMsg) {
const banner = document.getElementById('room-waiting-banner');
banner.textContent = '待機メッセージ: ' + res.waitingMsg;
banner.style.display = 'block';
} else {
document.getElementById('room-waiting-banner').style.display = 'none';
}
document.getElementById('join-target-room-title').innerText = '「' + roomName + '」に入室';
document.getElementById('join-key-warning').style.display = currentKey? 'none': 'block';
showView('view-join');
});
}

function enterPublicRoom() {
const nick = prompt('ニックネームを入力してください', '');
if (nick === null) return;
myNickname = nick.trim().substring(0, 20);
if (!myNickname) {
alert('ニックネームを入れてください');
return;
}
if (!socket.connected) {
alert('サーバーに接続されていません。ページを再読み込みしてください。');
return;
}
currentRoomId = PUBLIC_ROOM_ID;
currentRoomName = '公開ルーム';
currentKey = PUBLIC_ROOM_KEY;
isHost = false;
isPublicRoom = true;
socket.emit('join_room', {
roomId: PUBLIC_ROOM_ID,
roomName: '公開ルーム',
nickname: myNickname,
sessionId: userSessionId
}, function(res) {
if (!res) {
alert('サーバーからの応答がありません');
isPublicRoom = false;
return;
}
if (res.success) {
isHost = false;
currentRoomId = res.roomId || PUBLIC_ROOM_ID;
currentRoomName = res.roomName || '公開ルーム';
currentMaxMembers = res.maxMembers || 50;
currentImageDisplaySeconds = res.imageDisplaySeconds || 5;
isPublicRoom = true;
setupChatView(currentRoomId, currentRoomName, res.messages || [], currentMaxMembers, currentImageDisplaySeconds, res.members || []);
document.getElementById('header-copy-btn').style.display = 'none';
document.getElementById('btn-delete-room').style.display = 'none';
document.getElementById('btn-kick').style.display = 'none';
window.history.pushState({}, '', '/');
window.location.hash = '';
} else if (res.full) {
showToast('現在満員です', function() { goHome(true);});
} else {
alert(res.error || '入室に失敗しました');
isPublicRoom = false;
}
});
}
socket.on('connect', function() {
flushClientLogs();
clientLog('connect', '');
if (autoJoinPending && currentRoomId && currentKey && myNickname) {
autoJoinPending = false;
joinRoom();
return;
}
if (currentRoomId && userSessionId) {
if (isRoomBanned(currentRoomId)) {
goHome(true);
return;
}
socket.emit('rejoin_room', { roomId: currentRoomId, sessionId: userSessionId, nickname: myNickname});
if (isHost) startKeepAlive();
}
});
socket.on('disconnect', function(reason) { clientLog('disconnect', String(reason || '')); stopKeepAlive();});
socket.on('connect_error', function() { clientLog('connect_error', ''); });
try {
socket.io.on('reconnect_attempt', function(n) { clientLog('reconnect_attempt', 'n=' + n); });
socket.io.on('reconnect', function(n) { clientLog('reconnect', 'n=' + n); });
} catch (e) {}
document.addEventListener('visibilitychange', function() {
if (document.hidden) clientLog('visibility_hidden', '');
else { clientLog('visibility_visible', ''); if (!socket.connected) { try { socket.connect(); } catch (e) {} } }
});
window.addEventListener('pagehide', function() { clientLog('pagehide', ''); });
window.addEventListener('pageshow', function() { clientLog('pageshow', ''); });
socket.on('room_state_sync', function(data) {
if (!data || data.roomId!== currentRoomId) return;
updateMemberCount(data.count, data.maxMembers, data.members);
if (typeof data.imageDisplaySeconds === 'number') {
currentImageDisplaySeconds = data.imageDisplaySeconds;
const sel = document.getElementById('image-display-select');
if (sel) sel.value = String(data.imageDisplaySeconds);
}
if (refreshing) document.getElementById('chat-messages').innerHTML = '';
if (Array.isArray(data.messages)) {
data.messages.forEach(function(msg) {
if (msg.type === 'system') renderSystemNotification(msg.text, msg.id);
else { noteActivity(); renderSingleMessage(msg, true);}
});
}
refreshing = false;
const ind = document.getElementById('pull-indicator');
if (ind) ind.classList.remove('show');
});
socket.on('receive_message', function(msg) {
if (!msg) return;
if (msg.type === 'system') renderSystemNotification(msg.text, msg.id);
else { noteActivity(); renderSingleMessage(msg, false);}
});
socket.on('image_restored', function(data) {
if (!data || !data.msgId) return;
restoreImage(data.msgId, true);
});
socket.on('image_expired_now', function(data) {
if (!data || !data.msgId) return;
expireImageNow(data.msgId, true);
});
socket.on('message_deleted', function(data) {
const el = document.getElementById('msg-' + data.msgId);
if (el) el.remove();
});
socket.on('update_members', function(data) {
if (!data) return;
updateMemberCount(data.count, data.maxMembers, data.members);
});
socket.on('image_display_changed', function(data) {
if (!data) return;
currentImageDisplaySeconds = data.seconds;
const sel = document.getElementById('image-display-select');
if (sel) sel.value = String(data.seconds);
noteActivity();
renderSystemNotification(data.text, data.id);
});
socket.on('display_typing', function(data) {
document.getElementById('typing-indicator').innerText = data.isTyping? (data.nickname + ' が入力中...'): '';
});
socket.on('room_not_found', function(data) {
const rid = (data && data.roomId) || currentRoomId;
if (rid) removeRoomFromStorage(rid);
renderSavedRoomsList();
alert('この部屋はもう存在しません。一覧から削除しました。');
goHome(true);
});
socket.on('room_deleted_by_host', function(data) {
const reason = (data && data.reason === 'inactivity')? '1ヶ月間無発話のため、部屋は自動削除されました。': '部屋主によってこの部屋は削除されました。';
if (currentRoomId) removeRoomFromStorage(currentRoomId);
alert(reason);
goHome(true);
});
socket.on('force_left', function() {
if (currentRoomId) addBannedRoom(currentRoomId);
stopKeepAlive();
alert('強制退出させられました。この部屋へは今後入れません。');
goHome(true);
});
socket.on('room_full_rejected', function() { showToast('現在満員です', function() { goHome(true);});});
socket.on('members_for_kick', function(data) {
const list = document.getElementById('kick-member-list');
list.innerHTML = '';
if (!data.members || data.members.length === 0) {
list.innerHTML = '<p style="font-size:0.8rem;color:var(--text-muted);">他にメンバーがいません</p>';
return;
}
data.members.forEach(function(m) {
const div = document.createElement('div');
div.className = 'modal-member-item';
div.innerHTML = '<span>' + escapeHtml(m.nickname) + '</span>';
const btn = document.createElement('button');
btn.type = 'button';
btn.textContent = '退室';
btn.onclick = function() { confirmKick(m.sessionId, m.nickname);};
div.appendChild(btn);
list.appendChild(div);
});
});
function encryptText(plainText, key) {
if (!plainText) return '';
try { return CryptoJS.AES.encrypt(plainText, key).toString();} catch (e) { return plainText;}
}
function decryptText(cipherText, key) {
if (!cipherText) return '';
if (!key) return '(鍵がありません)';
try {
const bytes = CryptoJS.AES.decrypt(cipherText, key);
return bytes.toString(CryptoJS.enc.Utf8) || '(復号エラー)';
} catch (e) { return '(復号失敗)';}
}
function generateKey() {
if (typeof CryptoJS!== 'undefined' && CryptoJS.lib && CryptoJS.lib.WordArray) {
const wa = CryptoJS.lib.WordArray.random(16);
const b64 = CryptoJS.enc.Base64.stringify(wa);
return b64.replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
}
const arr = new Uint8Array(16);
if (window.crypto && window.crypto.getRandomValues) {
window.crypto.getRandomValues(arr);
} else {
for (let i = 0; i < 16; i++) arr[i] = Math.floor(Math.random() * 256);
}
let s = '';
for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
return btoa(s).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
}
/* Ver.2.2.0: sessionIdの新規発行を暗号論的乱数(12バイト=16桁)に強化。
既存端末に保存済みのIDはそのまま使う（移行で部屋から弾かれないため）。
なお、これは推測困難化であり認証ではない。真の認証にはサーバー発行の
部屋別秘密トークンへの再設計が必要（今回は対象外）。 */
function generateSessionId() {
const arr = new Uint8Array(12);
if (window.crypto && window.crypto.getRandomValues) {
window.crypto.getRandomValues(arr);
let s = '';
for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
return btoa(s).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
}
let fallback = '';
const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
for (let i = 0; i < 16; i++) fallback += chars[Math.floor(Math.random() * chars.length)];
return fallback;
}
function getOrCreateSessionId() {
let sid = sessionStorage.getItem('userSessionId');
if (!sid) {
sid = localStorage.getItem('userSessionId');
if (!sid) {
sid = generateSessionId();
try { localStorage.setItem('userSessionId', sid);} catch (e) {}
}
try { sessionStorage.setItem('userSessionId', sid);} catch (e) {}
}
return sid;
}
try { userSessionId = getOrCreateSessionId();} catch (e) { userSessionId = generateSessionId();}

/* Ver.2.3.3: 中サイズサムネ (長辺720px / JPEG 0.72) を Blob で作る。
   インライン表示はこちらを使い、原画はタップした人だけが viewer で読む。
   Base64にはしない (メッセージ/履歴/再同期が太るため)。ファイルとして上げてURLだけ載せる。
   小さい画像や、作っても小さくならない場合は null (原画表示にフォールバック)。 */
function createMidThumbnailBlob(file) {
return new Promise((resolve) => {
try {
if (!file || !file.type || file.type.indexOf('image/') !== 0) return resolve(null);
if (file.size <= 300 * 1024) return resolve(null);
const reader = new FileReader();
reader.onerror = () => resolve(null);
reader.onload = (e) => {
const img = new Image();
img.onerror = () => resolve(null);
img.onload = () => {
try {
const maxDim = 720;
const longest = Math.max(img.width, img.height);
const scale = longest > maxDim ? maxDim / longest : 1;
const canvas = document.createElement('canvas');
canvas.width = Math.max(1, Math.round(img.width * scale));
canvas.height = Math.max(1, Math.round(img.height * scale));
const ctx = canvas.getContext('2d');
ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
if (!canvas.toBlob) return resolve(null);
canvas.toBlob((blob) => {
if (!blob) return resolve(null);
if (blob.size >= file.size * 0.9) return resolve(null);
resolve(blob);
}, 'image/jpeg', 0.72);
} catch (err) { resolve(null); }
};
img.src = e.target.result;
};
reader.readAsDataURL(file);
} catch (err) { resolve(null); }
});
}
function createUltraLightThumbnail(file) {
return new Promise((resolve) => {
const reader = new FileReader();
reader.onload = (e) => {
const img = new Image();
img.onload = () => {
const canvas = document.createElement('canvas');
const targetWidth = 48;
const scale = targetWidth / img.width;
canvas.width = targetWidth;
canvas.height = Math.max(1, Math.round(img.height * scale));
const ctx = canvas.getContext('2d');
ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
resolve(canvas.toDataURL('image/jpeg', 0.35));
};
img.src = e.target.result;
};
reader.readAsDataURL(file);
});
}
/* Ver.2.2.0: 短縮リンクは '#鍵' 形式。旧形式 '#k=鍵' / '#key=鍵' も互換で読む */
function getKeyFromHash() {
const hash = window.location.hash;
if (!hash || hash.length < 2) return '';
if (hash.startsWith('#k=')) return decodeURIComponent(hash.substring(3));
if (hash.startsWith('#key=')) return decodeURIComponent(hash.substring(5));
return decodeURIComponent(hash.substring(1));
}
function setKeyToHash(key) { window.location.hash = encodeURIComponent(key);}
function buildRoomUrl(roomId, key) {
return '/' + encodeURIComponent(roomId) + (key? '#' + encodeURIComponent(key): '');
}
function getSavedRooms() {
try { return JSON.parse(localStorage.getItem('myJoinedRooms') || '{}');} catch (e) { return {};}
}
function saveRoomToStorage(roomId, roomName, nickname, key, isHostFlag) {
if (roomId === PUBLIC_ROOM_ID) return;
try {
const store = getSavedRooms();
store[roomId] = { roomId: roomId, roomName: roomName, nickname: nickname, key: key, isHost:!!isHostFlag, updatedAt: Date.now()};
localStorage.setItem('myJoinedRooms', JSON.stringify(store));
} catch (e) {}
}
function removeRoomFromStorage(roomId) {
try {
const store = getSavedRooms();
delete store[roomId];
localStorage.setItem('myJoinedRooms', JSON.stringify(store));
} catch (e) {}
}
/* Ver.2.3.1: サーバーに実在しない保存済み部屋を localStorage から消す。
   existsMap で false と断定された部屋だけ消す。通信失敗では呼ばれない=誤削除しない。 */
function pruneSavedRoomsByExistsMap(existsMap) {
if (!existsMap) return;
try {
const store = getSavedRooms();
let changed = false;
Object.keys(existsMap).forEach(function(id) {
if (existsMap[id] === false && store[id]) { delete store[id]; changed = true; logEventClientPrune(id); }
});
if (changed) {
localStorage.setItem('myJoinedRooms', JSON.stringify(store));
renderSavedRoomsList();
}
} catch (e) {}
}
function logEventClientPrune(roomId) { try { clientLog('saved_room_pruned', roomId); } catch (e) {} }
/* Ver.2.3.2: 存在チェックAPIの定期ポーリングは廃止。掃除は (1)既に取得している部屋一覧との照合 (追加通信なし) と
   (2)「部屋が存在しません」と分かった時 (タップ/入室/再接続時) の削除だけで行う。 */
function renderSavedRoomsList() {
const store = getSavedRooms();
const container = document.getElementById('my-rooms-list');
const section = document.getElementById('my-rooms-section');
if (!container ||!section) return;
container.innerHTML = '';
const ids = Object.keys(store).filter(function(id) { return id!== PUBLIC_ROOM_ID &&!isRoomBanned(id);});
if (ids.length === 0) { section.style.display = 'none'; return;}
ids.sort(function(a, b) { return (store[b].updatedAt || 0) - (store[a].updatedAt || 0);});
section.style.display = 'block';
ids.forEach(function(id) {
const r = store[id];
const card = document.createElement('div');
card.className = 'room-card';
card.onclick = function() { selectRoomFromList(id, r.roomName || id);};
const roleLabel = r.isHost? '作成者': '参加者';
card.innerHTML = '<div class="room-card-info"><div class="room-card-name">' + escapeHtml(r.roomName || r.roomId || id) + '</div><div class="room-card-meta">' + escapeHtml(r.nickname || '') + '（' + roleLabel + '）</div></div><span style="font-size:0.8rem;color:var(--accent-color);flex-shrink:0;">入室 →</span>';
container.appendChild(card);
});
}

window.onload = function() {
if (!userSessionId) userSessionId = getOrCreateSessionId();
renderSavedRoomsList();
bindVisualViewport();
setupPullToRefresh();
startHomePoll();

const urlParams = new URLSearchParams(window.location.search);
/* Ver.2.2.0: 短縮リンク '/部屋ID' 形式に対応。旧形式 '?r=' / '?room=' も互換で読む */
const pathRoomRefRaw = (window.location.pathname || '').replace(/^\\//, '').replace(/\\/$/, '');
const pathRoomRef = /^[a-z0-9]{6}$/.test(pathRoomRefRaw) && pathRoomRefRaw!== PUBLIC_ROOM_ID? pathRoomRefRaw: '';
const urlRoomRef = urlParams.get('r') || urlParams.get('room') || pathRoomRef;
const keyFromHash = getKeyFromHash();
if (urlRoomRef) {
if (isRoomBanned(urlRoomRef)) {
alert('この部屋へのアクセスは制限されています。');
location.href = '/';
return;
}
currentRoomId = urlRoomRef;
currentRoomName = urlRoomRef;
const saved = getSavedRooms()[urlRoomRef];
if (saved && saved.key) {
currentKey = saved.key;
currentRoomName = saved.roomName || urlRoomRef;
myNickname = saved.nickname || '';
isHost =!!saved.isHost;
if (myNickname) document.getElementById('join-nickname').value = myNickname;
}
if (keyFromHash) currentKey = keyFromHash;
document.getElementById('join-target-room-title').innerText = '部屋に入室';
document.getElementById('join-key-warning').style.display = currentKey? 'none': 'block';
showView('view-join');
/* Ver.2.3.0: 保存済み(鍵+ニックネームあり)ならタップなしで静かに自動入室する。復帰時は入室通知を出さない */
if (currentKey && myNickname) {
document.getElementById('join-nickname').value = myNickname;
if (socket.connected) joinRoom();
else autoJoinPending = true;
}
}
};

function showToast(message, callback) {
const overlay = document.getElementById('full-overlay');
document.getElementById('toast-text').innerText = message;
overlay.style.display = 'flex';
setTimeout(function() { overlay.style.display = 'none'; if (callback) callback();}, 2000);
}
function showView(id) {
document.querySelectorAll('.view').forEach(function(v) { v.classList.remove('active');});
document.getElementById(id).classList.add('active');
if (id === 'view-home') startHomePoll();
else stopHomePoll();
}
function goHome(skipLeave) {
if (!skipLeave && currentRoomId && userSessionId) {
socket.emit('leave_room', { roomId: currentRoomId, sessionId: userSessionId});
}
stopKeepAlive();
currentRoomId = '';
currentRoomName = '';
currentKey = '';
isHost = false;
isPublicRoom = false;
window.history.pushState({}, '', '/');
window.location.hash = '';
setRoomTitle('SimpleChatee');
document.getElementById('header-copy-btn').style.display = 'none';
document.getElementById('header-room-id-container').style.display = 'none';
document.getElementById('member-count').innerText = '';
document.getElementById('member-names').innerHTML = '';
document.getElementById('btn-delete-room').style.display = 'none';
document.getElementById('btn-kick').style.display = 'none';
document.getElementById('display-time-control').style.display = 'none';
renderSavedRoomsList();
showView('view-home');
}
function updateMemberCount(count, maxMembers, members) {
const el = document.getElementById('member-count');
if (!el) return;
const safeCount = Math.max(0, Number(count) || 0);
const max = maxMembers || currentMaxMembers || 3;
el.innerText = '入室中:' + safeCount + '/' + max + '人';
if (Array.isArray(members)) renderMemberNames(members);
}

function createRoom() {
if (createRoomInFlight) return;
const name = (document.getElementById('create-room-name').value || '').trim();
const waitingMsg = (document.getElementById('create-waiting-msg').value || '').trim().substring(0, 50);
myNickname = (document.getElementById('create-nickname').value || '部屋主').trim().substring(0, 20);
const maxMembersRadio = document.querySelector('input[name="max-members"]:checked');
const maxMembers = maxMembersRadio? parseInt(maxMembersRadio.value, 10): 3;
if (!name) return alert('部屋名を入力してください');
if (name.length > 30) return alert('部屋名は30文字以内にしてください');
if (name === '公開ルーム' || name.toLowerCase() === 'public') return alert('この部屋名は使用できません');
if (!socket.connected) {
return alert('サーバーに接続されていません。ページを再読み込みしてください。');
}
if (!userSessionId) {
try { userSessionId = getOrCreateSessionId();} catch (e) {
userSessionId = generateSessionId();
}
}
try {
currentKey = generateKey();
} catch (e) {
return alert('暗号化鍵の生成に失敗しました。');
}
currentRoomName = name;
currentMaxMembers = maxMembers;
isHost = true;
isPublicRoom = false;
createRoomInFlight = true;
const ackTimeout = setTimeout(function() {
if (createRoomInFlight) {
createRoomInFlight = false;
alert('サーバーからの応答がタイムアウトしました。');
}
}, 10000);
socket.emit('create_room', {
name: name,
waitingMsg: waitingMsg,
nickname: myNickname,
sessionId: userSessionId,
maxMembers: maxMembers
}, function(res) {
clearTimeout(ackTimeout);
createRoomInFlight = false;
if (!res ||!res.success) {
alert((res && res.error) || '部屋の作成に失敗しました');
currentKey = ''; currentRoomId = ''; currentRoomName = ''; isHost = false;
return;
}
currentRoomId = res.roomId;
currentRoomName = res.roomName || name;
saveRoomToStorage(currentRoomId, currentRoomName, myNickname, currentKey, true);
setupChatView(currentRoomId, currentRoomName, res.messages || [], maxMembers, res.imageDisplaySeconds || 5, res.members || [myNickname]);
startKeepAlive();
});
}

function joinRoom() {
if (isRoomBanned(currentRoomId)) {
alert('この部屋へのアクセスは制限されています。');
goHome(true);
return;
}
myNickname = (document.getElementById('join-nickname').value || 'ゲスト').trim().substring(0, 20);
if (!currentKey) return alert('暗号化鍵がありません。招待リンクから入室してください。');
if (!socket.connected) {
return alert('サーバーに接続されていません。');
}
isPublicRoom = false;
socket.emit('join_room', { roomId: currentRoomId || undefined, roomName: currentRoomName || undefined, nickname: myNickname, sessionId: userSessionId}, function(res) {
if (!res) { alert('サーバーからの応答がありません'); return;}
if (res.success) {
isHost = res.isHost || false;
currentRoomId = res.roomId;
currentRoomName = res.roomName || currentRoomName;
currentMaxMembers = res.maxMembers || 3;
currentImageDisplaySeconds = res.imageDisplaySeconds || 5;
saveRoomToStorage(currentRoomId, currentRoomName, myNickname, currentKey, isHost);
setupChatView(currentRoomId, currentRoomName, res.messages || [], currentMaxMembers, currentImageDisplaySeconds, res.members || []);
if (isHost) startKeepAlive();
window.history.pushState({}, '', buildRoomUrl(currentRoomId, currentKey));
} else if (res.full) showToast('現在満員です', function() { goHome(true);});
else if (res.exists === false) {
if (currentRoomId) removeRoomFromStorage(currentRoomId);
renderSavedRoomsList();
alert('この部屋はもう存在しません。一覧から削除しました。');
goHome(true);
}
else alert(res.error || '入室に失敗しました');
});
}

function leaveRoom() {
if (confirm('本当にこの部屋から退室しますか？')) {
socket.emit('leave_room', { roomId: currentRoomId, sessionId: userSessionId});
goHome(true);
}
}
function deleteRoom() {
if (isPublicRoom || currentRoomId === PUBLIC_ROOM_ID) return alert('公開ルームは削除できません');
if (confirm('本当にこの部屋を削除しますか？')) {
const idToRemove = currentRoomId;
socket.emit('delete_room', { roomId: currentRoomId}, function(res) {
if (res && res.success) { removeRoomFromStorage(idToRemove); alert('部屋を削除しました'); goHome(true);}
else alert((res && res.error) || '削除権限がありません');
});
}
}
function openKickModal() {
if (isPublicRoom || currentRoomId === PUBLIC_ROOM_ID) return;
socket.emit('get_members_for_kick', { roomId: currentRoomId});
document.getElementById('kick-modal').classList.add('active');
}
function closeKickModal() { document.getElementById('kick-modal').classList.remove('active');}
function confirmKick(sessionId, nickname) {
pendingKickSessionId = sessionId;
pendingKickNickname = nickname;
document.getElementById('kick-confirm-text').innerText = nickname + 'さんを退室させますか？';
closeKickModal();
document.getElementById('kick-confirm-modal').classList.add('active');
}
function closeKickConfirmModal() {
document.getElementById('kick-confirm-modal').classList.remove('active');
pendingKickSessionId = null;
pendingKickNickname = null;
}
document.getElementById('kick-confirm-btn').onclick = function() {
if (!pendingKickSessionId) return;
socket.emit('force_kick', { roomId: currentRoomId, targetSessionId: pendingKickSessionId}, function(res) {
closeKickConfirmModal();
if (!res ||!res.success) alert((res && res.error) || '退室させられませんでした');
});
};

function setupChatView(roomId, roomName, messages, maxMembers, imageDisplaySeconds, members) {
currentRoomId = roomId;
currentRoomName = roomName || roomId;
currentMaxMembers = maxMembers || 3;
currentImageDisplaySeconds = imageDisplaySeconds || 5;
noteActivity();
setRoomTitle(currentRoomName);
document.getElementById('header-copy-btn').style.display = (isPublicRoom || roomId === PUBLIC_ROOM_ID)? 'none': 'inline-flex';
document.getElementById('header-room-id-container').style.display = 'flex';
document.getElementById('display-time-control').style.display = 'flex';
const sel = document.getElementById('image-display-select');
if (sel) sel.value = String(currentImageDisplaySeconds);
document.getElementById('btn-delete-room').style.display = (isHost &&!isPublicRoom && roomId!== PUBLIC_ROOM_ID)? 'flex': 'none';
document.getElementById('btn-kick').style.display = (isHost &&!isPublicRoom && roomId!== PUBLIC_ROOM_ID)? 'flex': 'none';
if (Array.isArray(members)) updateMemberCount(members.length, currentMaxMembers, members);
if (!isPublicRoom && roomId!== PUBLIC_ROOM_ID) {
window.history.pushState({}, '', buildRoomUrl(currentRoomId, currentKey));
}
showView('view-chat');
const container = document.getElementById('chat-messages');
container.innerHTML = '';
(messages || []).forEach(function(msg) {
if (msg.type === 'system') renderSystemNotification(msg.text, msg.id);
else renderSingleMessage(msg, true);
});
}

/* Ver.2.2.0: 短縮リンク '/部屋ID#鍵'（旧 '?r=部屋ID&s=ランダム#k=鍵' から14文字短縮） */
function copyRoomLink() {
if (isPublicRoom || currentRoomId === PUBLIC_ROOM_ID) return;
const url = window.location.origin + buildRoomUrl(currentRoomId, currentKey);
navigator.clipboard.writeText(url).then(function() {
alert('ショートURLをコピーしました！');
}).catch(function() { prompt('このリンクをコピーしてください', url);});
}

function changeImageDisplayTime() {
const seconds = parseInt(document.getElementById('image-display-select').value, 10);
if (isNaN(seconds) || ![0, 1, 2, 3, 5, 10, 3600].includes(seconds)) return;
noteActivity();
socket.emit('change_image_display_time', { roomId: currentRoomId, seconds: seconds});
}
function startKeepAlive() {
stopKeepAlive();
if (!isHost) return;
lastChatActivityAt = Date.now();
keepAliveTimer = setInterval(function() {
if (!socket.connected ||!currentRoomId ||!isHost) return;
if (Date.now() - lastChatActivityAt >= 5 * 60 * 1000) {
socket.emit('keep_alive', { roomId: currentRoomId});
fetch('/api/ping').catch(function() {});
}
}, 60 * 1000);
}
function stopKeepAlive() { if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null;}}
function onFileSelected(input) {
if (input.files && input.files[0]) {
selectedFile = input.files[0];
const preview = document.getElementById('file-name-preview');
preview.innerText = '選択中: ' + selectedFile.name;
preview.style.display = 'block';
}
}
function handleTyping() {
if (!isTyping) { isTyping = true; socket.emit('typing_start', { roomId: currentRoomId});}
clearTimeout(typingTimeout);
typingTimeout = setTimeout(function() { stopTyping();}, 2000);
}
function stopTyping() {
if (isTyping) { isTyping = false; socket.emit('typing_stop', { roomId: currentRoomId});}
clearTimeout(typingTimeout);
}
function onKeyDown(e) {
const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
if (!isMobile && e.key === 'Enter' &&!e.shiftKey) { e.preventDefault(); sendMessage();}
}
async function sendMessage() {
const input = document.getElementById('msg-input');
const text = input.value.trim();
let imageUrl = null;
let thumbMidUrl = null;
let thumbBase64 = null;
if (!text &&!selectedFile) return;
if (!currentKey) return alert('暗号化鍵がありません');
stopTyping();
noteActivity();
let displaySeconds = currentImageDisplaySeconds;
if (text && selectedFile && currentImageDisplaySeconds!== 0) displaySeconds = 3600;
if (selectedFile) {
try { thumbBase64 = await createUltraLightThumbnail(selectedFile);} catch (e) {}
if (displaySeconds!== 0) {
const formData = new FormData();
formData.append('image', selectedFile);
try {
const res = await fetch('/api/upload', { method: 'POST', body: formData});
const data = await res.json();
imageUrl = data.imageUrl;
} catch (e) { alert('画像のアップロードに失敗しました'); return;}
/* 中サムネもファイルとして上げる。失敗しても送信自体は止めず原画表示にフォールバック */
try {
const midBlob = await createMidThumbnailBlob(selectedFile);
if (midBlob) {
const midForm = new FormData();
midForm.append('image', midBlob, 'thumb.jpg');
const midRes = await fetch('/api/upload', { method: 'POST', body: midForm });
const midData = await midRes.json();
if (midData && midData.imageUrl) thumbMidUrl = midData.imageUrl;
}
} catch (e) {}
}
}
socket.emit('send_message', {
msgId: Math.random().toString(36).substring(2, 10),
roomId: currentRoomId,
text: text? encryptText(text, currentKey): '',
image: imageUrl,
thumbMid: thumbMidUrl,
thumb: thumbBase64,
displaySeconds: displaySeconds
});
input.value = '';
selectedFile = null;
document.getElementById('file-input').value = '';
document.getElementById('file-name-preview').style.display = 'none';
}
function deleteMessage(msgId) { socket.emit('delete_message', { roomId: currentRoomId, msgId: msgId});}
const messageMeta = {};
/* Ver.2.2.0: 期限タイマーを取消可能にするための管理表（Ctrl+Shift切替で使う） */
const imageExpireTimers = {};
const imageExpireObservers = {};
function clearImageExpireTimer(msgId) {
if (imageExpireTimers[msgId]) { clearTimeout(imageExpireTimers[msgId]); delete imageExpireTimers[msgId];}
if (imageExpireObservers[msgId]) {
try { imageExpireObservers[msgId].disconnect();} catch (e) {}
delete imageExpireObservers[msgId];
}
}
function handleExpiredThumbClick(event, msgId) {
if (!(event.ctrlKey && event.shiftKey)) return;
event.preventDefault();
event.stopPropagation();
restoreImage(msgId);
}
function handleImageExpire(imgEl, msgId, thumbBase64) {
imgEl.style.display = 'none';
imgEl.dataset.expired = '1';
const meta = messageMeta[msgId];
if (meta) meta.expired = true;
if (thumbBase64) {
const thumbImg = document.createElement('img');
thumbImg.src = thumbBase64;
thumbImg.className = 'chat-img-poster-thumb';
thumbImg.dataset.role = 'expired-thumb';
thumbImg.style.cursor = (meta && meta.image &&!meta.thumbOnly)? 'pointer': 'default';
thumbImg.addEventListener('click', function(e) { handleExpiredThumbClick(e, msgId);});
imgEl.parentNode.appendChild(thumbImg);
const note = document.createElement('div');
note.className = 'poster-only-note';
note.dataset.role = 'expired-note';
note.innerText = '時間経過につき粗サムネのみ表示';
note.addEventListener('click', function(e) { handleExpiredThumbClick(e, msgId);});
imgEl.parentNode.appendChild(note);
scrollMessageFully(imgEl.parentNode);
return;
}
const note = document.createElement('div');
note.className = 'expired-img-note';
note.dataset.role = 'expired-note';
note.innerText = '🔒 画像の表示期限が切れました';
note.addEventListener('click', function(e) { handleExpiredThumbClick(e, msgId);});
imgEl.parentNode.appendChild(note);
}
/* Ver.2.2.0: 原画表示中を即座に粗サムネ化する */
/* Ver.2.3.5: 即時粗サムネ化も全員反映できるが、有効化できるのは投稿者だけ。
   他の人が操作した場合は従来通り自分の画面だけに効く (サーバーへは送らない)。 */
function expireImageNow(msgId, fromServer) {
const meta = messageMeta[msgId];
const imgEl = document.getElementById('img-' + msgId);
if (!meta ||!imgEl || imgEl.dataset.expired === '1') return;
clearImageExpireTimer(msgId);
handleImageExpire(imgEl, msgId, meta.thumb || null);
if (!fromServer && meta.senderSessionId && meta.senderSessionId === userSessionId) {
try { socket.emit('expire_image', { roomId: currentRoomId, msgId: msgId }); } catch (e) {}
}
}
/* Ver.2.2.0: 粗サムネ化した原画を復元する。
期限は「投稿から1時間まで」（サーバー削除と一致）。1時間経過後は復元不可。
0秒（粗サムネのみ・原画未アップロード）は対象外。
Ver.2.3.4: 本人の操作はサーバーへ通知し、部屋全員と後からの入室者にも反映する。
サーバーからの通知で復元する場合は再通知しない (fromServer=true)。 */
function restoreImage(msgId, fromServer) {
const meta = messageMeta[msgId];
if (!meta || meta.thumbOnly ||!meta.image) return;
if (Date.now() - (meta.postedAt || Date.now()) >= 3600 * 1000) return;
const container = document.getElementById('msg-' + msgId);
const imgEl = document.getElementById('img-' + msgId);
if (!container ||!imgEl) return;
container.querySelectorAll('[data-role="expired-thumb"], [data-role="expired-note"]').forEach(function(el) { el.remove();});
imgEl.style.display = '';
delete imgEl.dataset.expired;
meta.expired = false;
meta.displaySeconds = 3600;
startImageExpireTimer(imgEl, msgId, meta.thumb || null, 3600, meta.postedAt, true);
scrollMessageFully(container);
if (!fromServer && meta.senderSessionId && meta.senderSessionId === userSessionId) {
try { socket.emit('restore_image', { roomId: currentRoomId, msgId: msgId }); } catch (e) {}
}
}
function startImageExpireTimer(imgEl, msgId, thumbBase64, displaySec, postedAt, isHistory) {
if (!imgEl || displaySec <= 0) return;
clearImageExpireTimer(msgId);
const runExpire = function(delayMs) {
imageExpireTimers[msgId] = setTimeout(function() {
delete imageExpireTimers[msgId];
if (imgEl && imgEl.parentNode && imgEl.dataset.expired!== '1') handleImageExpire(imgEl, msgId, thumbBase64);
}, Math.max(0, delayMs));
};
if (isHistory) { runExpire(displaySec * 1000 - (Date.now() - (postedAt || Date.now()))); return;}
const startFromVisible = function() { runExpire(displaySec * 1000);};
const rect = imgEl.getBoundingClientRect();
if (rect.top < window.innerHeight && rect.bottom > 0) { startFromVisible(); return;}
if (!('IntersectionObserver' in window)) { startFromVisible(); return;}
const observer = new IntersectionObserver(function(entries) {
entries.forEach(function(entry) {
if (entry.isIntersecting) {
observer.disconnect();
delete imageExpireObservers[msgId];
startFromVisible();
}
});
}, { threshold: 0.2});
imageExpireObservers[msgId] = observer;
observer.observe(imgEl);
}
function formatSecondsLabel(sec) { return sec >= 3600? '1時間': (sec + '秒'); }
function renderSingleMessage(msg, isHistory) {
const container = document.getElementById('chat-messages');
if (document.getElementById('msg-' + msg.id)) return;
const div = document.createElement('div');
const isSelf = (msg.sessionId === userSessionId);
div.className = 'message ' + (isSelf? 'self': ('user-color-' + (msg.colorIndex || 0) % 4));
div.id = 'msg-' + msg.id;
const plainText = msg.text? decryptText(msg.text, currentKey): '';
const displaySec = (typeof msg.displaySeconds === 'number')? msg.displaySeconds: currentImageDisplaySeconds;
const originalDisplaySec = (typeof msg.originalDisplaySeconds === 'number')? msg.originalDisplaySeconds: displaySec;
const postedAt = msg.postedAt || Date.now();
if (msg.image || msg.thumb) {
messageMeta[msg.id] = { image: msg.image || null, thumbMid: msg.thumbMid || null, thumb: msg.thumb || null, displaySeconds: displaySec, postedAt: postedAt, senderSessionId: msg.sessionId || null, originalDisplaySeconds: originalDisplaySec, thumbOnly: displaySec === 0 ||!msg.image, expired: false};
}
let html = '';
const date = new Date(postedAt);
const pad2 = n => String(n).padStart(2, '0');
const timestamp = date.getFullYear() + '/' + pad2(date.getMonth() + 1) + '/' + pad2(date.getDate()) + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds());
html += '<div class="msg-head"><span class="sender">' + escapeHtml(msg.senderName) + '</span><span class="message-timestamp">(' + timestamp + ')</span>' + (isSelf? '<span class="del-btn" data-del="1">✕</span>': '') + '</div>';
if (plainText) html += '<div class="text-content">' + escapeHtml(plainText) + '</div>';
if (displaySec === 0 && msg.thumb) {
html += '<img src="' + msg.thumb + '" class="chat-img-poster-thumb" style="cursor:default;" oncontextmenu="return false;">';
html += '<div class="poster-only-note">粗サムネのみ表示</div>';
} else if (msg.image) {
/* Ver.2.3.3: インラインは中サムネ (無ければ原画)。原画はタップ時の viewer だけが読む */
html += '<span class="img-wrap"><img src="' + (msg.thumbMid || msg.image) + '" class="chat-img" id="img-' + msg.id + '" oncontextmenu="return false;">' + (originalDisplaySec > 0? '<span class="img-badge">⏱ ' + formatSecondsLabel(originalDisplaySec) + '表示</span>': '') + '</span>';
} else if (msg.thumb) {
html += '<img src="' + msg.thumb + '" class="chat-img-poster-thumb" style="cursor:default;" oncontextmenu="return false;">';
html += '<div class="poster-only-note">粗サムネのみ表示</div>';
}


div.innerHTML = html;
container.appendChild(div);
const delEl = div.querySelector('.del-btn'); if (delEl) delEl.addEventListener('click', function() { deleteMessage(msg.id);});
scrollMessageFully(div);
if (msg.image) {
const imgEl = document.getElementById('img-' + msg.id);
if (imgEl) {
/* Ver.2.3.0: 通常クリック=別タブの専用viewerで開く(同タブのモーダルはポップアップが塞がれた時だけの予備) / Ctrl+Shift+クリック=即座に粗サムネ化 */
imgEl.addEventListener('click', function(e) {
if (e.ctrlKey && e.shiftKey) {
e.preventDefault();
e.stopPropagation();
expireImageNow(msg.id);
} else {
openImageInNewTab(msg.id);
}
});
if (displaySec!== 0) startImageExpireTimer(imgEl, msg.id, msg.thumb || null, displaySec, postedAt,!!isHistory);
if (msg.forceExpired) expireImageNow(msg.id, true);
}
}
}
function renderSystemNotification(text, msgId) {
const container = document.getElementById('chat-messages');
if (msgId && document.getElementById('system-msg-' + msgId)) return;
const div = document.createElement('div');
div.className = 'system-notification';
if (msgId) div.id = 'system-msg-' + msgId;
div.innerText = text;
container.appendChild(div);
container.scrollTop = container.scrollHeight;
}
let imageModalTimer = null;
let imageModalOpenedAt = 0;
function showSoftToast(text) {
const el = document.getElementById('soft-toast');
if (!el) return;
el.textContent = text || '右クリックできません';
el.classList.add('show');
setTimeout(function() { el.classList.remove('show');}, 1000);
}
function openImageModal(msgId) {
const meta = messageMeta[msgId];
if (!meta || meta.thumbOnly || meta.displaySeconds === 0 ||!meta.image) return;
if (meta.expired) return;
const elapsed = Date.now() - (meta.postedAt || Date.now());
if (meta.displaySeconds < 3600 && elapsed > meta.displaySeconds * 1000 + 120000) return;
const modal = document.getElementById('image-modal');
const img = document.getElementById('image-modal-img');
const note = document.getElementById('image-modal-note');
if (imageModalTimer) { clearTimeout(imageModalTimer); imageModalTimer = null;}
imageModalOpenedAt = Date.now();
note.textContent = '';
img.src = meta.image;
img.style.imageRendering = 'auto';
if (meta.thumb && meta.displaySeconds < 3600) {
imageModalTimer = setTimeout(function() {
img.src = meta.thumb;
img.style.imageRendering = 'pixelated';
note.textContent = '時間経過につき粗サムネのみ表示';
}, Math.max(1000, meta.displaySeconds * 1000));
}
modal.classList.add('active');
}
function openImageInNewTab(msgId) {
const meta = messageMeta[msgId];
if (!meta || meta.thumbOnly || meta.displaySeconds === 0 ||!meta.image) return;
if (meta.expired) return;
const elapsed = Date.now() - (meta.postedAt || Date.now());
if (meta.displaySeconds < 3600 && elapsed > meta.displaySeconds * 1000 + 120000) return;
clientLog('image_open_new_tab', '');
const viewerUrl = '/viewer#i=' + encodeURIComponent(meta.image) + '&s=' + encodeURIComponent(String(meta.displaySeconds)) + '&t=' + encodeURIComponent(String(meta.postedAt || Date.now()));
const win = window.open(viewerUrl, '_blank');
if (!win) { openImageModal(msgId); showSoftToast('別タブを開けなかったため、このタブで表示しました'); }
}
function closeImageModal(event, force) {
if (event) {
if (!force && event.target && event.target.id === 'image-modal-img') return;
event.stopPropagation();
}
const shown = Date.now() - imageModalOpenedAt;
if (shown < 1000 &&!force) { setTimeout(function() { closeImageModal(null, true);}, 1000 - shown); return;}
const modal = document.getElementById('image-modal');
if (modal) modal.classList.remove('active');
if (imageModalTimer) { clearTimeout(imageModalTimer); imageModalTimer = null;}
}
document.addEventListener('contextmenu', function(e) {
const t = e.target;
if (t && (t.id === 'image-modal-img' || (t.classList && (t.classList.contains('chat-img') || t.classList.contains('chat-img-poster-thumb'))))) {
e.preventDefault();
showSoftToast('右クリックできません');
}
});
function escapeHtml(str) {
if (!str) return '';
return String(str).replace(/[&<>"']/g, function(m) {
return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[m];
});
}
</script>
</body>
</html>`;

const VIEWER_HTML = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>画像を表示中 - SimpleChatee</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
body { background: #000; color: #f8fafc; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: calc(12px + env(safe-area-inset-top)) 12px calc(12px + env(safe-area-inset-bottom)); }
img { max-width: 100vw; max-height: calc(100vh - 90px); object-fit: contain; user-select: none; -webkit-user-drag: none; -webkit-touch-callout: none; }
#note { color: #94a3b8; font-size: 0.8rem; margin-top: 10px; text-align: center; line-height: 1.5; }
#close-btn { margin-top: 14px; padding: 10px 22px; border: none; border-radius: 8px; background: #38bdf8; color: #0f172a; font-weight: bold; font-size: 0.9rem; cursor: pointer; }
</style>
</head>
<body>
<img id="viewer-img" alt="画像" oncontextmenu="return false;">
<div id="note">表示時間が過ぎると自動で消えます。このタブを閉じるとチャットに戻ります。</div>
<button type="button" id="close-btn" onclick="window.close()">タブを閉じる</button>
<script>
(function() {
function parseHash() {
var out = {};
var h = (window.location.hash || '').replace(/^#/, '');
h.split('&').forEach(function(pair) {
var idx = pair.indexOf('=');
if (idx > 0) out[pair.substring(0, idx)] = decodeURIComponent(pair.substring(idx + 1));
});
return out;
}
var p = parseHash();
var img = document.getElementById('viewer-img');
var note = document.getElementById('note');
var src = p.i || '';
if (!src || src.indexOf('/uploads/') !== 0) { note.textContent = '画像の指定が正しくありません。'; img.style.display = 'none'; return; }
img.src = src;
document.addEventListener('contextmenu', function(e) { e.preventDefault(); });
var seconds = parseInt(p.s || '5', 10);
var postedAt = parseInt(p.t || '0', 10) || Date.now();
if (!isNaN(seconds) && seconds > 0 && seconds < 3600) {
var remaining = seconds * 1000 - (Date.now() - postedAt);
var expire = function() {
img.remove();
note.textContent = '表示時間が過ぎたため、画像は表示できません。このタブを閉じてください。';
};
if (remaining <= 0) expire();
else setTimeout(expire, remaining);
}
})();
</script>
</body>
</html>`;

app.get('/', (req, res) => {
res.send(HTML_CONTENT);
});
app.get('/viewer', (req, res) => {
res.set('Cache-Control', 'no-store');
res.send(VIEWER_HTML);
});


/* Ver.2.2.0: 短縮リンク '/部屋ID' 形式でもページを返す（/api・/uploads・socket.io には当たらない6桁固定） */
app.get('/:roomId([a-z0-9]{6})', (req, res) => {
res.send(HTML_CONTENT);
});

function safeCallback(callback, payload) {
if (typeof callback === 'function') {
try { callback(payload);} catch (e) { console.error(e);}
}
}

io.on('connection', (socket) => {
const connectedAt = Date.now();
logEvent('connect', { socket: shortId(socket.id), transport: (socket.conn && socket.conn.transport)? socket.conn.transport.name: '-', recovered: !!socket.recovered });
if (socket.conn) socket.conn.on('upgrade', (transport) => { logEvent('transport_upgrade', { socket: shortId(socket.id), transport: transport.name }); });
socket.on('client_log', (data) => {
try {
const allowed = ['connect', 'disconnect', 'connect_error', 'reconnect_attempt', 'reconnect', 'visibility_hidden', 'visibility_visible', 'pagehide', 'pageshow', 'pull_refresh', 'image_open_new_tab', 'saved_room_pruned'];
const ev = data && allowed.includes(data.event)? data.event: null;
if (!ev) return;
logEvent('client_' + ev, { socket: shortId(socket.id), room: (data && data.roomId) || socket.data.roomId || '-', sid: shortId(socket.data.sessionId), detail: String((data && data.detail) || '').substring(0, 100) });
} catch (e) {}
});
function setSocketSession(roomId, sessionId) {
socket.data.roomId = roomId;
socket.data.sessionId = sessionId;
}
function emitMemberCount(roomId) { emitMemberCountGlobal(roomId); }
function syncRoomToSocket(targetSocket, roomId) {
const room = rooms[roomId];
if (!room) return;
const active = getActiveMembers(room);
const syncMessages = recentMessages(room);
let syncBytes = 0;
try { syncBytes = JSON.stringify(syncMessages).length; } catch (e) {}
logEvent('room_state_sync', { room: roomId, sid: shortId(targetSocket.data.sessionId), messages: syncMessages.length, totalMessages: room.messages.length, bytes: syncBytes });
targetSocket.emit('room_state_sync', {
roomId: roomId, roomName: room.name, count: active.length, maxMembers: room.maxMembers,
members: active.map(m => m.nickname), imageDisplaySeconds: room.imageDisplaySeconds, messages: syncMessages
});
}
socket.on('keep_alive', () => {});

socket.on('get_room_info', ({ roomId}, callback) => {
const room = rooms[roomId];
if (!room) return safeCallback(callback, { exists: false, waitingMsg: ''});
safeCallback(callback, { exists: true, waitingMsg: room.waitingMsg || ''});
});

socket.on('rejoin_room', ({ roomId, sessionId, nickname}) => {
ensurePublicRoom();
const room = rooms[roomId];
if (!room) { logEvent('rejoin_room_not_found', { room: roomId, sid: shortId(sessionId) }); socket.emit('room_not_found', { roomId: roomId }); return; }
const beforeCount = getActiveMembers(room).length;
const beforeNames = getMemberNames(room).join('|');
cancelPendingOffline(roomId, sessionId);
socket.join(roomId);
setSocketSession(roomId, sessionId);
let member = room.members.find(m => m.sessionId === sessionId);
const wasAway = !!(member && member.awaySince);
if (member) {
member.id = socket.id;
member.awaySince = null;
member.explicitlyLeft = false;
if (nickname) member.nickname = nickname;
logEvent('rejoin_room', { room: roomId, sid: shortId(sessionId), kind: wasAway? 'return_from_away': 'existing', count: getActiveMembers(room).length });
} else {
const active = getActiveMembers(room);
const isRegisteredMember = room.joinedSessionIds && room.joinedSessionIds.includes(sessionId);
if (active.length < room.maxMembers || isRegisteredMember) {
if (!room.joinedSessionIds.includes(sessionId)) room.joinedSessionIds.push(sessionId);
room.members.push({ id: socket.id, sessionId, nickname: nickname || 'ゲスト', colorIndex: room.members.length % 4, awaySince: null, explicitlyLeft: false});
logEvent('rejoin_room', { room: roomId, sid: shortId(sessionId), kind: 'new_member', count: getActiveMembers(room).length });
} else {
logEvent('rejoin_room_full', { room: roomId, sid: shortId(sessionId), count: active.length });
socket.emit('room_full_rejected');
return;
}
}
room.lastActivityAt = Date.now();
syncRoomToSocket(socket, roomId);
if (beforeCount !== getActiveMembers(room).length || beforeNames !== getMemberNames(room).join('|')) emitMemberCount(roomId);
});

socket.on('create_room', (data, callback) => {
try {
const { name, waitingMsg, nickname, sessionId, maxMembers} = data || {};
if (!name || typeof name!== 'string') {
return safeCallback(callback, { success: false, error: '部屋名が不正です'});
}
const roomName = name.trim().substring(0, 30);
const wMsg = (waitingMsg || '').trim().substring(0, 50);
if (!roomName) {
return safeCallback(callback, { success: false, error: '部屋名を入力してください'});
}
if (roomName === PUBLIC_ROOM_NAME || roomName.toLowerCase() === 'public') {
return safeCallback(callback, { success: false, error: 'この部屋名は使用できません'});
}
if (roomNameToId[roomName]) {
return safeCallback(callback, { success: false, error: 'この部屋名は既に使われています。'});
}
const safeMax = [3, 4, 5].includes(maxMembers)? maxMembers: 3;
const roomId = generateRoomId();
const nick = nickname || '部屋主';
const initialSystemMsg = { type: 'system', id: 'system-' + Math.random().toString(36).substring(2, 10), text: nick + ' が入室しました'};
rooms[roomId] = {
id: roomId,
name: roomName,
waitingMsg: wMsg,
hostSessionId: sessionId,
maxMembers: safeMax,
imageDisplaySeconds: 5,
members: [{ id: socket.id, sessionId, nickname: nick, colorIndex: 0}],
joinedSessionIds: [sessionId],
messages: [initialSystemMsg],
lastActivityAt: Date.now()
};
roomNameToId[roomName] = roomId;
logEvent('create_room', { room: roomId, sid: shortId(sessionId) });
socket.join(roomId);
setSocketSession(roomId, sessionId);
safeCallback(callback, {
success: true, roomId, roomName, messages: [initialSystemMsg], isHost: true,
maxMembers: safeMax, imageDisplaySeconds: 5, memberCount: 1, members: [nick]
});
emitMemberCount(roomId);
} catch (err) {
safeCallback(callback, { success: false, error: '部屋の作成中にエラーが発生しました'});
}
});

socket.on('join_room', ({ roomId, roomName, nickname, sessionId}, callback) => {
try {
ensurePublicRoom();
const id = resolveRoomId(roomId, roomName);
const room = id? rooms[id]: null;
if (!room) return safeCallback(callback, { success: false, exists: false, error: '部屋が存在しません。'});

const existingMember = room.members.find(m => m.sessionId === sessionId);
const activeMembers = getActiveMembers(room);
const isRegistered = room.joinedSessionIds && room.joinedSessionIds.includes(sessionId);

/* Ver.2.2.0: 旧実装に同一条件の満員チェックが二重にあり2つ目が到達不能だったため1つに統合 */
if (!existingMember &&!isRegistered && activeMembers.length >= room.maxMembers) {
socket.emit('room_full_rejected');
return safeCallback(callback, { success: false, full: true, error: '現在満員です'});
}

const wasExplicitlyLeft = !!(existingMember && existingMember.explicitlyLeft);
const isReturning = !!existingMember || !!isRegistered;
cancelPendingOffline(id, sessionId);
if (!room.joinedSessionIds.includes(sessionId)) {
room.joinedSessionIds.push(sessionId);
}

if (!existingMember) {
room.members.push({ id: socket.id, sessionId, nickname: nickname || 'ゲスト', colorIndex: room.members.length % 4, awaySince: null, explicitlyLeft: false});
} else {
existingMember.id = socket.id;
existingMember.awaySince = null;
existingMember.explicitlyLeft = false;
existingMember.nickname = nickname || existingMember.nickname;
}
room.lastActivityAt = Date.now();
socket.join(id);
setSocketSession(id, sessionId);
logEvent('join_room', { room: id, sid: shortId(sessionId), kind: isReturning? (wasExplicitlyLeft? 'return_after_leave': 'returning'): 'new', count: getActiveMembers(room).length });
/* Ver.2.3.0: 入室通知は新規入室と明示退室後の復帰だけ。単なる再接続/再読み込みの復帰では出さない */
const shouldAnnounce = !isReturning || wasExplicitlyLeft;
let systemMsg = null;
if (shouldAnnounce) {
systemMsg = { type: 'system', id: 'system-' + Math.random().toString(36).substring(2, 10), text: (nickname || 'ゲスト') + ' が入室しました'};
room.messages.push(systemMsg);
if (room.isPublic && room.messages.length > 100) {
room.messages = room.messages.slice(-80);
}
trimPrivateHistory(room);
}
safeCallback(callback, {
success: true, roomId: id, roomName: room.name, messages: recentMessages(room), isHost: room.hostSessionId === sessionId,
maxMembers: room.maxMembers, imageDisplaySeconds: room.imageDisplaySeconds,
memberCount: getActiveMembers(room).length, members: getMemberNames(room)
});
setTimeout(() => { if (rooms[id]) { if (systemMsg) io.to(id).emit('receive_message', systemMsg); emitMemberCount(id);}}, 0);
} catch (err) {
safeCallback(callback, { success: false, error: '入室中にエラーが発生しました'});
}
});

socket.on('leave_room', ({ roomId, sessionId}) => {
const targetId = roomId || socket.data.roomId;
const room = rooms[targetId];
if (!room) return;
const sid = sessionId || socket.data.sessionId;
const member = room.members.find(m => m.sessionId === sid || m.id === socket.id);
if (!member) return;
cancelPendingOffline(targetId, member.sessionId);
member.id = null;
member.awaySince = null;
member.explicitlyLeft = true;
logEvent('leave_room', { room: targetId, sid: shortId(member.sessionId) });
room.lastActivityAt = Date.now();
const systemMsg = { type: 'system', id: 'system-' + Math.random().toString(36).substring(2, 10), text: member.nickname + ' が退室しました'};
room.messages.push(systemMsg);
io.to(targetId).emit('receive_message', systemMsg);
emitMemberCount(targetId);
socket.leave(targetId);
socket.data.roomId = null;
});

socket.on('delete_room', ({ roomId}, callback) => {
const targetId = roomId || socket.data.roomId;
if (targetId === PUBLIC_ROOM_ID) return safeCallback(callback, { success: false, error: '公開ルームは削除できません'});
const room = rooms[targetId];
if (!room) return safeCallback(callback, { success: false, error: '部屋が存在しません'});
if (room.hostSessionId!== socket.data.sessionId) return safeCallback(callback, { success: false, error: '権限がありません'});
(room.members || []).forEach(m => cancelPendingOffline(targetId, m.sessionId));
logEvent('delete_room', { room: targetId, sid: shortId(socket.data.sessionId) });
room.messages.forEach(msg => {
if (msg.image) {
const filePath = path.join(uploadDir, path.basename(msg.image));
if (fs.existsSync(filePath)) fs.unlink(filePath, () => {});
}
if (msg.thumbMid) {
const thumbPath = path.join(uploadDir, path.basename(msg.thumbMid));
if (fs.existsSync(thumbPath)) fs.unlink(thumbPath, () => {});
}
});
if (room.name && roomNameToId[room.name] === targetId) delete roomNameToId[room.name];
io.to(targetId).emit('room_deleted_by_host');
delete rooms[targetId];
safeCallback(callback, { success: true});
});

socket.on('get_members_for_kick', ({ roomId}) => {
if (roomId === PUBLIC_ROOM_ID) return;
const room = rooms[roomId];
if (!room || room.hostSessionId!== socket.data.sessionId) return;
socket.emit('members_for_kick', { members: room.members.filter(m => m.id!== null && m.sessionId!== socket.data.sessionId).map(m => ({ sessionId: m.sessionId, nickname: m.nickname}))});
});

socket.on('force_kick', ({ roomId, targetSessionId}, callback) => {
if (roomId === PUBLIC_ROOM_ID) return safeCallback(callback, { success: false, error: '公開ルームでは強制退室できません'});
const room = rooms[roomId];
if (!room) return safeCallback(callback, { success: false, error: '部屋が存在しません'});
if (room.hostSessionId!== socket.data.sessionId) return safeCallback(callback, { success: false, error: '権限がありません'});
if (targetSessionId === room.hostSessionId) return safeCallback(callback, { success: false, error: '自分自身は退室させられません'});
const target = room.members.find(m => m.sessionId === targetSessionId);
if (!target) return safeCallback(callback, { success: false, error: '対象のメンバーが見つかりません'});

cancelPendingOffline(roomId, targetSessionId);
room.joinedSessionIds = (room.joinedSessionIds || []).filter(s => s !== targetSessionId);
target.awaySince = null;
logEvent('force_kick', { room: roomId, sid: shortId(socket.data.sessionId), target: shortId(targetSessionId) });
if (target.id) {
const targetSocket = io.sockets.sockets.get(target.id);
if (targetSocket) {
targetSocket.emit('force_left');
targetSocket.leave(roomId);
targetSocket.data.roomId = null;
}
}
target.id = null;
emitMemberCount(roomId);
safeCallback(callback, { success: true});
});

socket.on('change_image_display_time', ({ roomId, seconds}) => {
const room = rooms[roomId];
if (!room || ![0, 1, 2, 3, 5, 10, 3600].includes(seconds)) return;
room.imageDisplaySeconds = seconds;
room.lastActivityAt = Date.now();
let label = seconds + '秒';
if (seconds === 0) label = '粗サムネのみ';
else if (seconds === 3600) label = '1時間';
const systemMsg = { type: 'system', id: 'system-' + Math.random().toString(36).substring(2, 10), text: '画像表示時間が' + label + 'に切り替わりました'};
room.messages.push(systemMsg);
io.to(roomId).emit('image_display_changed', { seconds: seconds, text: systemMsg.text, id: systemMsg.id});
});

socket.on('typing_start', ({ roomId}) => {
const targetId = roomId || socket.data.roomId;
const room = rooms[targetId];
if (!room) return;
const sender = room.members.find(m => m.id === socket.id);
if (sender) socket.to(targetId).emit('display_typing', { nickname: sender.nickname, isTyping: true});
});
socket.on('typing_stop', ({ roomId}) => {
socket.to(roomId || socket.data.roomId).emit('display_typing', { isTyping: false});
});

socket.on('send_message', ({ msgId, roomId, text, image, thumb, thumbMid, displaySeconds}) => {
const targetId = roomId || socket.data.roomId;
const room = rooms[targetId];
if (!room) return;
const sessionId = socket.data.sessionId;
let sender = room.members.find(m => m.sessionId === sessionId || m.id === socket.id);
if (sender) { cancelPendingOffline(targetId, sender.sessionId); sender.awaySince = null; sender.id = socket.id; socket.join(targetId); setSocketSession(targetId, sessionId);}
room.lastActivityAt = Date.now();
const ds = typeof displaySeconds === 'number'? displaySeconds: room.imageDisplaySeconds;
const safeThumbMid = (typeof thumbMid === 'string' && /^\/uploads\/[A-Za-z0-9._-]+$/.test(thumbMid))? thumbMid: null;
const messageData = {
type: 'user', id: msgId || Math.random().toString(36).substring(2, 10), sessionId: sessionId,
senderName: sender? sender.nickname: '匿名', colorIndex: sender? sender.colorIndex: 0,
text, image: image || null, thumbMid: safeThumbMid, thumb: thumb || null, displaySeconds: ds, originalDisplaySeconds: ds, postedAt: Date.now()
};
if (image) scheduleImageDelete(image, ds);
if (safeThumbMid) scheduleImageDelete(safeThumbMid, ds);
room.messages.push(messageData);
if (room.isPublic && room.messages.length > 100) {
room.messages = room.messages.slice(-80);
}
trimPrivateHistory(room);
io.to(targetId).emit('receive_message', messageData);
});

socket.on('restore_image', ({ roomId, msgId}) => {
const targetId = roomId || socket.data.roomId;
const room = rooms[targetId];
if (!room) return;
const member = room.members.find(m => m.sessionId === socket.data.sessionId || m.id === socket.id);
if (!member) return;
const targetMsg = room.messages.find(m => m.id === msgId);
if (!targetMsg || !targetMsg.image) return;
if (targetMsg.displaySeconds === 0) return;
if (Date.now() - (targetMsg.postedAt || Date.now()) >= 3600 * 1000) return;
/* Ver.2.3.5: 全員への反映を有効化できるのは投稿者だけ */
if (targetMsg.sessionId !== socket.data.sessionId) { logEvent('image_restore_denied_not_sender', { room: targetId, sid: shortId(socket.data.sessionId), msg: msgId }); return; }
if (targetMsg.displaySeconds === 3600 && !targetMsg.forceExpired) return;
if (Date.now() - (targetMsg.lastToggleAt || 0) < 1000) { logEvent('image_toggle_rate_limited', { room: targetId, sid: shortId(socket.data.sessionId), msg: msgId }); return; }
targetMsg.lastToggleAt = Date.now();
targetMsg.displaySeconds = 3600;
targetMsg.forceExpired = false;
targetMsg.restoredAt = Date.now();
logEvent('image_restored', { room: targetId, sid: shortId(socket.data.sessionId), msg: msgId });
io.to(targetId).emit('image_restored', { msgId: msgId, displaySeconds: 3600, restoredAt: targetMsg.restoredAt });
});

socket.on('expire_image', ({ roomId, msgId}) => {
const targetId = roomId || socket.data.roomId;
const room = rooms[targetId];
if (!room) return;
const member = room.members.find(m => m.sessionId === socket.data.sessionId || m.id === socket.id);
if (!member) return;
const targetMsg = room.messages.find(m => m.id === msgId);
if (!targetMsg || !targetMsg.image) return;
if (targetMsg.displaySeconds === 0) return;
/* Ver.2.3.5: 全員への即時粗サムネ化も投稿者だけ */
if (targetMsg.sessionId !== socket.data.sessionId) { logEvent('image_expire_denied_not_sender', { room: targetId, sid: shortId(socket.data.sessionId), msg: msgId }); return; }
if (targetMsg.forceExpired) return;
if (Date.now() - (targetMsg.lastToggleAt || 0) < 1000) { logEvent('image_toggle_rate_limited', { room: targetId, sid: shortId(socket.data.sessionId), msg: msgId }); return; }
targetMsg.lastToggleAt = Date.now();
targetMsg.forceExpired = true;
targetMsg.forceExpiredAt = Date.now();
logEvent('image_expired_now', { room: targetId, sid: shortId(socket.data.sessionId), msg: msgId });
io.to(targetId).emit('image_expired_now', { msgId: msgId, forceExpiredAt: targetMsg.forceExpiredAt });
});

socket.on('delete_message', ({ roomId, msgId}) => {
const targetId = roomId || socket.data.roomId;
const room = rooms[targetId];
if (!room) return;
const targetMsg = room.messages.find(m => m.id === msgId);
if (targetMsg && targetMsg.sessionId === socket.data.sessionId) {
room.messages = room.messages.filter(m => m.id!== msgId);
io.to(targetId).emit('message_deleted', { msgId});
}
});

socket.on('disconnect', (reason) => {
const roomId = socket.data.roomId;
const sessionId = socket.data.sessionId;
logEvent('disconnect', { socket: shortId(socket.id), room: roomId || '-', sid: shortId(sessionId), reason: reason, durationMs: Date.now() - connectedAt, recovered: !!socket.recovered });
if (!roomId || !rooms[roomId]) return;
const room = rooms[roomId];
const member = room.members.find(m => m.id === socket.id);
if (!member) { logEvent('disconnect_stale_socket', { room: roomId, sid: shortId(sessionId) }); return; }
/* Ver.2.3.0: 即退室にせず90秒の復帰猶予に入る。この間は人数も名前も変わらない */
member.awaySince = Date.now();
scheduleMemberOffline(roomId, member.sessionId, socket.id);
logEvent('member_away_grace_started', { room: roomId, sid: shortId(member.sessionId), reason: reason, graceSec: DISCONNECT_GRACE_MS / 1000, count: getActiveMembers(room).length });
});
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log('Server running on port ' + PORT);});
