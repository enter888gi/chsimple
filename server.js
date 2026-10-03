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

// --- 画像アップロード API ---
app.post('/api/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'ファイルがありません' });

  const imageUrl = '/uploads/' + req.file.filename;
  const filePath = req.file.path;

  // 1時間後に自動削除
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
  <title>SimpleChatee - Anonymous Chat</title>
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
    .header { padding: 12px 16px; border-bottom: 1px solid var(--border-color); background: #111827; display: flex; justify-content: space-between; align-items: center; gap: 8px; }
    .header-left { display: flex; align-items: center; gap: 8px; overflow: hidden; }
    .header .room-name { color: var(--accent-color); font-weight: bold; cursor: pointer; white-space: nowrap; text-overflow: ellipsis; overflow: hidden; }
    
    .header-sub-info { font-size: 0.7rem; color: var(--text-muted); display: flex; align-items: center; gap: 6px; }
    .header-copy-btn { background: #334155; color: #f8fafc; border: none; padding: 3px 6px; border-radius: 4px; cursor: pointer; font-size: 0.7rem; }
    .header-copy-btn:hover { background: #475569; }

    .view { display: none; padding: 20px; flex-direction: column; height: 100%; overflow-y: auto; }
    .view.active { display: flex; }

    label { font-size: 0.85rem; color: var(--text-muted); margin-top: 12px; display: block; }
    input, textarea { width: 100%; padding: 12px; margin-top: 6px; border-radius: 8px; border: 1px solid var(--border-color); background: #0f172a; color: white; outline: none; }
    input:focus, textarea:focus { border-color: var(--accent-color); }
    textarea { resize: none; height: 44px; font-size: 0.9rem; line-height: 1.4; }
    
    button { width: 100%; padding: 12px; margin-top: 18px; border-radius: 8px; border: none; background: var(--accent-color); color: #0f172a; font-weight: bold; cursor: pointer; }
    .btn-secondary { background: #475569; color: white; }

    #chat-messages { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; padding-bottom: 10px; }
    
    /* 吹き出しのスタイル */
    .message { display: flex; flex-direction: column; width: fit-content; max-width: 80%; padding: 8px 12px; border-radius: 12px; position: relative; word-break: break-word; align-self: flex-start; font-size: 0.85rem; line-height: 1.4; }
    
    /* 自分（青） */
    .message.self { align-self: flex-end; background: #0284c7; color: white; }
    .message.self .sender { color: #e0f2fe; }

    /* 他ユーザー（1つ目のデフォルト・グレー） */
    .message.user-color-0 { background: #334155; color: #f8fafc; }
    
    /* 他ユーザー（2つ目・薄いグリーン） */
    .message.user-color-1 { background: #1e3a29; color: #f8fafc; border: 1px solid #2e5d40; }

    .message .sender { font-size: 0.75rem; color: var(--text-muted); margin-bottom: 2px; padding-right: 20px; font-weight: bold; }
    .message .text-content { white-space: pre-wrap; }
    .message .del-btn { position: absolute; top: 4px; right: 8px; cursor: pointer; color: #fca5a5; font-size: 0.75rem; opacity: 0; transition: 0.2s; }
    .message:hover .del-btn { opacity: 1; }

    .chat-img { max-width: 100%; max-height: 200px; border-radius: 8px; margin-top: 6px; cursor: pointer; user-select: none; -webkit-user-drag: none; }
    
    .input-area { display: flex; flex-direction: column; gap: 6px; padding-top: 10px; border-top: 1px solid var(--border-color); }
    .input-row { display: flex; gap: 8px; align-items: flex-end; }
    .file-btn { background: #475569; color: white; padding: 12px; border-radius: 8px; cursor: pointer; font-size: 0.9rem; margin: 0; width: auto; height: 44px; display: flex; align-items: center; justify-content: center; }
  </style>
</head>
<body>

<div class="container">
  <div class="header">
    <div class="header-left">
      <span class="room-name" id="header-room-name" onclick="goHome()">SimpleChatee</span>
      <div id="header-room-id-container" class="header-sub-info" style="display: none;">
        <span>ID:<span id="display-room-id"></span></span>
        <button class="header-copy-btn" onclick="copyRoomLink()">🔗コピー</button>
      </div>
    </div>
    <span id="member-count" style="font-size: 0.8rem; color: var(--text-muted); white-space: nowrap;"></span>
  </div>

  <!-- メイン画面 -->
  <div id="view-home" class="view active">
    <h2 style="text-align:center; margin-bottom: 20px;">SimpleChatee</h2>
    <button onclick="showView('view-create')">新しい部屋を作成</button>
    <div style="text-align: center; margin: 15px 0; color: var(--text-muted);">- または -</div>
    <input type="text" id="join-room-id" placeholder="部屋IDを入力">
    <button class="btn-secondary" onclick="checkRoomJoin()">部屋に参加</button>
  </div>

  <!-- 部屋作成画面 -->
  <div id="view-create" class="view">
    <h3>部屋を作成</h3>
    <label>部屋名</label>
    <input type="text" id="create-room-name" placeholder="例: ひみつの部屋">
    <label>共通パスワード（参加者用）</label>
    <input type="password" id="create-password" placeholder="合言葉を入力">
    <label>あなたのニックネーム</label>
    <input type="text" id="create-nickname" placeholder="名無し">
    <button onclick="createRoom()">作成して入室</button>
    <button class="btn-secondary" style="margin-top: 10px;" onclick="goHome()">キャンセル</button>
  </div>

  <!-- 入室画面 -->
  <div id="view-join" class="view">
    <h3 id="join-target-room-title">部屋に入室</h3>
    <label>あなたのニックネーム</label>
    <input type="text" id="join-nickname" placeholder="名無し">
    <label>パスワード</label>
    <input type="password" id="join-password" placeholder="パスワードを入力">
    <button onclick="joinRoom()">入室する</button>
    <button class="btn-secondary" style="margin-top: 10px;" onclick="goHome()">トップに戻る（部屋作成 / 別の部屋へ）</button>
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
        <textarea id="msg-input" placeholder="メッセージを入力..." onkeydown="onKeyDown(event)"></textarea>
        <button style="margin-top:0; width:auto; padding: 0 16px; height: 44px;" onclick="sendMessage()">送信</button>
      </div>
    </div>
  </div>
</div>

<script src="/socket.io/socket.io.js"></script>
<script>
  const socket = io();
  let currentRoomId = '';
  let myNickname = '';
  let selectedFile = null;

  window.onload = function() {
    const urlParams = new URLSearchParams(window.location.search);
    const roomId = urlParams.get('room');
    
    const savedRoomId = sessionStorage.getItem('currentRoomId');
    const savedNickname = sessionStorage.getItem('myNickname');
    const savedPassword = sessionStorage.getItem('myPassword');

    if (savedRoomId && savedRoomId === roomId) {
      currentRoomId = savedRoomId;
      myNickname = savedNickname || 'ゲスト';
      socket.emit('join_room', { roomId: currentRoomId, password: savedPassword, nickname: myNickname }, function(res) {
        if (res.success) {
          setupChatView(res.roomName, res.messages);
        } else {
          clearSession();
          initJoinView(roomId);
        }
      });
    } else if (roomId) {
      initJoinView(roomId);
    }
  };

  function initJoinView(roomId) {
    document.getElementById('join-room-id').value = roomId;
    currentRoomId = roomId;

    socket.emit('get_room_info', { roomId: roomId }, function(res) {
      if (res.success && res.roomName) {
        document.getElementById('join-target-room-title').innerText = '「' + res.roomName + '」に入室';
      } else {
        document.getElementById('join-target-room-title').innerText = '部屋に入室';
      }
      showView('view-join');
    });
  }

  function showView(id) {
    const views = document.querySelectorAll('.view');
    views.forEach(function(v) { v.classList.remove('active'); });
    document.getElementById(id).classList.add('active');
  }

  function goHome() {
    clearSession();
    window.history.pushState({}, '', window.location.pathname);
    document.getElementById('header-room-name').innerText = 'SimpleChatee';
    document.getElementById('header-room-id-container').style.display = 'none';
    document.getElementById('member-count').innerText = '';
    showView('view-home');
  }

  function clearSession() {
    sessionStorage.removeItem('currentRoomId');
    sessionStorage.removeItem('myNickname');
    sessionStorage.removeItem('myPassword');
  }

  function createRoom() {
    const name = document.getElementById('create-room-name').value || '無題の部屋';
    const password = document.getElementById('create-password').value;
    myNickname = document.getElementById('create-nickname').value || '部屋主';

    if (!password) return alert('パスワードを設定してください');

    socket.emit('create_room', { name: name, password: password, nickname: myNickname }, function(res) {
      if (res.success) {
        currentRoomId = res.roomId;
        sessionStorage.setItem('currentRoomId', currentRoomId);
        sessionStorage.setItem('myNickname', myNickname);
        sessionStorage.setItem('myPassword', password);
        setupChatView(name, []);
      }
    });
  }

  function checkRoomJoin() {
    const roomId = document.getElementById('join-room-id').value.trim();
    if (!roomId) return alert('部屋IDを入力してください');
    initJoinView(roomId);
  }

  function joinRoom() {
    myNickname = document.getElementById('join-nickname').value || 'ゲスト';
    const password = document.getElementById('join-password').value;

    socket.emit('join_room', { roomId: currentRoomId, password: password, nickname: myNickname }, function(res) {
      if (res.success) {
        sessionStorage.setItem('currentRoomId', currentRoomId);
        sessionStorage.setItem('myNickname', myNickname);
        sessionStorage.setItem('myPassword', password);
        setupChatView(res.roomName, res.messages);
      } else {
        alert(res.error || '入室に失敗しました');
      }
    });
  }

  function setupChatView(roomName, messages) {
    document.getElementById('header-room-name').innerText = roomName;
    document.getElementById('display-room-id').innerText = currentRoomId;
    document.getElementById('header-room-id-container').style.display = 'inline-flex';
    window.history.pushState({}, '', '?room=' + currentRoomId);
    showView('view-chat');

    const container = document.getElementById('chat-messages');
    container.innerHTML = '';
    if (messages && messages.length > 0) {
      messages.forEach(function(msg) {
        renderSingleMessage(msg);
      });
    }
  }

  function copyRoomLink() {
    const url = window.location.origin + '?room=' + currentRoomId;
    navigator.clipboard.writeText(url).then(function() {
      alert('部屋の招待URLをコピーしました！\\nパスワードと一緒に友達に共有してください。');
    });
  }

  function onFileSelected(input) {
    if (input.files && input.files[0]) {
      selectedFile = input.files[0];
      const preview = document.getElementById('file-name-preview');
      preview.innerText = '選択中: ' + selectedFile.name;
      preview.style.display = 'block';
    }
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

    if (!text && !selectedFile) return;

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

    input.value = '';
    selectedFile = null;
    document.getElementById('file-input').value = '';
    document.getElementById('file-name-preview').style.display = 'none';
  }

  function deleteMessage(msgId) {
    socket.emit('delete_message', { roomId: currentRoomId, msgId: msgId });
  }

  function renderSingleMessage(msg) {
    const container = document.getElementById('chat-messages');
    const div = document.createElement('div');
    
    const isSelf = (msg.senderId === socket.id);
    const colorClass = isSelf ? 'self' : ('user-color-' + (msg.colorIndex || 0));
    
    div.className = 'message ' + colorClass;
    div.id = 'msg-' + msg.id;

    let html = '';
    if (isSelf) {
      html += '<span class="del-btn" onclick="deleteMessage(\\\'' + msg.id + '\\\')">✕ 削除</span>';
    }
    
    html += '<div class="sender">' + escapeHtml(msg.senderName) + '</div>';
    if (msg.text) html += '<div class="text-content">' + escapeHtml(msg.text) + '</div>';
    if (msg.image) {
      html += '<img src="' + msg.image + '" class="chat-img" onclick="openImageInNewTab(\\\'' + msg.image + '\\\')" oncontextmenu="return false;" onerror="this.alt=\\\'(送信から1時間経過のため画像は削除されました)\\\'; this.style.display=\\\'none\\\';">';
    }

    div.innerHTML = html;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  socket.on('receive_message', function(msg) {
    renderSingleMessage(msg);
  });

  socket.on('message_deleted', function(data) {
    const el = document.getElementById('msg-' + data.msgId);
    if (el) el.remove();
  });

  socket.on('update_members', function(data) {
    document.getElementById('member-count').innerText = '(' + data.count + '/3人)';
  });

  function openImageInNewTab(src) {
    window.open(src, '_blank');
  }

  function escapeHtml(str) {
    return str.replace(/[&<>"']/g, function(m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }
</script>
</body>
</html>
  `);
});

// --- Socket.io ---
io.on('connection', (socket) => {
  socket.on('get_room_info', ({ roomId }, callback) => {
    const room = rooms[roomId];
    if (room) {
      callback({ success: true, roomName: room.name });
    } else {
      callback({ success: false });
    }
  });

  // 部屋作成
  socket.on('create_room', ({ name, password, nickname }, callback) => {
    const roomId = Math.random().toString(36).substring(2, 8);
    
    rooms[roomId] = {
      name,
      password,
      members: [{ id: socket.id, nickname, colorIndex: 0 }],
      messages: []
    };

    // 24時間（86,400,000ミリ秒）後に部屋を完全削除
    setTimeout(() => {
      if (rooms[roomId]) {
        delete rooms[roomId];
        console.log(`部屋 ${roomId} を24時間経過のため自動削除しました`);
      }
    }, 24 * 60 * 60 * 1000);

    socket.join(roomId);
    callback({ success: true, roomId, messages: [] });
    io.to(roomId).emit('update_members', { count: rooms[roomId].members.length });
  });

  // 部屋入室
  socket.on('join_room', ({ roomId, password, nickname }, callback) => {
    const room = rooms[roomId];
    if (!room) return callback({ success: false, error: '部屋が存在しません（または消去されました）' });

    // パスワードチェック
    if (room.password && password !== room.password) {
      return callback({ success: false, error: 'パスワードが正しくありません' });
    }

    const existingMember = room.members.find(m => m.id === socket.id);

    // 既に3名（上限）に達しており、かつ自分が既存メンバーでない場合はブロック
    if (!existingMember && room.members.length >= 3) {
      return callback({ success: false, error: '部屋が満員です（最大3名）' });
    }

    // 新規参加の場合はメンバーリストに追加
    if (!existingMember) {
      const colorIndex = room.members.length > 1 ? 1 : 0;
      room.members.push({ id: socket.id, nickname, colorIndex });
    }

    socket.join(roomId);

    callback({ success: true, roomName: room.name, messages: room.messages });
    io.to(roomId).emit('update_members', { count: room.members.length });
  });

  // メッセージ送信
  socket.on('send_message', ({ roomId, text, image }) => {
    const room = rooms[roomId];
    if (!room) return;
    const sender = room.members.find(m => m.id === socket.id);

    const messageData = {
      id: Math.random().toString(36).substring(2, 10),
      senderId: socket.id,
      senderName: sender ? sender.nickname : '匿名',
      colorIndex: sender ? sender.colorIndex : 0,
      text,
      image
    };

    room.messages.push(messageData);
    io.to(roomId).emit('receive_message', messageData);
  });

  // メッセージ削除処理（送信本人のみ許可）
  socket.on('delete_message', ({ roomId, msgId }) => {
    const room = rooms[roomId];
    if (room) {
      const targetMsg = room.messages.find(m => m.id === msgId);
      if (targetMsg && targetMsg.senderId === socket.id) {
        room.messages = room.messages.filter(m => m.id !== msgId);
        io.to(roomId).emit('message_deleted', { msgId });
      }
    }
  });

  // 接続切断（24時間維持するため、メンバー数が0になっても部屋を即時削除しない）
  socket.on('disconnect', () => {
    for (const roomId in rooms) {
      const room = rooms[roomId];
      const index = room.members.findIndex(m => m.id === socket.id);
      if (index !== -1) {
        room.members.splice(index, 1);
        io.to(roomId).emit('update_members', { count: room.members.length });
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
