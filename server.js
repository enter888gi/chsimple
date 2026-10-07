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



  
  
  
  
  
  



右クリックできません




  
    
      
🏠
      
SimpleChatee
      
      
Ver. 2.0.12
    
    
  
  
    
SimpleChatee
    
画像表示の秒数を選べる空間

    
    
      🌐 公開ルーム
      
        

        
入室中: — 人
      
      
誰でも気軽にニックネームだけですぐ入れます。 少人数へのプライベートルームへの招待や雑談に。
      公開ルームに入室
    

    
    
      🔒 プライベートルーム
      
3人～5人までの個室ルームです。 招待リンクから入室した部屋と、自分が作成した部屋が表示されます。
      
      プライベートルームを新規作成
    

    
    
      
E2E暗号化
チャット内容はブラウザ間で暗号化され、管理者も閲覧できません。
      
画像の時限表示
1秒 / 3秒 / 5秒 などの時限表示。表示後はサーバーから自動削除されます。
      
履歴の不保持
メッセージ履歴を長期保持しない、使い切り型の設計です。
    
  
  
  
  





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
