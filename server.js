const Express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');

const app = Express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e7 });

// ============================================================
// Supabase / PostgreSQL
// ============================================================

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ============================================================
// DB初期化
// ============================================================

async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rooms (
        room_id VARCHAR(50) PRIMARY KEY,
        room_name VARCHAR(100) NOT NULL,
        password VARCHAR(255),
        host_session_id VARCHAR(100),
        members JSONB NOT NULL DEFAULT '[]'::jsonb,
        messages JSONB NOT NULL DEFAULT '[]'::jsonb,
        last_activity_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 既存roomsテーブルに新しい列がない場合に追加
    await pool.query(`
      ALTER TABLE rooms
      ADD COLUMN IF NOT EXISTS members JSONB NOT NULL DEFAULT '[]'::jsonb;
    `);

    await pool.query(`
      ALTER TABLE rooms
      ADD COLUMN IF NOT EXISTS messages JSONB NOT NULL DEFAULT '[]'::jsonb;
    `);

    console.log('[DB] テーブル初期化完了');
  } catch (err) {
    console.error('[DB] 初期化エラー:', err);
    throw err;
  }
}

// ============================================================
// DB操作
// ============================================================

async function dbSaveRoom(
  roomId,
  roomName,
  password,
  hostSessionId,
  members,
  messages,
  lastActivityAt
) {
  try {
    /*
     * socket.id は永続保存しない。
     *
     * DBへ保存するmembersは
     * sessionId / nickname / colorIndex
     * のみ。
     */
    const safeMembers = (members || []).map(member => ({
      sessionId: member.sessionId,
      nickname: member.nickname,
      colorIndex: member.colorIndex || 0
    }));

    /*
     * 画像は永続保存しない。
     * DBへ保存するmessagesからimageを除外する。
     */
    const safeMessages = (messages || []).map(msg => {
      const saved = {
        type: msg.type,
        id: msg.id,
        text: msg.text || '',
        senderName: msg.senderName || '',
        sessionId: msg.sessionId || null,
        colorIndex: msg.colorIndex || 0
      };

      return saved;
    });

    await pool.query(
      `
      INSERT INTO rooms (
        room_id,
        room_name,
        password,
        host_session_id,
        members,
        messages,
        last_activity_at
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5::jsonb,
        $6::jsonb,
        COALESCE($7, CURRENT_TIMESTAMP)
      )
      ON CONFLICT (room_id)
      DO UPDATE SET
        room_name = EXCLUDED.room_name,
        password = EXCLUDED.password,
        host_session_id = EXCLUDED.host_session_id,
        members = EXCLUDED.members,
        messages = EXCLUDED.messages,
        last_activity_at = EXCLUDED.last_activity_at
      `,
      [
        roomId,
        roomName,
        password,
        hostSessionId,
        JSON.stringify(safeMembers),
        JSON.stringify(safeMessages),
        lastActivityAt ? new Date(lastActivityAt) : new Date()
      ]
    );

    return true;

  } catch (err) {
    console.error('[DB] saveRoomエラー:', err);
    return false;
  }
}

async function dbGetRoom(roomId) {
  try {
    const result = await pool.query(
      `
      SELECT
        room_id,
        room_name,
        password,
        host_session_id,
        members,
        messages,
        last_activity_at,
        created_at
      FROM rooms
      WHERE room_id = $1
      `,
      [roomId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];

    return {
      room_id: row.room_id,
      room_name: row.room_name,
      password: row.password,
      host_session_id: row.host_session_id,
      members: Array.isArray(row.members) ? row.members : [],
      messages: Array.isArray(row.messages) ? row.messages : [],
      last_activity_at: row.last_activity_at,
      created_at: row.created_at
    };

  } catch (err) {
    console.error('[DB] getRoomエラー:', err);
    return null;
  }
}

async function dbDeleteRoom(roomId) {
  try {
    await pool.query(
      'DELETE FROM rooms WHERE room_id = $1',
      [roomId]
    );

    return true;

  } catch (err) {
    console.error('[DB] deleteRoomエラー:', err);
    return false;
  }
}

// ============================================================
// DB → メモリへ部屋を復元
// ============================================================

async function restoreRoomFromDb(roomId) {
  if (!roomId) return null;

  if (rooms[roomId]) {
    return rooms[roomId];
  }

  const dbRoom = await dbGetRoom(roomId);

  if (!dbRoom) {
    return null;
  }

  /*
   * DBにはsocket.idを保存していないため、
   * 再起動後は全memberを一旦非アクティブにする。
   *
   * その後、rejoin_room / join_roomで
   * 現在のsocket.idを付与する。
   */
  const restoredMembers = dbRoom.members.map(member => ({
    id: null,
    sessionId: member.sessionId,
    nickname: member.nickname || 'ゲスト',
    colorIndex: Number(member.colorIndex) || 0
  }));

  const restoredMessages = dbRoom.messages.map(msg => ({
    type: msg.type,
    id: msg.id,
    text: msg.text || '',
    senderName: msg.senderName || '',
    sessionId: msg.sessionId || null,
    colorIndex: Number(msg.colorIndex) || 0
  }));

  rooms[roomId] = {
    name: dbRoom.room_name,
    password: dbRoom.password,
    hostSessionId: dbRoom.host_session_id,
    members: restoredMembers,
    messages: restoredMessages,
    lastActivityAt: dbRoom.last_activity_at
      ? new Date(dbRoom.last_activity_at).getTime()
      : Date.now()
  };

  return rooms[roomId];
}

// ============================================================
// メモリ上の部屋をDBへ保存
// ============================================================

async function persistRoom(roomId) {
  const room = rooms[roomId];

  if (!room) {
    return false;
  }

  return await dbSaveRoom(
    roomId,
    room.name,
    room.password,
    room.hostSessionId,
    room.members,
    room.messages,
    room.lastActivityAt
  );
}

// ============================================================
// 画像アップロード
// ============================================================

const uploadDir = path.join(__dirname, 'uploads');

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },

  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);

    const uniqueName =
      Date.now() +
      '-' +
      Math.round(Math.random() * 1E9) +
      ext;

    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024
  }
});

app.use('/uploads', Express.static(uploadDir));

// ============================================================
// メモリ上の部屋
// ============================================================

const rooms = {};

// ============================================================
// 画像アップロードAPI
// ============================================================

app.post('/api/upload', upload.single('image'), (req, res) => {

  if (!req.file) {
    return res.status(400).json({
      error: 'ファイルがありません'
    });
  }

  const imageUrl = '/uploads/' + req.file.filename;
  const filePath = req.file.path;

  /*
   * 画像は保存不要なので、1時間後に削除。
   */
  setTimeout(() => {

    fs.unlink(filePath, (err) => {

      if (err) {
        console.error(
          '画像自動削除エラー:',
          err
        );
      } else {
        console.log(
          '1時間経過のため画像を自動削除しました:',
          req.file.filename
        );
      }

    });

  }, 60 * 60 * 1000);

  res.json({
    imageUrl
  });
});

// ============================================================
// Webページ
// ============================================================

app.get('/', (req, res) => {

  res.send(`
<!DOCTYPE html>
<html lang="ja">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width, initial-scale=1.0"
>

<meta
  name="robots"
  content="noindex, nofollow"
>

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

* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
  font-family:
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    Roboto,
    sans-serif;
}

body {
  background-color: var(--bg-color);
  color: var(--text-color);
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 100vh;
  padding: 10px;
}

.container {
  width: 100%;
  max-width: 500px;
  background: var(--card-bg);
  border-radius: 16px;
  border: 1px solid var(--border-color);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  height: 90vh;
  position: relative;
}

.header {
  padding: 10px 14px;
  border-bottom: 1px solid var(--border-color);
  background: #111827;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.header-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
  white-space: nowrap;
}

.header .room-name {
  color: var(--accent-color);
  font-weight: bold;
  cursor: pointer;
  white-space: nowrap;
  text-overflow: ellipsis;
  overflow: hidden;
  font-size: 1.05rem;
}

.header-sub-info {
  font-size: 0.75rem;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}

.header-copy-btn {
  background: #334155;
  color: #f8fafc;
  border: none;
  padding: 2px 6px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 0.7rem;
  line-height: 1.2;
  flex-shrink: 0;
  margin: 0;
}

.header-copy-btn:hover {
  background: #475569;
}

.version-tag {
  font-size: 0.65rem;
  color: #64748b;
  flex-shrink: 0;
}

.btn-action-group {
  display: flex;
  gap: 6px;
  width: 100%;
  align-items: center;
  overflow: hidden;
}

.btn-leave {
  background: #64748b;
  color: white;
  border: none;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.75rem;
  font-weight: bold;
  flex: 7;
  min-width: 0;
  text-align: left;
  line-height: 1.2;
  overflow: hidden;
}

.btn-leave:hover {
  background: #475569;
}

.btn-leave .sub-text {
  font-size: 0.6rem;
  font-weight: normal;
  opacity: 0.85;
  display: block;
  margin-top: 1px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.btn-delete-room {
  background: #ef4444;
  color: white;
  border: none;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.75rem;
  font-weight: bold;
  line-height: 1.2;
  white-space: nowrap;
  flex: 3;
  display: none;
  align-items: center;
  justify-content: center;
  height: 100%;
  text-align: center;
}

.btn-delete-room:hover {
  background: #dc2626;
}

.view {
  display: none;
  padding: 20px;
  flex-direction: column;
  height: 100%;
  overflow-y: auto;
}

.view.active {
  display: flex;
}

label {
  font-size: 0.85rem;
  color: var(--text-muted);
  margin-top: 12px;
  display: block;
}

input,
textarea {
  width: 100%;
  padding: 12px;
  margin-top: 6px;
  border-radius: 8px;
  border: 1px solid var(--border-color);
  background: #0f172a;
  color: white;
  outline: none;
}

input:focus,
textarea:focus {
  border-color: var(--accent-color);
}

textarea {
  resize: none;
  height: 44px;
  font-size: 0.9rem;
  line-height: 1.4;
}

button {
  width: 100%;
  padding: 12px;
  margin-top: 18px;
  border-radius: 8px;
  border: none;
  background: var(--accent-color);
  color: #0f172a;
  font-weight: bold;
  cursor: pointer;
}

.btn-secondary {
  background: #475569;
  color: white;
}

.my-rooms-section {
  margin-bottom: 20px;
  display: none;
}

.my-rooms-title {
  font-size: 0.85rem;
  color: var(--text-muted);
  margin-bottom: 8px;
  font-weight: bold;
}

.room-card-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.room-card {
  background: #0f172a;
  border: 1px solid var(--border-color);
  padding: 12px;
  border-radius: 8px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  cursor: pointer;
  transition: 0.2s;
}

.room-card:hover {
  border-color: var(--accent-color);
  background: #172554;
}

.room-card-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.room-card-name {
  font-weight: bold;
  font-size: 0.95rem;
  color: var(--text-color);
}

.room-card-id {
  font-size: 0.75rem;
  color: var(--text-muted);
}

#chat-messages {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-bottom: 10px;
}

.message {
  display: flex;
  flex-direction: column;
  width: fit-content;
  max-width: 80%;
  padding: 8px 12px;
  border-radius: 12px;
  position: relative;
  word-break: break-word;
  align-self: flex-start;
  font-size: 0.85rem;
  line-height: 1.4;
}

.message.self {
  align-self: flex-end;
  background: #0284c7;
  color: white;
}

.message.self .sender {
  color: #e0f2fe;
}

.message.user-color-0 {
  background: #334155;
  color: #f8fafc;
}

.message.user-color-1 {
  background: #1e3a29;
  color: #f8fafc;
  border: 1px solid #2e5d40;
}

.message .sender {
  font-size: 0.75rem;
  color: var(--text-muted);
  margin-bottom: 2px;
  padding-right: 20px;
  font-weight: bold;
}

.message .text-content {
  white-space: pre-wrap;
}

.message .del-btn {
  position: absolute;
  top: 4px;
  right: 8px;
  cursor: pointer;
  color: #fca5a5;
  font-size: 0.75rem;
  opacity: 0;
  transition: 0.2s;
}

.message:hover .del-btn {
  opacity: 1;
}

.system-notification {
  text-align: center;
  font-size: 0.75rem;
  color: var(--text-muted);
  margin: 4px 0;
  align-self: center;
}

.chat-img {
  max-width: 100%;
  max-height: 200px;
  border-radius: 8px;
  margin-top: 6px;
  cursor: pointer;
  user-select: none;
  -webkit-user-drag: none;
}

.chat-img-admin-thumb {
  width: 120px;
  height: auto;
  border-radius: 6px;
  margin-top: 6px;
  image-rendering: pixelated;
  border: 1px dashed var(--accent-color);
}

.expired-img-note {
  font-size: 0.72rem;
  color: #f87171;
  font-style: italic;
  margin-top: 4px;
  display: flex;
  align-items: center;
  gap: 4px;
}

.input-area {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 8px;
  border-top: 1px solid var(--border-color);
}

.typing-indicator {
  font-size: 0.75rem;
  color: var(--text-muted);
  font-style: italic;
  min-height: 1.1rem;
}

.input-row {
  display: flex;
  gap: 8px;
  align-items: flex-end;
}

.file-btn {
  background: #475569;
  color: white;
  padding: 12px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 0.9rem;
  margin: 0;
  width: auto;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.security-disclaimer {
  font-size: 0.68rem;
  color: #94a3b8;
  line-height: 1.35;
  margin-top: 4px;
  padding: 0 2px;
}

#full-overlay {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  background: rgba(15, 23, 42, 0.85);
  backdrop-filter: blur(4px);
  z-index: 9999;
  display: none;
  justify-content: center;
  align-items: center;
}

.toast-message {
  background: #ef4444;
  color: white;
  padding: 14px 28px;
  border-radius: 12px;
  font-weight: bold;
  font-size: 1rem;
  box-shadow: 0 10px 25px -5px rgba(0,0,0,0.5);
  text-align: center;
}

</style>

</head>

<body>

<div id="full-overlay">
  <div class="toast-message" id="toast-text">
    現在満員です
  </div>
</div>

<div class="container">

<div class="header">

  <div class="header-row">

    <span
      class="room-name"
      id="header-room-name"
      onclick="goHome()"
    >
      SimpleChatee
    </span>

    <span class="version-tag">
      Ver. 1.2.8
    </span>

  </div>

  <div
    class="header-row"
    id="header-room-id-container"
    style="display:none;"
  >

    <div class="header-sub-info">

      <span>
        部屋ID:
        <span id="display-room-id"></span>
      </span>

      <button
        class="header-copy-btn"
        onclick="copyRoomLink()"
      >
        🔗コピー
      </button>

    </div>

    <span
      id="member-count"
      style="
        font-size:0.75rem;
        color:var(--text-muted);
        white-space:nowrap;
        margin-left:auto;
      "
    ></span>

  </div>

  <div
    class="header-row"
    id="room-action-container"
    style="display:none;"
  >

    <div class="btn-action-group">

      <button
        class="btn-leave"
        onclick="leaveRoom()"
      >
        退室する

        <span class="sub-text">
          (同じブラウザならトップからPWなしで再入室可)
        </span>

      </button>

      <button
        id="btn-delete-room"
        class="btn-delete-room"
        onclick="deleteRoom()"
      >
        部屋削除
      </button>

    </div>

  </div>

</div>


<!-- HOME -->

<div
  id="view-home"
  class="view active"
>

  <h2
    style="
      text-align:center;
      margin-bottom:20px;
    "
  >
    SimpleChatee
  </h2>

  <div
    id="my-rooms-section"
    class="my-rooms-section"
  >

    <div class="my-rooms-title">
      参加中の部屋
    </div>

    <div
      id="my-rooms-list"
      class="room-card-list"
    ></div>

  </div>

  <button onclick="showView('view-create')">
    新しい部屋を作成
  </button>

  <div
    style="
      text-align:center;
      margin:15px 0;
      color:var(--text-muted);
    "
  >
    - または -
  </div>

  <input
    type="text"
    id="join-room-id"
    placeholder="部屋IDを入力"
  >

  <button
    class="btn-secondary"
    onclick="checkRoomJoin()"
  >
    部屋に参加
  </button>

</div>


<!-- CREATE -->

<div
  id="view-create"
  class="view"
>

  <h3>部屋を作成</h3>

  <label>部屋名</label>

  <input
    type="text"
    id="create-room-name"
    placeholder="例: ひみつの部屋"
  >

  <label>共通パスワード（参加者用）</label>

  <input
    type="password"
    id="create-password"
    placeholder="合言葉を入力"
  >

  <label>あなたのニックネーム</label>

  <input
    type="text"
    id="create-nickname"
    placeholder="名無し"
  >

  <button onclick="createRoom()">
    作成して入室
  </button>

  <button
    class="btn-secondary"
    style="margin-top:10px;"
    onclick="goHome()"
  >
    キャンセル
  </button>

</div>


<!-- JOIN -->

<div
  id="view-join"
  class="view"
>

  <h3 id="join-target-room-title">
    部屋に入室
  </h3>

  <label>あなたのニックネーム</label>

  <input
    type="text"
    id="join-nickname"
    placeholder="名無し"
  >

  <label>パスワード</label>

  <input
    type="password"
    id="join-password"
    placeholder="パスワードを入力"
  >

  <button onclick="joinRoom()">
    入室する
  </button>

  <button
    class="btn-secondary"
    style="margin-top:10px;"
    onclick="goHome()"
  >
    トップに戻る
  </button>

</div>


<!-- CHAT -->

<div
  id="view-chat"
  class="view"
>

  <div id="chat-messages"></div>

  <div class="input-area">

    <div
      id="file-name-preview"
      style="
        font-size:0.75rem;
        color:var(--accent-color);
        display:none;
      "
    ></div>

    <div
      id="typing-indicator"
      class="typing-indicator"
    ></div>

    <div class="input-row">

      <label class="file-btn">

        📷

        <input
          type="file"
          id="file-input"
          accept="image/*"
          style="display:none;"
          onchange="onFileSelected(this)"
        >

      </label>

      <textarea
        id="msg-input"
        placeholder="メッセージを入力..."
        oninput="handleTyping()"
        onkeydown="onKeyDown(event)"
      ></textarea>

      <button
        style="
          margin-top:0;
          width:auto;
          padding:0 16px;
          height:44px;
        "
        onclick="sendMessage()"
      >
        送信
      </button>

    </div>

    <div class="security-disclaimer">

      🔒 チャット内容はE2E暗号化により管理者も閲覧不可です。
      画像は1時間以内に自動削除されます。
      作成された部屋は作成者が削除するまで残ります。

    </div>

  </div>

</div>

</div>


<script src="/socket.io/socket.io.js"></script>

<script>

const socket = io();

let currentRoomId = '';
let currentPassword = '';
let myNickname = '';
let userSessionId = '';
let selectedFile = null;
let isHost = false;

let typingTimeout = null;
let isTyping = false;


// ============================================================
// Socket.IO
// ============================================================

socket.on('connect', function() {

  console.log(
    '[Socket.IO] connected:',
    socket.id
  );

  if (currentRoomId && userSessionId) {

    socket.emit(
      'rejoin_room',
      {
        roomId: currentRoomId,
        sessionId: userSessionId,
        nickname: myNickname
      }
    );

  }

});


socket.on('disconnect', function(reason) {

  console.log(
    '[Socket.IO] disconnected:',
    reason
  );

});


socket.on('connect_error', function(error) {

  console.error(
    '[Socket.IO] connection error:',
    error
  );

});


socket.on('room_state_sync', function(data) {

  if (!data || data.roomId !== currentRoomId) {
    return;
  }

  updateMemberCount(data.count);

  if (Array.isArray(data.messages)) {

    data.messages.forEach(function(msg) {

      if (msg.type === 'system') {

        renderSystemNotification(
          msg.text,
          msg.id
        );

      } else {

        renderSingleMessage(msg);

      }

    });

  }

});


socket.on('receive_message', function(msg) {

  if (!msg) {
    return;
  }

  if (msg.type === 'system') {

    renderSystemNotification(
      msg.text,
      msg.id
    );

  } else {

    renderSingleMessage(msg);

  }

});


socket.on('message_deleted', function(data) {

  if (!data) {
    return;
  }

  const el =
    document.getElementById(
      'msg-' + data.msgId
    );

  if (el) {
    el.remove();
  }

});


socket.on('update_members', function(data) {

  if (!data) {
    return;
  }

  updateMemberCount(data.count);

});


function updateMemberCount(count) {

  const memberCount =
    document.getElementById(
      'member-count'
    );

  if (!memberCount) {
    return;
  }

  const safeCount =
    Math.max(
      0,
      Math.min(
        3,
        Number(count) || 0
      )
    );

  memberCount.innerText =
    '(' + safeCount + '/3人)';

}


socket.on('display_typing', function(data) {

  const indicator =
    document.getElementById(
      'typing-indicator'
    );

  if (!indicator) {
    return;
  }

  if (data.isTyping) {

    indicator.innerText =
      data.nickname + ' が入力中...';

  } else {

    indicator.innerText = '';

  }

});


socket.on(
  'room_deleted_by_host',
  function(data) {

    if (
      data &&
      data.reason === 'inactivity'
    ) {

      alert(
        '1ヶ月間無発言のため、部屋は自動削除されました。'
      );

    } else {

      alert(
        '部屋主によってこの部屋は削除されました。'
      );

    }

    removeRoomFromStorage(
      currentRoomId
    );

    goHome();

  }
);


socket.on(
  'room_full_rejected',
  function() {

    showToast(
      '現在満員です',
      function() {
        goHome();
      }
    );

  }
);


// ============================================================
// 暗号化
// ============================================================

function encryptText(plainText, key) {

  if (!plainText) {
    return '';
  }

  try {

    return CryptoJS.AES
      .encrypt(
        plainText,
        key
      )
      .toString();

  } catch (e) {

    console.error(e);

    return plainText;

  }

}


function decryptText(cipherText, key) {

  if (!cipherText) {
    return '';
  }

  try {

    const bytes =
      CryptoJS.AES.decrypt(
        cipherText,
        key
      );

    const originalText =
      bytes.toString(
        CryptoJS.enc.Utf8
      );

    return (
      originalText ||
      '(復号エラー: パスワード不一致)'
    );

  } catch (e) {

    return '(復号失敗)';

  }

}


// ============================================================
// Session
// ============================================================

function getOrCreateSessionId() {

  let sid =
    sessionStorage.getItem(
      'userSessionId'
    );

  if (!sid) {

    sid =
      localStorage.getItem(
        'userSessionId'
      );

  }

  if (!sid) {

    sid =
      Math.random()
        .toString(36)
        .substring(2, 10);

    localStorage.setItem(
      'userSessionId',
      sid
    );

  }

  sessionStorage.setItem(
    'userSessionId',
    sid
  );

  return sid;

}


function setHostFlag(roomId) {

  sessionStorage.setItem(
    'is_room_host_' + roomId,
    'true'
  );

}


function isRoomHostStored(roomId) {

  return (
    sessionStorage.getItem(
      'is_room_host_' + roomId
    ) === 'true'
    ||
    localStorage.getItem(
      'is_room_host_' + roomId
    ) === 'true'
  );

}


function removeHostFlag(roomId) {

  sessionStorage.removeItem(
    'is_room_host_' + roomId
  );

  localStorage.removeItem(
    'is_room_host_' + roomId
  );

}


// ============================================================
// Admin thumbnail
// ============================================================

function getAdminThumbnails(roomId) {

  return JSON.parse(
    localStorage.getItem(
      'admin_thumbnails_' + roomId
    ) || '{}'
  );

}


function saveAdminThumbnail(
  roomId,
  msgId,
  base64Thumb
) {

  const thumbs =
    getAdminThumbnails(roomId);

  thumbs[msgId] =
    base64Thumb;

  localStorage.setItem(
    'admin_thumbnails_' + roomId,
    JSON.stringify(thumbs)
  );

}


function createUltraLightThumbnail(file) {

  return new Promise((resolve) => {

    const reader =
      new FileReader();

    reader.onload = (e) => {

      const img =
        new Image();

      img.onload = () => {

        const canvas =
          document.createElement(
            'canvas'
          );

        const targetWidth = 50;

        const scale =
          targetWidth /
          img.width;

        canvas.width =
          targetWidth;

        canvas.height =
          img.height * scale;

        const ctx =
          canvas.getContext('2d');

        ctx.drawImage(
          img,
          0,
          0,
          canvas.width,
          canvas.height
        );

        resolve(
          canvas.toDataURL(
            'image/jpeg',
            0.5
          )
        );

      };

      img.src =
        e.target.result;

    };

    reader.readAsDataURL(file);

  });

}


// ============================================================
// Local room storage
// ============================================================

function getSavedRooms() {

  return JSON.parse(
    localStorage.getItem(
      'myJoinedRooms'
    ) || '{}'
  );

}


function saveRoomToStorage(
  roomId,
  roomName,
  nickname,
  password
) {

  const savedRooms =
    getSavedRooms();

  savedRooms[roomId] = {
    roomName,
    nickname,
    password
  };

  localStorage.setItem(
    'myJoinedRooms',
    JSON.stringify(savedRooms)
  );

}


function removeRoomFromStorage(roomId) {

  const savedRooms =
    getSavedRooms();

  delete savedRooms[roomId];

  localStorage.setItem(
    'myJoinedRooms',
    JSON.stringify(savedRooms)
  );

  removeHostFlag(roomId);

}


function renderSavedRoomsList() {

  const savedRooms =
    getSavedRooms();

  const container =
    document.getElementById(
      'my-rooms-list'
    );

  const section =
    document.getElementById(
      'my-rooms-section'
    );

  container.innerHTML = '';

  const roomIds =
    Object.keys(savedRooms);

  if (roomIds.length === 0) {

    section.style.display =
      'none';

    return;

  }

  section.style.display =
    'block';

  roomIds.forEach(id => {

    const room =
      savedRooms[id];

    const card =
      document.createElement(
        'div'
      );

    card.className =
      'room-card';

    card.onclick = () => {

      quickJoin(
        id,
        room.password,
        room.nickname
      );

    };

    card.innerHTML = `

      <div class="room-card-info">

        <div class="room-card-name">
          ${escapeHtml(room.roomName)}
        </div>

        <div class="room-card-id">
          部屋ID: ${escapeHtml(id)}
        </div>

      </div>

      <span
        style="
          font-size:0.8rem;
          color:var(--accent-color);
        "
      >
        入室 →
      </span>

    `;

    container.appendChild(card);

  });

}


// ============================================================
// 起動時
// ============================================================

window.onload = function() {

  userSessionId =
    getOrCreateSessionId();

  renderSavedRoomsList();

  const urlParams =
    new URLSearchParams(
      window.location.search
    );

  const urlRoomId =
    urlParams.get('room');

  if (urlRoomId) {

    const savedRooms =
      getSavedRooms();

    if (savedRooms[urlRoomId]) {

      const r =
        savedRooms[urlRoomId];

      quickJoin(
        urlRoomId,
        r.password,
        r.nickname
      );

    } else {

      initJoinView(
        urlRoomId
      );

    }

  }

};


// ============================================================
// Toast
// ============================================================

function showToast(
  message,
  callback
) {

  const overlay =
    document.getElementById(
      'full-overlay'
    );

  const toast =
    document.getElementById(
      'toast-text'
    );

  toast.innerText =
    message;

  overlay.style.display =
    'flex';

  setTimeout(() => {

    overlay.style.display =
      'none';

    if (callback) {
      callback();
    }

  }, 2000);

}


// ============================================================
// Quick Join
// ============================================================

function quickJoin(
  roomId,
  password,
  nickname
) {

  currentRoomId =
    roomId;

  currentPassword =
    password;

  myNickname =
    nickname || 'ゲスト';

  socket.emit(
    'join_room',
    {
      roomId,
      password,
      nickname: myNickname,
      sessionId: userSessionId
    },
    function(res) {

      if (res && res.success) {

        saveRoomToStorage(
          roomId,
          res.roomName,
          myNickname,
          password
        );

        isHost =
          res.isHost ||
          isRoomHostStored(
            roomId
          );

        if (isHost) {
          setHostFlag(roomId);
        }

        setupChatView(
          res.roomName,
          res.messages,
          roomId
        );

        if (
          typeof res.memberCount !==
          'undefined'
        ) {

          updateMemberCount(
            res.memberCount
          );

        }

      } else {

        if (res && res.full) {

          showToast(
            '現在満員です',
            () => {
              goHome();
            }
          );

        } else {

          alert(
            (res && res.error) ||
            '入室に失敗しました'
          );

          removeRoomFromStorage(
            roomId
          );

          renderSavedRoomsList();

          goHome();

        }

      }

    }
  );

}


// ============================================================
// Room info
// ============================================================

function initJoinView(roomId) {

  document.getElementById(
    'join-room-id'
  ).value = roomId;

  currentRoomId =
    roomId;

  socket.emit(
    'get_room_info',
    {
      roomId: roomId
    },
    function(res) {

      if (
        res &&
        res.success &&
        res.roomName
      ) {

        document.getElementById(
          'join-target-room-title'
        ).innerText =
          '「' +
          res.roomName +
          '」に入室';

        showView(
          'view-join'
        );

      } else {

        alert(
          'この部屋は存在しないか、削除されています'
        );

        removeRoomFromStorage(
          roomId
        );

        renderSavedRoomsList();

        goHome();

      }

    }
  );

}


// ============================================================
// View
// ============================================================

function showView(id) {

  const views =
    document.querySelectorAll(
      '.view'
    );

  views.forEach(
    function(v) {
      v.classList.remove(
        'active'
      );
    }
  );

  document
    .getElementById(id)
    .classList.add(
      'active'
    );

}


// ============================================================
// Home
// ============================================================

function goHome() {

  currentRoomId = '';

  window.history.pushState(
    {},
    '',
    window.location.pathname
  );

  document.getElementById(
    'header-room-name'
  ).innerText =
    'SimpleChatee';

  document.getElementById(
    'header-room-id-container'
  ).style.display =
    'none';

  document.getElementById(
    'member-count'
  ).innerText =
    '';

  document.getElementById(
    'room-action-container'
  ).style.display =
    'none';

  document.getElementById(
    'btn-delete-room'
  ).style.display =
    'none';

  renderSavedRoomsList();

  showView(
    'view-home'
  );

}


// ============================================================
// CREATE ROOM
// ============================================================

function createRoom() {

  const name =
    document.getElementById(
      'create-room-name'
    ).value.trim()
    || '無題の部屋';

  const password =
    document.getElementById(
      'create-password'
    ).value;

  myNickname =
    document.getElementById(
      'create-nickname'
    ).value.trim()
    || '部屋主';

  if (!password) {

    alert(
      'パスワードを設定してください'
    );

    return;

  }

  if (!socket.connected) {

    alert(
      'サーバーに接続できていません。少し待ってからもう一度お試しください。'
    );

    return;

  }

  currentPassword =
    password;

  console.log(
    '[CREATE] 部屋作成開始'
  );

  socket.emit(
    'create_room',
    {
      name: name,
      password: password,
      nickname: myNickname,
      sessionId: userSessionId
    },
    function(res) {

      console.log(
        '[CREATE] サーバー応答:',
        res
      );

      if (res && res.success) {

        currentRoomId =
          res.roomId;

        isHost = true;

        setHostFlag(
          currentRoomId
        );

        saveRoomToStorage(
          currentRoomId,
          name,
          myNickname,
          password
        );

        setupChatView(
          name,
          res.messages,
          currentRoomId
        );

        if (
          typeof res.memberCount !==
          'undefined'
        ) {

          updateMemberCount(
            res.memberCount
          );

        }

      } else {

        alert(
          (res && res.error) ||
          '部屋の作成に失敗しました'
        );

      }

    }
  );

}


// ============================================================
// JOIN ROOM
// ============================================================

function checkRoomJoin() {

  const roomId =
    document.getElementById(
      'join-room-id'
    ).value.trim();

  if (!roomId) {

    alert(
      '部屋IDを入力してください'
    );

    return;

  }

  initJoinView(
    roomId
  );

}


function joinRoom() {

  myNickname =
    document.getElementById(
      'join-nickname'
    ).value.trim()
    || 'ゲスト';

  const password =
    document.getElementById(
      'join-password'
    ).value;

  if (!password) {

    alert(
      'パスワードを入力してください'
    );

    return;

  }

  currentPassword =
    password;

  socket.emit(
    'join_room',
    {
      roomId: currentRoomId,
      password: password,
      nickname: myNickname,
      sessionId: userSessionId
    },
    function(res) {

      if (res && res.success) {

        isHost =
          res.isHost ||
          isRoomHostStored(
            currentRoomId
          );

        if (isHost) {

          setHostFlag(
            currentRoomId
          );

        }

        saveRoomToStorage(
          currentRoomId,
          res.roomName,
          myNickname,
          password
        );

        setupChatView(
          res.roomName,
          res.messages,
          currentRoomId
        );

        if (
          typeof res.memberCount !==
          'undefined'
        ) {

          updateMemberCount(
            res.memberCount
          );

        }

      } else {

        if (res && res.full) {

          showToast(
            '現在満員です',
            () => {
              goHome();
            }
          );

        } else {

          alert(
            (res && res.error) ||
            '入室に失敗しました'
          );

        }

      }

    }
  );

}


// ============================================================
// Leave
// ============================================================

function leaveRoom() {

  if (
    confirm(
      '本当にこの部屋から退室しますか？'
    )
  ) {

    socket.emit(
      'leave_room',
      {
        roomId: currentRoomId,
        sessionId: userSessionId
      }
    );

    goHome();

  }

}


// ============================================================
// Delete Room
// ============================================================

function deleteRoom() {

  if (
    !confirm(
      '【警告】本当にこの部屋を削除しますか？'
    )
  ) {
    return;
  }

  socket.emit(
    'delete_room',
    {
      roomId: currentRoomId
    },
    function(res) {

      if (res && res.success) {

        alert(
          '部屋を削除しました'
        );

        removeRoomFromStorage(
          currentRoomId
        );

        goHome();

      } else {

        alert(
          (res && res.error) ||
          '削除権限がありません'
        );

      }

    }
  );

}


// ============================================================
// Chat View
// ============================================================

function setupChatView(
  roomName,
  messages,
  roomId
) {

  if (roomId) {
    currentRoomId =
      roomId;
  }

  document.getElementById(
    'header-room-name'
  ).innerText =
    roomName;

  document.getElementById(
    'display-room-id'
  ).innerText =
    currentRoomId;

  document.getElementById(
    'header-room-id-container'
  ).style.display =
    'flex';

  document.getElementById(
    'room-action-container'
  ).style.display =
    'flex';

  if (isHost) {

    document.getElementById(
      'btn-delete-room'
    ).style.display =
      'flex';

  } else {

    document.getElementById(
      'btn-delete-room'
    ).style.display =
      'none';

  }

  window.history.pushState(
    {},
    '',
    '?room=' +
    encodeURIComponent(
      currentRoomId
    )
  );

  showView(
    'view-chat'
  );

  const container =
    document.getElementById(
      'chat-messages'
    );

  container.innerHTML = '';

  if (
    messages &&
    messages.length > 0
  ) {

    messages.forEach(
      function(msg) {

        if (
          msg.type === 'system'
        ) {

          renderSystemNotification(
            msg.text,
            msg.id
          );

        } else {

          renderSingleMessage(
            msg
          );

        }

      }
    );

  }

}


// ============================================================
// Copy room link
// ============================================================

function copyRoomLink() {

  const url =
    window.location.origin +
    '?room=' +
    encodeURIComponent(
      currentRoomId
    );

  navigator.clipboard
    .writeText(url)
    .then(function() {

      alert(
        '部屋の招待URLをコピーしました！'
      );

    })
    .catch(function() {

      alert(
        'URLのコピーに失敗しました'
      );

    });

}


// ============================================================
// File
// ============================================================

function onFileSelected(input) {

  if (
    input.files &&
    input.files[0]
  ) {

    selectedFile =
      input.files[0];

    const preview =
      document.getElementById(
        'file-name-preview'
      );

    preview.innerText =
      '選択中: ' +
      selectedFile.name;

    preview.style.display =
      'block';

  }

}


// ============================================================
// Typing
// ============================================================

function handleTyping() {

  if (!isTyping) {

    isTyping = true;

    socket.emit(
      'typing_start',
      {
        roomId: currentRoomId
      }
    );

  }

  clearTimeout(
    typingTimeout
  );

  typingTimeout =
    setTimeout(
      () => {
        stopTyping();
      },
      2000
    );

}


function stopTyping() {

  if (isTyping) {

    isTyping = false;

    socket.emit(
      'typing_stop',
      {
        roomId: currentRoomId
      }
    );

  }

  clearTimeout(
    typingTimeout
  );

}


// ============================================================
// Keyboard
// ============================================================

function onKeyDown(e) {

  const isMobile =
    /iPhone|iPad|iPod|Android/i
      .test(
        navigator.userAgent
      );

  if (
    !isMobile &&
    e.key === 'Enter' &&
    !e.shiftKey
  ) {

    e.preventDefault();

    sendMessage();

  }

}


// ============================================================
// Send Message
// ============================================================

async function sendMessage() {

  const input =
    document.getElementById(
      'msg-input'
    );

  const text =
    input.value.trim();

  let imageUrl = null;

  let localThumbBase64 =
    null;

  if (
    !text &&
    !selectedFile
  ) {
    return;
  }

  stopTyping();

  // ------------------------------------------
  // 画像アップロード
  // ------------------------------------------

  if (selectedFile) {

    if (isHost) {

      try {

        localThumbBase64 =
          await createUltraLightThumbnail(
            selectedFile
          );

      } catch (e) {}

    }

    const formData =
      new FormData();

    formData.append(
      'image',
      selectedFile
    );

    try {

      const res =
        await fetch(
          '/api/upload',
          {
            method: 'POST',
            body: formData
          }
        );

      const data =
        await res.json();

      if (!res.ok) {

        throw new Error(
          data.error ||
          'アップロードエラー'
        );

      }

      imageUrl =
        data.imageUrl;

    } catch (e) {

      console.error(e);

      alert(
        '画像のアップロードに失敗しました'
      );

      return;

    }

  }

  const encryptedText =
    text
      ? encryptText(
          text,
          currentPassword
        )
      : '';

  const msgId =
    Math.random()
      .toString(36)
      .substring(2, 10);

  if (
    isHost &&
    localThumbBase64
  ) {

    saveAdminThumbnail(
      currentRoomId,
      msgId,
      localThumbBase64
    );

  }

  socket.emit(
    'send_message',
    {
      msgId: msgId,
      roomId: currentRoomId,
      text: encryptedText,
      image: imageUrl
    }
  );

  input.value = '';

  selectedFile = null;

  document.getElementById(
    'file-input'
  ).value = '';

  document.getElementById(
    'file-name-preview'
  ).style.display =
    'none';

}


// ============================================================
// Delete Message
// ============================================================

function deleteMessage(msgId) {

  socket.emit(
    'delete_message',
    {
      roomId: currentRoomId,
      msgId: msgId
    }
  );

}


// ============================================================
// Image error
// ============================================================

function handleImageError(
  imgEl,
  msgId
) {

  imgEl.onerror = null;

  if (isHost) {

    const thumbs =
      getAdminThumbnails(
        currentRoomId
      );

    if (thumbs[msgId]) {

      imgEl.src =
        thumbs[msgId];

      imgEl.className =
        'chat-img-admin-thumb';

      return;

    }

  }

  imgEl.style.display =
    'none';

  const note =
    document.createElement(
      'div'
    );

  note.className =
    'expired-img-note';

  note.innerText =
    '🔒 画像は削除されました';

  imgEl.parentNode.appendChild(
    note
  );

}


// ============================================================
// Render message
// ============================================================

function renderSingleMessage(msg) {

  const container =
    document.getElementById(
      'chat-messages'
    );

  if (
    document.getElementById(
      'msg-' + msg.id
    )
  ) {
    return;
  }

  const div =
    document.createElement(
      'div'
    );

  const isSelf =
    msg.sessionId ===
    userSessionId;

  const colorClass =
    isSelf
      ? 'self'
      : 'user-color-' +
        (msg.colorIndex || 0);

  div.className =
    'message ' +
    colorClass;

  div.id =
    'msg-' + msg.id;

  const plainText =
    msg.text
      ? decryptText(
          msg.text,
          currentPassword
        )
      : '';

  let html = '';

  if (isSelf) {

    html +=
      '<span class="del-btn" ' +
      'onclick="deleteMessage(\\'' +
      msg.id +
      '\\')">' +
      '✕ 削除' +
      '</span>';

  }

  html +=
    '<div class="sender">' +
    escapeHtml(
      msg.senderName || ''
    ) +
    '</div>';

  if (plainText) {

    html +=
      '<div class="text-content">' +
      escapeHtml(
        plainText
      ) +
      '</div>';

  }

  /*
   * 現在接続中のメモリに画像URLが存在する場合のみ表示。
   *
   * DB復元時のメッセージにはimageを保存していないため、
   * Render再起動後に画像は復元されない。
   */

  if (msg.image) {

    html +=
      '<img src="' +
      escapeHtml(msg.image) +
      '" class="chat-img" ' +
      'onclick="openImageInNewTab(\\'' +
      escapeHtml(msg.image) +
      '\\')" ' +
      'onerror="handleImageError(this, \\'' +
      msg.id +
      '\\')">';

  }

  div.innerHTML =
    html;

  container.appendChild(
    div
  );

  container.scrollTop =
    container.scrollHeight;

}


// ============================================================
// System message
// ============================================================

function renderSystemNotification(
  text,
  msgId
) {

  const container =
    document.getElementById(
      'chat-messages'
    );

  if (
    msgId &&
    document.getElementById(
      'system-msg-' + msgId
    )
  ) {
    return;
  }

  const div =
    document.createElement(
      'div'
    );

  div.className =
    'system-notification';

  if (msgId) {

    div.id =
      'system-msg-' + msgId;

  }

  div.innerText =
    text;

  container.appendChild(
    div
  );

  container.scrollTop =
    container.scrollHeight;

}


// ============================================================
// Image
// ============================================================

function openImageInNewTab(src) {

  window.open(
    src,
    '_blank'
  );

}


// ============================================================
// HTML escape
// ============================================================

function escapeHtml(str) {

  return String(str || '')
    .replace(
      /[&<>"']/g,
      function(m) {

        return {
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;'
        }[m];

      }
    );

}

</script>

</body>

</html>
  `);

});


// ============================================================
// Socket.IO server
// ============================================================

io.on('connection', (socket) => {


  // ==========================================================
  // Socket session
  // ==========================================================

  function setSocketSession(
    roomId,
    sessionId
  ) {

    socket.data.roomId =
      roomId;

    socket.data.sessionId =
      sessionId;

  }


  // ==========================================================
  // Active member count
  // ==========================================================

  function getActiveMemberCount(room) {

    if (!room) {
      return 0;
    }

    return room.members.filter(
      m => m.id !== null
    ).length;

  }


  // ==========================================================
  // Member count
  // ==========================================================

  function emitMemberCount(roomId) {

    const room =
      rooms[roomId];

    if (!room) {
      return;
    }

    const activeCount =
      getActiveMemberCount(
        room
      );

    io.to(roomId).emit(
      'update_members',
      {
        count: activeCount
      }
    );

  }


  // ==========================================================
  // Sync room
  // ==========================================================

  function syncRoomToSocket(
    targetSocket,
    roomId
  ) {

    const room =
      rooms[roomId];

    if (!room) {
      return;
    }

    const activeCount =
      getActiveMemberCount(
        room
      );

    targetSocket.emit(
      'room_state_sync',
      {
        roomId: roomId,
        count: activeCount,
        messages: room.messages
      }
    );

  }


  // ==========================================================
  // REJOIN
  // ==========================================================

  socket.on(
    'rejoin_room',
    async ({
      roomId,
      sessionId,
      nickname
    }) => {

      const room =
        await restoreRoomFromDb(
          roomId
        );

      if (!room) {
        return;
      }

      socket.join(
        roomId
      );

      setSocketSession(
        roomId,
        sessionId
      );

      let member =
        room.members.find(
          m =>
            m.sessionId ===
            sessionId
        );

      if (member) {

        member.id =
          socket.id;

        if (nickname) {
          member.nickname =
            nickname;
        }

      } else {

        const colorIndex =
          room.members.length %
          2;

        member = {
          id: socket.id,
          sessionId,
          nickname:
            nickname || 'ゲスト',
          colorIndex
        };

        room.members.push(
          member
        );

      }

      room.lastActivityAt =
        Date.now();

      await persistRoom(
        roomId
      );

      syncRoomToSocket(
        socket,
        roomId
      );

      emitMemberCount(
        roomId
      );

    }
  );


  // ==========================================================
  // GET ROOM INFO
  // ==========================================================

  socket.on(
    'get_room_info',
    async ({
      roomId
    }, callback) => {

      const room =
        await restoreRoomFromDb(
          roomId
        );

      callback({
        success: !!room,
        roomName:
          room
            ? room.name
            : ''
      });

    }
  );


  // ==========================================================
  // CREATE ROOM
  // ==========================================================

  socket.on(
    'create_room',
    async ({
      name,
      password,
      nickname,
      sessionId
    }, callback) => {

      try {

        if (!sessionId) {

          return callback({
            success: false,
            error:
              'セッション情報を取得できませんでした'
          });

        }

        if (!password) {

          return callback({
            success: false,
            error:
              'パスワードを設定してください'
          });

        }

        const roomId =
          Math.random()
            .toString(36)
            .substring(2, 8);

        const initialSystemMsg = {
          type: 'system',
          id:
            'system-' +
            Math.random()
              .toString(36)
              .substring(2, 10),
          text:
            `${nickname} が入室しました`
        };

        const initialMember = {
          id: socket.id,
          sessionId,
          nickname:
            nickname || '部屋主',
          colorIndex: 0
        };

        rooms[roomId] = {

          name:
            name || '無題の部屋',

          password,

          hostSessionId:
            sessionId,

          members: [
            initialMember
          ],

          messages: [
            initialSystemMsg
          ],

          lastActivityAt:
            Date.now()

        };

        /*
         * ここでDB保存。
         *
         * 失敗したら「部屋を作ったこと」にしない。
         */

        const saved =
          await persistRoom(
            roomId
          );

        if (!saved) {

          delete rooms[
            roomId
          ];

          return callback({
            success: false,
            error:
              'データベースへの保存に失敗しました。DATABASE_URLやSupabaseの接続状態を確認してください。'
          });

        }

        socket.join(
          roomId
        );

        setSocketSession(
          roomId,
          sessionId
        );

        callback({

          success: true,

          roomId,

          messages: [
            initialSystemMsg
          ],

          isHost: true,

          memberCount: 1

        });

        emitMemberCount(
          roomId
        );

        console.log(
          '[ROOM] 作成成功:',
          roomId
        );

      } catch (err) {

        console.error(
          '[ROOM] create_roomエラー:',
          err
        );

        callback({
          success: false,
          error:
            '部屋の作成中にエラーが発生しました: ' +
            err.message
        });

      }

    }
  );


  // ==========================================================
  // JOIN ROOM
  // ==========================================================

  socket.on(
    'join_room',
    async ({
      roomId,
      password,
      nickname,
      sessionId
    }, callback) => {

      try {

        const room =
          await restoreRoomFromDb(
            roomId
          );

        if (!room) {

          return callback({
            success: false,
            error:
              '部屋が存在しません'
          });

        }

        if (
          room.password &&
          password !== room.password
        ) {

          return callback({
            success: false,
            error:
              'パスワードが正しくありません'
          });

        }

        const existingMember =
          room.members.find(
            m =>
              m.sessionId ===
              sessionId
          );

        const activeMembers =
          room.members.filter(
            m =>
              m.id !== null &&
              m.sessionId !==
                sessionId
          );

        /*
         * 新規参加者のみ3人制限。
         *
         * 過去に参加したsessionIdなら
         * Render再起動後でも再入室可能。
         */

        if (
          !existingMember &&
          activeMembers.length >= 3
        ) {

          socket.emit(
            'room_full_rejected'
          );

          return callback({
            success: false,
            full: true,
            error:
              '現在満員です'
          });

        }

        if (!existingMember) {

          const colorIndex =
            room.members.length %
            2;

          room.members.push({
            id: socket.id,
            sessionId,
            nickname:
              nickname || 'ゲスト',
            colorIndex
          });

        } else {

          existingMember.id =
            socket.id;

          existingMember.nickname =
            nickname ||
            existingMember.nickname ||
            'ゲスト';

        }

        room.lastActivityAt =
          Date.now();

        socket.join(
          roomId
        );

        setSocketSession(
          roomId,
          sessionId
        );

        /*
         * 「新規参加者」の場合だけ
         * 入室メッセージを作る。
         *
         * 既存memberの再接続では
         * 毎回「○○が入室しました」を
         * 増やさない。
         */

        if (!existingMember) {

          const systemMsg = {

            type: 'system',

            id:
              'system-' +
              Math.random()
                .toString(36)
                .substring(2, 10),

            text:
              `${nickname} が入室しました`

          };

          room.messages.push(
            systemMsg
          );

        }

        const saved =
          await persistRoom(
            roomId
          );

        if (!saved) {

          return callback({
            success: false,
            error:
              'データベースへの保存に失敗しました'
          });

        }

        const isHost =
          room.hostSessionId ===
          sessionId;

        const activeCount =
          getActiveMemberCount(
            room
          );

        callback({

          success: true,

          roomName:
            room.name,

          messages:
            room.messages,

          isHost,

          memberCount:
            activeCount

        });

        if (!existingMember) {

          const latest =
            room.messages[
              room.messages.length - 1
            ];

          setTimeout(() => {

            if (rooms[roomId]) {

              io.to(roomId).emit(
                'receive_message',
                latest
              );

            }

          }, 0);

        }

        emitMemberCount(
          roomId
        );

      } catch (err) {

        console.error(
          '[ROOM] join_roomエラー:',
          err
        );

        callback({
          success: false,
          error:
            '入室中にエラーが発生しました'
        });

      }

    }
  );


  // ==========================================================
  // LEAVE
  // ==========================================================

  socket.on(
    'leave_room',
    async ({
      roomId
    }) => {

      const targetRoomId =
        roomId ||
        socket.data.roomId;

      const room =
        rooms[targetRoomId];

      if (!room) {
        return;
      }

      const sessionId =
        socket.data.sessionId;

      const member =
        room.members.find(
          m =>
            m.sessionId ===
              sessionId ||
            m.id ===
              socket.id
        );

      if (!member) {
        return;
      }

      /*
       * DB上のmemberは残す。
       *
       * idだけnullにする。
       */

      member.id = null;

      room.lastActivityAt =
        Date.now();

      const systemMsg = {

        type: 'system',

        id:
          'system-' +
          Math.random()
            .toString(36)
            .substring(2, 10),

        text:
          `${member.nickname} が退室しました`

      };

      room.messages.push(
        systemMsg
      );

      await persistRoom(
        targetRoomId
      );

      io.to(
        targetRoomId
      ).emit(
        'receive_message',
        systemMsg
      );

      emitMemberCount(
        targetRoomId
      );

      socket.leave(
        targetRoomId
      );

      socket.data.roomId =
        null;

    }
  );


  // ==========================================================
  // DELETE ROOM
  // ==========================================================

  socket.on(
    'delete_room',
    async ({
      roomId
    }, callback) => {

      try {

        const targetRoomId =
          roomId ||
          socket.data.roomId;

        const room =
          await restoreRoomFromDb(
            targetRoomId
          );

        if (!room) {

          return callback({
            success: false,
            error:
              '部屋が存在しません'
          });

        }

        if (
          room.hostSessionId !==
          socket.data.sessionId
        ) {

          return callback({
            success: false,
            error:
              '部屋を削除する権限がありません'
          });

        }

        /*
         * 画像はDBに保存していないが、
         * 現在のRenderに残っているものは
         * 可能なら削除する。
         */

        room.messages.forEach(
          msg => {

            if (msg.image) {

              const filename =
                path.basename(
                  msg.image
                );

              const filePath =
                path.join(
                  uploadDir,
                  filename
                );

              if (
                fs.existsSync(
                  filePath
                )
              ) {

                fs.unlink(
                  filePath,
                  () => {}
                );

              }

            }

          }
        );

        io.to(
          targetRoomId
        ).emit(
          'room_deleted_by_host'
        );

        delete rooms[
          targetRoomId
        ];

        await dbDeleteRoom(
          targetRoomId
        );

        callback({
          success: true
        });

        console.log(
          '[ROOM] 削除:',
          targetRoomId
        );

      } catch (err) {

        console.error(
          '[ROOM] delete_roomエラー:',
          err
        );

        callback({
          success: false,
          error:
            '部屋削除中にエラーが発生しました'
        });

      }

    }
  );


  // ==========================================================
  // TYPING START
  // ==========================================================

  socket.on(
    'typing_start',
    ({
      roomId
    }) => {

      const targetRoomId =
        roomId ||
        socket.data.roomId;

      const room =
        rooms[targetRoomId];

      if (!room) {
        return;
      }

      const sender =
        room.members.find(
          m =>
            m.id ===
            socket.id
        );

      if (sender) {

        socket.to(
          targetRoomId
        ).emit(
          'display_typing',
          {
            nickname:
              sender.nickname,
            isTyping: true
          }
        );

      }

    }
  );


  // ==========================================================
  // TYPING STOP
  // ==========================================================

  socket.on(
    'typing_stop',
    ({
      roomId
    }) => {

      const targetRoomId =
        roomId ||
        socket.data.roomId;

      socket.to(
        targetRoomId
      ).emit(
        'display_typing',
        {
          isTyping: false
        }
      );

    }
  );


  // ==========================================================
  // SEND MESSAGE
  // ==========================================================

  socket.on(
    'send_message',
    async ({
      msgId,
      roomId,
      text,
      image
    }) => {

      try {

        const targetRoomId =
          roomId ||
          socket.data.roomId;

        const room =
          await restoreRoomFromDb(
            targetRoomId
          );

        if (!room) {
          return;
        }

        const sessionId =
          socket.data.sessionId;

        const sender =
          room.members.find(
            m =>
              m.sessionId ===
                sessionId ||
              m.id ===
                socket.id
          );

        if (!sender) {

          console.warn(
            '[MESSAGE] 未参加者からの送信:',
            sessionId
          );

          return;
        }

        sender.id =
          socket.id;

        socket.join(
          targetRoomId
        );

        setSocketSession(
          targetRoomId,
          sessionId
        );

        room.lastActivityAt =
          Date.now();

        const messageData = {

          type: 'user',

          id:
            msgId ||
            Math.random()
              .toString(36)
              .substring(2, 10),

          sessionId:
            sessionId,

          senderName:
            sender.nickname,

          colorIndex:
            sender.colorIndex,

          text:
            text || ''

        };

        /*
         * imageはメモリ上だけに持つ。
         *
         * DB保存時にはdbSaveRoom()が
         * imageを除外する。
         */

        if (image) {
          messageData.image =
            image;
        }

        room.messages.push(
          messageData
        );

        /*
         * メッセージ送信時に
         * DBへ永続保存。
         */

        const saved =
          await persistRoom(
            targetRoomId
          );

        if (!saved) {

          console.error(
            '[MESSAGE] DB保存失敗:',
            targetRoomId
          );

        }

        io.to(
          targetRoomId
        ).emit(
          'receive_message',
          messageData
        );

      } catch (err) {

        console.error(
          '[MESSAGE] send_messageエラー:',
          err
        );

      }

    }
  );


  // ==========================================================
  // DELETE MESSAGE
  // ==========================================================

  socket.on(
    'delete_message',
    async ({
      roomId,
      msgId
    }) => {

      const targetRoomId =
        roomId ||
        socket.data.roomId;

      const room =
        rooms[targetRoomId];

      if (!room) {
        return;
      }

      const targetMsg =
        room.messages.find(
          m =>
            m.id ===
            msgId
        );

      if (!targetMsg) {
        return;
      }

      if (
        targetMsg.sessionId !==
        socket.data.sessionId
      ) {

        return;
      }

      room.messages =
        room.messages.filter(
          m =>
            m.id !==
            msgId
        );

      room.lastActivityAt =
        Date.now();

      await persistRoom(
        targetRoomId
      );

      io.to(
        targetRoomId
      ).emit(
        'message_deleted',
        {
          msgId
        }
      );

    }
  );


  // ==========================================================
  // DISCONNECT
  // ==========================================================

  socket.on(
    'disconnect',
    async () => {

      const roomId =
        socket.data.roomId;

      if (
        !roomId ||
        !rooms[roomId]
      ) {
        return;
      }

      const room =
        rooms[roomId];

      const member =
        room.members.find(
          m =>
            m.id ===
            socket.id
        );

      if (member) {

        /*
         * DBにはmemberを残し、
         * 現在接続しているsocketだけ解除。
         */

        member.id = null;

        await persistRoom(
          roomId
        );

        emitMemberCount(
          roomId
        );

      }

    }
  );

});


// ============================================================
// START SERVER
// ============================================================

const PORT =
  process.env.PORT ||
  3000;


/*
 * 非常に重要。
 *
 * 以前は
 *
 * initDb();
 * server.listen(...)
 *
 * だったため、
 * DB初期化が終わる前にユーザーが
 * 「部屋を作成」を押す可能性があった。
 *
 * 今回はDB初期化完了後に
 * サーバーを起動する。
 */

async function startServer() {

  try {

    await initDb();

    server.listen(
      PORT,
      () => {

        console.log(
          `Server running on port ${PORT}`
        );

      }
    );

  } catch (err) {

    console.error(
      '================================'
    );

    console.error(
      'サーバー起動失敗'
    );

    console.error(
      'DATABASE_URL / PostgreSQL接続を確認してください'
    );

    console.error(
      err
    );

    console.error(
      '================================'
    );

    process.exit(1);

  }

}

startServer();
