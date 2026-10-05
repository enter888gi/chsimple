const Express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = Express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e7 });

// --- 画像の保存先設定 (uploads フォルダ) ---
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
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB上限

// 静的ファイルとしてアップロード画像を公開
app.use('/uploads', Express.static(uploadDir));

// --- 部屋データ管理（メモリのみ・Supabase完全削除） ---
// key: roomName
const rooms = {};

// --- 画像アップロード API ---
app.post('/api/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'ファイルがありません' });

  const imageUrl = '/uploads/' + req.file.filename;
  const filePath = req.file.path;

  // 最大1時間後に自動物理削除
  setTimeout(() => {
    fs.unlink(filePath, (err) => {
      if (err) console.error('画像自動削除エラー:', err);
      else console.log('1時間経過のため画像を自動削除しました:', req.file.filename);
    });
  }, 60 * 60 * 1000);

  res.json({ imageUrl });
});

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
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { background-color: var(--bg-color); color: var(--text-color); display: flex; justify-content: center; align-items: center; min-height: 100vh; padding: 10px; }
    
    .container { width: 100%; max-width: 500px; background: var(--card-bg); border-radius: 16px; border: 1px solid var(--border-color); overflow: hidden; display: flex; flex-direction: column; height: 90vh; position: relative; }
    
    .header { padding: 10px 14px; border-bottom: 1px solid var(--border-color); background: #111827; display: flex; flex-direction: column; gap: 6px; }
    .header-row { display: flex; justify-content: space-between; align-items: center; width: 100%; white-space: nowrap; }
    
    .header .room-name { color: var(--accent-color); font-weight: bold; cursor: pointer; white-space: nowrap; text-overflow: ellipsis; overflow: hidden; font-size: 1.05rem; max-width: 70%; }
    .header-sub-info { font-size: 0.75rem; color: var(--text-muted); display: flex; align-items: center; gap: 6px; white-space: nowrap; }
    .header-copy-btn { background: #334155; color: #f8fafc; border: none; padding: 2px 6px; border-radius: 4px; cursor: pointer; font-size: 0.7rem; line-height: 1.2; flex-shrink: 0; margin: 0; }
    .header-copy-btn:hover { background: #475569; }

    .version-tag { font-size: 0.65rem; color: #64748b; flex-shrink: 0; }
    
    .btn-action-group { display: flex; gap: 6px; width: 100%; align-items: center; overflow: hidden; }
    .btn-leave { background: #64748b; color: white; border: none; padding: 6px 8px; border-radius: 6px; cursor: pointer; font-size: 0.75rem; font-weight: bold; flex: 1; min-width: 0; text-align: center; line-height: 1.2; }
    .btn-leave:hover { background: #475569; }

    .btn-host-action { background: #ef4444; color: white; border: none; padding: 6px 8px; border-radius: 6px; cursor: pointer; font-size: 0.72rem; font-weight: bold; line-height: 1.2; white-space: nowrap; display: none; align-items: center; justify-content: center; }
    .btn-host-action:hover { background: #dc2626; }
    .btn-kick { background: #f59e0b; }
    .btn-kick:hover { background: #d97706; }

    .view { display: none; padding: 20px; flex-direction: column; height: 100%; overflow-y: auto; }
    .view.active { display: flex; }

    label { font-size: 0.85rem; color: var(--text-muted); margin-top: 12px; display: block; }
    input, textarea, select { width: 100%; padding: 12px; margin-top: 6px; border-radius: 8px; border: 1px solid var(--border-color); background: #0f172a; color: white; outline: none; }
    input:focus, textarea:focus, select:focus { border-color: var(--accent-color); }
    textarea { resize: none; height: 44px; font-size: 0.9rem; line-height: 1.4; }
    
    button { width: 100%; padding: 12px; margin-top: 18px; border-radius: 8px; border: none; background: var(--accent-color); color: #0f172a; font-weight: bold; cursor: pointer; }
    .btn-secondary { background: #475569; color: white; }

    .max-members-group { display: flex; gap: 8px; margin-top: 8px; }
    .max-members-group label { margin: 0; flex: 1; }
    .max-members-group input[type="radio"] { display: none; }
    .max-members-group span { display: block; text-align: center; padding: 10px 0; border-radius: 8px; border: 1px solid var(--border-color); background: #0f172a; color: var(--text-muted); cursor: pointer; font-size: 0.9rem; }
    .max-members-group input[type="radio"]:checked + span { border-color: var(--accent-color); background: #0c4a6e; color: white; font-weight: bold; }

    #chat-messages { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; padding-bottom: 10px; }
    
    .message { display: flex; flex-direction: column; width: fit-content; max-width: 80%; padding: 8px 12px; border-radius: 12px; position: relative; word-break: break-word; align-self: flex-start; font-size: 0.85rem; line-height: 1.4; }
    
    .message.self { align-self: flex-end; background: #0284c7; color: white; }
    .message.self .sender { color: #e0f2fe; }

    .message.user-color-0 { background: #334155; color: #f8fafc; }
    .message.user-color-1 { background: #1e3a29; color: #f8fafc; border: 1px solid #2e5d40; }
    .message.user-color-2 { background: #3b2f1e; color: #f8fafc; border: 1px solid #5d4a2e; }
    .message.user-color-3 { background: #2e1e3b; color: #f8fafc; border: 1px solid #4a2e5d; }

    .message .sender { font-size: 0.75rem; color: var(--text-muted); margin-bottom: 2px; padding-right: 20px; font-weight: bold; }
    .message .text-content { white-space: pre-wrap; }
    .message .del-btn { position: absolute; top: 4px; right: 8px; cursor: pointer; color: #fca5a5; font-size: 0.75rem; opacity: 0; transition: 0.2s; }
    .message:hover .del-btn { opacity: 1; }

    .system-notification { text-align: center; font-size: 0.75rem; color: var(--text-muted); margin: 4px 0; align-self: center; }

    .chat-img { max-width: 100%; max-height: 200px; border-radius: 8px; margin-top: 6px; cursor: pointer; user-select: none; -webkit-user-drag: none; }
    .chat-img-poster-thumb { width: 120px; height: auto; border-radius: 6px; margin-top: 6px; image-rendering: pixelated; border: 1px dashed #f59e0b; }
    .expired-img-note { font-size: 0.72rem; color: #f87171; font-style: italic; margin-top: 4px; }
    .poster-only-note { font-size: 0.68rem; color: #fbbf24; margin-top: 2px; }
    
    .input-area { display: flex; flex-direction: column; gap: 6px; padding-top: 8px; border-top: 1px solid var(--border-color); }
    
    .typing-indicator { font-size: 0.75rem; color: var(--text-muted); font-style: italic; min-height: 1.1rem; }
    
    .input-row { display: flex; gap: 8px; align-items: flex-end; }
    .file-btn { background: #475569; color: white; padding: 12px; border-radius: 8px; cursor: pointer; font-size: 0.9rem; margin: 0; width: auto; height: 44px; display: flex; align-items: center; justify-content: center; }

    .security-disclaimer { font-size: 0.68rem; color: #94a3b8; line-height: 1.35; margin-top: 4px; padding: 0 2px; }

    .display-time-row { display: flex; align-items: center; gap: 8px; font-size: 0.75rem; color: var(--text-muted); }
    .display-time-row select { width: auto; padding: 4px 8px; margin: 0; font-size: 0.75rem; }

    #full-overlay { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(15, 23, 42, 0.85); backdrop-filter: blur(4px); z-index: 9999; display: none; justify-content: center; align-items: center; }
    .toast-message { background: #ef4444; color: white; padding: 14px 28px; border-radius: 12px; font-weight: bold; font-size: 1rem; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.5); text-align: center; }

    /* モーダル */
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
  </style>
</head>
<body>

<div id="full-overlay">
  <div class="toast-message" id="toast-text">現在満員です</div>
</div>

<!-- 強制退室モーダル -->
<div id="kick-modal" class="modal-overlay">
  <div class="modal-box">
    <h3>強制退室</h3>
    <p>退室させるメンバーを選んでください</p>
    <div id="kick-member-list" class="modal-member-list"></div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeKickModal()">キャンセル</button>
    </div>
  </div>
</div>

<!-- 強制退室確認モーダル -->
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
    <div class="header-row">
      <span class="room-name" id="header-room-name" onclick="goHome()">SimpleChatee</span>
      <span class="version-tag">Ver. 2.0.0</span>
    </div>
    <div class="header-row" id="header-room-id-container" style="display: none;">
      <div class="header-sub-info">
        <span id="member-count"></span>
        <button class="header-copy-btn" onclick="copyRoomLink()">🔗コピー</button>
      </div>
      <div class="display-time-row" id="display-time-control" style="display:none;">
        <span>画像</span>
        <select id="image-display-select" onchange="changeImageDisplayTime()">
          <option value="1">1秒</option>
          <option value="3">3秒</option>
          <option value="5">5秒</option>
          <option value="3600">1時間</option>
        </select>
      </div>
    </div>
    <div class="header-row" id="room-action-container" style="display: none;">
      <div class="btn-action-group">
        <button class="btn-leave" onclick="leaveRoom()">退室</button>
        <button id="btn-kick" class="btn-host-action btn-kick" onclick="openKickModal()">強制退室</button>
        <button id="btn-delete-room" class="btn-host-action" onclick="deleteRoom()">部屋削除</button>
      </div>
    </div>
  </div>

  <!-- メイン画面 -->
  <div id="view-home" class="view active">
    <h2 style="text-align:center; margin-bottom: 20px;">SimpleChatee</h2>
    
    <button onclick="showView('view-create')">新しい部屋を作成</button>
    <div style="text-align: center; margin: 15px 0; color: var(--text-muted);">- または -</div>
    <input type="text" id="join-room-name" placeholder="部屋名を入力">
    <button class="btn-secondary" onclick="checkRoomJoin()">部屋に参加</button>
    <p style="font-size:0.72rem; color:var(--text-muted); margin-top:12px; text-align:center; line-height:1.4;">
      招待リンクがある場合はリンクから入室してください。<br>
      暗号化鍵はリンクに含まれています。
    </p>
  </div>

  <!-- 部屋作成画面 -->
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

  <!-- 入室画面 -->
  <div id="view-join" class="view">
    <h3 id="join-target-room-title">部屋に入室</h3>
    <label>あなたのニックネーム</label>
    <input type="text" id="join-nickname" placeholder="名無し" maxlength="20">
    <p id="join-key-warning" style="font-size:0.75rem; color:#f87171; margin-top:10px; display:none;">
      暗号化鍵が見つかりません。招待リンクから入室してください。
    </p>
    <button onclick="joinRoom()">入室する</button>
    <button class="btn-secondary" style="margin-top: 10px;" onclick="goHome()">トップに戻る</button>
  </div>

  <!-- チャット画面 -->
  <div id="view-chat" class="view">
    <div id="chat-messages"></div>

    <div class="input-area">
      <div id="file-name-preview" style="font-size: 0.75rem; color: var(--accent-color); display: none;"></div>
      <div id="typing-indicator" class="typing-indicator"></div>
      <div class="input-row">
        <label class="file-btn">
          📷
          <input type="file" id="file-input" accept="image/*" style="display:none;" onchange="onFileSelected(this)">
        </label>
        <textarea id="msg-input" placeholder="メッセージを入力..." oninput="handleTyping()" onkeydown="onKeyDown(event)"></textarea>
        <button style="margin-top:0; width:auto; padding: 0 16px; height: 44px;" onclick="sendMessage()">送信</button>
      </div>
      <div class="security-disclaimer">
        🔒 チャット内容はE2E暗号化により管理者も閲覧不可です。画像は最大1時間で自動削除されます。
      </div>
    </div>
  </div>
</div>

<script src="/socket.io/socket.io.js"></script>
<script>
  const socket = io();
  let currentRoomName = '';
  let currentKey = '';          // 暗号化鍵（URLフラグメントから取得 or 作成時生成）
  let myNickname = '';
  let userSessionId = '';
  let selectedFile = null;
  let isHost = false;
  let currentMaxMembers = 3;
  let currentImageDisplaySeconds = 5;
  let keepAliveTimer = null;
  let pendingKickSessionId = null;
  let pendingKickNickname = null;
  
  let typingTimeout = null;
  let isTyping = false;

  // --- Socket.io 受信イベント ---
  socket.on('connect', function() {
    console.log('[Socket.IO] connected:', socket.id);
    if (currentRoomName && userSessionId) {
      socket.emit('rejoin_room', {
        roomName: currentRoomName,
        sessionId: userSessionId,
        nickname: myNickname
      });
    }
  });

  socket.on('disconnect', function(reason) {
    console.log('[Socket.IO] disconnected:', reason);
    stopKeepAlive();
  });

  socket.on('room_state_sync', function(data) {
    if (!data || data.roomName !== currentRoomName) return;
    updateMemberCount(data.count, data.maxMembers);
    if (typeof data.imageDisplaySeconds === 'number') {
      currentImageDisplaySeconds = data.imageDisplaySeconds;
      const sel = document.getElementById('image-display-select');
      if (sel) sel.value = String(data.imageDisplaySeconds);
    }
    if (Array.isArray(data.messages)) {
      data.messages.forEach(function(msg) {
        if (msg.type === 'system') {
          renderSystemNotification(msg.text, msg.id);
        } else {
          renderSingleMessage(msg);
        }
      });
    }
  });

  socket.on('receive_message', function(msg) {
    if (!msg) return;
    if (msg.type === 'system') {
      renderSystemNotification(msg.text, msg.id);
    } else {
      renderSingleMessage(msg);
    }
  });

  socket.on('message_deleted', function(data) {
    const el = document.getElementById('msg-' + data.msgId);
    if (el) el.remove();
  });

  socket.on('update_members', function(data) {
    if (!data) return;
    updateMemberCount(data.count, data.maxMembers);
  });

  socket.on('image_display_changed', function(data) {
    if (!data) return;
    currentImageDisplaySeconds = data.seconds;
    const sel = document.getElementById('image-display-select');
    if (sel) sel.value = String(data.seconds);
    renderSystemNotification(data.text, data.id);
  });

  socket.on('display_typing', function(data) {
    const indicator = document.getElementById('typing-indicator');
    if (data.isTyping) {
      indicator.innerText = data.nickname + ' が入力中...';
    } else {
      indicator.innerText = '';
    }
  });

  socket.on('room_deleted_by_host', function() {
    alert('部屋主によってこの部屋は削除されました。');
    goHome();
  });

  socket.on('force_left', function() {
    // 強制退室された本人だけが受け取る。静かにトップへ
    stopKeepAlive();
    goHome();
  });

  socket.on('room_full_rejected', function() {
    showToast('現在満員です', function() { goHome(); });
  });

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

  // --- ユーティリティ・暗号化 ---
  function encryptText(plainText, key) {
    if (!plainText) return '';
    try {
      return CryptoJS.AES.encrypt(plainText, key).toString();
    } catch (e) {
      return plainText;
    }
  }

  function decryptText(cipherText, key) {
    if (!cipherText) return '';
    if (!key) return '(鍵がありません)';
    try {
      const bytes = CryptoJS.AES.decrypt(cipherText, key);
      const originalText = bytes.toString(CryptoJS.enc.Utf8);
      return originalText || '(復号エラー)';
    } catch (e) {
      return '(復号失敗)';
    }
  }

  function generateKey() {
    return CryptoJS.lib.WordArray.random(32).toString();
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

  function getPosterThumbnails(roomName) {
    return JSON.parse(localStorage.getItem('poster_thumbs_' + roomName) || '{}');
  }

  function savePosterThumbnail(roomName, msgId, base64Thumb) {
    const thumbs = getPosterThumbnails(roomName);
    thumbs[msgId] = base64Thumb;
    localStorage.setItem('poster_thumbs_' + roomName, JSON.stringify(thumbs));
  }

  function createUltraLightThumbnail(file) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          const targetWidth = 50;
          const scale = targetWidth / img.width;
          canvas.width = targetWidth;
          canvas.height = img.height * scale;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', 0.4));
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function getKeyFromHash() {
    const hash = window.location.hash;
    if (hash && hash.startsWith('#key=')) {
      return decodeURIComponent(hash.substring(5));
    }
    return '';
  }

  function setKeyToHash(key) {
    window.location.hash = 'key=' + encodeURIComponent(key);
  }

  window.onload = function() {
    userSessionId = getOrCreateSessionId();

    const urlParams = new URLSearchParams(window.location.search);
    const urlRoomName = urlParams.get('room');
    const keyFromHash = getKeyFromHash();

    if (urlRoomName) {
      currentRoomName = urlRoomName;
      if (keyFromHash) {
        currentKey = keyFromHash;
        // 自動入室はせず、ニックネーム入力へ
        document.getElementById('join-target-room-title').innerText = '「' + urlRoomName + '」に入室';
        document.getElementById('join-key-warning').style.display = 'none';
        showView('view-join');
      } else {
        document.getElementById('join-target-room-title').innerText = '「' + urlRoomName + '」に入室';
        document.getElementById('join-key-warning').style.display = 'block';
        showView('view-join');
      }
    }
  };

  function showToast(message, callback) {
    const overlay = document.getElementById('full-overlay');
    const toast = document.getElementById('toast-text');
    toast.innerText = message;
    overlay.style.display = 'flex';
    setTimeout(() => {
      overlay.style.display = 'none';
      if (callback) callback();
    }, 2000);
  }

  function showView(id) {
    const views = document.querySelectorAll('.view');
    views.forEach(function(v) { v.classList.remove('active'); });
    document.getElementById(id).classList.add('active');
  }

  function goHome() {
    stopKeepAlive();
    currentRoomName = '';
    currentKey = '';
    isHost = false;
    window.history.pushState({}, '', window.location.pathname);
    window.location.hash = '';
    document.getElementById('header-room-name').innerText = 'SimpleChatee';
    document.getElementById('header-room-id-container').style.display = 'none';
    document.getElementById('member-count').innerText = '';
    document.getElementById('room-action-container').style.display = 'none';
    document.getElementById('btn-delete-room').style.display = 'none';
    document.getElementById('btn-kick').style.display = 'none';
    document.getElementById('display-time-control').style.display = 'none';
    showView('view-home');
  }

  function updateMemberCount(count, maxMembers) {
    const el = document.getElementById('member-count');
    if (!el) return;
    const safeCount = Math.max(0, Number(count) || 0);
    const max = maxMembers || currentMaxMembers || 3;
    el.innerText = safeCount + '/' + max + '人';
  }

  // --- 部屋作成 ---
  function createRoom() {
    const name = (document.getElementById('create-room-name').value || '').trim();
    myNickname = (document.getElementById('create-nickname').value || '部屋主').trim().substring(0, 20);
    const maxMembersRadio = document.querySelector('input[name="max-members"]:checked');
    const maxMembers = maxMembersRadio ? parseInt(maxMembersRadio.value, 10) : 3;

    if (!name) return alert('部屋名を入力してください');
    if (name.length > 30) return alert('部屋名は30文字以内にしてください');

    // クライアント側で暗号化鍵を生成（サーバーには送らない）
    currentKey = generateKey();
    currentRoomName = name;
    currentMaxMembers = maxMembers;
    isHost = true;

    socket.emit('create_room', {
      name: name,
      nickname: myNickname,
      sessionId: userSessionId,
      maxMembers: maxMembers
    }, function(res) {
      if (res.success) {
        setKeyToHash(currentKey);
        setupChatView(name, res.messages || [], maxMembers, res.imageDisplaySeconds || 5);
        startKeepAlive();
      } else {
        alert(res.error || '部屋の作成に失敗しました');
        currentKey = '';
        currentRoomName = '';
        isHost = false;
      }
    });
  }

  function checkRoomJoin() {
    const roomName = (document.getElementById('join-room-name').value || '').trim();
    if (!roomName) return alert('部屋名を入力してください');
    currentRoomName = roomName;
    const keyFromHash = getKeyFromHash();
    if (keyFromHash) currentKey = keyFromHash;

    document.getElementById('join-target-room-title').innerText = '「' + roomName + '」に入室';
    document.getElementById('join-key-warning').style.display = currentKey ? 'none' : 'block';
    showView('view-join');
  }

  function joinRoom() {
    myNickname = (document.getElementById('join-nickname').value || 'ゲスト').trim().substring(0, 20);
    if (!currentKey) {
      alert('暗号化鍵がありません。招待リンクから入室してください。');
      return;
    }

    socket.emit('join_room', {
      roomName: currentRoomName,
      nickname: myNickname,
      sessionId: userSessionId
    }, function(res) {
      if (res.success) {
        isHost = res.isHost || false;
        currentMaxMembers = res.maxMembers || 3;
        currentImageDisplaySeconds = res.imageDisplaySeconds || 5;
        setupChatView(res.roomName || currentRoomName, res.messages || [], currentMaxMembers, currentImageDisplaySeconds);
        if (isHost) startKeepAlive();
        // URLを整える
        window.history.pushState({}, '', '?room=' + encodeURIComponent(currentRoomName));
        setKeyToHash(currentKey);
      } else {
        if (res.full) {
          showToast('現在満員です', function() { goHome(); });
        } else {
          alert(res.error || '入室に失敗しました');
        }
      }
    });
  }

  function leaveRoom() {
    if (confirm('本当にこの部屋から退室しますか？')) {
      socket.emit('leave_room', {
        roomName: currentRoomName,
        sessionId: userSessionId
      });
      goHome();
    }
  }

  function deleteRoom() {
    if (confirm('【警告】本当にこの部屋を削除しますか？\\n参加者全員が退室し、部屋は消滅します。')) {
      socket.emit('delete_room', { roomName: currentRoomName }, function(res) {
        if (res.success) {
          alert('部屋を削除しました');
          goHome();
        } else {
          alert(res.error || '削除権限がありません');
        }
      });
    }
  }

  // --- 強制退室 ---
  function openKickModal() {
    socket.emit('get_members_for_kick', { roomName: currentRoomName });
    document.getElementById('kick-modal').classList.add('active');
  }

  function closeKickModal() {
    document.getElementById('kick-modal').classList.remove('active');
  }

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
    socket.emit('force_kick', {
      roomName: currentRoomName,
      targetSessionId: pendingKickSessionId
    }, function(res) {
      closeKickConfirmModal();
      if (!res.success) {
        alert(res.error || '退室させられませんでした');
      }
      // 成功時は他の人にも本人にも何も出さない（要件通り）
    });
  };

  function setupChatView(roomName, messages, maxMembers, imageDisplaySeconds) {
    currentRoomName = roomName;
    currentMaxMembers = maxMembers || 3;
    currentImageDisplaySeconds = imageDisplaySeconds || 5;

    document.getElementById('header-room-name').innerText = roomName;
    document.getElementById('header-room-id-container').style.display = 'flex';
    document.getElementById('room-action-container').style.display = 'flex';
    document.getElementById('display-time-control').style.display = 'flex';

    const sel = document.getElementById('image-display-select');
    if (sel) sel.value = String(currentImageDisplaySeconds);

    if (isHost) {
      document.getElementById('btn-delete-room').style.display = 'flex';
      document.getElementById('btn-kick').style.display = 'flex';
    } else {
      document.getElementById('btn-delete-room').style.display = 'none';
      document.getElementById('btn-kick').style.display = 'none';
    }

    window.history.pushState({}, '', '?room=' + encodeURIComponent(currentRoomName));
    if (currentKey) setKeyToHash(currentKey);

    showView('view-chat');

    const container = document.getElementById('chat-messages');
    container.innerHTML = '';

    if (messages && messages.length > 0) {
      messages.forEach(function(msg) {
        if (msg.type === 'system') {
          renderSystemNotification(msg.text, msg.id);
        } else {
          renderSingleMessage(msg);
        }
      });
    }
  }

  function copyRoomLink() {
    const url = window.location.origin + '?room=' + encodeURIComponent(currentRoomName) + '#key=' + encodeURIComponent(currentKey);
    navigator.clipboard.writeText(url).then(function() {
      alert('招待リンクをコピーしました！\\n（暗号化鍵が含まれています）');
    }).catch(function() {
      prompt('このリンクをコピーしてください', url);
    });
  }

  function changeImageDisplayTime() {
    const sel = document.getElementById('image-display-select');
    const seconds = parseInt(sel.value, 10);
    if (!seconds) return;
    socket.emit('change_image_display_time', {
      roomName: currentRoomName,
      seconds: seconds
    });
  }

  // --- ホストkeep-alive（14分間隔） ---
  function startKeepAlive() {
    stopKeepAlive();
    if (!isHost) return;
    keepAliveTimer = setInterval(function() {
      if (socket.connected && currentRoomName) {
        socket.emit('keep_alive', { roomName: currentRoomName });
      }
    }, 14 * 60 * 1000); // 14分
  }

  function stopKeepAlive() {
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
  }

  function onFileSelected(input) {
    if (input.files && input.files[0]) {
      selectedFile = input.files[0];
      const preview = document.getElementById('file-name-preview');
      preview.innerText = '選択中: ' + selectedFile.name;
      preview.style.display = 'block';
    }
  }

  function handleTyping() {
    if (!isTyping) {
      isTyping = true;
      socket.emit('typing_start', { roomName: currentRoomName });
    }
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => { stopTyping(); }, 2000);
  }

  function stopTyping() {
    if (isTyping) {
      isTyping = false;
      socket.emit('typing_stop', { roomName: currentRoomName });
    }
    clearTimeout(typingTimeout);
  }

  function onKeyDown(e) {
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    if (!isMobile && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  async function sendMessage() {
    const input = document.getElementById('msg-input');
    const text = input.value.trim();
    let imageUrl = null;
    let localThumbBase64 = null;

    if (!text && !selectedFile) return;
    if (!currentKey) {
      alert('暗号化鍵がありません');
      return;
    }

    stopTyping();

    // 画像+テキスト同時投稿なら強制1時間、画像のみなら部屋設定
    const hasText = !!text;
    const hasImage = !!selectedFile;
    let displaySeconds = currentImageDisplaySeconds;
    if (hasImage && hasText) {
      displaySeconds = 3600; // 強制1時間
    }

    if (selectedFile) {
      try {
        localThumbBase64 = await createUltraLightThumbnail(selectedFile);
      } catch (e) {}

      const formData = new FormData();
      formData.append('image', selectedFile);

      try {
        const res = await fetch('/api/upload', { method: 'POST', body: formData });
        const data = await res.json();
        imageUrl = data.imageUrl;
      } catch (e) {
        alert('画像のアップロードに失敗しました');
        return;
      }
    }

    const encryptedText = text ? encryptText(text, currentKey) : '';
    const msgId = Math.random().toString(36).substring(2, 10);

    // 投稿者本人のサムネを保存
    if (localThumbBase64) {
      savePosterThumbnail(currentRoomName, msgId, localThumbBase64);
    }

    socket.emit('send_message', {
      msgId: msgId,
      roomName: currentRoomName,
      text: encryptedText,
      image: imageUrl,
      displaySeconds: displaySeconds
    });

    input.value = '';
    selectedFile = null;
    document.getElementById('file-input').value = '';
    document.getElementById('file-name-preview').style.display = 'none';
  }

  function deleteMessage(msgId) {
    socket.emit('delete_message', {
      roomName: currentRoomName,
      msgId: msgId
    });
  }

  function handleImageExpire(imgEl, msgId, isSelf) {
    imgEl.style.display = 'none';

    if (isSelf) {
      const thumbs = getPosterThumbnails(currentRoomName);
      if (thumbs[msgId]) {
        const thumbImg = document.createElement('img');
        thumbImg.src = thumbs[msgId];
        thumbImg.className = 'chat-img-poster-thumb';
        thumbImg.title = '自分だけ見えるサムネ';
        imgEl.parentNode.appendChild(thumbImg);

        const note = document.createElement('div');
        note.className = 'poster-only-note';
        note.innerText = '🔒 自分だけ見えるサムネ';
        imgEl.parentNode.appendChild(note);
        return;
      }
    }

    const note = document.createElement('div');
    note.className = 'expired-img-note';
    note.innerText = '🔒 画像の表示期限が切れました';
    imgEl.parentNode.appendChild(note);
  }

  function renderSingleMessage(msg) {
    const container = document.getElementById('chat-messages');
    if (document.getElementById('msg-' + msg.id)) return;

    const div = document.createElement('div');
    const isSelf = (msg.sessionId === userSessionId);
    const colorClass = isSelf ? 'self' : ('user-color-' + (msg.colorIndex || 0) % 4);
    
    div.className = 'message ' + colorClass;
    div.id = 'msg-' + msg.id;

    const plainText = msg.text ? decryptText(msg.text, currentKey) : '';

    let html = '';
    if (isSelf) {
      html += '<span class="del-btn" onclick="deleteMessage(\\'' + msg.id + '\\')">✕</span>';
    }
    html += '<div class="sender">' + escapeHtml(msg.senderName) + '</div>';
    if (plainText) {
      html += '<div class="text-content">' + escapeHtml(plainText) + '</div>';
    }
    if (msg.image) {
      html += '<img src="' + msg.image + '" class="chat-img" id="img-' + msg.id + '" onclick="openImageInNewTab(\\'' + msg.image + '\\')">';
    }

    div.innerHTML = html;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;

    // 画像表示タイマー
    if (msg.image) {
      const displaySec = (typeof msg.displaySeconds === 'number') ? msg.displaySeconds : currentImageDisplaySeconds;
      const imgEl = document.getElementById('img-' + msg.id);
      if (imgEl && displaySec > 0) {
        setTimeout(function() {
          if (imgEl && imgEl.parentNode) {
            handleImageExpire(imgEl, msg.id, isSelf);
          }
        }, displaySec * 1000);
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

  function openImageInNewTab(src) {
    window.open(src, '_blank');
  }

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

// --- Socket.io サーバー側処理 ---
io.on('connection', (socket) => {

  function setSocketSession(roomName, sessionId) {
    socket.data.roomName = roomName;
    socket.data.sessionId = sessionId;
  }

  function getActiveMemberCount(room) {
    if (!room) return 0;
    return room.members.filter(m => m.id !== null).length;
  }

  function emitMemberCount(roomName) {
    const room = rooms[roomName];
    if (!room) return;
    const activeCount = getActiveMemberCount(room);
    io.to(roomName).emit('update_members', {
      count: activeCount,
      maxMembers: room.maxMembers
    });
  }

  function syncRoomToSocket(targetSocket, roomName) {
    const room = rooms[roomName];
    if (!room) return;
    const activeCount = getActiveMemberCount(room);
    targetSocket.emit('room_state_sync', {
      roomName: roomName,
      count: activeCount,
      maxMembers: room.maxMembers,
      imageDisplaySeconds: room.imageDisplaySeconds,
      messages: room.messages
    });
  }

  // 軽量keep-alive（ホストのみが送る）
  socket.on('keep_alive', ({ roomName }) => {
    // 何もしない。受信した事実だけでRenderのアイドルタイマーがリセットされる
  });

  socket.on('rejoin_room', ({ roomName, sessionId, nickname }) => {
    const room = rooms[roomName];
    if (!room) return;

    socket.join(roomName);
    setSocketSession(roomName, sessionId);

    let member = room.members.find(m => m.sessionId === sessionId);
    if (member) {
      member.id = socket.id;
      if (nickname) member.nickname = nickname;
    } else {
      // 再入室時にメンバー枠が空いていれば追加
      const activeCount = getActiveMemberCount(room);
      if (activeCount < room.maxMembers) {
        const colorIndex = room.members.length % 4;
        room.members.push({
          id: socket.id,
          sessionId,
          nickname: nickname || 'ゲスト',
          colorIndex
        });
      }
    }

    room.lastActivityAt = Date.now();
    syncRoomToSocket(socket, roomName);
    emitMemberCount(roomName);
  });

  socket.on('create_room', ({ name, nickname, sessionId, maxMembers }, callback) => {
    if (!name || typeof name !== 'string') {
      return callback({ success: false, error: '部屋名が不正です' });
    }
    const roomName = name.trim().substring(0, 30);
    if (!roomName) {
      return callback({ success: false, error: '部屋名を入力してください' });
    }

    // 既に同名の部屋が存在する場合
    if (rooms[roomName]) {
      return callback({ success: false, error: 'この部屋名は既に使われています。別の名前にしてください。' });
    }

    const safeMax = [3, 4, 5].includes(maxMembers) ? maxMembers : 3;

    const initialSystemMsg = {
      type: 'system',
      id: 'system-' + Math.random().toString(36).substring(2, 10),
      text: nickname + ' が入室しました'
    };

    rooms[roomName] = {
      name: roomName,
      hostSessionId: sessionId,
      maxMembers: safeMax,
      imageDisplaySeconds: 5, // デフォルト5秒
      members: [{
        id: socket.id,
        sessionId,
        nickname: nickname || '部屋主',
        colorIndex: 0
      }],
      messages: [initialSystemMsg],
      lastActivityAt: Date.now()
    };

    socket.join(roomName);
    setSocketSession(roomName, sessionId);

    callback({
      success: true,
      roomName,
      messages: [initialSystemMsg],
      isHost: true,
      maxMembers: safeMax,
      imageDisplaySeconds: 5,
      memberCount: 1
    });

    emitMemberCount(roomName);
  });

  socket.on('join_room', ({ roomName, nickname, sessionId }, callback) => {
    const room = rooms[roomName];
    if (!room) {
      return callback({ success: false, error: '部屋が存在しません。部屋名を確認するか、新しく作成してください。' });
    }

    const existingMember = room.members.find(m => m.sessionId === sessionId);
    const activeMembers = room.members.filter(m => m.id !== null && m.sessionId !== sessionId);

    if (!existingMember && activeMembers.length >= room.maxMembers) {
      socket.emit('room_full_rejected');
      return callback({ success: false, full: true, error: '現在満員です' });
    }

    if (!existingMember) {
      const colorIndex = room.members.length % 4;
      room.members.push({
        id: socket.id,
        sessionId,
        nickname: nickname || 'ゲスト',
        colorIndex
      });
    } else {
      existingMember.id = socket.id;
      existingMember.nickname = nickname || existingMember.nickname;
    }

    room.lastActivityAt = Date.now();
    socket.join(roomName);
    setSocketSession(roomName, sessionId);

    const systemMsg = {
      type: 'system',
      id: 'system-' + Math.random().toString(36).substring(2, 10),
      text: (nickname || 'ゲスト') + ' が入室しました'
    };
    room.messages.push(systemMsg);

    const isHost = (room.hostSessionId === sessionId);
    const activeCount = getActiveMemberCount(room);

    callback({
      success: true,
      roomName: room.name,
      messages: room.messages,
      isHost,
      maxMembers: room.maxMembers,
      imageDisplaySeconds: room.imageDisplaySeconds,
      memberCount: activeCount
    });

    setTimeout(() => {
      if (rooms[roomName]) {
        io.to(roomName).emit('receive_message', systemMsg);
        emitMemberCount(roomName);
      }
    }, 0);
  });

  socket.on('leave_room', ({ roomName, sessionId }) => {
    const targetRoomName = roomName || socket.data.roomName;
    const room = rooms[targetRoomName];
    if (!room) return;

    const sid = sessionId || socket.data.sessionId;
    const member = room.members.find(m => m.sessionId === sid || m.id === socket.id);
    if (member) {
      member.id = null;
      room.lastActivityAt = Date.now();

      const systemMsg = {
        type: 'system',
        id: 'system-' + Math.random().toString(36).substring(2, 10),
        text: member.nickname + ' が退室しました'
      };
      room.messages.push(systemMsg);
      io.to(targetRoomName).emit('receive_message', systemMsg);
      emitMemberCount(targetRoomName);
      socket.leave(targetRoomName);
      socket.data.roomName = null;
    }
  });

  socket.on('delete_room', ({ roomName }, callback) => {
    const targetRoomName = roomName || socket.data.roomName;
    const room = rooms[targetRoomName];
    if (!room) {
      return callback({ success: false, error: '部屋が存在しません' });
    }
    if (room.hostSessionId !== socket.data.sessionId) {
      return callback({ success: false, error: '部屋を削除する権限がありません' });
    }

    // 画像の物理削除
    room.messages.forEach(msg => {
      if (msg.image) {
        const filename = path.basename(msg.image);
        const filePath = path.join(uploadDir, filename);
        if (fs.existsSync(filePath)) {
          fs.unlink(filePath, () => {});
        }
      }
    });

    io.to(targetRoomName).emit('room_deleted_by_host');
    delete rooms[targetRoomName];
    callback({ success: true });
  });

  socket.on('get_members_for_kick', ({ roomName }) => {
    const room = rooms[roomName];
    if (!room || room.hostSessionId !== socket.data.sessionId) return;

    const others = room.members
      .filter(m => m.id !== null && m.sessionId !== socket.data.sessionId)
      .map(m => ({ sessionId: m.sessionId, nickname: m.nickname }));

    socket.emit('members_for_kick', { members: others });
  });

  socket.on('force_kick', ({ roomName, targetSessionId }, callback) => {
    const room = rooms[roomName];
    if (!room) {
      return callback({ success: false, error: '部屋が存在しません' });
    }
    if (room.hostSessionId !== socket.data.sessionId) {
      return callback({ success: false, error: '権限がありません' });
    }
    if (targetSessionId === room.hostSessionId) {
      return callback({ success: false, error: '自分自身は退室させられません' });
    }

    const target = room.members.find(m => m.sessionId === targetSessionId);
    if (!target || !target.id) {
      return callback({ success: false, error: '対象のメンバーが見つかりません' });
    }

    // 対象ソケットにだけ force_left を送り、静かに退室させる
    const targetSocket = io.sockets.sockets.get(target.id);
    if (targetSocket) {
      targetSocket.emit('force_left');
      targetSocket.leave(roomName);
      targetSocket.data.roomName = null;
    }

    // メンバーリストからアクティブ状態を外す（再入室可能にするため削除はしない）
    target.id = null;

    // 他の人には何も通知しない（要件）
    emitMemberCount(roomName);
    callback({ success: true });
  });

  socket.on('change_image_display_time', ({ roomName, seconds }) => {
    const room = rooms[roomName];
    if (!room) return;
    if (![1, 3, 5, 3600].includes(seconds)) return;

    room.imageDisplaySeconds = seconds;
    room.lastActivityAt = Date.now();

    let label = seconds + '秒';
    if (seconds === 3600) label = '1時間';

    const systemMsg = {
      type: 'system',
      id: 'system-' + Math.random().toString(36).substring(2, 10),
      text: '画像表示時間が' + label + 'に切り替わりました'
    };
    room.messages.push(systemMsg);

    io.to(roomName).emit('image_display_changed', {
      seconds: seconds,
      text: systemMsg.text,
      id: systemMsg.id
    });
  });

  socket.on('typing_start', ({ roomName }) => {
    const targetRoomName = roomName || socket.data.roomName;
    const room = rooms[targetRoomName];
    if (!room) return;
    const sender = room.members.find(m => m.id === socket.id);
    if (sender) {
      socket.to(targetRoomName).emit('display_typing', {
        nickname: sender.nickname,
        isTyping: true
      });
    }
  });

  socket.on('typing_stop', ({ roomName }) => {
    const targetRoomName = roomName || socket.data.roomName;
    socket.to(targetRoomName).emit('display_typing', { isTyping: false });
  });

  socket.on('send_message', ({ msgId, roomName, text, image, displaySeconds }) => {
    const targetRoomName = roomName || socket.data.roomName;
    const room = rooms[targetRoomName];
    if (!room) return;

    const sessionId = socket.data.sessionId;
    let sender = room.members.find(m => m.sessionId === sessionId || m.id === socket.id);
    if (sender) {
      sender.id = socket.id;
      socket.join(targetRoomName);
      setSocketSession(targetRoomName, sessionId);
    }

    room.lastActivityAt = Date.now();

    const messageData = {
      type: 'user',
      id: msgId || Math.random().toString(36).substring(2, 10),
      sessionId: sessionId,
      senderName: sender ? sender.nickname : '匿名',
      colorIndex: sender ? sender.colorIndex : 0,
      text,
      image,
      displaySeconds: typeof displaySeconds === 'number' ? displaySeconds : room.imageDisplaySeconds
    };

    room.messages.push(messageData);
    io.to(targetRoomName).emit('receive_message', messageData);
  });

  socket.on('delete_message', ({ roomName, msgId }) => {
    const targetRoomName = roomName || socket.data.roomName;
    const room = rooms[targetRoomName];
    if (!room) return;

    const targetMsg = room.messages.find(m => m.id === msgId);
    if (targetMsg && targetMsg.sessionId === socket.data.sessionId) {
      room.messages = room.messages.filter(m => m.id !== msgId);
      io.to(targetRoomName).emit('message_deleted', { msgId });
    }
  });

  socket.on('disconnect', () => {
    const roomName = socket.data.roomName;
    if (roomName && rooms[roomName]) {
      const room = rooms[roomName];
      const member = room.members.find(m => m.id === socket.id);
      if (member) {
        member.id = null;
        emitMemberCount(roomName);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
});
