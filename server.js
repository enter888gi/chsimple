const Express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = Express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e7 });
 
// --- PostgreSQL 永続DB ---
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL が設定されていません。');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false }
});

// --- DB初期化 ---
async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rooms (
      room_id TEXT PRIMARY KEY,
      room_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      last_activity_at TIMESTAMPTZ NOT NULL,
      host_session_id TEXT NOT NULL,
      members JSONB NOT NULL DEFAULT '[]'::jsonb
    )
  `);

  console.log('PostgreSQL データベースを初期化しました。');
}

// --- 画像の保存先設定 (uploads フォルダ) ---
const uploadDir = path.join(__dirname, 'uploads');

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const uniqueName =
      Date.now() + '-' + Math.round(Math.random() * 1E9) + ext;

    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024
  }
});

// 静的ファイルとしてアップロード画像を公開
app.use('/uploads', Express.static(uploadDir));

// --- 部屋データ管理 ---
// メッセージ本文・画像は従来どおりメモリ上のみ。
// 部屋情報・メンバー情報はPostgreSQLに永続保存。
const rooms = {};

// --- 部屋の無活動クリーンアップ（30日以上無発話の部屋を自動削除） ---
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// --- パスワードハッシュ ---
function hashPassword(password) {
  return crypto
    .createHash('sha256')
    .update(String(password))
    .digest('hex');
}

// --- 部屋IDの検証 ---
function isValidRoomId(roomId) {
  if (!roomId) return false;

  return /^[A-Za-z0-9_-]{3,32}$/.test(roomId);
}

// --- 自動生成部屋ID ---
function generateRoomId() {
  return Math.random().toString(36).substring(2, 8);
}

// --- DBへ部屋を保存 ---
async function saveRoomToDatabase(roomId) {
  const room = rooms[roomId];

  if (!room) return;

  await pool.query(
    `
    INSERT INTO rooms (
      room_id,
      room_name,
      password_hash,
      created_at,
      last_activity_at,
      host_session_id,
      members
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (room_id)
    DO UPDATE SET
      room_name = EXCLUDED.room_name,
      password_hash = EXCLUDED.password_hash,
      created_at = EXCLUDED.created_at,
      last_activity_at = EXCLUDED.last_activity_at,
      host_session_id = EXCLUDED.host_session_id,
      members = EXCLUDED.members
    `,
    [
      roomId,
      room.name,
      room.passwordHash,
      new Date(room.createdAt),
      new Date(room.lastActivityAt),
      room.hostSessionId,
      JSON.stringify(
        room.members.map(member => ({
          sessionId: member.sessionId,
          nickname: member.nickname,
          colorIndex: member.colorIndex
        }))
      )
    ]
  );
}

// --- DBから部屋を削除 ---
async function deleteRoomFromDatabase(roomId) {
  await pool.query(
    'DELETE FROM rooms WHERE room_id = $1',
    [roomId]
  );
}

// --- DBから部屋を復元 ---
async function loadRoomsFromDatabase() {
  const result = await pool.query(
    `
    SELECT
      room_id,
      room_name,
      password_hash,
      created_at,
      last_activity_at,
      host_session_id,
      members
    FROM rooms
    `
  );

  const now = Date.now();

  for (const row of result.rows) {
    const lastActivityAt = new Date(row.last_activity_at).getTime();

    // 30日以上無発言の部屋は起動時に削除
    if (now - lastActivityAt > THIRTY_DAYS_MS) {
      await deleteRoomFromDatabase(row.room_id);

      console.log(
        `部屋 ${row.room_id} は30日間無活動のためDBから自動削除されました。`
      );

      continue;
    }

    let members = [];

    try {
      members = Array.isArray(row.members)
        ? row.members
        : JSON.parse(row.members || '[]');
    } catch (e) {
      members = [];
    }

    // Render再起動時点では全Socketが切断状態なので
    // socket.id は null にして復元する
    members = members.map(member => ({
      id: null,
      sessionId: member.sessionId,
      nickname: member.nickname || 'ゲスト',
      colorIndex:
        typeof member.colorIndex === 'number'
          ? member.colorIndex
          : 0
    }));

    rooms[row.room_id] = {
      name: row.room_name,
      passwordHash: row.password_hash,
      hostSessionId: row.host_session_id,
      createdAt: new Date(row.created_at).getTime(),
      lastActivityAt,
      members,
      messages: []
    };

    console.log(`部屋 ${row.room_id} をDBから復元しました。`);
  }

  console.log(
    `永続DBから ${Object.keys(rooms).length} 件の部屋を復元しました。`
  );
}

// --- 30日無活動部屋の定期クリーンアップ ---
async function cleanupInactiveRooms() {
  const now = Date.now();

  for (const roomId in rooms) {
    const room = rooms[roomId];

    if (now - room.lastActivityAt > THIRTY_DAYS_MS) {
      // 部屋のメンバー全員に通知
      io.to(roomId).emit('room_deleted_by_host', {
        reason: 'inactivity'
      });

      // メッセージに含まれる画像ファイルを物理削除
      room.messages.forEach(msg => {
        if (msg.image) {
          const filename = path.basename(msg.image);
          const filePath = path.join(uploadDir, filename);

          if (fs.existsSync(filePath)) {
            fs.unlink(filePath, (err) => {
              if (err) {
                console.error(
                  '期限切れ部屋の画像削除エラー:',
                  err
                );
              }
            });
          }
        }
      });

      delete rooms[roomId];

      try {
        await deleteRoomFromDatabase(roomId);
      } catch (err) {
        console.error(
          `部屋 ${roomId} のDB削除エラー:`,
          err
        );
      }

      console.log(
        `部屋 ${roomId} は30日間無活動のため自動削除されました。`
      );
    }
  }
}

// 12時間ごとにチェック
setInterval(() => {
  cleanupInactiveRooms().catch(err => {
    console.error('無活動部屋クリーンアップエラー:', err);
  });
}, 12 * 60 * 60 * 1000);

// --- 画像アップロード API ---
app.post(
  '/api/upload',
  upload.single('image'),
  (req, res) => {
    if (!req.file) {
      return res.status(400).json({
        error: 'ファイルがありません'
      });
    }

    const imageUrl = '/uploads/' + req.file.filename;
    const filePath = req.file.path;

    // 1時間後に自動物理削除
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
  }
);

// --- 単一ファイルWebページ配信 ---
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
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

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
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

    /* 部屋名＋部屋IDを横並び */
    .create-room-row {
      display: flex;
      gap: 8px;
      width: 100%;
    }

    .create-room-field {
      flex: 1;
      min-width: 0;
    }

    .create-room-field.room-id-field {
      flex: 1;
    }
  </style>
</head>

<body>

<div id="full-overlay">
  <div class="toast-message" id="toast-text">現在満員です</div>
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
      style="display: none;"
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
        style="font-size: 0.75rem; color: var(--text-muted); white-space: nowrap; margin-left: auto;"
      ></span>
    </div>

    <div
      class="header-row"
      id="room-action-container"
      style="display: none;"
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

  <!-- メイン画面 -->
  <div
    id="view-home"
    class="view active"
  >

    <h2 style="text-align:center; margin-bottom: 20px;">
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
      style="text-align: center; margin: 15px 0; color: var(--text-muted);"
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

  <!-- 部屋作成画面 -->
  <div
    id="view-create"
    class="view"
  >

    <h3>部屋を作成</h3>

    <div class="create-room-row">

      <div class="create-room-field">
        <label>部屋名</label>

        <input
          type="text"
          id="create-room-name"
          placeholder="例: ひみつの部屋"
        >
      </div>

      <div class="create-room-field room-id-field">
        <label>部屋ID</label>

        <input
          type="text"
          id="create-room-id"
          placeholder="空欄の場合は自動生成"
          maxlength="32"
          autocomplete="off"
        >
      </div>

    </div>

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
      style="margin-top: 10px;"
      onclick="goHome()"
    >
      キャンセル
    </button>

  </div>

  <!-- 入室画面 -->
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
      style="margin-top: 10px;"
      onclick="goHome()"
    >
      トップに戻る
    </button>

  </div>

  <!-- チャット画面 -->
  <div
    id="view-chat"
    class="view"
  >

    <div id="chat-messages"></div>

    <div class="input-area">

      <div
        id="file-name-preview"
        style="font-size: 0.75rem; color: var(--accent-color); display: none;"
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
          style="margin-top:0; width:auto; padding: 0 16px; height: 44px;"
          onclick="sendMessage()"
        >
          送信
        </button>

      </div>

      <div class="security-disclaimer">
        🔒 チャット内容はE2E暗号化により管理者も閲覧不可です。画像は1時間以内に自動削除されます。作成された部屋は最終発言から30日間残ります。
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

  // --- Socket.io 受信イベントリスナーを最上位で登録 ---

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

  // 再接続時に部屋状態を同期

  socket.on('room_state_sync', function(data) {

    if (!data || data.roomId !== currentRoomId) return;

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

    if (!msg) return;

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

    const el =
      document.getElementById(
        'msg-' + data.msgId
      );

    if (el) el.remove();

  });

  socket.on('update_members', function(data) {

    if (!data) return;

    updateMemberCount(data.count);

  });

  function updateMemberCount(count) {

    const memberCount =
      document.getElementById('member-count');

    if (!memberCount) return;

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

    if (data.isTyping) {

      indicator.innerText =
        data.nickname +
        ' が入力中...';

    } else {

      indicator.innerText = '';

    }

  });

  socket.on('room_deleted_by_host', function(data) {

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

    removeRoomFromStorage(currentRoomId);

    goHome();

  });

  socket.on('room_full_rejected', function() {

    showToast(
      '現在満員です',
      function() {
        goHome();
      }
    );

  });

  // --- ユーティリティ・暗号化関数 ---

  function encryptText(plainText, key) {

    if (!plainText) return '';

    try {

      return CryptoJS.AES
        .encrypt(
          plainText,
          key
        )
        .toString();

    } catch (e) {

      return plainText;

    }

  }

  function decryptText(cipherText, key) {

    if (!cipherText) return '';

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

      return originalText ||
        '(復号エラー: パスワード不一致)';

    } catch (e) {

      return '(復号失敗)';

    }

  }

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

    }

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

    thumbs[msgId] = base64Thumb;

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

        const img = new Image();

        img.onload = () => {

          const canvas =
            document.createElement(
              'canvas'
            );

          const targetWidth = 50;

          const scale =
            targetWidth / img.width;

          canvas.width =
            targetWidth;

          canvas.height =
            img.height * scale;

          const ctx =
            canvas.getContext(
              '2d'
            );

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

    const rooms =
      getSavedRooms();

    rooms[roomId] = {
      roomName,
      nickname,
      password
    };

    localStorage.setItem(
      'myJoinedRooms',
      JSON.stringify(rooms)
    );

  }

  function removeRoomFromStorage(roomId) {

    const rooms =
      getSavedRooms();

    delete rooms[roomId];

    localStorage.setItem(
      'myJoinedRooms',
      JSON.stringify(rooms)
    );

    removeHostFlag(roomId);

  }

  function renderSavedRoomsList() {

    const rooms =
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
      Object.keys(rooms);

    if (roomIds.length === 0) {

      section.style.display =
        'none';

      return;

    }

    section.style.display =
      'block';

    roomIds.forEach(id => {

      const room =
        rooms[id];

      const card =
        document.createElement(
          'div'
        );

      card.className =
        'room-card';

      card.onclick = () =>
        quickJoin(
          id,
          room.password,
          room.nickname
        );

      card.innerHTML = \`
        <div class="room-card-info">
          <div class="room-card-name">
            \${escapeHtml(room.roomName)}
          </div>
          <div class="room-card-id">
            部屋ID: \${id}
          </div>
        </div>
        <span style="font-size: 0.8rem; color: var(--accent-color);">
          入室 →
        </span>
      \`;

      container.appendChild(card);

    });

  }

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

        if (res.success) {

          saveRoomToStorage(
            roomId,
            res.roomName,
            myNickname,
            password
          );

          isHost =
            res.isHost ||
            isRoomHostStored(roomId);

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

          if (res.full) {

            showToast(
              '現在満員です',
              () => {
                goHome();
              }
            );

          } else {

            alert(
              res.error ||
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

  function initJoinView(roomId) {

    document.getElementById(
      'join-room-id'
    ).value =
      roomId;

    currentRoomId =
      roomId;

    socket.emit(
      'get_room_info',
      {
        roomId: roomId
      },
      function(res) {

        if (
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

    document.getElementById(
      id
    ).classList.add(
      'active'
    );

  }

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

  function createRoom() {

    const name =
      document.getElementById(
        'create-room-name'
      ).value ||
      '無題の部屋';

    const requestedRoomId =
      document.getElementById(
        'create-room-id'
      ).value.trim();

    const password =
      document.getElementById(
        'create-password'
      ).value;

    myNickname =
      document.getElementById(
        'create-nickname'
      ).value ||
      '部屋主';

    if (!password) {

      return alert(
        'パスワードを設定してください'
      );

    }

    if (
      requestedRoomId &&
      !/^[A-Za-z0-9_-]{3,32}$/.test(
        requestedRoomId
      )
    ) {

      return alert(
        '部屋IDは3～32文字の英数字、_、-のみ使用できます'
      );

    }

    currentPassword =
      password;

    socket.emit(
      'create_room',
      {
        name: name,
        roomId:
          requestedRoomId || '',
        password: password,
        nickname: myNickname,
        sessionId: userSessionId
      },
      function(res) {

        if (res.success) {

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
            res.error ||
            '部屋の作成に失敗しました'
          );

        }

      }
    );

  }

  function checkRoomJoin() {

    const roomId =
      document.getElementById(
        'join-room-id'
      ).value.trim();

    if (!roomId) {

      return alert(
        '部屋IDを入力してください'
      );

    }

    initJoinView(
      roomId
    );

  }

  function joinRoom() {

    myNickname =
      document.getElementById(
        'join-nickname'
      ).value ||
      'ゲスト';

    const password =
      document.getElementById(
        'join-password'
      ).value;

    currentPassword =
      password;

    socket.emit(
      'join_room',
      {
        roomId:
          currentRoomId,
        password:
          password,
        nickname:
          myNickname,
        sessionId:
          userSessionId
      },
      function(res) {

        if (res.success) {

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

          if (res.full) {

            showToast(
              '現在満員です',
              () => {
                goHome();
              }
            );

          } else {

            alert(
              res.error ||
              '入室に失敗しました'
            );

          }

        }

      }
    );

  }

  function leaveRoom() {

    if (
      confirm(
        '本当にこの部屋から退室しますか？'
      )
    ) {

      socket.emit(
        'leave_room',
        {
          roomId:
            currentRoomId,
          sessionId:
            userSessionId
        }
      );

      goHome();

    }

  }

  function deleteRoom() {

    if (
      confirm(
        '【警告】本当にこの部屋を削除しますか？'
      )
    ) {

      socket.emit(
        'delete_room',
        {
          roomId:
            currentRoomId
        },
        function(res) {

          if (res.success) {

            alert(
              '部屋を削除しました'
            );

            removeRoomFromStorage(
              currentRoomId
            );

            goHome();

          } else {

            alert(
              res.error ||
              '削除権限がありません'
            );

          }

        }
      );

    }

  }

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
      currentRoomId
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
            msg.type ===
            'system'
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

  function copyRoomLink() {

    const url =
      window.location.origin +
      '?room=' +
      currentRoomId;

    navigator.clipboard
      .writeText(url)
      .then(
        function() {

          alert(
            '部屋の招待URLをコピーしました！'
          );

        }
      );

  }

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

  function handleTyping() {

    if (!isTyping) {

      isTyping = true;

      socket.emit(
        'typing_start',
        {
          roomId:
            currentRoomId
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
          roomId:
            currentRoomId
        }
      );

    }

    clearTimeout(
      typingTimeout
    );

  }

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

  async function sendMessage() {

    const input =
      document.getElementById(
        'msg-input'
      );

    const text =
      input.value.trim();

    let imageUrl = null;
    let localThumbBase64 = null;

    if (
      !text &&
      !selectedFile
    ) {
      return;
    }

    stopTyping();

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

        imageUrl =
          data.imageUrl;

      } catch (e) {

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
        msgId:
          msgId,
        roomId:
          currentRoomId,
        text:
          encryptedText,
        image:
          imageUrl
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

  function deleteMessage(msgId) {

    socket.emit(
      'delete_message',
      {
        roomId:
          currentRoomId,
        msgId:
          msgId
      }
    );

  }

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

    imgEl.parentNode
      .appendChild(
        note
      );

  }

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
      'msg-' +
      msg.id;

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
        '<span class="del-btn" onclick="deleteMessage(\\\'' +
        msg.id +
        '\\\')">✕ 削除</span>';

    }

    html +=
      '<div class="sender">' +
      escapeHtml(
        msg.senderName
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

    if (msg.image) {

      html +=
        '<img src="' +
        msg.image +
        '" class="chat-img" onclick="openImageInNewTab(\\\'' +
        msg.image +
        '\\\')" onerror="handleImageError(this, \\\'' +
        msg.id +
        '\\\')">';

    }

    div.innerHTML =
      html;

    container.appendChild(
      div
    );

    container.scrollTop =
      container.scrollHeight;

  }

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
        'system-msg-' +
        msgId
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
        'system-msg-' +
        msgId;

    }

    div.innerText =
      text;

    container.appendChild(
      div
    );

    container.scrollTop =
      container.scrollHeight;

  }

  function openImageInNewTab(src) {

    window.open(
      src,
      '_blank'
    );

  }

  function escapeHtml(str) {

    return str.replace(
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

// --- Socket.io サーバー側処理 ---

io.on('connection', (socket) => {

  // セッション情報保持ヘルパー
  function setSocketSession(
    roomId,
    sessionId
  ) {

    socket.data.roomId =
      roomId;

    socket.data.sessionId =
      sessionId;

  }

  // 現在アクティブなメンバー数を取得
  function getActiveMemberCount(room) {

    if (!room) return 0;

    return room.members.filter(
      m => m.id !== null
    ).length;

  }

  // メンバー数だけを部屋全員へ同期
  function emitMemberCount(roomId) {

    const room =
      rooms[roomId];

    if (!room) return;

    const activeCount =
      getActiveMemberCount(
        room
      );

    io.to(roomId).emit(
      'update_members',
      {
        count:
          activeCount
      }
    );

  }

  // 指定ソケットへ部屋全体の状態を同期
  function syncRoomToSocket(
    targetSocket,
    roomId
  ) {

    const room =
      rooms[roomId];

    if (!room) return;

    const activeCount =
      getActiveMemberCount(
        room
      );

    targetSocket.emit(
      'room_state_sync',
      {
        roomId:
          roomId,
        count:
          activeCount,
        messages:
          room.messages
      }
    );

  }

  socket.on(
    'rejoin_room',
    async ({
      roomId,
      sessionId,
      nickname
    }) => {

      const room =
        rooms[roomId];

      if (!room) return;

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

        const activeMembers =
          room.members.filter(
            m =>
              m.id !== null
          );

        if (
          activeMembers.length >= 3
        ) {
          return;
        }

        const colorIndex =
          room.members.length > 0
            ? (
                room.members.length %
                2
              )
            : 0;

        room.members.push({
          id:
            socket.id,
          sessionId,
          nickname:
            nickname ||
            'ゲスト',
          colorIndex
        });

      }

      room.lastActivityAt =
        Date.now();

      try {

        await saveRoomToDatabase(
          roomId
        );

      } catch (err) {

        console.error(
          '再接続時のDB保存エラー:',
          err
        );

      }

      // 再接続時は入室通知を作らない
      syncRoomToSocket(
        socket,
        roomId
      );

      emitMemberCount(
        roomId
      );

    }
  );

  socket.on(
    'get_room_info',
    async ({
      roomId
    }, callback) => {

      const room =
        rooms[roomId];

      callback({
        success:
          !!room,
        roomName:
          room
            ? room.name
            : ''
      });

    }
  );

  socket.on(
    'create_room',
    async ({
      name,
      roomId: requestedRoomId,
      password,
      nickname,
      sessionId
    }, callback) => {

      try {

        let roomId =
          requestedRoomId
            ? requestedRoomId.trim()
            : '';

        // 部屋ID指定あり
        if (roomId) {

          if (
            !isValidRoomId(
              roomId
            )
          ) {

            return callback({
              success:
                false,
              error:
                '部屋IDは3～32文字の英数字、_、-のみ使用できます'
            });

          }

          if (
            rooms[roomId]
          ) {

            return callback({
              success:
                false,
              error:
                'その部屋IDはすでに使用されています'
            });

          }

          const existing =
            await pool.query(
              'SELECT room_id FROM rooms WHERE room_id = $1',
              [roomId]
            );

          if (
            existing.rows.length > 0
          ) {

            return callback({
              success:
                false,
              error:
                'その部屋IDはすでに使用されています'
            });

          }

        } else {

          // 空欄なら自動生成
          let attempts = 0;

          do {

            roomId =
              generateRoomId();

            attempts++;

            const existsInMemory =
              !!rooms[roomId];

            if (existsInMemory) {
              continue;
            }

            const existing =
              await pool.query(
                'SELECT room_id FROM rooms WHERE room_id = $1',
                [roomId]
              );

            if (
              existing.rows.length === 0
            ) {
              break;
            }

          } while (
            attempts < 20
          );

          if (
            attempts >= 20
          ) {

            return callback({
              success:
                false,
              error:
                '部屋IDの自動生成に失敗しました。もう一度お試しください'
            });

          }

        }

        const now =
          Date.now();

        // 部屋作成者自身の最初の入室アナウンスを保存
        const initialSystemMsg = {
          type:
            'system',
          id:
            'system-' +
            Math.random()
              .toString(36)
              .substring(2, 10),
          text:
            nickname +
            ' が入室しました'
        };

        rooms[roomId] = {
          name:
            name ||
            '無題の部屋',

          passwordHash:
            hashPassword(
              password
            ),

          hostSessionId:
            sessionId,

          createdAt:
            now,

          lastActivityAt:
            now,

          members: [
            {
              id:
                socket.id,
              sessionId,
              nickname,
              colorIndex:
                0
            }
          ],

          messages: [
            initialSystemMsg
          ]
        };

        try {

          await saveRoomToDatabase(
            roomId
          );

        } catch (dbError) {

          delete rooms[roomId];

          console.error(
            '部屋作成時のDB保存エラー:',
            dbError
          );

          return callback({
            success:
              false,
            error:
              '部屋の保存に失敗しました。もう一度お試しください'
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
          success:
            true,
          roomId,
          messages: [
            initialSystemMsg
          ],
          isHost:
            true,
          memberCount:
            1
        });

        emitMemberCount(
          roomId
        );

      } catch (err) {

        console.error(
          'create_room エラー:',
          err
        );

        callback({
          success:
            false,
          error:
            '部屋の作成に失敗しました'
        });

      }

    }
  );

  socket.on(
    'join_room',
    async ({
      roomId,
      password,
      nickname,
      sessionId
    }, callback) => {

      const room =
        rooms[roomId];

      if (!room) {

        return callback({
          success:
            false,
          error:
            '部屋が存在しません'
        });

      }

      // DBにはパスワードのハッシュだけ保存
      if (
        room.passwordHash !==
        hashPassword(
          password
        )
      ) {

        return callback({
          success:
            false,
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

      // 既存参加者以外の新規入室で3人なら拒否
      if (
        !existingMember &&
        activeMembers.length >= 3
      ) {

        socket.emit(
          'room_full_rejected'
        );

        return callback({
          success:
            false,
          full:
            true,
          error:
            '現在満員です'
        });

      }

      if (!existingMember) {

        const colorIndex =
          room.members.length > 0
            ? (
                room.members.length %
                2
              )
            : 0;

        room.members.push({
          id:
            socket.id,
          sessionId,
          nickname,
          colorIndex
        });

      } else {

        existingMember.id =
          socket.id;

        existingMember.nickname =
          nickname;

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

      // 明示的な再入室でも入室通知
      const systemMsg = {
        type:
          'system',
        id:
          'system-' +
          Math.random()
            .toString(36)
            .substring(2, 10),
        text:
          nickname +
          ' が入室しました'
      };

      room.messages.push(
        systemMsg
      );

      try {

        await saveRoomToDatabase(
          roomId
        );

      } catch (err) {

        console.error(
          'join_room DB保存エラー:',
          err
        );

      }

      const isHost =
        room.hostSessionId ===
        sessionId;

      const activeCount =
        getActiveMemberCount(
          room
        );

      callback({
        success:
          true,
        roomName:
          room.name,
        messages:
          room.messages,
        isHost:
          isHost,
        memberCount:
          activeCount
      });

      setTimeout(
        () => {

          if (
            rooms[roomId]
          ) {

            io.to(roomId).emit(
              'receive_message',
              systemMsg
            );

            emitMemberCount(
              roomId
            );

          }

        },
        0
      );

    }
  );

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

      if (!room) return;

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

      if (member) {

        member.id =
          null;

        room.lastActivityAt =
          Date.now();

        const systemMsg = {
          type:
            'system',
          id:
            'system-' +
            Math.random()
              .toString(36)
              .substring(2, 10),
          text:
            member.nickname +
            ' が退室しました'
        };

        room.messages.push(
          systemMsg
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

        try {

          await saveRoomToDatabase(
            targetRoomId
          );

        } catch (err) {

          console.error(
            'leave_room DB保存エラー:',
            err
          );

        }

      }

    }
  );

  socket.on(
    'delete_room',
    async ({
      roomId
    }, callback) => {

      const targetRoomId =
        roomId ||
        socket.data.roomId;

      const room =
        rooms[targetRoomId];

      if (!room) {

        return callback({
          success:
            false,
          error:
            '部屋が存在しません'
        });

      }

      if (
        room.hostSessionId !==
        socket.data.sessionId
      ) {

        return callback({
          success:
            false,
          error:
            '部屋を削除する権限がありません'
        });

      }

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

      try {

        await deleteRoomFromDatabase(
          targetRoomId
        );

      } catch (err) {

        console.error(
          'delete_room DB削除エラー:',
          err
        );

        return callback({
          success:
            false,
          error:
            '部屋は削除されましたが、DBからの削除に失敗しました'
        });

      }

      callback({
        success:
          true
      });

    }
  );

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

      if (!room) return;

      const sender =
        room.members.find(
          m =>
            m.id ===
            socket.id
        );

      if (sender) {

        socket
          .to(targetRoomId)
          .emit(
            'display_typing',
            {
              nickname:
                sender.nickname,
              isTyping:
                true
            }
          );

      }

    }
  );

  socket.on(
    'typing_stop',
    ({
      roomId
    }) => {

      const targetRoomId =
        roomId ||
        socket.data.roomId;

      socket
        .to(targetRoomId)
        .emit(
          'display_typing',
          {
            isTyping:
              false
          }
        );

    }
  );

  socket.on(
    'send_message',
    async ({
      msgId,
      roomId,
      text,
      image
    }) => {

      const targetRoomId =
        roomId ||
        socket.data.roomId;

      const room =
        rooms[targetRoomId];

      if (!room) return;

      const sessionId =
        socket.data.sessionId;

      let sender =
        room.members.find(
          m =>
            m.sessionId ===
              sessionId ||
            m.id ===
              socket.id
        );

      if (sender) {

        sender.id =
          socket.id;

        socket.join(
          targetRoomId
        );

        setSocketSession(
          targetRoomId,
          sessionId
        );

      }

      // 発言があったので最終発言日時を更新
      room.lastActivityAt =
        Date.now();

      const messageData = {
        type:
          'user',
        id:
          msgId ||
          Math.random()
            .toString(36)
            .substring(2, 10),
        sessionId:
          sessionId,
        senderName:
          sender
            ? sender.nickname
            : '匿名',
        colorIndex:
          sender
            ? sender.colorIndex
            : 0,
        text,
        image
      };

      room.messages.push(
        messageData
      );

      // 最終発言日時＋メンバー情報を永続化
      try {

        await saveRoomToDatabase(
          targetRoomId
        );

      } catch (err) {

        console.error(
          'send_message DB保存エラー:',
          err
        );

      }

      io.to(
        targetRoomId
      ).emit(
        'receive_message',
        messageData
      );

    }
  );

  socket.on(
    'delete_message',
    ({
      roomId,
      msgId
    }) => {

      const targetRoomId =
        roomId ||
        socket.data.roomId;

      const room =
        rooms[targetRoomId];

      if (room) {

        const targetMsg =
          room.messages.find(
            m =>
              m.id ===
              msgId
          );

        if (
          targetMsg &&
          targetMsg.sessionId ===
            socket.data.sessionId
        ) {

          room.messages =
            room.messages.filter(
              m =>
                m.id !==
                msgId
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

      }

    }
  );

  socket.on(
    'disconnect',
    async () => {

      const roomId =
        socket.data.roomId;

      if (
        roomId &&
        rooms[roomId]
      ) {

        const room =
          rooms[roomId];

        const member =
          room.members.find(
            m =>
              m.id ===
              socket.id
          );

        if (member) {

          member.id =
            null;

          // 切断だけでは発言ではないので
          // lastActivityAtは更新しない

          emitMemberCount(
            roomId
          );

          try {

            await saveRoomToDatabase(
              roomId
            );

          } catch (err) {

            console.error(
              'disconnect DB保存エラー:',
              err
            );

          }

        }

      }

    }
  );

});

// --- サーバー起動 ---
async function startServer() {

  try {

    await initDatabase();

    await loadRoomsFromDatabase();

    const PORT =
      process.env.PORT ||
      3000;

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
      'サーバー起動時にエラーが発生しました:',
      err
    );

    process.exit(1);

  }

}

startServer();
