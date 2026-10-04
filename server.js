const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// アップロード用フォルダの作成
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Multer設定（画像アップロード）
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, uniqueSuffix + ext);
  }
});
const upload = multer({ storage });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// 部屋の状態管理（最後の発話日時を記録）
let roomData = {
  lastActivity: Date.now(),
  isDeleted: false
};

// 1ヶ月（30日）無発話時の自動部屋削除タイマー（1時間毎にチェック）
const ONE_MONTH_MS = 30 * 24 * 60 * 60 * 1000;
setInterval(() => {
  if (!roomData.isDeleted && (Date.now() - roomData.lastActivity > ONE_MONTH_MS)) {
    deleteRoomData("1ヶ月間発話がなかったため自動削除されました");
  }
}, 60 * 60 * 1000);

// 部屋および関連ファイルの完全削除関数
function deleteRoomData(reason) {
  roomData.isDeleted = true;
  
  // アップロードフォルダ内のファイルを全削除
  fs.readdir(uploadDir, (err, files) => {
    if (!err && files) {
      for (const file of files) {
        fs.unlink(path.join(uploadDir, file), () => {});
      }
    }
  });

  // 全クライアントへ部屋削除を通知
  io.emit('roomDeleted', { reason: reason });
  console.log(`[部屋削除] ${reason}`);
}

// 画像アップロードAPI
app.post('/api/upload', upload.single('image'), (req, res) => {
  if (roomData.isDeleted) {
    return res.status(400).json({ error: '部屋は既に削除されています。' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'ファイルが選択されていません。' });
  }

  // 最終アクティビティ更新
  roomData.lastActivity = Date.now();

  const imageUrl = `/uploads/${req.file.filename}`;
  const filePath = req.file.path;

  // 1時間後にサーバー上のオリジナル画像ファイルを物理削除
  setTimeout(() => {
    fs.unlink(filePath, (err) => {
      if (!err) {
        console.log(`1時間経過のためサーバー画像ファイルを削除しました: ${req.file.filename}`);
      }
    });
  }, 60 * 60 * 1000);

  res.json({ imageUrl });
});

// ルーティング
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>匿名チャットアプリ Ver. 1.1.5</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background-color: #f4f5f7; display: flex; justify-content: center; height: 100vh; }
    .chat-container { width: 100%; max-width: 600px; background: #fff; display: flex; flex-direction: column; height: 100vh; box-shadow: 0 0 10px rgba(0,0,0,0.1); }
    .header { background: #4f46e5; color: white; padding: 12px 16px; display: flex; justify-content: space-between; align-items: center; }
    .header h1 { font-size: 16px; font-weight: bold; }
    .header-actions { display: flex; align-items: center; gap: 8px; }
    .header .version { font-size: 11px; opacity: 0.8; }
    .btn-delete-room { background: #ef4444; color: white; border: none; padding: 4px 8px; font-size: 11px; border-radius: 4px; cursor: pointer; font-weight: bold; }
    .messages-list { flex: 1; padding: 16px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; }
    .message-item { display: flex; flex-direction: column; max-width: 80%; }
    .message-item.self { align-self: flex-end; align-items: flex-end; }
    .message-item.other { align-self: flex-start; align-items: flex-start; }
    .message-bubble { padding: 10px 14px; border-radius: 12px; font-size: 14px; word-break: break-all; }
    .message-item.self .message-bubble { background: #4f46e5; color: white; border-bottom-right-radius: 2px; }
    .message-item.other .message-bubble { background: #e5e7eb; color: #1f2937; border-bottom-left-radius: 2px; }
    
    /* 通常時画像表示 */
    .chat-img {
      max-width: 100%;
      max-height: 200px;
      border-radius: 8px;
      margin-top: 6px;
      cursor: pointer;
      user-select: none;
      -webkit-user-drag: none;
    }

    /* 1時間経過後：管理者専用50px拡大サムネイル表示領域 */
    .expired-admin-thumb-wrapper {
      display: inline-block;
      margin-top: 6px;
      padding: 6px;
      background-color: #f3f4f6;
      border: 1px dashed #9ca3af;
      border-radius: 8px;
    }
    .expired-badge {
      display: block;
      font-size: 10px;
      color: #6b7280;
      font-weight: bold;
      margin-bottom: 4px;
    }
    .chat-img-expired-stretched {
      width: 120px;
      height: auto;
      border-radius: 4px;
      display: block;
      image-rendering: pixelated;
      opacity: 0.85;
    }

    /* 1時間経過後：ゲスト用テキストプレースホルダー */
    .expired-placeholder {
      font-size: 12px;
      color: #6b7280;
      background-color: #f9fafb;
      border: 1px solid #e5e7eb;
      padding: 8px 12px;
      border-radius: 6px;
      margin-top: 6px;
      display: inline-block;
    }

    .input-area { padding: 12px; border-top: 1px solid #e5e7eb; display: flex; gap: 8px; align-items: center; }
    .input-area input[type="text"] { flex: 1; padding: 10px; border: 1px solid #d1d5db; border-radius: 6px; outline: none; }
    .input-area button { padding: 10px 16px; background: #4f46e5; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: bold; }
    .file-label { cursor: pointer; padding: 8px 12px; background: #f3f4f6; border: 1px solid #d1d5db; border-radius: 6px; font-size: 12px; color: #374151; }
    #fileInput { display: none; }
  </style>
</head>
<body>
  <div class="chat-container">
    <div class="header">
      <h1>匿名チャット</h1>
      <div class="header-actions">
        <span class="version">Ver. 1.1.5</span>
        <button id="deleteRoomBtn" class="btn-delete-room" style="display:none;">部屋削除</button>
      </div>
    </div>
    <div class="messages-list" id="messagesList"></div>
    <div class="input-area">
      <label class="file-label" for="fileInput">画像選択</label>
      <input type="file" id="fileInput" accept="image/*" />
      <input type="text" id="messageInput" placeholder="メッセージを入力..." />
      <button id="sendBtn">送信</button>
    </div>
  </div>

  <script src="/socket.io/socket.io.js"></script>
  <script>
    const socket = io();
    const messagesList = document.getElementById('messagesList');
    const messageInput = document.getElementById('messageInput');
    const sendBtn = document.getElementById('sendBtn');
    const fileInput = document.getElementById('fileInput');
    const deleteRoomBtn = document.getElementById('deleteRoomBtn');

    // 部屋作成者（管理者）判定
    let isHost = localStorage.getItem('is_room_host') === 'true';
    if (!localStorage.getItem('is_room_host_initialized')) {
      isHost = true;
      localStorage.setItem('is_room_host', 'true');
      localStorage.setItem('is_room_host_initialized', 'true');
    }

    // 作成者の場合のみ部屋削除ボタンを表示
    if (isHost) {
      deleteRoomBtn.style.display = 'inline-block';
    }

    let mySocketId = '';
    socket.on('connect', () => {
      mySocketId = socket.id;
    });

    // ローカルストレージのサムネイル一括削除関数（部屋削除時のみ実行）
    function clearAdminLocalThumbnails() {
      localStorage.removeItem('admin_thumbnails');
      console.log('部屋削除に伴い、LocalStorage 内の確認用サムネイルをクリアしました。');
    }

    // 手動で「部屋削除」ボタンが押された時
    deleteRoomBtn.addEventListener('click', () => {
      if (confirm('本当に部屋を削除しますか？すべてのメッセージと画像データが消去されます。')) {
        socket.emit('requestDeleteRoom');
      }
    });

    // 部屋削除イベント受信時（手動削除、または1ヶ月無発話による自動削除）
    socket.on('roomDeleted', (data) => {
      // 部屋消去時にのみローカルストレージのサムネイルデータを完全消去
      clearAdminLocalThumbnails();
      alert('部屋が削除されました：' + (data.reason || '手動または自動期限切れ'));
      location.reload();
    });

    // 50px幅のミニサムネイルをLocalStorageへ保存
    function saveAdminMiniThumbnail(messageId, file) {
      if (!isHost) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d');

          const targetWidth = 50;
          const scale = targetWidth / img.width;
          canvas.width = targetWidth;
          canvas.height = img.height * scale;

          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          const miniBase64 = canvas.toDataURL('image/jpeg', 0.5);

          const thumbnails = JSON.parse(localStorage.getItem('admin_thumbnails') || '{}');
          thumbnails[messageId] = miniBase64;
          localStorage.setItem('admin_thumbnails', JSON.stringify(thumbnails));
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    }

    // 画像描画HTML生成関数
    function renderImageHTML(message) {
      const now = new Date();
      const createdTime = new Date(message.createdAt);
      const isExpired = (now - createdTime) > 60 * 60 * 1000; // 1時間判定

      if (!isExpired) {
        return \`<img src="\${message.imageUrl}" class="chat-img" alt="画像" onclick="window.open('\${message.imageUrl}')" />\`;
      }

      if (isHost) {
        const thumbnails = JSON.parse(localStorage.getItem('admin_thumbnails') || '{}');
        const miniThumb = thumbnails[message.id];
        if (miniThumb) {
          return \`
            <div class="expired-admin-thumb-wrapper">
              <span class="expired-badge">削除済み（作成者確認用）</span>
              <img src="\${miniThumb}" class="chat-img-expired-stretched" alt="確認用サムネ" />
            </div>
          \`;
        }
      }

      return \`
        <div class="expired-placeholder">
          🔒 画像は有効期限（1時間）を過ぎたため削除されました
        </div>
      \`;
    }

    // メッセージ受信時
    socket.on('chatMessage', (msg) => {
      appendMessage(msg);
    });

    function appendMessage(msg) {
      const item = document.createElement('div');
      const isSelf = msg.senderId === mySocketId;
      item.className = \`message-item \${isSelf ? 'self' : 'other'}\`;

      let contentHTML = '';
      if (msg.text) {
        contentHTML += \`<div class="message-bubble">\${escapeHtml(msg.text)}</div>\`;
      }
      if (msg.imageUrl) {
        contentHTML += renderImageHTML(msg);
      }

      item.innerHTML = contentHTML;
      messagesList.appendChild(item);
      messagesList.scrollTop = messagesList.scrollHeight;
    }

    // 送信ボタン押下時
    sendBtn.addEventListener('click', async () => {
      const text = messageInput.value.trim();
      const file = fileInput.files[0];

      if (!text && !file) return;

      const messageId = 'msg-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
      let uploadedImageUrl = null;

      if (file) {
        saveAdminMiniThumbnail(messageId, file);

        const formData = new FormData();
        formData.append('image', file);
        try {
          const res = await fetch('/api/upload', { method: 'POST', body: formData });
          const data = await res.json();
          uploadedImageUrl = data.imageUrl;
        } catch (err) {
          alert('画像のアップロードに失敗しました。');
          return;
        }
      }

      const msgData = {
        id: messageId,
        text: text,
        imageUrl: uploadedImageUrl,
        createdAt: new Date().toISOString(),
        senderId: socket.id
      };

      socket.emit('chatMessage', msgData);

      messageInput.value = '';
      fileInput.value = '';
    });

    function escapeHtml(str) {
      return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
  </script>
</body>
</html>
  `);
});

// Socket.io 接続管理
io.on('connection', (socket) => {
  socket.on('chatMessage', (msg) => {
    roomData.lastActivity = Date.now(); // 発話があったため最終アクティビティを更新
    io.emit('chatMessage', msg);
  });

  // 手動部屋削除リクエストの処理
  socket.on('requestDeleteRoom', () => {
    deleteRoomData("部屋作成者によって手動削除されました");
  });
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT} (Ver. 1.1.5)`);
});
