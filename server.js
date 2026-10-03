const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
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
app.use('/uploads', express.static(uploadDir));

// --- 部屋データ管理 ---
const rooms = {};

// --- 画像アップロード API (送信時に1時間後自動削除タイマーをセット) ---
app.post('/api/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'ファイルがありません' });

  const imageUrl = '/uploads/' + req.file.filename;
  const filePath = req.file.path;

  // 1時間（3,600,000ミリ秒）後にファイルをサーバーから自動消去
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
  <title>ChatAlya - Anonymous Chat</title>
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
    
    .container { width: 100%; max-width: 500px; background: var(--card-bg); border-radius: 16px; border: 1px solid var(--border-color); overflow: hidden; display: flex; flex-direction: column; height: 90vh; }
    .header { padding: 16px; border-bottom: 1px solid var(--border-color); text-align: center; font-weight: bold; background: #111827; display: flex; justify-content: space-between; align-items: center; }
    .header .room-name { color: var(--accent-color); }
    
    .view { display: none; padding: 20px; flex-direction: column; height: 100%; overflow-y: auto; }
    .view.active { display: flex; }

    label { font-size: 0.85rem; color: var(--text-muted); margin-top: 12px; display: block; }
    input { width: 100%; padding: 12px; margin-top: 6px; border-radius: 8px; border: 1px solid var(--border-color); background: #0f172a; color: white; outline: none; }
    input:focus { border-color: var(--accent-color); }
    button { width: 100%; padding: 12px; margin-top: 18px; border-radius: 8px; border: none; background: var(--accent-color); color: #0f172a; font-weight: bold; cursor: pointer; }

    #chat-messages { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; padding-bottom: 10px; }
    .message { display: flex; flex-direction: column; max-width: 80%; background: #334155; padding: 10px 14px; border-radius: 12px; position: relative; word-break: break-word; }
    .message.self { align-self: flex-end; background: #0284c7; color: white; }
    .message .sender { font-size: 0.75rem; color: var(--text-muted); margin-bottom: 4px; }
    .message.self .sender { color: #e0f2fe; }
    .message .del-btn { position: absolute; top: 4px; right: 8px; cursor: pointer; color: #fca5a5; font-size: 0.75rem; opacity: 0; transition: 0.2s; }
    .message:hover .del-btn { opacity: 1; }

    .chat-img { max-width: 100%; max-height: 200px; border-radius: 8px; margin-top: 6px; cursor: pointer; }
    
    .input-area { display: flex; flex-direction: column; gap: 6px; padding-top: 10px; border-top: 1px solid var(--border-color); }
    .input-row { display: flex; gap: 8px; align-items: center; }
    .input-row input[type="text"] { margin-top: 0; flex: 1; }
    .file-btn { background: #475569; color: white; padding: 12px; border-radius: 8px; cursor: pointer; font-size: 0.9rem; margin: 0; width: auto; }

    .modal { display: none; position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0,0,0,0.85); justify-content: center; align-items: center; z-index: 1000; }
    .modal img { max-width: 90%; max-height: 90%; border-radius: 8px; }
  </style>
</head>
<body>

<div class="container">
  <div class="header">
    <span class="room-name" id="header-room-name">ChatAlya</span>
    <span id="member-count" style="font-size: 0.8rem; color: var(--text-muted);"></span>
  </div>

  <!-- メイン画面 -->
  <div id="view-home" class="view active">
    <h2 style="text-align:center; margin-bottom: 20px;">匿名チャット</h2>
    <button onclick="showView('view-create')">新しい部屋を作成</button>
    <div style="text-align: center; margin: 15px 0; color: var(--text-muted);">- または -</div>
    <input type="text" id="join-room-id" placeholder="部屋IDを入力">
    <button style="background:#475569; color:white;" onclick="checkRoomJoin()">部屋に参加</button>
  </div>

  <!-- 部屋作成画面 -->
  <div id="view-create" class="view">
    <h3>部屋を作成</h3>
    <label>部屋名</label>
    <input type="text" id="create-room-name" placeholder="例: ひみつの部屋">
    <label>パスワード 1（2人目用）</label>
    <input type="password" id="create-pass1" placeholder="パスワード1">
    <label>パスワード 2（3人目用）</label>
    <input type="password" id="create-pass2" placeholder="パスワード2">
    <label>あなたのニックネーム</label>
    <input type="text" id="create-nickname" placeholder="名無し">
    <button onclick="createRoom()">作成して入室</button>
  </div>

  <!-- 入室画面 -->
  <div id="view-join" class="view">
    <h3>部屋に入室</h3>
    <label>あなたのニックネーム</label>
    <input type="text" id="join-nickname" placeholder="名無し">
    <label>簡易パスワード</label>
    <input type="password" id="join-password" placeholder="パスワードを入力">
    <button onclick="joinRoom()">入室する</button>
  </div>

  <!-- チャット画面 -->
  <div id="view-chat" class="view">
    <div id="chat-messages"></div>

    <div class="input-area">
      <div id="file-name-preview" style="font-size: 0.75rem; color: var(--accent-color); display: none;"></div>
      <div class="input-row">
        <label class="file-btn">
          📷
          <input type="file" id="file-input" accept="image/*" style="display:none;" onchange="onFileSelected(this)">
        </label>
        <input type="text" id="msg-input" placeholder="メッセージを入力...">
        <button style="margin-top:0; width:auto; padding: 0 16px;" onclick="sendMessage()">送信</button>
      </div>
    </div>
  </div>
</div>

<div id="img-modal" class="modal" onclick="this.style.display='none'">
  <img id="modal-img" src="">
</div>

<script src="/socket.io/socket.io.js"></script>
<script>
  const socket = io();
  let currentRoomId = '';
  let myNickname = '';
  let selectedFile = null;

  window.onload = () => {
    const urlParams = new URLSearchParams(window.location.search);
    const roomId = urlParams.get('room');
    if (roomId) {
      document.getElementById('join-room-id').value = roomId;
      showView('view-join');
    }
  };

  function showView(id) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById(id).classList.add('active');
  }

  function createRoom() {
    const name = document.getElementById('create-room-name').value || '無題の部屋';
    const pass1 = document.getElementById('create-pass1').value;
    const pass2 = document.getElementById('create-pass2').value;
    myNickname = document.getElementById('create-nickname').value || '部屋主';

    if (!pass1 || !pass2) return alert('パスワードを2つ設定してください');

    socket.emit('create_room', { name, pass1, pass2, nickname: myNickname }, (res) => {
      if (res.success) {
        currentRoomId = res.roomId;
        setupChatView(name);
      }
    });
  }

  function checkRoomJoin() {
    const roomId = document.getElementById('join-room-id').value.trim();
    if (!roomId) return alert('部屋IDを入力してください');
    currentRoomId = roomId;
    showView('view-join');
  }

  function joinRoom() {
    myNickname = document.getElementById('join-nickname').value || 'ゲスト';
    const password = document.getElementById('join-password').value;

    socket.emit('join_room', { roomId: currentRoomId, password, nickname: myNickname }, (res) => {
      if (res.success) {
        setupChatView(res.roomName);
      } else {
        alert(res.error || '入室に失敗しました');
      }
    });
  }

  function setupChatView(roomName) {
    document.getElementById('header-room-name').innerText = roomName;
    window.history.pushState({}, '', '?room=' + currentRoomId);
    showView('view-chat');
  }

  function onFileSelected(input) {
    if (input.files && input.files[0]) {
      selectedFile = input.files[0];
      const preview = document.getElementById('file-name-preview');
      preview.innerText = '選択中: ' + selectedFile.name;
      preview.style.display = 'block';
    }
  }

  async function sendMessage() {
    const input = document.getElementById('msg-input');
    const text = input.value.trim();
    let imageUrl = null;

    if (!text && !selectedFile) return;

    // 画像が選択されている場合は先にアップロード
    if (selectedFile) {
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

    socket.emit('send_message', {
      roomId: currentRoomId,
      text: text,
      image: imageUrl
    });

    // 入力リセット
    input.value = '';
    selectedFile = null;
    document.getElementById('file-input').value = '';
    document.getElementById('file-name-preview').style.display = 'none';
  }

  function deleteMessage(msgId) {
    socket.emit('delete_message', { roomId: currentRoomId, msgId });
  }

  socket.on('receive_message', (msg) => {
    const container = document.getElementById('chat-messages');
    const div = document.createElement('div');
    div.className = 'message ' + (msg.senderId === socket.id ? 'self' : '');
    div.id = 'msg-' + msg.id;

    let html = \`<span class="del-btn" onclick="deleteMessage('\${msg.id}')">✕ 削除</span>\`;
    html += \`<div class="sender">\${msg.senderName}</div>\`;
    if (msg.text) html += \`<div>\${escapeHtml(msg.text)}</div>\`;
    if (msg.image) {
      html += \`<img src="\${msg.image}" class="chat-img" onclick="openModal('\${msg.image}')" onerror="this.alt='(送信から1時間経過のため画像は削除されました)'; this.style.display='none';">\`;
    }

    div.innerHTML = html;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  });

  socket.on('message_deleted', ({ msgId }) => {
    const el = document.getElementById('msg-' + msgId);
    if (el) el.remove();
  });

  socket.on('update_members', ({ count }) => {
    document.getElementById('member-count').innerText = \`(\${count}/3人)\`;
  });

  function openModal(src) {
    document.getElementById('modal-img').src = src;
    document.getElementById('img-modal').style.display = 'flex';
  }

  function escapeHtml(str) {
    return str.replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]);
  }
</script>
</body>
</html>
  `);
});

// --- Socket.io ---
io.on('connection', (socket) => {
  socket.on('create_room', ({ name, pass1, pass2, nickname }, callback) => {
    const roomId = Math.random().toString(36).substring(2, 8);
    rooms[roomId] = { name, pass1, pass2, members: [{ id: socket.id, nickname, role: 'host' }] };
    socket.join(roomId);
    callback({ success: true, roomId });
    io.to(roomId).emit('update_members', { count: rooms[roomId].members.length });
  });

  socket.on('join_room', ({ roomId, password, nickname }, callback) => {
    const room = rooms[roomId];
    if (!room) return callback({ success: false, error: '部屋が存在しません' });
    if (room.members.length >= 3) return callback({ success: false, error: '部屋が満員です（最大3名）' });

    const isValidPass = (password === room.pass1 || password === room.pass2);
    if (!isValidPass) return callback({ success: false, error: 'パスワードが正しくありません' });

    room.members.push({ id: socket.id, nickname, role: 'guest' });
    socket.join(roomId);

    callback({ success: true, roomName: room.name });
    io.to(roomId).emit('update_members', { count: room.members.length });
  });

  socket.on('send_message', ({ roomId, text, image }) => {
    const room = rooms[roomId];
    if (!room) return;
    const sender = room.members.find(m => m.id === socket.id);

    const messageData = {
      id: Math.random().toString(36).substring(2, 10),
      senderId: socket.id,
      senderName: sender ? sender.nickname : '匿名',
      text,
      image
    };

    io.to(roomId).emit('receive_message', messageData);
  });

  socket.on('delete_message', ({ roomId, msgId }) => {
    io.to(roomId).emit('message_deleted', { msgId });
  });

  socket.on('disconnect', () => {
    for (const roomId in rooms) {
      const room = rooms[roomId];
      const index = room.members.findIndex(m => m.id === socket.id);
      if (index !== -1) {
        room.members.splice(index, 1);
        io.to(roomId).emit('update_members', { count: room.members.length });
        if (room.members.length === 0) delete rooms[roomId];
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
