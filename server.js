const Express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
 
const app = Express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 35e6 });

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
const upload = multer({ storage, limits: { fileSize: 30 * 1024 * 1024 } });

app.use('/uploads', Express.static(uploadDir));

app.get('/api/ping', (req, res) => {
  res.json({ ok: true, t: Date.now() });
});

const rooms = {};
const roomNameToId = {};

/** 公開ルーム（固定ID） */
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
    isPublic: true
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
  return room.members.filter(m => m.id !== null);
}

function getMemberNames(room) {
  return getActiveMembers(room).map(m => m.nickname);
}

function getPublicRoomCount() {
  const room = rooms[PUBLIC_ROOM_ID];
  if (!room) return 0;
  return getActiveMembers(room).length;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const roomId of Object.keys(rooms)) {
    if (roomId === PUBLIC_ROOM_ID) continue; // 公開ルームは自動削除しない
    const room = rooms[roomId];
    if (!room) continue;
    if (now - (room.lastActivityAt || 0) > THIRTY_DAYS_MS) {
      (room.messages || []).forEach(msg => {
        if (msg.image) {
          const filename = path.basename(msg.image);
          const filePath = path.join(uploadDir, filename);
          if (fs.existsSync(filePath)) fs.unlink(filePath, () => {});
        }
      });
      if (room.name && roomNameToId[room.name] === roomId) {
        delete roomNameToId[room.name];
      }
      io.to(roomId).emit('room_deleted_by_host', { reason: 'inactivity' });
      delete rooms[roomId];
      console.log('部屋「' + (room.name || roomId) + '」は30日間無発話のため自動削除されました');
    }
  }
}, 12 * 60 * 60 * 1000);

app.post('/api/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'ファイルがありません' });
  const imageUrl = '/uploads/' + req.file.filename;
  const filePath = req.file.path;
  setTimeout(() => {
    fs.unlink(filePath, (err) => {
      if (err) return;
      console.log('フォールバック1時間削除:', req.file.filename);
    });
  }, 60 * 60 * 1000);
  res.json({ imageUrl });
});

function scheduleImageDelete(imageUrl, displaySeconds) {
  if (!imageUrl) return;
  const filename = path.basename(imageUrl);
  const filePath = path.join(uploadDir, filename);
  const sec = Number(displaySeconds);
  const safeSec = (isNaN(sec) || sec < 0) ? 3600 : sec;
  const delayMs = (Math.max(2, safeSec) + 90) * 1000;
  setTimeout(() => {
    fs.unlink(filePath, (err) => {
      if (err) return;
      console.log('表示時間+猶予経過により画像削除:', filename, delayMs + 'ms');
    });
  }, delayMs);
}

app.get('/api/public-count', (req, res) => {
  ensurePublicRoom();
  res.json({ count: getPublicRoomCount(), maxMembers: PUBLIC_ROOM_MAX });
});

app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
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
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    html, body { height: 100%; }
    body { background-color: var(--bg-color); color: var(--text-color); margin: 0; padding: 0; overflow: hidden; }
    .container { position: fixed; top: 0; left: 0; right: 0; margin: 0 auto; width: 100%; max-width: 560px; background: var(--card-bg); overflow: hidden; display: flex; flex-direction: column; height: 100%; min-height: 0; }
    .header { padding: 6px 8px 6px; border-bottom: 1px solid var(--border-color); background: #111827; display: flex; flex-direction: column; gap: 4px; flex-shrink: 0; }
    .header-top { display: flex; align-items: center; gap: 6px; min-width: 0; }
    .home-btn { width: 28px; height: 28px; margin: 0; padding: 0; border: none; border-radius: 6px; background: transparent; color: var(--text-color); font-size: 1rem; cursor: pointer; flex-shrink: 0; }
    .header .room-name { color: var(--accent-color); font-weight: bold; cursor: default; white-space: nowrap; text-overflow: ellipsis; overflow: hidden; font-size: 0.95rem; max-width: 14em; min-width: 0; flex: 0 1 auto; }
    .header-copy-btn { background: #334155; color: #f8fafc; border: none; padding: 3px 8px; border-radius: 12px; cursor: pointer; font-size: 0.66rem; line-height: 1.2; flex-shrink: 0; width: auto; margin: 0; }
    .version-tag { font-size: 0.58rem; color: #64748b; flex-shrink: 0; margin-left: auto; }
    .header-members { display: flex; align-items: flex-start; gap: 6px; min-width: 0; }
    .member-block { flex: 1; min-width: 0; }
    .member-count { font-size: 0.68rem; color: var(--text-muted); line-height: 1.2; }
    .member-names { font-size: 0.68rem; color: #cbd5e1; line-height: 1.25; word-break: break-all; }
    .member-line { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .btn-action-group { display: flex; gap: 4px; flex-shrink: 0; align-items: stretch; }
    .btn-leave, .btn-host-action { width: 42px; min-width: 42px; margin: 0; padding: 4px 2px; border: none; border-radius: 4px; color: white; font-size: 0.62rem; font-weight: bold; line-height: 1.15; cursor: pointer; text-align: center; }
    .btn-leave { background: #64748b; display: inline-flex; align-items: center; justify-content: center; }
    .btn-host-action { background: #ef4444; display: none; align-items: center; justify-content: center; }
    .btn-kick { background: #f59e0b; color: #111827; }
    .view { display: none; padding: 20px; flex-direction: column; flex: 1; min-height: 0; overflow-y: auto; }
    .view.active { display: flex; }
    #view-chat { padding: 0; overflow: hidden; position: relative; }
    label { font-size: 0.85rem; color: var(--text-muted); margin-top: 12px; display: block; }
    input, textarea, select { width: 100%; padding: 12px; margin-top: 6px; border-radius: 8px; border: 1px solid var(--border-color); background: #0f172a; color: white; outline: none; font-size: 16px; }
    input:focus, textarea:focus, select:focus { border-color: var(--accent-color); }
    textarea { resize: none; height: 44px; font-size: 16px; line-height: 1.4; }
    button { width: 100%; padding: 12px; margin-top: 18px; border-radius: 8px; border: none; background: var(--accent-color); color: #0f172a; font-weight: bold; cursor: pointer; }
    .btn-secondary { background: #475569; color: white; }
    .max-members-group { display: flex; gap: 8px; margin-top: 8px; }
    .max-members-group label { margin: 0; flex: 1; }
    .max-members-group input[type="radio"] { display: none; }
    .max-members-group span { display: block; text-align: center; padding: 10px 0; border-radius: 8px; border: 1px solid var(--border-color); background: #0f172a; color: var(--text-muted); cursor: pointer; font-size: 0.9rem; }
    .max-members-group input[type="radio"]:checked + span { border-color: var(--accent-color); background: #0c4a6e; color: white; font-weight: bold; }
    .my-rooms-section { margin-bottom: 14px; display: none; }
    .my-rooms-title { font-size: 0.85rem; color: var(--text-muted); margin-bottom: 8px; font-weight: bold; }
    .room-card-list { display: flex; flex-direction: column; gap: 8px; }
    .room-card { background: #0f172a; border: 1px solid var(--border-color); padding: 12px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; cursor: pointer; }
    .room-card-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .room-card-name { font-weight: bold; font-size: 0.95rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .room-card-meta { font-size: 0.72rem; color: var(--text-muted); }
    /* ホーム：セクション構成 */
    .home-title { text-align: center; margin-bottom: 18px; font-size: 1.35rem; }
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
    .public-status {
      font-size: 0.8rem;
      color: #cbd5e1;
      margin-bottom: 10px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .public-status .dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: #22c55e;
      box-shadow: 0 0 6px #22c55e88;
      flex-shrink: 0;
    }
    .section-card button { margin-top: 8px; }
    .section-divider {
      text-align: center;
      margin: 6px 0 12px;
      color: var(--text-muted);
      font-size: 0.75rem;
    }
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
    .home-feature-item .feat-label {
      color: #94a3b8;
      font-weight: 600;
      white-space: nowrap;
      flex-shrink: 0;
    }
    #chat-messages { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; display: flex; flex-direction: column; gap: 12px; padding: 36px 10px 48px; }
    .pull-indicator { position: absolute; top: 6px; left: 0; right: 0; display: none; justify-content: center; z-index: 3; pointer-events: none; }
    .pull-indicator.show { display: flex; }
    .spinner { width: 18px; height: 18px; border: 2px solid #334155; border-top-color: var(--accent-color); border-radius: 50%; animation: spin 0.7s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .message { display: flex; flex-direction: column; width: fit-content; max-width: 80%; padding: 8px 12px; border-radius: 12px; position: relative; word-break: break-word; align-self: flex-start; font-size: 0.85rem; line-height: 1.4; }
    .message.self { align-self: flex-end; background: #0284c7; color: white; }
    .message.self .sender { color: #e0f2fe; }
    .message.user-color-0 { background: #334155; color: #f8fafc; }
    .message.user-color-1 { background: #1e3a29; color: #f8fafc; border: 1px solid #2e5d40; }
    .message.user-color-2 { background: #3b2f1e; color: #f8fafc; border: 1px solid #5d4a2e; }
    .message.user-color-3 { background: #2e1e3b; color: #f8fafc; border: 1px solid #4a2e5d; }
    .message .sender { font-size: 0.75rem; color: var(--text-muted); margin-bottom: 2px; padding-right: 20px; font-weight: bold; }
    .message .text-content { white-space: pre-wrap; }
    .message .del-btn { position: absolute; top: 4px; right: 8px; cursor: pointer; color: #fca5a5; font-size: 0.75rem; opacity: 0.85; }
    .system-notification { text-align: center; font-size: 0.75rem; color: var(--text-muted); margin: 4px 0; align-self: center; }
    .chat-img { max-width: 100%; max-height: 200px; border-radius: 8px; margin-top: 6px; cursor: pointer; user-select: none; -webkit-user-drag: none; display: block; }
    .chat-img-poster-thumb { width: 100px; height: auto; border-radius: 6px; margin-top: 6px; image-rendering: pixelated; border: 1px dashed #94a3b8; opacity: 0.85; display: block; }
    .expired-img-note { font-size: 0.72rem; color: #f87171; font-style: italic; margin-top: 4px; }
    .poster-only-note { font-size: 0.68rem; color: #94a3b8; margin-top: 2px; }
    .input-area { display: flex; flex-direction: column; gap: 4px; padding: 6px 8px calc(4px + env(safe-area-inset-bottom)); border-top: 1px solid var(--border-color); flex-shrink: 0; background: var(--card-bg); }
    .typing-indicator { font-size: 0.75rem; color: var(--text-muted); font-style: italic; min-height: 0.2rem; }
    .display-time-row { display: flex; align-items: center; gap: 6px; font-size: 0.68rem; color: var(--text-muted); }
    .display-time-row select { width: auto; padding: 2px 6px; margin: 0; font-size: 0.72rem; border-radius: 8px; }
    .input-row { display: flex; gap: 8px; align-items: flex-end; }
    .file-btn { background: #475569; color: white; padding: 12px; border-radius: 8px; cursor: pointer; font-size: 0.9rem; margin: 0; width: 46px; height: 46px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
    .input-row textarea { margin: 0; min-height: 46px; }
    .input-row button { margin: 0; width: 52px; height: 46px; padding: 0; flex-shrink: 0; line-height: 1.15; }
    .security-disclaimer { font-size: 0.58rem; color: #94a3b8; line-height: 1.3; margin-top: 2px; padding: 0 2px; }
    #full-overlay { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(15, 23, 42, 0.85); backdrop-filter: blur(4px); z-index: 9999; display: none; justify-content: center; align-items: center; }
    .toast-message { background: #ef4444; color: white; padding: 14px 28px; border-radius: 12px; font-weight: bold; font-size: 1rem; text-align: center; }
    .modal-overlay { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(15, 23, 42, 0.75); z-index: 10000; display: none; justify-content: center; align-items: center; }
    .modal-overlay.active { display: flex; }
    .modal-box { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 12px; padding: 20px; width: 90%; max-width: 340px; }
    .modal-box h3 { font-size: 1rem; margin-bottom: 12px; }
    .modal-box p { font-size: 0.85rem; color: var(--text-muted); margin-bottom: 16px; }
    .modal-actions { display: flex; gap: 8px; }
    .modal-actions button { margin: 0; flex: 1; padding: 10px; font-size: 0.85rem; }
    .modal-member-list { max-height: 200px; overflow-y: auto; margin-bottom: 12px; }
    .modal-member-item { display: flex; justify-content: space-between; align-items: center; padding: 8px 10px; border-radius: 6px; background: #0f172a; margin-bottom: 6px; font-size: 0.85rem; }
    .modal-member-item button { width: auto; margin: 0; padding: 4px 10px; font-size: 0.75rem; background: #f59e0b; color: #0f172a; }
    #image-modal { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0,0,0,0.92); z-index: 10001; display: none; justify-content: center; align-items: center; padding: 12px; }
    #image-modal.active { display: flex; }
    #image-modal-img { max-width: 100vw; max-height: 100vh; object-fit: contain; border-radius: 4px; user-select: none; -webkit-user-drag: none; }
    #image-modal-close { position: fixed; top: calc(12px + env(safe-area-inset-top)); right: 12px; width: 40px; height: 40px; border-radius: 50%; border: none; background: rgba(248,250,252,0.95); color: #0f172a; font-size: 1.4rem; font-weight: bold; cursor: pointer; z-index: 10002; margin: 0; }
    #image-modal-note { color: #94a3b8; font-size: 0.75rem; margin-top: 8px; text-align: center; }
    .soft-toast { position: fixed; bottom: calc(24px + env(safe-area-inset-bottom)); left: 50%; transform: translateX(-50%); background: rgba(30,41,59,0.92); color: #e2e8f0; padding: 8px 16px; border-radius: 8px; font-size: 0.8rem; z-index: 10003; opacity: 0; transition: opacity 0.2s; pointer-events: none; }
    .soft-toast.show { opacity: 1; }
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
    <div class="modal-actions"><button class="btn-secondary" onclick="closeKickModal()">キャンセル</button></div>
  </div>
</div>
<div id="kick-confirm-modal" class="modal-overlay">
  <div class="modal-box">
    <h3>確認</h3>
    <p id="kick-confirm-text">このメンバーを退室させますか？</p>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeKickConfirmModal()">キャンセル</button>
      <button id="kick-confirm-btn" style="background:#ef4444;color:white;">退室させる</button>
    </div>
  </div>
</div>
<div class="container">
  <div class="header">
    <div class="header-top">
      <button type="button" class="home-btn" onclick="goHome()" aria-label="トップへ">🏠</button>
      <span class="room-name" id="header-room-name">SimpleChatee</span>
      <button type="button" class="header-copy-btn" id="header-copy-btn" onclick="copyRoomLink()" style="display:none;">🔗コピー</button>
      <span class="version-tag">Ver. 2.0.10</span>
    </div>
    <div class="header-members" id="header-room-id-container" style="display:none;">
      <div class="member-block">
        <div class="member-count" id="member-count"></div>
        <div class="member-names" id="member-names"></div>
      </div>
      <div class="btn-action-group" id="room-action-container">
        <button id="btn-delete-room" class="btn-host-action" onclick="deleteRoom()">部屋<br>削除</button>
        <button id="btn-kick" class="btn-host-action btn-kick" onclick="openKickModal()">強制<br>退室</button>
        <button class="btn-leave" onclick="leaveRoom()">退室<br>する</button>
      </div>
    </div>
  </div>
  <div id="view-home" class="view active">
    <h2 class="home-title">SimpleChatee</h2>

    <!-- 公開ルーム -->
    <div class="section-card" id="public-room-section">
      <h3>🌐 公開ルーム</h3>
      <div class="public-status">
        <span class="dot" aria-hidden="true"></span>
        <span id="public-room-status">入室中: — 人</span>
      </div>
      <p class="section-desc">誰でも自由に入れる共通の集合場所です。気軽に雑談できます。ニックネームを決めてすぐに入室できます。</p>
      <button type="button" onclick="enterPublicRoom()">公開ルームに入室</button>
    </div>

    <!-- プライベートルーム -->
    <div class="section-card" id="private-room-section">
      <h3>🔒 プライベートルーム</h3>
      <p class="section-desc">招待リンクまたは部屋名で入室する、少人数向けの個室チャットです。作成した部屋は端末に保存され、後から復元入室できます。</p>
      <div id="my-rooms-section" class="my-rooms-section">
        <div class="my-rooms-title">作成・参加した部屋</div>
        <div id="my-rooms-list" class="room-card-list"></div>
      </div>
      <button type="button" onclick="showView('view-create')">部屋を作成・入室</button>
      <div class="section-divider">- または -</div>
      <input type="text" id="join-room-name" placeholder="部屋名を入力">
      <button type="button" class="btn-secondary" style="margin-top:10px;" onclick="checkRoomJoin()">部屋に参加</button>
      <p style="font-size:0.68rem; color:var(--text-muted); margin-top:10px; text-align:center; line-height:1.4;">招待リンクがある場合はリンクから入室してください。<br>暗号化鍵はリンクに含まれています。</p>
    </div>

    <!-- 特徴表記（フッター） -->
    <div class="home-features">
      <div class="home-feature-item"><span class="feat-label">E2E暗号化</span><span>チャット内容はブラウザ間で暗号化され、管理者も閲覧できません。</span></div>
      <div class="home-feature-item"><span class="feat-label">画像の時限表示</span><span>1秒 / 3秒 / 5秒 などの時限表示。表示後はサーバーから自動削除されます。</span></div>
      <div class="home-feature-item"><span class="feat-label">履歴の不保持</span><span>メッセージ履歴を長期保持しない、使い切り型の設計です。</span></div>
    </div>
  </div>
  <div id="view-create" class="view">
    <h3>部屋を作成</h3>
    <label>部屋名</label>
    <input type="text" id="create-room-name" placeholder="例: ひみつの部屋" maxlength="30">
    <label>最大人数（部屋主含む）</label>
    <div class="max-members-group">
      <label><input type="radio" name="max-members" value="3" checked><span>3人</span></label>
      <label><input type="radio" name="max-members" value="4"><span>4人</span></label>
      <label><input type="radio" name="max-members" value="5"><span>5人</span></label>
    </div>
    <label>あなたのニックネーム</label>
    <input type="text" id="create-nickname" placeholder="名無し" maxlength="20">
    <button onclick="createRoom()">作成して入室</button>
    <button class="btn-secondary" style="margin-top: 10px;" onclick="goHome()">キャンセル</button>
  </div>
  <div id="view-join" class="view">
    <h3 id="join-target-room-title">部屋に入室</h3>
    <label>あなたのニックネーム</label>
    <input type="text" id="join-nickname" placeholder="名無し" maxlength="20">
    <p id="join-key-warning" style="font-size:0.75rem; color:#f87171; margin-top:10px; display:none;">暗号化鍵が見つかりません。招待リンクから入室してください。</p>
    <button onclick="joinRoom()">入室する</button>
    <button class="btn-secondary" style="margin-top: 10px;" onclick="goHome()">トップに戻る</button>
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
          <option value="3">3秒</option>
          <option value="5">5秒</option>
          <option value="3600">1時間</option>
        </select>
      </div>
      <div class="input-row">
        <label class="file-btn">📷<input type="file" id="file-input" accept="image/*" style="display:none;" onchange="onFileSelected(this)"></label>
        <textarea id="msg-input" placeholder="メッセージを入力..." oninput="handleTyping()" onkeydown="onKeyDown(event)"></textarea>
        <button onclick="sendMessage()">送<br>信</button>
      </div>
      <div class="security-disclaimer">🔒 チャット内容はE2E暗号化により管理者も閲覧不可です。画像は表示時間経過後に削除されます。粗サムネのみの場合はフル画像をサーバーに保存しません。</div>
    </div>
  </div>
</div>
<script src="/socket.io/socket.io.js"></script>
<script>
  const socket = io();
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

  const PUBLIC_ROOM_ID = 'public';
  /** 公開ルーム用の固定E2E鍵（全員共通。ブラウザ間暗号化は維持） */
  const PUBLIC_ROOM_KEY = 'SimpleChatee-Public-Room-Key-v1';

  function noteActivity() { lastChatActivityAt = Date.now(); }
  function truncateLabel(str, max) {
    const s = String(str || '');
    return s.length > max ? s.slice(0, max) + '…' : s;
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
    const list = Array.isArray(names) ? names : [];
    for (let i = 0; i < list.length; i += 3) {
      const line = document.createElement('div');
      line.className = 'member-line';
      line.textContent = list.slice(i, i + 3).map(function(n) { return truncateLabel(n, 9); }).join(' ');
      el.appendChild(line);
    }
  }
  function bindVisualViewport() {
    const vv = window.visualViewport;
    const shell = document.querySelector('.container');
    if (!shell) return;
    const sync = function() {
      shell.style.height = (vv ? vv.height : window.innerHeight) + 'px';
      shell.style.top = (vv ? (vv.offsetTop || 0) : 0) + 'px';
    };
    if (vv) { vv.addEventListener('resize', sync); vv.addEventListener('scroll', sync); }
    window.addEventListener('resize', sync);
    sync();
    const input = document.getElementById('msg-input');
    if (!input) return;
    const place = function() { window.scrollTo(0, 0); sync(); };
    input.addEventListener('focus', function() { place(); setTimeout(place, 60); setTimeout(place, 300); });
    input.addEventListener('blur', function() { setTimeout(place, 80); });
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
    }, { passive: true });
    scroller.addEventListener('touchmove', function(e) {
      if (!pulling) return;
      if (e.touches[0].clientY - startY > 36) indicator.classList.add('show');
    }, { passive: true });
    scroller.addEventListener('touchend', function() {
      if (indicator.classList.contains('show') && pulling) refreshRoom();
      else indicator.classList.remove('show');
      pulling = false;
    });
  }
  function refreshRoom() {
    if (!currentRoomId || !userSessionId) return;
    refreshing = true;
    document.getElementById('pull-indicator').classList.add('show');
    socket.emit('rejoin_room', { roomId: currentRoomId, sessionId: userSessionId, nickname: myNickname });
    setTimeout(function() {
      refreshing = false;
      const ind = document.getElementById('pull-indicator');
      if (ind) ind.classList.remove('show');
    }, 4000);
  }
  function scrollMessageFully(el) {
    const container = document.getElementById('chat-messages');
    if (!el || !container) return;
    const run = function() {
      const bottom = el.offsetTop + el.offsetHeight;
      const viewBottom = container.scrollTop + container.clientHeight;
      if (bottom > viewBottom - 8) container.scrollTop = bottom - container.clientHeight + 16;
    };
    run();
    const img = el.querySelector('img');
    if (img) {
      if (!img.complete) img.addEventListener('load', run, { once: true });
      setTimeout(run, 80);
      setTimeout(run, 240);
    }
  }
  function updatePublicRoomStatus() {
    fetch('/api/public-count').then(function(r) { return r.json(); }).then(function(data) {
      const el = document.getElementById('public-room-status');
      if (!el) return;
      const c = (data && typeof data.count === 'number') ? data.count : 0;
      el.textContent = '入室中: ' + c + ' 人';
    }).catch(function() {});
  }
  function startPublicCountPolling() {
    stopPublicCountPolling();
    updatePublicRoomStatus();
    publicCountTimer = setInterval(updatePublicRoomStatus, 5000);
  }
  function stopPublicCountPolling() {
    if (publicCountTimer) { clearInterval(publicCountTimer); publicCountTimer = null; }
  }
  function enterPublicRoom() {
    const nick = prompt('ニックネームを入力してください', 'ゲスト');
    if (nick === null) return;
    myNickname = (nick || 'ゲスト').trim().substring(0, 20) || 'ゲスト';
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
      if (res.success) {
        isHost = false;
        currentRoomId = res.roomId || PUBLIC_ROOM_ID;
        currentRoomName = res.roomName || '公開ルーム';
        currentMaxMembers = res.maxMembers || 50;
        currentImageDisplaySeconds = res.imageDisplaySeconds || 5;
        isPublicRoom = true;
        setupChatView(currentRoomId, currentRoomName, res.messages || [], currentMaxMembers, currentImageDisplaySeconds, res.members || []);
        // 公開ルームは招待リンクコピー・部屋削除・キック非表示
        document.getElementById('header-copy-btn').style.display = 'none';
        document.getElementById('btn-delete-room').style.display = 'none';
        document.getElementById('btn-kick').style.display = 'none';
        window.history.pushState({}, '', window.location.pathname);
        window.location.hash = '';
      } else if (res.full) {
        showToast('現在満員です', function() { goHome(true); });
      } else {
        alert(res.error || '入室に失敗しました');
        isPublicRoom = false;
      }
    });
  }
  socket.on('connect', function() {
    if (currentRoomId && userSessionId) {
      socket.emit('rejoin_room', { roomId: currentRoomId, sessionId: userSessionId, nickname: myNickname });
    }
  });
  socket.on('disconnect', function() { stopKeepAlive(); });
  socket.on('room_state_sync', function(data) {
    if (!data || data.roomId !== currentRoomId) return;
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
        else { noteActivity(); renderSingleMessage(msg, true); }
      });
    }
    refreshing = false;
    const ind = document.getElementById('pull-indicator');
    if (ind) ind.classList.remove('show');
  });
  socket.on('receive_message', function(msg) {
    if (!msg) return;
    if (msg.type === 'system') renderSystemNotification(msg.text, msg.id);
    else { noteActivity(); renderSingleMessage(msg, false); }
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
    document.getElementById('typing-indicator').innerText = data.isTyping ? (data.nickname + ' が入力中...') : '';
  });
  socket.on('room_deleted_by_host', function(data) {
    const reason = (data && data.reason === 'inactivity') ? '1ヶ月間無発話のため、部屋は自動削除されました。' : '部屋主によってこの部屋は削除されました。';
    if (currentRoomId) removeRoomFromStorage(currentRoomId);
    alert(reason);
    goHome(true);
  });
  socket.on('force_left', function() { stopKeepAlive(); goHome(true); });
  socket.on('room_full_rejected', function() { showToast('現在満員です', function() { goHome(true); }); });
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
      btn.textContent = '退室';
      btn.onclick = function() { confirmKick(m.sessionId, m.nickname); };
      div.appendChild(btn);
      list.appendChild(div);
    });
  });
  function encryptText(plainText, key) {
    if (!plainText) return '';
    try { return CryptoJS.AES.encrypt(plainText, key).toString(); } catch (e) { return plainText; }
  }
  function decryptText(cipherText, key) {
    if (!cipherText) return '';
    if (!key) return '(鍵がありません)';
    try {
      const bytes = CryptoJS.AES.decrypt(cipherText, key);
      return bytes.toString(CryptoJS.enc.Utf8) || '(復号エラー)';
    } catch (e) { return '(復号失敗)'; }
  }
  function generateKey() {
    const wa = CryptoJS.lib.WordArray.random(16);
    const b64 = CryptoJS.enc.Base64.stringify(wa);
    return b64.replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  }
  function getOrCreateSessionId() {
    let sid = sessionStorage.getItem('userSessionId');
    if (!sid) {
      sid = localStorage.getItem('userSessionId');
      if (!sid) {
        sid = Math.random().toString(36).substring(2, 10);
        localStorage.setItem('userSessionId', sid);
      }
      sessionStorage.setItem('userSessionId', sid);
    }
    return sid;
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
  function getKeyFromHash() {
    const hash = window.location.hash;
    if (!hash) return '';
    if (hash.startsWith('#k=')) return decodeURIComponent(hash.substring(3));
    if (hash.startsWith('#key=')) return decodeURIComponent(hash.substring(5));
    return '';
  }
  function setKeyToHash(key) { window.location.hash = 'k=' + encodeURIComponent(key); }
  function getSavedRooms() {
    try { return JSON.parse(localStorage.getItem('myJoinedRooms') || '{}'); } catch (e) { return {}; }
  }
  function saveRoomToStorage(roomId, roomName, nickname, key, isHostFlag) {
    if (roomId === PUBLIC_ROOM_ID) return; // 公開ルームは保存しない
    const store = getSavedRooms();
    store[roomId] = { roomId: roomId, roomName: roomName, nickname: nickname, key: key, isHost: !!isHostFlag, updatedAt: Date.now() };
    localStorage.setItem('myJoinedRooms', JSON.stringify(store));
  }
  function removeRoomFromStorage(roomId) {
    const store = getSavedRooms();
    delete store[roomId];
    localStorage.setItem('myJoinedRooms', JSON.stringify(store));
  }
  function renderSavedRoomsList() {
    const store = getSavedRooms();
    const container = document.getElementById('my-rooms-list');
    const section = document.getElementById('my-rooms-section');
    if (!container || !section) return;
    container.innerHTML = '';
    const ids = Object.keys(store).filter(function(id) { return id !== PUBLIC_ROOM_ID; });
    if (ids.length === 0) { section.style.display = 'none'; return; }
    ids.sort(function(a, b) { return (store[b].updatedAt || 0) - (store[a].updatedAt || 0); });
    section.style.display = 'block';
    ids.forEach(function(id) {
      const r = store[id];
      const card = document.createElement('div');
      card.className = 'room-card';
      card.onclick = function() { quickJoin(id); };
      const roleLabel = r.isHost ? '作成者' : '参加者';
      card.innerHTML = '<div class="room-card-info"><div class="room-card-name">' + escapeHtml(r.roomName || r.roomId || id) + '</div><div class="room-card-meta">' + escapeHtml(r.nickname || '') + '（' + roleLabel + '）</div></div><span style="font-size:0.8rem;color:var(--accent-color);flex-shrink:0;">入室 →</span>';
      container.appendChild(card);
    });
  }
  function quickJoin(roomId) {
    const r = getSavedRooms()[roomId];
    if (!r || !r.key) {
      currentRoomId = roomId;
      currentRoomName = (r && r.roomName) || roomId;
      document.getElementById('join-target-room-title').innerText = '「' + currentRoomName + '」に入室';
      document.getElementById('join-key-warning').style.display = 'block';
      showView('view-join');
      return;
    }
    currentRoomId = roomId;
    currentRoomName = r.roomName || roomId;
    currentKey = r.key;
    myNickname = r.nickname || 'ゲスト';
    isHost = !!r.isHost;
    isPublicRoom = false;
    socket.emit('join_room', { roomId: currentRoomId, nickname: myNickname, sessionId: userSessionId }, function(res) {
      if (res.success) {
        isHost = res.isHost || isHost;
        currentRoomId = res.roomId || currentRoomId;
        currentRoomName = res.roomName || currentRoomName;
        currentMaxMembers = res.maxMembers || 3;
        currentImageDisplaySeconds = res.imageDisplaySeconds || 5;
        saveRoomToStorage(currentRoomId, currentRoomName, myNickname, currentKey, isHost);
        setupChatView(currentRoomId, currentRoomName, res.messages || [], currentMaxMembers, currentImageDisplaySeconds, res.members || []);
        if (isHost) startKeepAlive();
        window.history.pushState({}, '', '?r=' + encodeURIComponent(currentRoomId));
        setKeyToHash(currentKey);
      } else if (res.full) showToast('現在満員です', function() { goHome(true); });
      else {
        alert(res.error || '入室に失敗しました（部屋が削除された可能性があります）');
        removeRoomFromStorage(roomId);
        renderSavedRoomsList();
      }
    });
  }
  window.onload = function() {
    userSessionId = getOrCreateSessionId();
    renderSavedRoomsList();
    bindVisualViewport();
    setupPullToRefresh();
    startPublicCountPolling();
    const urlParams = new URLSearchParams(window.location.search);
    const urlRoomRef = urlParams.get('r') || urlParams.get('room');
    const keyFromHash = getKeyFromHash();
    if (urlRoomRef) {
      currentRoomId = urlRoomRef;
      currentRoomName = urlRoomRef;
      const saved = getSavedRooms()[urlRoomRef];
      if (saved && saved.key) {
        currentKey = saved.key;
        currentRoomName = saved.roomName || urlRoomRef;
        myNickname = saved.nickname || '';
        isHost = !!saved.isHost;
        if (myNickname) document.getElementById('join-nickname').value = myNickname;
      }
      if (keyFromHash) currentKey = keyFromHash;
      document.getElementById('join-target-room-title').innerText = '部屋に入室';
      document.getElementById('join-key-warning').style.display = currentKey ? 'none' : 'block';
      showView('view-join');
    }
  };
  function showToast(message, callback) {
    const overlay = document.getElementById('full-overlay');
    document.getElementById('toast-text').innerText = message;
    overlay.style.display = 'flex';
    setTimeout(function() { overlay.style.display = 'none'; if (callback) callback(); }, 2000);
  }
  function showView(id) {
    document.querySelectorAll('.view').forEach(function(v) { v.classList.remove('active'); });
    document.getElementById(id).classList.add('active');
    if (id === 'view-home') startPublicCountPolling();
    else stopPublicCountPolling();
  }
  function goHome(skipLeave) {
    if (!skipLeave && currentRoomId && userSessionId) {
      socket.emit('leave_room', { roomId: currentRoomId, sessionId: userSessionId });
    }
    stopKeepAlive();
    currentRoomId = '';
    currentRoomName = '';
    currentKey = '';
    isHost = false;
    isPublicRoom = false;
    window.history.pushState({}, '', window.location.pathname);
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
    const name = (document.getElementById('create-room-name').value || '').trim();
    myNickname = (document.getElementById('create-nickname').value || '部屋主').trim().substring(0, 20);
    const maxMembersRadio = document.querySelector('input[name="max-members"]:checked');
    const maxMembers = maxMembersRadio ? parseInt(maxMembersRadio.value, 10) : 3;
    if (!name) return alert('部屋名を入力してください');
    if (name.length > 30) return alert('部屋名は30文字以内にしてください');
    if (name === '公開ルーム' || name.toLowerCase() === 'public') return alert('この部屋名は使用できません');
    currentKey = generateKey();
    currentRoomName = name;
    currentMaxMembers = maxMembers;
    isHost = true;
    isPublicRoom = false;
    socket.emit('create_room', { name: name, nickname: myNickname, sessionId: userSessionId, maxMembers: maxMembers }, function(res) {
      if (res.success) {
        currentRoomId = res.roomId;
        currentRoomName = res.roomName || name;
        setKeyToHash(currentKey);
        saveRoomToStorage(currentRoomId, currentRoomName, myNickname, currentKey, true);
        setupChatView(currentRoomId, currentRoomName, res.messages || [], maxMembers, res.imageDisplaySeconds || 5, res.members || [myNickname]);
        startKeepAlive();
      } else {
        alert(res.error || '部屋の作成に失敗しました');
        currentKey = ''; currentRoomId = ''; currentRoomName = ''; isHost = false;
      }
    });
  }
  function checkRoomJoin() {
    const roomName = (document.getElementById('join-room-name').value || '').trim();
    if (!roomName) return alert('部屋名を入力してください');
    currentRoomId = '';
    currentRoomName = roomName;
    const keyFromHash = getKeyFromHash();
    if (keyFromHash) currentKey = keyFromHash;
    document.getElementById('join-target-room-title').innerText = '「' + roomName + '」に入室';
    document.getElementById('join-key-warning').style.display = currentKey ? 'none' : 'block';
    showView('view-join');
  }
  function joinRoom() {
    myNickname = (document.getElementById('join-nickname').value || 'ゲスト').trim().substring(0, 20);
    if (!currentKey) return alert('暗号化鍵がありません。招待リンクから入室してください。');
    isPublicRoom = false;
    socket.emit('join_room', { roomId: currentRoomId || undefined, roomName: currentRoomName || undefined, nickname: myNickname, sessionId: userSessionId }, function(res) {
      if (res.success) {
        isHost = res.isHost || false;
        currentRoomId = res.roomId;
        currentRoomName = res.roomName || currentRoomName;
        currentMaxMembers = res.maxMembers || 3;
        currentImageDisplaySeconds = res.imageDisplaySeconds || 5;
        saveRoomToStorage(currentRoomId, currentRoomName, myNickname, currentKey, isHost);
        setupChatView(currentRoomId, currentRoomName, res.messages || [], currentMaxMembers, currentImageDisplaySeconds, res.members || []);
        if (isHost) startKeepAlive();
        window.history.pushState({}, '', '?r=' + encodeURIComponent(currentRoomId));
        setKeyToHash(currentKey);
      } else if (res.full) showToast('現在満員です', function() { goHome(true); });
      else alert(res.error || '入室に失敗しました');
    });
  }
  function leaveRoom() {
    if (confirm('本当にこの部屋から退室しますか？\\n\\n※部屋作成者が退室しても部屋は残ります。\\n　部屋を消す場合は「部屋削除」を使ってください。')) {
      socket.emit('leave_room', { roomId: currentRoomId, sessionId: userSessionId });
      goHome(true);
    }
  }
  function deleteRoom() {
    if (isPublicRoom || currentRoomId === PUBLIC_ROOM_ID) return alert('公開ルームは削除できません');
    if (confirm('【警告】本当にこの部屋を削除しますか？\\n参加者全員が退室し、部屋は消滅します。')) {
      const idToRemove = currentRoomId;
      socket.emit('delete_room', { roomId: currentRoomId }, function(res) {
        if (res.success) { removeRoomFromStorage(idToRemove); alert('部屋を削除しました'); goHome(true); }
        else alert(res.error || '削除権限がありません');
      });
    }
  }
  function openKickModal() {
    if (isPublicRoom || currentRoomId === PUBLIC_ROOM_ID) return;
    socket.emit('get_members_for_kick', { roomId: currentRoomId });
    document.getElementById('kick-modal').classList.add('active');
  }
  function closeKickModal() { document.getElementById('kick-modal').classList.remove('active'); }
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
    socket.emit('force_kick', { roomId: currentRoomId, targetSessionId: pendingKickSessionId }, function(res) {
      closeKickConfirmModal();
      if (!res.success) alert(res.error || '退室させられませんでした');
    });
  };
  function setupChatView(roomId, roomName, messages, maxMembers, imageDisplaySeconds, members) {
    currentRoomId = roomId;
    currentRoomName = roomName || roomId;
    currentMaxMembers = maxMembers || 3;
    currentImageDisplaySeconds = imageDisplaySeconds || 5;
    noteActivity();
    setRoomTitle(currentRoomName);
    document.getElementById('header-copy-btn').style.display = (isPublicRoom || roomId === PUBLIC_ROOM_ID) ? 'none' : 'inline-flex';
    document.getElementById('header-room-id-container').style.display = 'flex';
    document.getElementById('display-time-control').style.display = 'flex';
    const sel = document.getElementById('image-display-select');
    if (sel) sel.value = String(currentImageDisplaySeconds);
    document.getElementById('btn-delete-room').style.display = (isHost && !isPublicRoom && roomId !== PUBLIC_ROOM_ID) ? 'flex' : 'none';
    document.getElementById('btn-kick').style.display = (isHost && !isPublicRoom && roomId !== PUBLIC_ROOM_ID) ? 'flex' : 'none';
    if (Array.isArray(members)) updateMemberCount(members.length, currentMaxMembers, members);
    if (!isPublicRoom && roomId !== PUBLIC_ROOM_ID) {
      window.history.pushState({}, '', '?r=' + encodeURIComponent(currentRoomId));
      if (currentKey) setKeyToHash(currentKey);
    }
    showView('view-chat');
    const container = document.getElementById('chat-messages');
    container.innerHTML = '';
    (messages || []).forEach(function(msg) {
      if (msg.type === 'system') renderSystemNotification(msg.text, msg.id);
      else renderSingleMessage(msg, true);
    });
  }
  function copyRoomLink() {
    if (isPublicRoom || currentRoomId === PUBLIC_ROOM_ID) return;
    const url = window.location.origin + '?r=' + encodeURIComponent(currentRoomId) + '#k=' + encodeURIComponent(currentKey);
    navigator.clipboard.writeText(url).then(function() {
      alert('招待リンクをコピーしました！\\n（短い部屋IDと暗号化鍵が含まれています）');
    }).catch(function() { prompt('このリンクをコピーしてください', url); });
  }
  function changeImageDisplayTime() {
    const seconds = parseInt(document.getElementById('image-display-select').value, 10);
    if (isNaN(seconds) || ![0, 1, 3, 5, 3600].includes(seconds)) return;
    noteActivity();
    socket.emit('change_image_display_time', { roomId: currentRoomId, seconds: seconds });
  }
  function startKeepAlive() {
    stopKeepAlive();
    if (!isHost) return;
    lastChatActivityAt = Date.now();
    keepAliveTimer = setInterval(function() {
      if (!socket.connected || !currentRoomId || !isHost) return;
      if (Date.now() - lastChatActivityAt >= 5 * 60 * 1000) {
        socket.emit('keep_alive', { roomId: currentRoomId });
        fetch('/api/ping').catch(function() {});
      }
    }, 60 * 1000);
  }
  function stopKeepAlive() { if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; } }
  function onFileSelected(input) {
    if (input.files && input.files[0]) {
      selectedFile = input.files[0];
      const preview = document.getElementById('file-name-preview');
      preview.innerText = '選択中: ' + selectedFile.name;
      preview.style.display = 'block';
    }
  }
  function handleTyping() {
    if (!isTyping) { isTyping = true; socket.emit('typing_start', { roomId: currentRoomId }); }
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(function() { stopTyping(); }, 2000);
  }
  function stopTyping() {
    if (isTyping) { isTyping = false; socket.emit('typing_stop', { roomId: currentRoomId }); }
    clearTimeout(typingTimeout);
  }
  function onKeyDown(e) {
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    if (!isMobile && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  }
  async function sendMessage() {
    const input = document.getElementById('msg-input');
    const text = input.value.trim();
    let imageUrl = null;
    let thumbBase64 = null;
    if (!text && !selectedFile) return;
    if (!currentKey) return alert('暗号化鍵がありません');
    stopTyping();
    noteActivity();
    let displaySeconds = currentImageDisplaySeconds;
    if (text && selectedFile && currentImageDisplaySeconds !== 0) displaySeconds = 3600;
    if (selectedFile) {
      try { thumbBase64 = await createUltraLightThumbnail(selectedFile); } catch (e) {}
      if (displaySeconds !== 0) {
        const formData = new FormData();
        formData.append('image', selectedFile);
        try {
          const res = await fetch('/api/upload', { method: 'POST', body: formData });
          const data = await res.json();
          imageUrl = data.imageUrl;
        } catch (e) { alert('画像のアップロードに失敗しました'); return; }
      }
    }
    socket.emit('send_message', {
      msgId: Math.random().toString(36).substring(2, 10),
      roomId: currentRoomId,
      text: text ? encryptText(text, currentKey) : '',
      image: imageUrl,
      thumb: thumbBase64,
      displaySeconds: displaySeconds
    });
    input.value = '';
    selectedFile = null;
    document.getElementById('file-input').value = '';
    document.getElementById('file-name-preview').style.display = 'none';
  }
  function deleteMessage(msgId) { socket.emit('delete_message', { roomId: currentRoomId, msgId: msgId }); }
  const messageMeta = {};
  function handleImageExpire(imgEl, msgId, thumbBase64) {
    imgEl.style.display = 'none';
    imgEl.dataset.expired = '1';
    if (thumbBase64) {
      const thumbImg = document.createElement('img');
      thumbImg.src = thumbBase64;
      thumbImg.className = 'chat-img-poster-thumb';
      thumbImg.style.cursor = 'default';
      imgEl.parentNode.appendChild(thumbImg);
      const note = document.createElement('div');
      note.className = 'poster-only-note';
      note.innerText = '時間経過につき粗サムネのみ表示';
      imgEl.parentNode.appendChild(note);
      scrollMessageFully(imgEl.parentNode);
      return;
    }
    const note = document.createElement('div');
    note.className = 'expired-img-note';
    note.innerText = '🔒 画像の表示期限が切れました';
    imgEl.parentNode.appendChild(note);
  }
  function startImageExpireTimer(imgEl, msgId, thumbBase64, displaySec, postedAt, isHistory) {
    if (!imgEl || displaySec <= 0) return;
    const runExpire = function(delayMs) {
      setTimeout(function() {
        if (imgEl && imgEl.parentNode && imgEl.dataset.expired !== '1') handleImageExpire(imgEl, msgId, thumbBase64);
      }, Math.max(0, delayMs));
    };
    if (isHistory) { runExpire(displaySec * 1000 - (Date.now() - (postedAt || Date.now()))); return; }
    const startFromVisible = function() { runExpire(displaySec * 1000); };
    const rect = imgEl.getBoundingClientRect();
    if (rect.top < window.innerHeight && rect.bottom > 0) { startFromVisible(); return; }
    if (!('IntersectionObserver' in window)) { startFromVisible(); return; }
    const observer = new IntersectionObserver(function(entries) {
      entries.forEach(function(entry) {
        if (entry.isIntersecting) { observer.disconnect(); startFromVisible(); }
      });
    }, { threshold: 0.2 });
    observer.observe(imgEl);
  }
  function renderSingleMessage(msg, isHistory) {
    const container = document.getElementById('chat-messages');
    if (document.getElementById('msg-' + msg.id)) return;
    const div = document.createElement('div');
    const isSelf = (msg.sessionId === userSessionId);
    div.className = 'message ' + (isSelf ? 'self' : ('user-color-' + (msg.colorIndex || 0) % 4));
    div.id = 'msg-' + msg.id;
    const plainText = msg.text ? decryptText(msg.text, currentKey) : '';
    const displaySec = (typeof msg.displaySeconds === 'number') ? msg.displaySeconds : currentImageDisplaySeconds;
    const postedAt = msg.postedAt || Date.now();
    if (msg.image || msg.thumb) {
      messageMeta[msg.id] = { image: msg.image || null, thumb: msg.thumb || null, displaySeconds: displaySec, postedAt: postedAt, thumbOnly: displaySec === 0 || !msg.image };
    }
    let html = '';
    if (isSelf) html += '<span class="del-btn" onclick="deleteMessage(\\'' + msg.id + '\\')">✕</span>';
    html += '<div class="sender">' + escapeHtml(msg.senderName) + '</div>';
    if (plainText) html += '<div class="text-content">' + escapeHtml(plainText) + '</div>';
    if (displaySec === 0 && msg.thumb) {
      html += '<img src="' + msg.thumb + '" class="chat-img-poster-thumb" style="cursor:default;" oncontextmenu="return false;">';
      html += '<div class="poster-only-note">粗サムネのみ表示</div>';
    } else if (msg.image) {
      html += '<img src="' + msg.image + '" class="chat-img" id="img-' + msg.id + '" onclick="openImageModal(\\'' + msg.id + '\\')" oncontextmenu="return false;">';
    } else if (msg.thumb) {
      html += '<img src="' + msg.thumb + '" class="chat-img-poster-thumb" style="cursor:default;" oncontextmenu="return false;">';
      html += '<div class="poster-only-note">粗サムネのみ表示</div>';
    }
    div.innerHTML = html;
    container.appendChild(div);
    scrollMessageFully(div);
    if (msg.image && displaySec !== 0) {
      const imgEl = document.getElementById('img-' + msg.id);
      if (imgEl) startImageExpireTimer(imgEl, msg.id, msg.thumb || null, displaySec, postedAt, !!isHistory);
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
    setTimeout(function() { el.classList.remove('show'); }, 1000);
  }
  function openImageModal(msgId) {
    const meta = messageMeta[msgId];
    if (!meta || meta.thumbOnly || meta.displaySeconds === 0 || !meta.image) return;
    const elapsed = Date.now() - (meta.postedAt || Date.now());
    if (meta.displaySeconds < 3600 && elapsed > meta.displaySeconds * 1000 + 120000) return;
    const modal = document.getElementById('image-modal');
    const img = document.getElementById('image-modal-img');
    const note = document.getElementById('image-modal-note');
    if (imageModalTimer) { clearTimeout(imageModalTimer); imageModalTimer = null; }
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
  function closeImageModal(event, force) {
    if (event) {
      if (!force && event.target && event.target.id === 'image-modal-img') return;
      event.stopPropagation();
    }
    const shown = Date.now() - imageModalOpenedAt;
    if (shown < 1000 && !force) { setTimeout(function() { closeImageModal(null, true); }, 1000 - shown); return; }
    const modal = document.getElementById('image-modal');
    if (modal) modal.classList.remove('active');
    if (imageModalTimer) { clearTimeout(imageModalTimer); imageModalTimer = null; }
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
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }
</script>
</body>
</html>
  `);
});

io.on('connection', (socket) => {
  function setSocketSession(roomId, sessionId) {
    socket.data.roomId = roomId;
    socket.data.sessionId = sessionId;
  }
  function emitMemberCount(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    const active = getActiveMembers(room);
    io.to(roomId).emit('update_members', { count: active.length, maxMembers: room.maxMembers, members: active.map(m => m.nickname) });
  }
  function syncRoomToSocket(targetSocket, roomId) {
    const room = rooms[roomId];
    if (!room) return;
    const active = getActiveMembers(room);
    targetSocket.emit('room_state_sync', {
      roomId: roomId, roomName: room.name, count: active.length, maxMembers: room.maxMembers,
      members: active.map(m => m.nickname), imageDisplaySeconds: room.imageDisplaySeconds, messages: room.messages
    });
  }
  socket.on('keep_alive', () => {});
  socket.on('rejoin_room', ({ roomId, sessionId, nickname }) => {
    ensurePublicRoom();
    const room = rooms[roomId];
    if (!room) return;
    socket.join(roomId);
    setSocketSession(roomId, sessionId);
    let member = room.members.find(m => m.sessionId === sessionId);
    if (member) {
      member.id = socket.id;
      if (nickname) member.nickname = nickname;
    } else if (getActiveMembers(room).length < room.maxMembers) {
      room.members.push({ id: socket.id, sessionId, nickname: nickname || 'ゲスト', colorIndex: room.members.length % 4 });
    }
    room.lastActivityAt = Date.now();
    syncRoomToSocket(socket, roomId);
    emitMemberCount(roomId);
  });
  socket.on('create_room', ({ name, nickname, sessionId, maxMembers }, callback) => {
    if (!name || typeof name !== 'string') return callback({ success: false, error: '部屋名が不正です' });
    const roomName = name.trim().substring(0, 30);
    if (!roomName) return callback({ success: false, error: '部屋名を入力してください' });
    if (roomName === PUBLIC_ROOM_NAME || roomName.toLowerCase() === 'public') {
      return callback({ success: false, error: 'この部屋名は使用できません' });
    }
    if (roomNameToId[roomName]) return callback({ success: false, error: 'この部屋名は既に使われています。別の名前にしてください。' });
    const safeMax = [3, 4, 5].includes(maxMembers) ? maxMembers : 3;
    const roomId = generateRoomId();
    const nick = nickname || '部屋主';
    const initialSystemMsg = { type: 'system', id: 'system-' + Math.random().toString(36).substring(2, 10), text: nick + ' が入室しました' };
    rooms[roomId] = {
      id: roomId, name: roomName, hostSessionId: sessionId, maxMembers: safeMax, imageDisplaySeconds: 5,
      members: [{ id: socket.id, sessionId, nickname: nick, colorIndex: 0 }],
      messages: [initialSystemMsg], lastActivityAt: Date.now()
    };
    roomNameToId[roomName] = roomId;
    socket.join(roomId);
    setSocketSession(roomId, sessionId);
    callback({ success: true, roomId, roomName, messages: [initialSystemMsg], isHost: true, maxMembers: safeMax, imageDisplaySeconds: 5, memberCount: 1, members: [nick] });
    emitMemberCount(roomId);
  });
  socket.on('join_room', ({ roomId, roomName, nickname, sessionId }, callback) => {
    ensurePublicRoom();
    const id = resolveRoomId(roomId, roomName);
    const room = id ? rooms[id] : null;
    if (!room) return callback({ success: false, error: '部屋が存在しません。部屋名を確認するか、新しく作成してください。' });
    const existingMember = room.members.find(m => m.sessionId === sessionId);
    const activeMembers = room.members.filter(m => m.id !== null && m.sessionId !== sessionId);
    if (!existingMember && activeMembers.length >= room.maxMembers) {
      socket.emit('room_full_rejected');
      return callback({ success: false, full: true, error: '現在満員です' });
    }
    if (!existingMember) room.members.push({ id: socket.id, sessionId, nickname: nickname || 'ゲスト', colorIndex: room.members.length % 4 });
    else { existingMember.id = socket.id; existingMember.nickname = nickname || existingMember.nickname; }
    room.lastActivityAt = Date.now();
    socket.join(id);
    setSocketSession(id, sessionId);
    const systemMsg = { type: 'system', id: 'system-' + Math.random().toString(36).substring(2, 10), text: (nickname || 'ゲスト') + ' が入室しました' };
    room.messages.push(systemMsg);
    // 公開ルームはメッセージ数を制限（使い切り寄り）
    if (room.isPublic && room.messages.length > 100) {
      room.messages = room.messages.slice(-80);
    }
    callback({
      success: true, roomId: id, roomName: room.name, messages: room.messages, isHost: room.hostSessionId === sessionId,
      maxMembers: room.maxMembers, imageDisplaySeconds: room.imageDisplaySeconds,
      memberCount: getActiveMembers(room).length, members: getMemberNames(room)
    });
    setTimeout(() => { if (rooms[id]) { io.to(id).emit('receive_message', systemMsg); emitMemberCount(id); } }, 0);
  });
  socket.on('leave_room', ({ roomId, sessionId }) => {
    const targetId = roomId || socket.data.roomId;
    const room = rooms[targetId];
    if (!room) return;
    const sid = sessionId || socket.data.sessionId;
    const member = room.members.find(m => m.sessionId === sid || m.id === socket.id);
    if (!member) return;
    member.id = null;
    room.lastActivityAt = Date.now();
    const systemMsg = { type: 'system', id: 'system-' + Math.random().toString(36).substring(2, 10), text: member.nickname + ' が退室しました' };
    room.messages.push(systemMsg);
    if (room.isPublic && room.messages.length > 100) {
      room.messages = room.messages.slice(-80);
    }
    io.to(targetId).emit('receive_message', systemMsg);
    emitMemberCount(targetId);
    socket.leave(targetId);
    socket.data.roomId = null;
  });
  socket.on('delete_room', ({ roomId }, callback) => {
    const targetId = roomId || socket.data.roomId;
    if (targetId === PUBLIC_ROOM_ID) return callback({ success: false, error: '公開ルームは削除できません' });
    const room = rooms[targetId];
    if (!room) return callback({ success: false, error: '部屋が存在しません' });
    if (room.hostSessionId !== socket.data.sessionId) return callback({ success: false, error: '部屋を削除する権限がありません' });
    room.messages.forEach(msg => {
      if (msg.image) {
        const filePath = path.join(uploadDir, path.basename(msg.image));
        if (fs.existsSync(filePath)) fs.unlink(filePath, () => {});
      }
    });
    if (room.name && roomNameToId[room.name] === targetId) delete roomNameToId[room.name];
    io.to(targetId).emit('room_deleted_by_host');
    delete rooms[targetId];
    callback({ success: true });
  });
  socket.on('get_members_for_kick', ({ roomId }) => {
    if (roomId === PUBLIC_ROOM_ID) return;
    const room = rooms[roomId];
    if (!room || room.hostSessionId !== socket.data.sessionId) return;
    socket.emit('members_for_kick', { members: room.members.filter(m => m.id !== null && m.sessionId !== socket.data.sessionId).map(m => ({ sessionId: m.sessionId, nickname: m.nickname })) });
  });
  socket.on('force_kick', ({ roomId, targetSessionId }, callback) => {
    if (roomId === PUBLIC_ROOM_ID) return callback({ success: false, error: '公開ルームでは強制退室できません' });
    const room = rooms[roomId];
    if (!room) return callback({ success: false, error: '部屋が存在しません' });
    if (room.hostSessionId !== socket.data.sessionId) return callback({ success: false, error: '権限がありません' });
    if (targetSessionId === room.hostSessionId) return callback({ success: false, error: '自分自身は退室させられません' });
    const target = room.members.find(m => m.sessionId === targetSessionId);
    if (!target || !target.id) return callback({ success: false, error: '対象のメンバーが見つかりません' });
    const targetSocket = io.sockets.sockets.get(target.id);
    if (targetSocket) { targetSocket.emit('force_left'); targetSocket.leave(roomId); targetSocket.data.roomId = null; }
    target.id = null;
    emitMemberCount(roomId);
    callback({ success: true });
  });
  socket.on('change_image_display_time', ({ roomId, seconds }) => {
    const room = rooms[roomId];
    if (!room || ![0, 1, 3, 5, 3600].includes(seconds)) return;
    room.imageDisplaySeconds = seconds;
    room.lastActivityAt = Date.now();
    let label = seconds + '秒';
    if (seconds === 0) label = '粗サムネのみ';
    else if (seconds === 3600) label = '1時間';
    const systemMsg = { type: 'system', id: 'system-' + Math.random().toString(36).substring(2, 10), text: '画像表示時間が' + label + 'に切り替わりました' };
    room.messages.push(systemMsg);
    io.to(roomId).emit('image_display_changed', { seconds: seconds, text: systemMsg.text, id: systemMsg.id });
  });
  socket.on('typing_start', ({ roomId }) => {
    const targetId = roomId || socket.data.roomId;
    const room = rooms[targetId];
    if (!room) return;
    const sender = room.members.find(m => m.id === socket.id);
    if (sender) socket.to(targetId).emit('display_typing', { nickname: sender.nickname, isTyping: true });
  });
  socket.on('typing_stop', ({ roomId }) => {
    socket.to(roomId || socket.data.roomId).emit('display_typing', { isTyping: false });
  });
  socket.on('send_message', ({ msgId, roomId, text, image, thumb, displaySeconds }) => {
    const targetId = roomId || socket.data.roomId;
    const room = rooms[targetId];
    if (!room) return;
    const sessionId = socket.data.sessionId;
    let sender = room.members.find(m => m.sessionId === sessionId || m.id === socket.id);
    if (sender) { sender.id = socket.id; socket.join(targetId); setSocketSession(targetId, sessionId); }
    room.lastActivityAt = Date.now();
    const ds = typeof displaySeconds === 'number' ? displaySeconds : room.imageDisplaySeconds;
    const messageData = {
      type: 'user', id: msgId || Math.random().toString(36).substring(2, 10), sessionId: sessionId,
      senderName: sender ? sender.nickname : '匿名', colorIndex: sender ? sender.colorIndex : 0,
      text, image: image || null, thumb: thumb || null, displaySeconds: ds, postedAt: Date.now()
    };
    if (image) scheduleImageDelete(image, ds);
    room.messages.push(messageData);
    if (room.isPublic && room.messages.length > 100) {
      room.messages = room.messages.slice(-80);
    }
    io.to(targetId).emit('receive_message', messageData);
  });
  socket.on('delete_message', ({ roomId, msgId }) => {
    const targetId = roomId || socket.data.roomId;
    const room = rooms[targetId];
    if (!room) return;
    const targetMsg = room.messages.find(m => m.id === msgId);
    if (targetMsg && targetMsg.sessionId === socket.data.sessionId) {
      room.messages = room.messages.filter(m => m.id !== msgId);
      io.to(targetId).emit('message_deleted', { msgId });
    }
  });
  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (roomId && rooms[roomId]) {
      const member = rooms[roomId].members.find(m => m.id === socket.id);
      if (member) { member.id = null; emitMemberCount(roomId); }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log('Server running on port ' + PORT); });
