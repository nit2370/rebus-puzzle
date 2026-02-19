const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 10e6, // 10MB for image uploads
  pingTimeout: 30000,
  pingInterval: 10000
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── In-Memory State ───
const rooms = new Map();

// ─── Helpers ───

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function normalize(str) {
  return str.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\b(the|a|an)\b/g, '').replace(/\s+/g, ' ').trim();
}

function checkGuess(guess, answer) {
  const g = normalize(guess);
  const a = normalize(answer);
  if (!g) return { match: 'wrong', similarity: 0 };

  // Exact match
  if (g === a) return { match: 'correct', similarity: 1 };

  // Levenshtein distance
  const dist = levenshtein(g, a);
  const maxLen = Math.max(g.length, a.length);
  const similarity = 1 - dist / maxLen;

  // Typo tolerance: distance ≤ 2 for short, ≤ 3 for long
  const threshold = a.length <= 6 ? 2 : 3;
  if (dist <= threshold) return { match: 'correct', similarity };

  // Contains check — if answer is inside guess or vice-versa
  if (g.includes(a) || a.includes(g)) return { match: 'correct', similarity: 0.9 };

  // Partial credit
  if (similarity >= 0.6) return { match: 'partial', similarity };

  return { match: 'wrong', similarity };
}

function calcScore(timeRemaining, totalTime, matchType, similarity) {
  const timeRatio = timeRemaining / totalTime;
  let base = Math.round(1000 * timeRatio);
  base = Math.max(base, 50); // minimum 50 for any correct
  if (matchType === 'partial') {
    return Math.round(base * 0.5 * similarity);
  }
  return base;
}

function generateHints(answer) {
  const words = answer.split(/\s+/);
  // Hint 1 (50%): first letter + word count
  const hint1Letters = words.map(w => w[0].toUpperCase() + '_'.repeat(w.length - 1)).join(' ');
  const hint1 = `${hint1Letters} (${words.length} word${words.length > 1 ? 's' : ''})`;

  // Hint 2 (75%): alternating letters revealed
  const hint2 = words.map(w =>
    w.split('').map((c, i) => i % 2 === 0 ? c.toUpperCase() : '_').join('')
  ).join(' ');

  return { hint1, hint2 };
}

function getLeaderboard(room) {
  return Object.values(room.players)
    .map(p => ({
      id: p.id,
      name: p.name,
      score: p.score,
      online: p.online,
      guessedThisRound: p.guessedThisRound || false
    }))
    .sort((a, b) => b.score - a.score);
}

// ─── REST Endpoints ───

app.post('/api/create-room', (req, res) => {
  const roomCode = generateRoomCode();
  rooms.set(roomCode, {
    code: roomCode,
    hostId: null,
    hostSessionId: null,
    puzzles: [],
    players: {},
    sessions: {},       // sessionId → playerId
    state: 'setup',     // setup | lobby | playing | finished
    currentRound: 0,
    totalRounds: 0,
    timePerRound: 30,
    roundTimer: null,
    hintTimers: [],
    roundStartTime: null,
    roundAnswered: {}   // playerId → true if already answered this round
  });
  res.json({ roomCode });
});

app.post('/api/upload/:roomCode', upload.array('images', 50), (req, res) => {
  const room = rooms.get(req.params.roomCode);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  const answers = JSON.parse(req.body.answers || '[]');
  const puzzles = req.files.map((file, i) => ({
    image: `data:${file.mimetype};base64,${file.buffer.toString('base64')}`,
    answer: answers[i] || 'Unknown',
    hints: generateHints(answers[i] || 'Unknown')
  }));
  room.puzzles = puzzles;
  room.totalRounds = puzzles.length;
  room.state = 'lobby';
  res.json({ success: true, puzzleCount: puzzles.length });
});

app.get('/api/room/:roomCode/status', (req, res) => {
  const room = rooms.get(req.params.roomCode.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({
    code: room.code,
    state: room.state,
    playerCount: Object.values(room.players).filter(p => p.online).length,
    totalRounds: room.totalRounds
  });
});

// ─── Socket.IO ───

io.on('connection', (socket) => {

  socket.on('host-join', ({ roomCode, sessionId }) => {
    const room = rooms.get(roomCode);
    if (!room) return socket.emit('error-msg', { message: 'Room not found' });

    room.hostId = socket.id;
    room.hostSessionId = sessionId;
    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.isHost = true;
    socket.emit('host-joined', { roomCode, puzzleCount: room.puzzles.length });
  });

  socket.on('join-room', ({ roomCode, playerName, sessionId }) => {
    roomCode = roomCode.toUpperCase();
    const room = rooms.get(roomCode);
    if (!room) return socket.emit('error-msg', { message: 'Room not found' });
    if (room.state === 'setup') return socket.emit('error-msg', { message: 'Room is not ready yet' });

    let playerId;

    // Check for session reconnection
    if (sessionId && room.sessions[sessionId]) {
      playerId = room.sessions[sessionId];
      const existingPlayer = room.players[playerId];
      if (existingPlayer) {
        existingPlayer.socketId = socket.id;
        existingPlayer.online = true;
        existingPlayer.name = playerName || existingPlayer.name;
        socket.join(roomCode);
        socket.roomCode = roomCode;
        socket.playerId = playerId;
        socket.sessionId = sessionId;

        socket.emit('joined', {
          playerId,
          roomCode,
          playerName: existingPlayer.name,
          state: room.state,
          score: existingPlayer.score,
          restored: true
        });

        // If game is in progress, send current round data
        if (room.state === 'playing') {
          const puzzle = room.puzzles[room.currentRound];
          const elapsed = (Date.now() - room.roundStartTime) / 1000;
          const remaining = Math.max(0, room.timePerRound - elapsed);
          socket.emit('new-round', {
            roundNum: room.currentRound + 1,
            totalRounds: room.totalRounds,
            image: puzzle.image,
            timePerRound: room.timePerRound,
            remainingTime: remaining
          });
          if (room.roundAnswered[playerId]) {
            socket.emit('already-answered', {});
          }
        }

        io.to(roomCode).emit('leaderboard-update', getLeaderboard(room));
        io.to(roomCode).emit('player-joined', {
          playerName: existingPlayer.name,
          playerCount: Object.values(room.players).filter(p => p.online).length,
          players: Object.values(room.players).map(p => ({ name: p.name, online: p.online }))
        });
        return;
      }
    }

    // New player
    playerId = uuidv4().slice(0, 8);
    const newSessionId = sessionId || uuidv4();
    room.players[playerId] = {
      id: playerId,
      socketId: socket.id,
      name: playerName,
      score: 0,
      online: true,
      guessedThisRound: false
    };
    room.sessions[newSessionId] = playerId;

    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.playerId = playerId;
    socket.sessionId = newSessionId;

    socket.emit('joined', {
      playerId,
      roomCode,
      playerName,
      sessionId: newSessionId,
      state: room.state,
      score: 0,
      restored: false
    });

    io.to(roomCode).emit('leaderboard-update', getLeaderboard(room));
    io.to(roomCode).emit('player-joined', {
      playerName,
      playerCount: Object.values(room.players).filter(p => p.online).length,
      players: Object.values(room.players).map(p => ({ name: p.name, online: p.online }))
    });
  });

  socket.on('start-game', ({ roomCode, rounds, timePerRound }) => {
    const room = rooms.get(roomCode);
    if (!room || socket.id !== room.hostId) return;

    room.totalRounds = Math.min(rounds || room.puzzles.length, room.puzzles.length);
    room.timePerRound = timePerRound || 30;
    room.currentRound = 0;
    room.state = 'playing';

    // Reset all scores
    Object.values(room.players).forEach(p => { p.score = 0; p.guessedThisRound = false; });

    startRound(room);
  });

  socket.on('submit-guess', ({ roomCode, guess }) => {
    const room = rooms.get(roomCode);
    if (!room || room.state !== 'playing') return;

    const playerId = socket.playerId;
    const player = room.players[playerId];
    if (!player || room.roundAnswered[playerId]) return;

    const puzzle = room.puzzles[room.currentRound];
    const result = checkGuess(guess, puzzle.answer);

    if (result.match === 'wrong') {
      socket.emit('guess-result', { match: 'wrong', guess });
      return;
    }

    const elapsed = (Date.now() - room.roundStartTime) / 1000;
    const remaining = Math.max(0, room.timePerRound - elapsed);
    const score = calcScore(remaining, room.timePerRound, result.match, result.similarity);

    player.score += score;
    player.guessedThisRound = true;
    room.roundAnswered[playerId] = true;

    socket.emit('guess-result', {
      match: result.match,
      score,
      totalScore: player.score,
      answer: result.match === 'correct' ? puzzle.answer : null
    });

    io.to(roomCode).emit('leaderboard-update', getLeaderboard(room));

    // Notify others someone guessed correctly
    io.to(roomCode).emit('player-guessed', {
      playerName: player.name,
      match: result.match
    });

    // Check if all online players have answered
    const onlinePlayers = Object.values(room.players).filter(p => p.online);
    const allAnswered = onlinePlayers.every(p => room.roundAnswered[p.id]);
    if (allAnswered) {
      endRound(room);
    }
  });

  socket.on('next-round', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room || socket.id !== room.hostId) return;
    if (room.currentRound >= room.totalRounds - 1) {
      endGame(room);
    } else {
      room.currentRound++;
      startRound(room);
    }
  });

  socket.on('disconnect', () => {
    const roomCode = socket.roomCode;
    if (!roomCode) return;
    const room = rooms.get(roomCode);
    if (!room) return;

    const playerId = socket.playerId;
    if (playerId && room.players[playerId]) {
      room.players[playerId].online = false;
      room.players[playerId].socketId = null;
      io.to(roomCode).emit('player-left', {
        playerName: room.players[playerId].name,
        playerCount: Object.values(room.players).filter(p => p.online).length,
        players: Object.values(room.players).map(p => ({ name: p.name, online: p.online }))
      });
      io.to(roomCode).emit('leaderboard-update', getLeaderboard(room));
    }

    // If host disconnects, transfer host
    if (socket.isHost) {
      const onlinePlayer = Object.values(room.players).find(p => p.online);
      if (onlinePlayer) {
        room.hostId = onlinePlayer.socketId;
        io.to(onlinePlayer.socketId).emit('host-promoted', {});
      }
    }

    // Cleanup empty rooms after 10 minutes
    const onlineCount = Object.values(room.players).filter(p => p.online).length;
    if (onlineCount === 0 && !room.hostId) {
      setTimeout(() => {
        const r = rooms.get(roomCode);
        if (r && Object.values(r.players).filter(p => p.online).length === 0) {
          clearTimers(r);
          rooms.delete(roomCode);
        }
      }, 10 * 60 * 1000);
    }
  });
});

// ─── Game Flow ───

function startRound(room) {
  const puzzle = room.puzzles[room.currentRound];
  room.roundStartTime = Date.now();
  room.roundAnswered = {};
  Object.values(room.players).forEach(p => { p.guessedThisRound = false; });

  clearTimers(room);

  io.to(room.code).emit('new-round', {
    roundNum: room.currentRound + 1,
    totalRounds: room.totalRounds,
    image: puzzle.image,
    timePerRound: room.timePerRound
  });

  io.to(room.code).emit('leaderboard-update', getLeaderboard(room));

  // Hint at 50%
  const hint1Timer = setTimeout(() => {
    io.to(room.code).emit('hint', { level: 1, text: puzzle.hints.hint1 });
  }, room.timePerRound * 500);

  // Hint at 75%
  const hint2Timer = setTimeout(() => {
    io.to(room.code).emit('hint', { level: 2, text: puzzle.hints.hint2 });
  }, room.timePerRound * 750);

  // Round end
  const roundTimer = setTimeout(() => {
    endRound(room);
  }, room.timePerRound * 1000);

  room.hintTimers = [hint1Timer, hint2Timer];
  room.roundTimer = roundTimer;
}

function endRound(room) {
  clearTimers(room);

  const puzzle = room.puzzles[room.currentRound];
  io.to(room.code).emit('round-end', {
    correctAnswer: puzzle.answer,
    roundNum: room.currentRound + 1,
    totalRounds: room.totalRounds,
    leaderboard: getLeaderboard(room),
    isLastRound: room.currentRound >= room.totalRounds - 1
  });

  // Auto-advance after 5 seconds if not last round
  if (room.currentRound < room.totalRounds - 1) {
    room.roundTimer = setTimeout(() => {
      room.currentRound++;
      startRound(room);
    }, 5000);
  } else {
    // Auto end game after 3 seconds
    room.roundTimer = setTimeout(() => {
      endGame(room);
    }, 3000);
  }
}

function endGame(room) {
  clearTimers(room);
  room.state = 'finished';
  io.to(room.code).emit('game-over', {
    leaderboard: getLeaderboard(room)
  });
}

function clearTimers(room) {
  if (room.roundTimer) { clearTimeout(room.roundTimer); room.roundTimer = null; }
  (room.hintTimers || []).forEach(t => clearTimeout(t));
  room.hintTimers = [];
}

// ─── Start ───
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🧩 Rebus Puzzle Game running on http://localhost:${PORT}`);
});
