const Express = require('express');
const http = require('http');
const { Server} = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const nodeCrypto = require('crypto');

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
/* Ver.2.3.9: サーバー短縮リンク。code -> { roomId, key } をメモリに保持する。
   鍵はユーザーの選択によりサーバーを経由する。ログには絶対に鍵を出さないこと。
   部屋が消えればリンクも消える (purgeShortLinksForRoom)。 */
const shortLinks = {};
const shortLinkByRoomKey = {};
function generateShortCode() {
const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
let c;
do {
const bytes = nodeCrypto.randomBytes(8);
c = '';
for (let i = 0; i < 8; i++) c += chars[bytes[i] % chars.length];
} while (shortLinks[c]);
return c;
}
function purgeShortLinksForRoom(roomId) {
for (const code of Object.keys(shortLinks)) {
if (shortLinks[code].roomId === roomId) {
delete shortLinkByRoomKey[roomId + '\n' + shortLinks[code].key];
delete shortLinks[code];
}
}
}
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
imageDisplaySeconds: 5, thumbQuality: 0.8,
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
purgeShortLinksForRoom(roomId);
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
.version-tag { font-size: 0.58rem; color: #64748b; flex-shrink: 0; margin-left: auto; cursor: pointer;}
#qr-panel { position: fixed; right: 10px; z-index: 9000; background: #f8fafc; padding: 12px 12px 10px; border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,0.45); text-align: center; width: 204px;}
#qr-panel svg { width: 180px; height: 180px; display: block;}
#qr-close { position: absolute; top: 4px; right: 6px; width: auto; margin: 0; padding: 2px 7px; background: transparent; border: none; color: #475569; font-size: 0.85rem; cursor: pointer;}
#qr-caption { color: #0f172a; font-size: 0.78rem; font-weight: bold; margin-top: 6px;}
#qr-url { color: #64748b; font-size: 0.58rem; word-break: break-all; margin-top: 2px; line-height: 1.3;}
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
#recent-strip { display: none; gap: 6px; padding: 6px 8px; background: var(--card-bg); border-bottom: 1px solid var(--border-color); overflow: hidden; align-items: center; flex-shrink: 0;}
#recent-strip.show { display: flex;}
.strip-item { flex: 0 0 calc((100% - 24px) / 5); aspect-ratio: 54 / 40; border-radius: 6px; overflow: hidden; cursor: pointer; transition: flex 0.25s ease, max-width 0.25s ease, opacity 0.25s ease, margin-right 0.25s ease;}
.strip-item img { width: 100%; height: 100%; object-fit: cover; display: block;}
.strip-item.leaving { flex: 0 0 0; max-width: 0; opacity: 0; margin-right: -6px;}
.strip-item.enter { animation: stripIn 0.25s ease;}
@keyframes stripIn { from { transform: translateX(14px); opacity: 0;} to { transform: none; opacity: 1;}}
.strip-lock { display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; background: #1e293b; font-size: 1rem;}
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
.chat-img-poster-thumb { width: auto; height: 200px; max-width: 100%; border-radius: 6px; margin-top: 6px; image-rendering: pixelated; border: 1px dashed #94a3b8; opacity: 0.85; display: block;}
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
.security-disclaimer { font-size: 0.92rem; color: var(--text-muted); line-height: 1.45; margin-top: 2px; padding: 0 2px;}
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
#view-chat.drag-over { box-shadow: inset 0 0 0 2px var(--accent-color); }
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
<span class="version-tag" id="version-tag" onclick="toggleRoomQr()">Ver. 2.3.25</span>
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
<div id="qr-panel" style="display:none;">
<button type="button" id="qr-close" onclick="closeRoomQr()">✕</button>
<div id="qr-code"></div>
<div id="qr-caption">部屋の招待QR</div>
<div id="qr-url"></div>
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
<div id="recent-strip"></div>
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
<span>粗サムネ品質</span>
<select id="thumb-quality-select" onchange="changeThumbQuality()">
<option value="0.3">0.3</option>
<option value="0.4">0.4</option>
<option value="0.5">0.5</option>
<option value="0.6">0.6</option>
<option value="0.7">0.7</option>
<option value="0.8">0.8</option>
<option value="0.9">0.9</option>
<option value="1">1.0</option>
</select>
</div>
<div class="input-row">
<label class="file-btn">📷<input type="file" id="file-input" accept="image/*" style="display:none;" onchange="onFileSelected(this)"></label>
<textarea id="msg-input" placeholder="メッセージを入力..." oninput="handleTyping()" onkeydown="onKeyDown(event)"></textarea>
<button type="button" onclick="sendMessage()">送<br>信</button>
</div>
<div class="security-disclaimer">🕒指定の時間を過ぎたら自動でモザイクが入ります。<br>🔒 チャット内容はE2E暗号化により管理者も閲覧不可です。<br>🔒画像は表示時間経過後にサーバーからも安全に削除されます。</div>
</div>
</div>
</div>
<script src="/socket.io/socket.io.js"></script>
<script>
/**
 * Minified by jsDelivr using Terser v5.37.0.
 * Original file: /npm/qrcode-generator@1.4.4/qrcode.js
 *
 * Do NOT use SRI with dynamically generated files! More information: https://www.jsdelivr.com/using-sri-with-dynamic-files
 */
var qrcode=function(){var t=function(t,r){var e=t,n=g[r],o=null,i=0,a=null,u=[],f={},c=function(t,r){o=function(t){for(var r=new Array(t),e=0;e<t;e+=1){r[e]=new Array(t);for(var n=0;n<t;n+=1)r[e][n]=null}return r}(i=4*e+17),l(0,0),l(i-7,0),l(0,i-7),s(),h(),d(t,r),e>=7&&v(t),null==a&&(a=p(e,n,u)),w(a,r)},l=function(t,r){for(var e=-1;e<=7;e+=1)if(!(t+e<=-1||i<=t+e))for(var n=-1;n<=7;n+=1)r+n<=-1||i<=r+n||(o[t+e][r+n]=0<=e&&e<=6&&(0==n||6==n)||0<=n&&n<=6&&(0==e||6==e)||2<=e&&e<=4&&2<=n&&n<=4)},h=function(){for(var t=8;t<i-8;t+=1)null==o[t][6]&&(o[t][6]=t%2==0);for(var r=8;r<i-8;r+=1)null==o[6][r]&&(o[6][r]=r%2==0)},s=function(){for(var t=B.getPatternPosition(e),r=0;r<t.length;r+=1)for(var n=0;n<t.length;n+=1){var i=t[r],a=t[n];if(null==o[i][a])for(var u=-2;u<=2;u+=1)for(var f=-2;f<=2;f+=1)o[i+u][a+f]=-2==u||2==u||-2==f||2==f||0==u&&0==f}},v=function(t){for(var r=B.getBCHTypeNumber(e),n=0;n<18;n+=1){var a=!t&&1==(r>>n&1);o[Math.floor(n/3)][n%3+i-8-3]=a}for(n=0;n<18;n+=1){a=!t&&1==(r>>n&1);o[n%3+i-8-3][Math.floor(n/3)]=a}},d=function(t,r){for(var e=n<<3|r,a=B.getBCHTypeInfo(e),u=0;u<15;u+=1){var f=!t&&1==(a>>u&1);u<6?o[u][8]=f:u<8?o[u+1][8]=f:o[i-15+u][8]=f}for(u=0;u<15;u+=1){f=!t&&1==(a>>u&1);u<8?o[8][i-u-1]=f:u<9?o[8][15-u-1+1]=f:o[8][15-u-1]=f}o[i-8][8]=!t},w=function(t,r){for(var e=-1,n=i-1,a=7,u=0,f=B.getMaskFunction(r),c=i-1;c>0;c-=2)for(6==c&&(c-=1);;){for(var g=0;g<2;g+=1)if(null==o[n][c-g]){var l=!1;u<t.length&&(l=1==(t[u]>>>a&1)),f(n,c-g)&&(l=!l),o[n][c-g]=l,-1==(a-=1)&&(u+=1,a=7)}if((n+=e)<0||i<=n){n-=e,e=-e;break}}},p=function(t,r,e){for(var n=A.getRSBlocks(t,r),o=b(),i=0;i<e.length;i+=1){var a=e[i];o.put(a.getMode(),4),o.put(a.getLength(),B.getLengthInBits(a.getMode(),t)),a.write(o)}var u=0;for(i=0;i<n.length;i+=1)u+=n[i].dataCount;if(o.getLengthInBits()>8*u)throw"code length overflow. ("+o.getLengthInBits()+">"+8*u+")";for(o.getLengthInBits()+4<=8*u&&o.put(0,4);o.getLengthInBits()%8!=0;)o.putBit(!1);for(;!(o.getLengthInBits()>=8*u||(o.put(236,8),o.getLengthInBits()>=8*u));)o.put(17,8);return function(t,r){for(var e=0,n=0,o=0,i=new Array(r.length),a=new Array(r.length),u=0;u<r.length;u+=1){var f=r[u].dataCount,c=r[u].totalCount-f;n=Math.max(n,f),o=Math.max(o,c),i[u]=new Array(f);for(var g=0;g<i[u].length;g+=1)i[u][g]=255&t.getBuffer()[g+e];e+=f;var l=B.getErrorCorrectPolynomial(c),h=k(i[u],l.getLength()-1).mod(l);for(a[u]=new Array(l.getLength()-1),g=0;g<a[u].length;g+=1){var s=g+h.getLength()-a[u].length;a[u][g]=s>=0?h.getAt(s):0}}var v=0;for(g=0;g<r.length;g+=1)v+=r[g].totalCount;var d=new Array(v),w=0;for(g=0;g<n;g+=1)for(u=0;u<r.length;u+=1)g<i[u].length&&(d[w]=i[u][g],w+=1);for(g=0;g<o;g+=1)for(u=0;u<r.length;u+=1)g<a[u].length&&(d[w]=a[u][g],w+=1);return d}(o,n)};f.addData=function(t,r){var e=null;switch(r=r||"Byte"){case"Numeric":e=M(t);break;case"Alphanumeric":e=x(t);break;case"Byte":e=m(t);break;case"Kanji":e=L(t);break;default:throw"mode:"+r}u.push(e),a=null},f.isDark=function(t,r){if(t<0||i<=t||r<0||i<=r)throw t+","+r;return o[t][r]},f.getModuleCount=function(){return i},f.make=function(){if(e<1){for(var t=1;t<40;t++){for(var r=A.getRSBlocks(t,n),o=b(),i=0;i<u.length;i++){var a=u[i];o.put(a.getMode(),4),o.put(a.getLength(),B.getLengthInBits(a.getMode(),t)),a.write(o)}var g=0;for(i=0;i<r.length;i++)g+=r[i].dataCount;if(o.getLengthInBits()<=8*g)break}e=t}c(!1,function(){for(var t=0,r=0,e=0;e<8;e+=1){c(!0,e);var n=B.getLostPoint(f);(0==e||t>n)&&(t=n,r=e)}return r}())},f.createTableTag=function(t,r){t=t||2;var e="";e+='<table style="',e+=" border-width: 0px; border-style: none;",e+=" border-collapse: collapse;",e+=" padding: 0px; margin: "+(r=void 0===r?4*t:r)+"px;",e+='">',e+="<tbody>";for(var n=0;n<f.getModuleCount();n+=1){e+="<tr>";for(var o=0;o<f.getModuleCount();o+=1)e+='<td style="',e+=" border-width: 0px; border-style: none;",e+=" border-collapse: collapse;",e+=" padding: 0px; margin: 0px;",e+=" width: "+t+"px;",e+=" height: "+t+"px;",e+=" background-color: ",e+=f.isDark(n,o)?"#000000":"#ffffff",e+=";",e+='"/>';e+="</tr>"}return e+="</tbody>",e+="</table>"},f.createSvgTag=function(t,r,e,n){var o={};"object"==typeof arguments[0]&&(t=(o=arguments[0]).cellSize,r=o.margin,e=o.alt,n=o.title),t=t||2,r=void 0===r?4*t:r,(e="string"==typeof e?{text:e}:e||{}).text=e.text||null,e.id=e.text?e.id||"qrcode-description":null,(n="string"==typeof n?{text:n}:n||{}).text=n.text||null,n.id=n.text?n.id||"qrcode-title":null;var i,a,u,c,g=f.getModuleCount()*t+2*r,l="";for(c="l"+t+",0 0,"+t+" -"+t+",0 0,-"+t+"z ",l+='<svg version="1.1" xmlns="http://www.w3.org/2000/svg"',l+=o.scalable?"":' width="'+g+'px" height="'+g+'px"',l+=' viewBox="0 0 '+g+" "+g+'" ',l+=' preserveAspectRatio="xMinYMin meet"',l+=n.text||e.text?' role="img" aria-labelledby="'+y([n.id,e.id].join(" ").trim())+'"':"",l+=">",l+=n.text?'<title id="'+y(n.id)+'">'+y(n.text)+"</title>":"",l+=e.text?'<description id="'+y(e.id)+'">'+y(e.text)+"</description>":"",l+='<rect width="100%" height="100%" fill="white" cx="0" cy="0"/>',l+='<path d="',a=0;a<f.getModuleCount();a+=1)for(u=a*t+r,i=0;i<f.getModuleCount();i+=1)f.isDark(a,i)&&(l+="M"+(i*t+r)+","+u+c);return l+='" stroke="transparent" fill="black"/>',l+="</svg>"},f.createDataURL=function(t,r){t=t||2,r=void 0===r?4*t:r;var e=f.getModuleCount()*t+2*r,n=r,o=e-r;return I(e,e,(function(r,e){if(n<=r&&r<o&&n<=e&&e<o){var i=Math.floor((r-n)/t),a=Math.floor((e-n)/t);return f.isDark(a,i)?0:1}return 1}))},f.createImgTag=function(t,r,e){t=t||2,r=void 0===r?4*t:r;var n=f.getModuleCount()*t+2*r,o="";return o+="<img",o+=' src="',o+=f.createDataURL(t,r),o+='"',o+=' width="',o+=n,o+='"',o+=' height="',o+=n,o+='"',e&&(o+=' alt="',o+=y(e),o+='"'),o+="/>"};var y=function(t){for(var r="",e=0;e<t.length;e+=1){var n=t.charAt(e);switch(n){case"<":r+="&lt;";break;case">":r+="&gt;";break;case"&":r+="&amp;";break;case'"':r+="&quot;";break;default:r+=n}}return r};return f.createASCII=function(t,r){if((t=t||1)<2)return function(t){t=void 0===t?2:t;var r,e,n,o,i,a=1*f.getModuleCount()+2*t,u=t,c=a-t,g={"██":"█","█ ":"▀"," █":"▄","  ":" "},l={"██":"▀","█ ":"▀"," █":" ","  ":" "},h="";for(r=0;r<a;r+=2){for(n=Math.floor((r-u)/1),o=Math.floor((r+1-u)/1),e=0;e<a;e+=1)i="█",u<=e&&e<c&&u<=r&&r<c&&f.isDark(n,Math.floor((e-u)/1))&&(i=" "),u<=e&&e<c&&u<=r+1&&r+1<c&&f.isDark(o,Math.floor((e-u)/1))?i+=" ":i+="█",h+=t<1&&r+1>=c?l[i]:g[i];h+="\\n"}return a%2&&t>0?h.substring(0,h.length-a-1)+Array(a+1).join("▀"):h.substring(0,h.length-1)}(r);t-=1,r=void 0===r?2*t:r;var e,n,o,i,a=f.getModuleCount()*t+2*r,u=r,c=a-r,g=Array(t+1).join("██"),l=Array(t+1).join("  "),h="",s="";for(e=0;e<a;e+=1){for(o=Math.floor((e-u)/t),s="",n=0;n<a;n+=1)i=1,u<=n&&n<c&&u<=e&&e<c&&f.isDark(o,Math.floor((n-u)/t))&&(i=0),s+=i?g:l;for(o=0;o<t;o+=1)h+=s+"\\n"}return h.substring(0,h.length-1)},f.renderTo2dContext=function(t,r){r=r||2;for(var e=f.getModuleCount(),n=0;n<e;n++)for(var o=0;o<e;o++)t.fillStyle=f.isDark(n,o)?"black":"white",t.fillRect(n*r,o*r,r,r)},f};t.stringToBytes=(t.stringToBytesFuncs={default:function(t){for(var r=[],e=0;e<t.length;e+=1){var n=t.charCodeAt(e);r.push(255&n)}return r}}).default,t.createStringToBytes=function(t,r){var e=function(){for(var e=S(t),n=function(){var t=e.read();if(-1==t)throw"eof";return t},o=0,i={};;){var a=e.read();if(-1==a)break;var u=n(),f=n()<<8|n();i[String.fromCharCode(a<<8|u)]=f,o+=1}if(o!=r)throw o+" != "+r;return i}(),n="?".charCodeAt(0);return function(t){for(var r=[],o=0;o<t.length;o+=1){var i=t.charCodeAt(o);if(i<128)r.push(i);else{var a=e[t.charAt(o)];"number"==typeof a?(255&a)==a?r.push(a):(r.push(a>>>8),r.push(255&a)):r.push(n)}}return r}};var r,e,n,o,i,a=1,u=2,f=4,c=8,g={L:1,M:0,Q:3,H:2},l=0,h=1,s=2,v=3,d=4,w=5,p=6,y=7,B=(r=[[],[6,18],[6,22],[6,26],[6,30],[6,34],[6,22,38],[6,24,42],[6,26,46],[6,28,50],[6,30,54],[6,32,58],[6,34,62],[6,26,46,66],[6,26,48,70],[6,26,50,74],[6,30,54,78],[6,30,56,82],[6,30,58,86],[6,34,62,90],[6,28,50,72,94],[6,26,50,74,98],[6,30,54,78,102],[6,28,54,80,106],[6,32,58,84,110],[6,30,58,86,114],[6,34,62,90,118],[6,26,50,74,98,122],[6,30,54,78,102,126],[6,26,52,78,104,130],[6,30,56,82,108,134],[6,34,60,86,112,138],[6,30,58,86,114,142],[6,34,62,90,118,146],[6,30,54,78,102,126,150],[6,24,50,76,102,128,154],[6,28,54,80,106,132,158],[6,32,58,84,110,136,162],[6,26,54,82,110,138,166],[6,30,58,86,114,142,170]],e=1335,n=7973,i=function(t){for(var r=0;0!=t;)r+=1,t>>>=1;return r},(o={}).getBCHTypeInfo=function(t){for(var r=t<<10;i(r)-i(e)>=0;)r^=e<<i(r)-i(e);return 21522^(t<<10|r)},o.getBCHTypeNumber=function(t){for(var r=t<<12;i(r)-i(n)>=0;)r^=n<<i(r)-i(n);return t<<12|r},o.getPatternPosition=function(t){return r[t-1]},o.getMaskFunction=function(t){switch(t){case l:return function(t,r){return(t+r)%2==0};case h:return function(t,r){return t%2==0};case s:return function(t,r){return r%3==0};case v:return function(t,r){return(t+r)%3==0};case d:return function(t,r){return(Math.floor(t/2)+Math.floor(r/3))%2==0};case w:return function(t,r){return t*r%2+t*r%3==0};case p:return function(t,r){return(t*r%2+t*r%3)%2==0};case y:return function(t,r){return(t*r%3+(t+r)%2)%2==0};default:throw"bad maskPattern:"+t}},o.getErrorCorrectPolynomial=function(t){for(var r=k([1],0),e=0;e<t;e+=1)r=r.multiply(k([1,C.gexp(e)],0));return r},o.getLengthInBits=function(t,r){if(1<=r&&r<10)switch(t){case a:return 10;case u:return 9;case f:case c:return 8;default:throw"mode:"+t}else if(r<27)switch(t){case a:return 12;case u:return 11;case f:return 16;case c:return 10;default:throw"mode:"+t}else{if(!(r<41))throw"type:"+r;switch(t){case a:return 14;case u:return 13;case f:return 16;case c:return 12;default:throw"mode:"+t}}},o.getLostPoint=function(t){for(var r=t.getModuleCount(),e=0,n=0;n<r;n+=1)for(var o=0;o<r;o+=1){for(var i=0,a=t.isDark(n,o),u=-1;u<=1;u+=1)if(!(n+u<0||r<=n+u))for(var f=-1;f<=1;f+=1)o+f<0||r<=o+f||0==u&&0==f||a==t.isDark(n+u,o+f)&&(i+=1);i>5&&(e+=3+i-5)}for(n=0;n<r-1;n+=1)for(o=0;o<r-1;o+=1){var c=0;t.isDark(n,o)&&(c+=1),t.isDark(n+1,o)&&(c+=1),t.isDark(n,o+1)&&(c+=1),t.isDark(n+1,o+1)&&(c+=1),0!=c&&4!=c||(e+=3)}for(n=0;n<r;n+=1)for(o=0;o<r-6;o+=1)t.isDark(n,o)&&!t.isDark(n,o+1)&&t.isDark(n,o+2)&&t.isDark(n,o+3)&&t.isDark(n,o+4)&&!t.isDark(n,o+5)&&t.isDark(n,o+6)&&(e+=40);for(o=0;o<r;o+=1)for(n=0;n<r-6;n+=1)t.isDark(n,o)&&!t.isDark(n+1,o)&&t.isDark(n+2,o)&&t.isDark(n+3,o)&&t.isDark(n+4,o)&&!t.isDark(n+5,o)&&t.isDark(n+6,o)&&(e+=40);var g=0;for(o=0;o<r;o+=1)for(n=0;n<r;n+=1)t.isDark(n,o)&&(g+=1);return e+=Math.abs(100*g/r/r-50)/5*10},o),C=function(){for(var t=new Array(256),r=new Array(256),e=0;e<8;e+=1)t[e]=1<<e;for(e=8;e<256;e+=1)t[e]=t[e-4]^t[e-5]^t[e-6]^t[e-8];for(e=0;e<255;e+=1)r[t[e]]=e;var n={glog:function(t){if(t<1)throw"glog("+t+")";return r[t]},gexp:function(r){for(;r<0;)r+=255;for(;r>=256;)r-=255;return t[r]}};return n}();function k(t,r){if(void 0===t.length)throw t.length+"/"+r;var e=function(){for(var e=0;e<t.length&&0==t[e];)e+=1;for(var n=new Array(t.length-e+r),o=0;o<t.length-e;o+=1)n[o]=t[o+e];return n}(),n={getAt:function(t){return e[t]},getLength:function(){return e.length},multiply:function(t){for(var r=new Array(n.getLength()+t.getLength()-1),e=0;e<n.getLength();e+=1)for(var o=0;o<t.getLength();o+=1)r[e+o]^=C.gexp(C.glog(n.getAt(e))+C.glog(t.getAt(o)));return k(r,0)},mod:function(t){if(n.getLength()-t.getLength()<0)return n;for(var r=C.glog(n.getAt(0))-C.glog(t.getAt(0)),e=new Array(n.getLength()),o=0;o<n.getLength();o+=1)e[o]=n.getAt(o);for(o=0;o<t.getLength();o+=1)e[o]^=C.gexp(C.glog(t.getAt(o))+r);return k(e,0).mod(t)}};return n}var A=function(){var t=[[1,26,19],[1,26,16],[1,26,13],[1,26,9],[1,44,34],[1,44,28],[1,44,22],[1,44,16],[1,70,55],[1,70,44],[2,35,17],[2,35,13],[1,100,80],[2,50,32],[2,50,24],[4,25,9],[1,134,108],[2,67,43],[2,33,15,2,34,16],[2,33,11,2,34,12],[2,86,68],[4,43,27],[4,43,19],[4,43,15],[2,98,78],[4,49,31],[2,32,14,4,33,15],[4,39,13,1,40,14],[2,121,97],[2,60,38,2,61,39],[4,40,18,2,41,19],[4,40,14,2,41,15],[2,146,116],[3,58,36,2,59,37],[4,36,16,4,37,17],[4,36,12,4,37,13],[2,86,68,2,87,69],[4,69,43,1,70,44],[6,43,19,2,44,20],[6,43,15,2,44,16],[4,101,81],[1,80,50,4,81,51],[4,50,22,4,51,23],[3,36,12,8,37,13],[2,116,92,2,117,93],[6,58,36,2,59,37],[4,46,20,6,47,21],[7,42,14,4,43,15],[4,133,107],[8,59,37,1,60,38],[8,44,20,4,45,21],[12,33,11,4,34,12],[3,145,115,1,146,116],[4,64,40,5,65,41],[11,36,16,5,37,17],[11,36,12,5,37,13],[5,109,87,1,110,88],[5,65,41,5,66,42],[5,54,24,7,55,25],[11,36,12,7,37,13],[5,122,98,1,123,99],[7,73,45,3,74,46],[15,43,19,2,44,20],[3,45,15,13,46,16],[1,135,107,5,136,108],[10,74,46,1,75,47],[1,50,22,15,51,23],[2,42,14,17,43,15],[5,150,120,1,151,121],[9,69,43,4,70,44],[17,50,22,1,51,23],[2,42,14,19,43,15],[3,141,113,4,142,114],[3,70,44,11,71,45],[17,47,21,4,48,22],[9,39,13,16,40,14],[3,135,107,5,136,108],[3,67,41,13,68,42],[15,54,24,5,55,25],[15,43,15,10,44,16],[4,144,116,4,145,117],[17,68,42],[17,50,22,6,51,23],[19,46,16,6,47,17],[2,139,111,7,140,112],[17,74,46],[7,54,24,16,55,25],[34,37,13],[4,151,121,5,152,122],[4,75,47,14,76,48],[11,54,24,14,55,25],[16,45,15,14,46,16],[6,147,117,4,148,118],[6,73,45,14,74,46],[11,54,24,16,55,25],[30,46,16,2,47,17],[8,132,106,4,133,107],[8,75,47,13,76,48],[7,54,24,22,55,25],[22,45,15,13,46,16],[10,142,114,2,143,115],[19,74,46,4,75,47],[28,50,22,6,51,23],[33,46,16,4,47,17],[8,152,122,4,153,123],[22,73,45,3,74,46],[8,53,23,26,54,24],[12,45,15,28,46,16],[3,147,117,10,148,118],[3,73,45,23,74,46],[4,54,24,31,55,25],[11,45,15,31,46,16],[7,146,116,7,147,117],[21,73,45,7,74,46],[1,53,23,37,54,24],[19,45,15,26,46,16],[5,145,115,10,146,116],[19,75,47,10,76,48],[15,54,24,25,55,25],[23,45,15,25,46,16],[13,145,115,3,146,116],[2,74,46,29,75,47],[42,54,24,1,55,25],[23,45,15,28,46,16],[17,145,115],[10,74,46,23,75,47],[10,54,24,35,55,25],[19,45,15,35,46,16],[17,145,115,1,146,116],[14,74,46,21,75,47],[29,54,24,19,55,25],[11,45,15,46,46,16],[13,145,115,6,146,116],[14,74,46,23,75,47],[44,54,24,7,55,25],[59,46,16,1,47,17],[12,151,121,7,152,122],[12,75,47,26,76,48],[39,54,24,14,55,25],[22,45,15,41,46,16],[6,151,121,14,152,122],[6,75,47,34,76,48],[46,54,24,10,55,25],[2,45,15,64,46,16],[17,152,122,4,153,123],[29,74,46,14,75,47],[49,54,24,10,55,25],[24,45,15,46,46,16],[4,152,122,18,153,123],[13,74,46,32,75,47],[48,54,24,14,55,25],[42,45,15,32,46,16],[20,147,117,4,148,118],[40,75,47,7,76,48],[43,54,24,22,55,25],[10,45,15,67,46,16],[19,148,118,6,149,119],[18,75,47,31,76,48],[34,54,24,34,55,25],[20,45,15,61,46,16]],r=function(t,r){var e={};return e.totalCount=t,e.dataCount=r,e},e={};return e.getRSBlocks=function(e,n){var o=function(r,e){switch(e){case g.L:return t[4*(r-1)+0];case g.M:return t[4*(r-1)+1];case g.Q:return t[4*(r-1)+2];case g.H:return t[4*(r-1)+3];default:return}}(e,n);if(void 0===o)throw"bad rs block @ typeNumber:"+e+"/errorCorrectionLevel:"+n;for(var i=o.length/3,a=[],u=0;u<i;u+=1)for(var f=o[3*u+0],c=o[3*u+1],l=o[3*u+2],h=0;h<f;h+=1)a.push(r(c,l));return a},e}(),b=function(){var t=[],r=0,e={getBuffer:function(){return t},getAt:function(r){var e=Math.floor(r/8);return 1==(t[e]>>>7-r%8&1)},put:function(t,r){for(var n=0;n<r;n+=1)e.putBit(1==(t>>>r-n-1&1))},getLengthInBits:function(){return r},putBit:function(e){var n=Math.floor(r/8);t.length<=n&&t.push(0),e&&(t[n]|=128>>>r%8),r+=1}};return e},M=function(t){var r=a,e=t,n={getMode:function(){return r},getLength:function(t){return e.length},write:function(t){for(var r=e,n=0;n+2<r.length;)t.put(o(r.substring(n,n+3)),10),n+=3;n<r.length&&(r.length-n==1?t.put(o(r.substring(n,n+1)),4):r.length-n==2&&t.put(o(r.substring(n,n+2)),7))}},o=function(t){for(var r=0,e=0;e<t.length;e+=1)r=10*r+i(t.charAt(e));return r},i=function(t){if("0"<=t&&t<="9")return t.charCodeAt(0)-"0".charCodeAt(0);throw"illegal char :"+t};return n},x=function(t){var r=u,e=t,n={getMode:function(){return r},getLength:function(t){return e.length},write:function(t){for(var r=e,n=0;n+1<r.length;)t.put(45*o(r.charAt(n))+o(r.charAt(n+1)),11),n+=2;n<r.length&&t.put(o(r.charAt(n)),6)}},o=function(t){if("0"<=t&&t<="9")return t.charCodeAt(0)-"0".charCodeAt(0);if("A"<=t&&t<="Z")return t.charCodeAt(0)-"A".charCodeAt(0)+10;switch(t){case" ":return 36;case"$":return 37;case"%":return 38;case"*":return 39;case"+":return 40;case"-":return 41;case".":return 42;case"/":return 43;case":":return 44;default:throw"illegal char :"+t}};return n},m=function(r){var e=f,n=t.stringToBytes(r),o={getMode:function(){return e},getLength:function(t){return n.length},write:function(t){for(var r=0;r<n.length;r+=1)t.put(n[r],8)}};return o},L=function(r){var e=c,n=t.stringToBytesFuncs.SJIS;if(!n)throw"sjis not supported.";!function(){var t=n("友");if(2!=t.length||38726!=(t[0]<<8|t[1]))throw"sjis not supported."}();var o=n(r),i={getMode:function(){return e},getLength:function(t){return~~(o.length/2)},write:function(t){for(var r=o,e=0;e+1<r.length;){var n=(255&r[e])<<8|255&r[e+1];if(33088<=n&&n<=40956)n-=33088;else{if(!(57408<=n&&n<=60351))throw"illegal char at "+(e+1)+"/"+n;n-=49472}n=192*(n>>>8&255)+(255&n),t.put(n,13),e+=2}if(e<r.length)throw"illegal char at "+(e+1)}};return i},D=function(){var t=[],r={writeByte:function(r){t.push(255&r)},writeShort:function(t){r.writeByte(t),r.writeByte(t>>>8)},writeBytes:function(t,e,n){e=e||0,n=n||t.length;for(var o=0;o<n;o+=1)r.writeByte(t[o+e])},writeString:function(t){for(var e=0;e<t.length;e+=1)r.writeByte(t.charCodeAt(e))},toByteArray:function(){return t},toString:function(){var r="";r+="[";for(var e=0;e<t.length;e+=1)e>0&&(r+=","),r+=t[e];return r+="]"}};return r},S=function(t){var r=t,e=0,n=0,o=0,i={read:function(){for(;o<8;){if(e>=r.length){if(0==o)return-1;throw"unexpected end of file./"+o}var t=r.charAt(e);if(e+=1,"="==t)return o=0,-1;t.match(/^\\s$/)||(n=n<<6|a(t.charCodeAt(0)),o+=6)}var i=n>>>o-8&255;return o-=8,i}},a=function(t){if(65<=t&&t<=90)return t-65;if(97<=t&&t<=122)return t-97+26;if(48<=t&&t<=57)return t-48+52;if(43==t)return 62;if(47==t)return 63;throw"c:"+t};return i},I=function(t,r,e){for(var n=function(t,r){var e=t,n=r,o=new Array(t*r),i={setPixel:function(t,r,n){o[r*e+t]=n},write:function(t){t.writeString("GIF87a"),t.writeShort(e),t.writeShort(n),t.writeByte(128),t.writeByte(0),t.writeByte(0),t.writeByte(0),t.writeByte(0),t.writeByte(0),t.writeByte(255),t.writeByte(255),t.writeByte(255),t.writeString(","),t.writeShort(0),t.writeShort(0),t.writeShort(e),t.writeShort(n),t.writeByte(0);var r=a(2);t.writeByte(2);for(var o=0;r.length-o>255;)t.writeByte(255),t.writeBytes(r,o,255),o+=255;t.writeByte(r.length-o),t.writeBytes(r,o,r.length-o),t.writeByte(0),t.writeString(";")}},a=function(t){for(var r=1<<t,e=1+(1<<t),n=t+1,i=u(),a=0;a<r;a+=1)i.add(String.fromCharCode(a));i.add(String.fromCharCode(r)),i.add(String.fromCharCode(e));var f,c,g,l=D(),h=(f=l,c=0,g=0,{write:function(t,r){if(t>>>r!=0)throw"length over";for(;c+r>=8;)f.writeByte(255&(t<<c|g)),r-=8-c,t>>>=8-c,g=0,c=0;g|=t<<c,c+=r},flush:function(){c>0&&f.writeByte(g)}});h.write(r,n);var s=0,v=String.fromCharCode(o[s]);for(s+=1;s<o.length;){var d=String.fromCharCode(o[s]);s+=1,i.contains(v+d)?v+=d:(h.write(i.indexOf(v),n),i.size()<4095&&(i.size()==1<<n&&(n+=1),i.add(v+d)),v=d)}return h.write(i.indexOf(v),n),h.write(e,n),h.flush(),l.toByteArray()},u=function(){var t={},r=0,e={add:function(n){if(e.contains(n))throw"dup key:"+n;t[n]=r,r+=1},size:function(){return r},indexOf:function(r){return t[r]},contains:function(r){return void 0!==t[r]}};return e};return i}(t,r),o=0;o<r;o+=1)for(var i=0;i<t;i+=1)n.setPixel(i,o,e(i,o));var a=D();n.write(a);for(var u=function(){var t=0,r=0,e=0,n="",o={},i=function(t){n+=String.fromCharCode(a(63&t))},a=function(t){if(t<0);else{if(t<26)return 65+t;if(t<52)return t-26+97;if(t<62)return t-52+48;if(62==t)return 43;if(63==t)return 47}throw"n:"+t};return o.writeByte=function(n){for(t=t<<8|255&n,r+=8,e+=1;r>=6;)i(t>>>r-6),r-=6},o.flush=function(){if(r>0&&(i(t<<6-r),t=0,r=0),e%3!=0)for(var o=3-e%3,a=0;a<o;a+=1)n+="="},o.toString=function(){return n},o}(),f=a.toByteArray(),c=0;c<f.length;c+=1)u.writeByte(f[c]);return u.flush(),"data:image/gif;base64,"+u};return t}();qrcode.stringToBytesFuncs["UTF-8"]=function(t){return function(t){for(var r=[],e=0;e<t.length;e++){var n=t.charCodeAt(e);n<128?r.push(n):n<2048?r.push(192|n>>6,128|63&n):n<55296||n>=57344?r.push(224|n>>12,128|n>>6&63,128|63&n):(e++,n=65536+((1023&n)<<10|1023&t.charCodeAt(e)),r.push(240|n>>18,128|n>>12&63,128|n>>6&63,128|63&n))}return r}(t)},function(t){"function"==typeof define&&define.amd?define([],t):"object"==typeof exports&&(module.exports=t())}((function(){return qrcode}));
//# sourceMappingURL=/sm/26b4b0d0b1e283d6b3ec9857ac597d7a60c76ac17be1ef4c965f03086de426bb.map
</script>
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
let currentThumbQuality = 0.8;
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
if (typeof res.thumbQuality === 'number') currentThumbQuality = res.thumbQuality;
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
if (typeof data.thumbQuality === 'number') {
currentThumbQuality = data.thumbQuality;
const qsel = document.getElementById('thumb-quality-select');
if (qsel) qsel.value = String(data.thumbQuality);
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
socket.on('image_toggle_rate_limited', function(data) {
showSoftToast('切り替えが速すぎます。少し待ってください');
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
socket.on('thumb_quality_changed', function(data) {
if (!data || typeof data.quality !== 'number') return;
currentThumbQuality = data.quality;
const qsel = document.getElementById('thumb-quality-select');
if (qsel) qsel.value = String(data.quality);
noteActivity();
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
const maxDim = 560;
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
}, 'image/jpeg', 0.70);
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
const targetWidth = 128;
const scale = targetWidth / img.width;
canvas.width = targetWidth;
canvas.height = Math.max(1, Math.round(img.height * scale));
const ctx = canvas.getContext('2d');
ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
resolve(canvas.toDataURL('image/jpeg', currentThumbQuality));
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
setupChatView(currentRoomId, currentRoomName, res.messages || [], maxMembers, res.imageDisplaySeconds || 5, res.members || [myNickname], res.thumbQuality);
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
if (typeof res.thumbQuality === 'number') currentThumbQuality = res.thumbQuality;
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

function setupChatView(roomId, roomName, messages, maxMembers, imageDisplaySeconds, members, thumbQuality) {
currentRoomId = roomId;
currentRoomName = roomName || roomId;
currentMaxMembers = maxMembers || 3;
currentImageDisplaySeconds = imageDisplaySeconds || 5;
currentThumbQuality = (typeof thumbQuality === 'number')? thumbQuality: 0.8;
const qsel0 = document.getElementById('thumb-quality-select');
if (qsel0) { qsel0.value = String(currentThumbQuality); qsel0.disabled = !isHost; }
noteActivity();
setRoomTitle(currentRoomName);
document.getElementById('header-copy-btn').style.display = (isPublicRoom || roomId === PUBLIC_ROOM_ID)? 'none': 'inline-flex';
document.getElementById('header-room-id-container').style.display = 'flex';
document.getElementById('display-time-control').style.display = (isPublicRoom || roomId === PUBLIC_ROOM_ID)? 'none': 'flex';
const fileBtn = document.querySelector('.file-btn');
if (fileBtn) fileBtn.style.display = (isPublicRoom || roomId === PUBLIC_ROOM_ID)? 'none': 'flex';
const sel = document.getElementById('image-display-select');
if (sel) sel.value = String(currentImageDisplaySeconds);
document.getElementById('btn-delete-room').style.display = (isHost &&!isPublicRoom && roomId!== PUBLIC_ROOM_ID)? 'flex': 'none';
document.getElementById('btn-kick').style.display = (isHost &&!isPublicRoom && roomId!== PUBLIC_ROOM_ID)? 'flex': 'none';
if (Array.isArray(members)) updateMemberCount(members.length, currentMaxMembers, members);
if (!isPublicRoom && roomId!== PUBLIC_ROOM_ID) {
window.history.pushState({}, '', buildRoomUrl(currentRoomId, currentKey));
stripIds = [];
stripSeenOut = {};
const stripEl = document.getElementById('recent-strip');
if (stripEl) stripEl.innerHTML = '';
scheduleStripUpdate();
}
stripIds = [];
stripSeenOut = {};
const stripEl2 = document.getElementById('recent-strip');
if (stripEl2) stripEl2.innerHTML = '';
const chatView = document.getElementById('view-chat');
if (chatView && !chatView.dataset.dndBound) {
chatView.dataset.dndBound = '1';
chatView.addEventListener('dragover', function(e) { e.preventDefault(); chatView.classList.add('drag-over'); });
chatView.addEventListener('dragleave', function(e) { if (e.relatedTarget && chatView.contains(e.relatedTarget)) return; chatView.classList.remove('drag-over'); });
chatView.addEventListener('drop', function(e) {
e.preventDefault();
chatView.classList.remove('drag-over');
if (!currentRoomId) return;
const files = Array.prototype.slice.call((e.dataTransfer && e.dataTransfer.files) || []).filter(function(f) { return f.type && f.type.indexOf('image/') === 0; });
files.forEach(function(f) { postImageFile(f); });
});
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
const fallbackUrl = window.location.origin + buildRoomUrl(currentRoomId, currentKey);
socket.emit('get_short_link', { roomId: currentRoomId, key: currentKey }, function(res) {
const url = (res && res.success && res.code)? window.location.origin + '/s/' + res.code: fallbackUrl;
navigator.clipboard.writeText(url).then(function() {
alert('ショートURLをコピーしました！');
}).catch(function() { prompt('このリンクをコピーしてください', url);});
});
}

/* Ver.2.3.8: バージョン名タップで部屋QRを右上に表示 (押した本人だけ・完全ローカル動作)。
   QR生成は同梱ライブラリで端末内処理し、招待URL (鍵を含む) を外部へ送らない。 */
function buildRoomQrUrl() {
if (currentRoomId && !isPublicRoom && currentRoomId!== PUBLIC_ROOM_ID) return window.location.origin + buildRoomUrl(currentRoomId, currentKey);
if (currentRoomId) return window.location.origin + '/' + currentRoomId;
return window.location.origin + '/';
}
let qrRequestSeq = 0;
function toggleRoomQr() {
const panel = document.getElementById('qr-panel');
if (!panel) return;
if (panel.style.display!== 'none') { closeRoomQr(); return;}
document.getElementById('qr-caption').textContent = currentRoomId? ((isPublicRoom || currentRoomId === PUBLIC_ROOM_ID)? '公開ルームのQR': '部屋の招待QR'): 'このサイトのQR';
document.getElementById('qr-url').textContent = 'リンクを生成中…';
document.getElementById('qr-code').innerHTML = '';
const header = document.querySelector('.header');
const bottom = header? header.getBoundingClientRect().bottom: 56;
panel.style.top = (bottom + 8) + 'px';
panel.style.display = 'block';
const seq = ++qrRequestSeq;
let finished = false;
const finish = function(url) {
if (finished || seq!== qrRequestSeq) return;
finished = true;
try {
const qr = qrcode(0, 'M');
qr.addData(url);
qr.make();
document.getElementById('qr-code').innerHTML = qr.createSvgTag(4, 8);
} catch (e) {
document.getElementById('qr-code').innerHTML = '';
}
document.getElementById('qr-url').textContent = url;
};
if (currentRoomId && !isPublicRoom && currentRoomId!== PUBLIC_ROOM_ID && currentKey) {
socket.emit('get_short_link', { roomId: currentRoomId, key: currentKey }, function(res) {
finish((res && res.success && res.code)? window.location.origin + '/s/' + res.code: buildRoomQrUrl());
});
setTimeout(function() { finish(buildRoomQrUrl()); }, 3000);
} else {
finish(buildRoomQrUrl());
}
}
function closeRoomQr() {
const panel = document.getElementById('qr-panel');
if (panel) panel.style.display = 'none';
}

function changeImageDisplayTime() {
const seconds = parseInt(document.getElementById('image-display-select').value, 10);
if (isNaN(seconds) || ![0, 1, 2, 3, 5, 10, 3600].includes(seconds)) return;
noteActivity();
socket.emit('change_image_display_time', { roomId: currentRoomId, seconds: seconds});
}
/* Ver.2.3.21: 粗サムネ品質は部屋主だけが変更できる。変更しても何も表示しない */
function changeThumbQuality() {
if (!isHost) return;
const q = parseFloat(document.getElementById('thumb-quality-select').value);
if (![0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1].includes(q)) return;
noteActivity();
socket.emit('change_thumb_quality', { roomId: currentRoomId, quality: q });
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
/* Ver.2.3.22: ドラッグ&ドロップで落とされた画像を、現在の設定のまま即時投稿する */
async function postImageFile(file) {
if (!file || !currentKey) return;
if (isPublicRoom || currentRoomId === PUBLIC_ROOM_ID) { showSoftToast('公開ルームでは画像を投稿できません'); return; }
stopTyping();
noteActivity();
let thumbBase64 = null;
try { thumbBase64 = await createUltraLightThumbnail(file); } catch (e) {}
const displaySeconds = currentImageDisplaySeconds;
let imageUrl = null;
let thumbMidUrl = null;
if (displaySeconds !== 0) {
const formData = new FormData();
formData.append('image', file);
try {
const res = await fetch('/api/upload', { method: 'POST', body: formData });
const data = await res.json();
imageUrl = data.imageUrl;
} catch (e) { showSoftToast('画像のアップロードに失敗しました'); return; }
try {
const midBlob = await createMidThumbnailBlob(file);
if (midBlob) {
const midForm = new FormData();
midForm.append('image', midBlob, 'thumb.jpg');
const midRes = await fetch('/api/upload', { method: 'POST', body: midForm });
const midData = await midRes.json();
if (midData && midData.imageUrl) thumbMidUrl = midData.imageUrl;
}
} catch (e) {}
}
socket.emit('send_message', {
msgId: Math.random().toString(36).substring(2, 10),
roomId: currentRoomId,
text: '',
image: imageUrl,
thumbMid: thumbMidUrl,
thumb: thumbBase64,
displaySeconds: displaySeconds
});
}
function onFileSelected(input) {
if (isPublicRoom || currentRoomId === PUBLIC_ROOM_ID) {
input.value = '';
showSoftToast('公開ルームでは画像を投稿できません');
return;
}
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
thumbImg.style.cursor = (meta && meta.image &&!meta.thumbOnly)? 'pointer': 'default';
thumbImg.addEventListener('click', function(e) { handleExpiredThumbClick(e, msgId);});
const wrap = document.createElement('span');
wrap.className = 'img-wrap';
wrap.dataset.role = 'expired-thumb';
wrap.appendChild(thumbImg);
if (meta && meta.originalDisplaySeconds > 0) {
const badge = document.createElement('span');
badge.className = 'img-badge';
badge.textContent = '⏱ ' + formatSecondsLabel(meta.originalDisplaySeconds) + '表示';
wrap.appendChild(badge);
}
imgEl.parentNode.appendChild(wrap);
const note = document.createElement('div');
note.className = 'poster-only-note';
note.dataset.role = 'expired-note';
note.innerText = '時間経過につき粗サムネのみ表示';
note.addEventListener('click', function(e) { handleExpiredThumbClick(e, msgId);});
imgEl.parentNode.appendChild(note);
scrollMessageFully(imgEl.parentNode);
scheduleStripUpdate();
return;
}
const note = document.createElement('div');
note.className = 'expired-img-note';
note.dataset.role = 'expired-note';
note.innerText = '🔒 画像の表示期限が切れました' + ((meta && meta.originalDisplaySeconds > 0)? '（⏱ ' + formatSecondsLabel(meta.originalDisplaySeconds) + '表示で投稿）': '');
note.addEventListener('click', function(e) { handleExpiredThumbClick(e, msgId);});
imgEl.parentNode.appendChild(note);
scheduleStripUpdate();
}
/* Ver.2.2.0: 原画表示中を即座に粗サムネ化する */
/* Ver.2.3.5: 即時粗サムネ化も全員反映できるが、有効化できるのは投稿者だけ。
   他の人が操作した場合は従来通り自分の画面だけに効く (サーバーへは送らない)。 */
function expireImageNow(msgId, fromServer) {
const meta = messageMeta[msgId];
const imgEl = document.getElementById('img-' + msgId);
if (!meta ||!imgEl || imgEl.dataset.expired === '1') return;
/* Ver.2.3.10: 自分の投稿の全員反映は、サーバーの配信が戻ってきてから適用する (エコー駆動)。
   先に自分の画面だけ変えると、サーバーのクールダウンで弾かれた時に自分と他人の状態がズレるため。 */
if (!fromServer && meta.senderSessionId && meta.senderSessionId === userSessionId) {
try { socket.emit('expire_image', { roomId: currentRoomId, msgId: msgId }); } catch (e) {}
return;
}
clearImageExpireTimer(msgId);
handleImageExpire(imgEl, msgId, meta.thumb || null);
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
/* Ver.2.3.10: expireImageNow と同じく、自分の投稿はサーバー配信のエコーで適用する */
if (!fromServer && meta.senderSessionId && meta.senderSessionId === userSessionId) {
try { socket.emit('restore_image', { roomId: currentRoomId, msgId: msgId }); } catch (e) {}
return;
}
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
scheduleStripUpdate();
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
/* Ver.2.3.11: 直近画像ストリップ。会話が進んで上へ見えなくなった画像を
   (Ver.2.3.13: スクロール操作では内容を変えず、会話の進行でのみ追加/押し出しする)
   チャット枠の1行目に常に5枚を左から並べる (狭い画面ではサムネが縮む)。満タン時は一番左が押し出される。
   期限切れ/粗サムネのみの画像は粗サムネ (無ければ鍵タイル) で出す。タップでその発話へ移動。 */
let stripUpdateQueued = false;
let stripIds = [];
let stripSeenOut = {};
function scheduleStripUpdate() {
if (stripUpdateQueued) return;
stripUpdateQueued = true;
requestAnimationFrame(function() { stripUpdateQueued = false; updateRecentStrip();});
}
function stripCapacity(strip) {
/* Ver.2.3.12: 枚数は常に5枚固定。狭い画面ではサムネ自体が縮む (CSSのflex+aspect-ratio)。 */
return 5;
}
function stripSrcFor(meta) {
if (!meta) return null;
if (meta.thumbOnly || meta.expired) return meta.thumb || null;
return meta.thumbMid || meta.image || meta.thumb || null;
}
function makeStripItem(msgId, src) {
const item = document.createElement('div');
item.className = 'strip-item enter';
item.dataset.msgId = msgId;
if (src) {
const img = document.createElement('img');
img.src = src;
img.alt = '';
item.appendChild(img);
item.dataset.src = src;
} else {
const lock = document.createElement('div');
lock.className = 'strip-lock';
lock.textContent = '🔒';
item.appendChild(lock);
item.dataset.src = '';
}
item.addEventListener('click', function() {
const target = document.getElementById('msg-' + msgId);
if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
});
return item;
}
function updateRecentStrip() {
const strip = document.getElementById('recent-strip');
const container = document.getElementById('chat-messages');
if (!strip || !container) return;
if (!currentRoomId) { strip.classList.remove('show'); strip.innerHTML = ''; return;}
const chatRect = container.getBoundingClientRect();
const above = [];
container.querySelectorAll('.message').forEach(function(el) {
if (!el.id || el.id.indexOf('msg-')!== 0) return;
const msgId = el.id.slice(4);
const meta = messageMeta[msgId];
if (!meta || (!meta.image && !meta.thumb)) return;
const r = el.getBoundingClientRect();
if (r.bottom < chatRect.top + 4) above.push(msgId);
});
above.forEach(function(id) {
if (!stripIds.includes(id) && !stripSeenOut[id]) stripIds.push(id);
});
const cap = stripCapacity(strip);
if (stripIds.length > cap) {
stripIds.slice(0, stripIds.length - cap).forEach(function(id) { stripSeenOut[id] = true;});
stripIds = stripIds.slice(-cap);
}
const desired = stripIds.slice();
const desiredSet = {};
desired.forEach(function(id) { desiredSet[id] = true;});
const existing = {};
strip.querySelectorAll('.strip-item').forEach(function(node) { existing[node.dataset.msgId] = node;});
const hasNewArrival = desired.some(function(id) { return !existing[id];});
Object.keys(existing).forEach(function(id) {
const node = existing[id];
if (desiredSet[id]) return;
if (desired.length >= cap && hasNewArrival) {
node.classList.add('leaving');
setTimeout(function() { if (node.parentNode) node.parentNode.removeChild(node);}, 260);
} else if (node.parentNode) {
node.parentNode.removeChild(node);
}
});
desired.forEach(function(id) {
const src = stripSrcFor(messageMeta[id]);
let node = existing[id];
if (node && (!node.parentNode || node.classList.contains('leaving'))) node = null;
if (node && node.dataset.src!== (src || '')) {
const fresh = makeStripItem(id, src);
fresh.classList.remove('enter');
node.parentNode.replaceChild(fresh, node);
node = fresh;
}
if (!node) node = makeStripItem(id, src);
strip.appendChild(node);
});
strip.classList.toggle('show', strip.querySelectorAll('.strip-item').length > 0);
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
/* Ver.2.3.24: 粗サムネのみ投稿も、サムネ左上に「⏱ 0秒表示」バッジを出す */
html += '<span class="img-wrap"><img src="' + msg.thumb + '" class="chat-img-poster-thumb" style="cursor:default;" oncontextmenu="return false;"><span class="img-badge">⏱ ' + formatSecondsLabel(0) + '表示</span></span>';
html += '<div class="poster-only-note">粗サムネのみ表示</div>';
} else if (msg.image) {
/* Ver.2.3.3: インラインは中サムネ (無ければ原画)。原画はタップ時の viewer だけが読む */
html += '<span class="img-wrap"><img src="' + (msg.thumbMid || msg.image) + '" class="chat-img" id="img-' + msg.id + '" oncontextmenu="return false;">' + (originalDisplaySec > 0? '<span class="img-badge">⏱ ' + formatSecondsLabel(originalDisplaySec) + '表示</span>': '') + '</span>';
} else if (msg.thumb) {
html += '<span class="img-wrap"><img src="' + msg.thumb + '" class="chat-img-poster-thumb" style="cursor:default;" oncontextmenu="return false;">' + (originalDisplaySec > 0? '<span class="img-badge">⏱ ' + formatSecondsLabel(originalDisplaySec) + '表示</span>': '') + '</span>';
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
scheduleStripUpdate();
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
note.textContent = (meta.originalDisplaySeconds > 0)? '⏱ ' + formatSecondsLabel(meta.originalDisplaySeconds) + '表示で投稿': '';
img.src = meta.image;
img.style.imageRendering = 'auto';
img.style.width = '';
img.style.height = '';
img.style.maxWidth = '';
img.style.maxHeight = '';
if (meta.thumb && meta.displaySeconds < 3600) {
imageModalTimer = setTimeout(function() {
img.src = meta.thumb;
img.style.imageRendering = 'pixelated';
/* Ver.2.3.19: 粗サムネは48px幅の原寸で出すと全画面モーダルの中央に小さな点のように見えて変だったため、チャット内の粗サムネと同じ大きさに揃える */
/* Ver.2.3.20: その揃え方を「高さ200px基準」に統一 (幅は縦横比から自動、吹き出し幅が上限) */
img.style.width = 'auto';
img.style.height = '200px';
img.style.maxWidth = '100%';
note.textContent = '時間経過につき粗サムネのみ表示' + ((meta.originalDisplaySeconds > 0)? '（⏱ ' + formatSecondsLabel(meta.originalDisplaySeconds) + '表示で投稿）': '');
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
const viewerUrl = '/viewer#i=' + encodeURIComponent(meta.image) + '&s=' + encodeURIComponent(String(meta.displaySeconds)) + '&t=' + encodeURIComponent(String(meta.postedAt || Date.now())) + '&o=' + encodeURIComponent(String(meta.originalDisplaySeconds || 0));
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
#expired-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.94); display: none; align-items: center; justify-content: center; z-index: 10; padding: 20px; }
.expired-box { text-align: center; }
#expired-msg { font-size: 1rem; line-height: 1.6; margin-bottom: 18px; }
#expired-orig { color: #94a3b8; font-size: 0.85rem; margin-bottom: 18px; }
#expired-close-btn { padding: 12px 26px; border: none; border-radius: 8px; background: #38bdf8; color: #0f172a; font-weight: bold; font-size: 0.95rem; cursor: pointer; }
</style>
</head>
<body>
<img id="viewer-img" alt="画像" oncontextmenu="return false;">
<div id="note">表示時間が過ぎると自動で消えます。このタブを閉じるとチャットに戻ります。</div>
<button type="button" id="close-btn" onclick="window.close()">タブを閉じる</button>
<div id="expired-overlay"><div class="expired-box"><div id="expired-msg">表示時間が過ぎたため、画像は表示できません。</div><div id="expired-orig"></div><button type="button" id="expired-close-btn" onclick="window.close()">タブを閉じる</button></div></div>
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
var origSec = parseInt(p.o || '0', 10);
if (origSec > 0) {
var origLabel = (origSec === 3600)? '1時間': (origSec + '秒');
note.textContent = '⏱ ' + origLabel + '表示で投稿された画像です。表示時間が過ぎると自動で消えます。このタブを閉じるとチャットに戻ります。';
document.getElementById('expired-orig').textContent = '⏱ ' + origLabel + '表示で投稿されました';
}
document.addEventListener('contextmenu', function(e) { e.preventDefault(); });
var seconds = parseInt(p.s || '5', 10);
var postedAt = parseInt(p.t || '0', 10) || Date.now();
if (!isNaN(seconds) && seconds > 0 && seconds < 3600) {
var remaining = seconds * 1000 - (Date.now() - postedAt);
var expire = function() {
img.remove();
note.style.display = 'none';
document.getElementById('close-btn').style.display = 'none';
document.getElementById('expired-overlay').style.display = 'flex';
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
app.get('/s/:code([a-zA-Z0-9]{8})', (req, res) => {
const entry = shortLinks[req.params.code];
if (!entry || !rooms[entry.roomId]) {
if (entry) purgeShortLinksForRoom(entry.roomId);
return res.status(404).send('リンクが見つかりません（部屋が削除された可能性があります）');
}
res.set('Cache-Control', 'no-store');
res.set('Referrer-Policy', 'no-referrer');
logEvent('short_link_used', { room: entry.roomId, code: req.params.code });
res.redirect(302, '/' + entry.roomId + '#' + encodeURIComponent(entry.key));
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
members: active.map(m => m.nickname), imageDisplaySeconds: room.imageDisplaySeconds, thumbQuality: (typeof room.thumbQuality === 'number')? room.thumbQuality: 0.8, messages: syncMessages
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
imageDisplaySeconds: 5, thumbQuality: 0.8,
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
maxMembers: safeMax, imageDisplaySeconds: 5, thumbQuality: 0.8, memberCount: 1, members: [nick]
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
maxMembers: room.maxMembers, imageDisplaySeconds: room.imageDisplaySeconds, thumbQuality: (typeof room.thumbQuality === 'number')? room.thumbQuality: 0.8,
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
purgeShortLinksForRoom(targetId);
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
/* Ver.2.3.21: 切り替えるたびにグレーのテキストを出す仕様に戻す (2.3.16で消したもの) */
let label = seconds + '秒';
if (seconds === 0) label = '粗サムネのみ';
else if (seconds === 3600) label = '1時間';
const systemMsg = { type: 'system', id: 'system-' + Math.random().toString(36).substring(2, 10), text: '画像表示時間が' + label + 'に切り替わりました'};
room.messages.push(systemMsg);
io.to(roomId).emit('image_display_changed', { seconds: seconds, text: systemMsg.text, id: systemMsg.id });
});

socket.on('change_thumb_quality', ({ roomId, quality }) => {
const room = rooms[roomId];
if (!room) return;
if (room.hostSessionId !== socket.data.sessionId) return;
if (![0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1].includes(quality)) return;
room.thumbQuality = quality;
room.lastActivityAt = Date.now();
logEvent('thumb_quality_changed', { room: roomId, sid: shortId(socket.data.sessionId), quality: quality });
/* Ver.2.3.21: 品質変更では何も表示しない (履歴にも残さない) */
io.to(roomId).emit('thumb_quality_changed', { quality: quality });
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
let effImage = image || null;
let effThumbMid = safeThumbMid;
let effThumb = thumb || null;
if (room.isPublic && (effImage || effThumbMid || effThumb)) {
/* Ver.2.3.15: 公開ルームは画像投稿なし。ファイル自体は掃除だけ予約して破棄する */
if (effImage) scheduleImageDelete(effImage, ds);
if (effThumbMid) scheduleImageDelete(effThumbMid, ds);
logEvent('image_blocked_public', { room: targetId, sid: shortId(socket.data.sessionId) });
effImage = null;
effThumbMid = null;
effThumb = null;
}
const messageData = {
type: 'user', id: msgId || Math.random().toString(36).substring(2, 10), sessionId: sessionId,
senderName: sender? sender.nickname: '匿名', colorIndex: sender? sender.colorIndex: 0,
text, image: effImage, thumbMid: effThumbMid, thumb: effThumb, displaySeconds: ds, originalDisplaySeconds: ds, postedAt: Date.now()
};
if (effImage) scheduleImageDelete(effImage, ds);
if (effThumbMid) scheduleImageDelete(effThumbMid, ds);
room.messages.push(messageData);
if (room.isPublic && room.messages.length > 100) {
room.messages = room.messages.slice(-80);
}
trimPrivateHistory(room);
io.to(targetId).emit('receive_message', messageData);
});

socket.on('get_short_link', ({ roomId, key }, callback) => {
const room = rooms[roomId];
if (!room || room.isPublic) return safeCallback(callback, { success: false });
const isMember = (room.members || []).some(m => m.sessionId === socket.data.sessionId) || (room.joinedSessionIds || []).includes(socket.data.sessionId);
if (!isMember) return safeCallback(callback, { success: false });
if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(key)) return safeCallback(callback, { success: false });
const mapKey = roomId + '\n' + key;
let code = shortLinkByRoomKey[mapKey];
if (!code) {
code = generateShortCode();
shortLinks[code] = { roomId: roomId, key: key };
shortLinkByRoomKey[mapKey] = code;
logEvent('short_link_created', { room: roomId, sid: shortId(socket.data.sessionId), code: code });
}
safeCallback(callback, { success: true, code: code, path: '/s/' + code });
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
if (Date.now() - (targetMsg.lastToggleAt || 0) < 500) { logEvent('image_toggle_rate_limited', { room: targetId, sid: shortId(socket.data.sessionId), msg: msgId }); socket.emit('image_toggle_rate_limited', { msgId: msgId }); return; }
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
if (Date.now() - (targetMsg.lastToggleAt || 0) < 500) { logEvent('image_toggle_rate_limited', { room: targetId, sid: shortId(socket.data.sessionId), msg: msgId }); socket.emit('image_toggle_rate_limited', { msgId: msgId }); return; }
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
