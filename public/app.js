(() => {
    // ─── State ───
    const params = new URLSearchParams(window.location.search);
    const roomCode = params.get('room')?.toUpperCase();

    let socket = null;
    let playerId = null;
    let sessionId = localStorage.getItem('rebus_session_' + roomCode);
    let timerInterval = null;
    let timerStartedAt = null;  // local timestamp when timer started
    let totalTime = 30;         // seconds per round
    let serverOffset = 0;       // server-client time difference
    let roundEndAt = null;      // local timestamp when round should end
    let currentView = 'join';

    if (!roomCode) {
        window.location.href = 'index.html';
        return;
    }

    // ─── Particles ───
    const particlesEl = document.getElementById('particles');
    for (let i = 0; i < 20; i++) {
        const p = document.createElement('div');
        p.className = 'particle';
        p.style.left = Math.random() * 100 + '%';
        p.style.top = Math.random() * 100 + '%';
        p.style.animationDelay = Math.random() * 6 + 's';
        p.style.animationDuration = (4 + Math.random() * 6) + 's';
        p.style.width = p.style.height = (4 + Math.random() * 8) + 'px';
        particlesEl.appendChild(p);
    }

    // ─── View Management ───
    const views = ['joinView', 'lobbyView', 'playView', 'roundResultView', 'gameOverView'];
    function showView(id) {
        views.forEach(v => document.getElementById(v).style.display = 'none');
        document.getElementById(id).style.display = 'flex';
        currentView = id;
    }

    // ─── Init ───
    async function init() {
        try {
            const res = await fetch(`/api/room/${roomCode}/status`);
            if (!res.ok) throw new Error('Room not found');
            const data = await res.json();

            document.getElementById('roomInfo').textContent =
                `Room ${roomCode} • ${data.playerCount} player${data.playerCount !== 1 ? 's' : ''} online`;

            // Auto-rejoin if session exists
            if (sessionId) {
                const savedName = localStorage.getItem('rebus_name_' + roomCode);
                if (savedName) {
                    document.getElementById('playerNameInput').value = savedName;
                }
            }
        } catch (err) {
            document.getElementById('roomInfo').textContent = '❌ Room not found. Please check the code.';
            document.getElementById('joinGameBtn').disabled = true;
        }
    }

    // ─── Socket Connection ───
    function connectSocket() {
        socket = io({ reconnection: true, reconnectionAttempts: 10, reconnectionDelay: 1000 });

        socket.on('connect', () => {
            console.log('Connected to server');
        });

        socket.on('error-msg', ({ message }) => {
            alert(message);
        });

        socket.on('joined', (data) => {
            playerId = data.playerId;
            if (data.sessionId) {
                sessionId = data.sessionId;
                localStorage.setItem('rebus_session_' + roomCode, data.sessionId);
            }
            if (data.restored) {
                console.log('Session restored! Score:', data.score);
            }
            if (data.state === 'lobby' || data.state === 'setup') {
                showView('lobbyView');
                document.getElementById('lobbyCode').textContent = roomCode;
            } else if (data.state === 'playing') {
                showView('playView');
            } else if (data.state === 'finished') {
                showView('lobbyView');
            }
        });

        socket.on('player-joined', ({ playerName, playerCount, players }) => {
            document.getElementById('playerCount').textContent = playerCount;
            renderPlayerList(players);
        });

        socket.on('player-left', ({ playerName, playerCount, players }) => {
            document.getElementById('playerCount').textContent = playerCount;
            renderPlayerList(players);
        });

        socket.on('new-round', (data) => {
            showView('playView');
            startPlayRound(data);
        });

        socket.on('hint', ({ level, text }) => {
            const hintArea = document.getElementById('hintArea');
            hintArea.style.display = 'flex';
            document.getElementById('hintText').textContent = text;
            hintArea.classList.add('hint-pop');
            setTimeout(() => hintArea.classList.remove('hint-pop'), 500);
        });

        socket.on('guess-result', (data) => {
            handleGuessResult(data);
        });

        socket.on('already-answered', () => {
            showAnswered(0);
        });

        socket.on('player-guessed', ({ playerName, match }) => {
            showGuessNotification(playerName, match);
        });

        socket.on('leaderboard-update', (leaderboard) => {
            renderMiniLeaderboard(leaderboard);
        });

        socket.on('round-end', (data) => {
            showRoundResults(data);
        });

        socket.on('game-over', (data) => {
            showGameOver(data);
        });
    }

    // ─── Join ───
    document.getElementById('joinGameBtn').addEventListener('click', joinGame);
    document.getElementById('playerNameInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') joinGame();
    });

    function joinGame() {
        const name = document.getElementById('playerNameInput').value.trim();
        if (!name) return alert('Please enter your name!');
        localStorage.setItem('rebus_name_' + roomCode, name);

        if (!socket) connectSocket();

        socket.emit('join-room', { roomCode, playerName: name, sessionId });
    }

    // ─── Players List ───
    function renderPlayerList(players) {
        const list = document.getElementById('playerList');
        list.innerHTML = players.map(p => `
      <div class="player-tag ${p.online ? '' : 'offline'}">
        <span class="player-dot ${p.online ? 'online' : 'offline'}"></span>
        ${escapeHtml(p.name)}
      </div>
    `).join('');
    }

    // ─── Play Round ───
    function startPlayRound(data) {
        document.getElementById('currentRound').textContent = data.roundNum;
        document.getElementById('totalRounds').textContent = data.totalRounds;
        document.getElementById('puzzleImage').src = data.image;

        totalTime = data.timePerRound;

        // Calculate accurate remaining time using server timestamps
        if (data.serverTime && data.roundStartTime) {
            const serverElapsed = (data.serverTime - data.roundStartTime) / 1000;
            const remaining = Math.max(0, totalTime - serverElapsed);
            roundEndAt = Date.now() + (remaining * 1000);
        } else if (data.remainingTime != null) {
            roundEndAt = Date.now() + (data.remainingTime * 1000);
        } else {
            roundEndAt = Date.now() + (totalTime * 1000);
        }

        // Reset UI
        document.getElementById('guessSection').style.display = 'block';
        document.getElementById('answeredSection').style.display = 'none';
        document.getElementById('hintArea').style.display = 'none';
        document.getElementById('guessFeedback').textContent = '';
        document.getElementById('guessInput').value = '';
        document.getElementById('guessInput').disabled = false;
        document.getElementById('submitGuessBtn').disabled = false;
        document.getElementById('guessInput').focus();

        // Start timer using absolute end time (no drift)
        startTimer();
    }

    function startTimer() {
        stopTimer();
        updateTimerUI();
        timerInterval = setInterval(() => {
            updateTimerUI();
            const remaining = (roundEndAt - Date.now()) / 1000;
            if (remaining <= 0) stopTimer();
        }, 50); // Update every 50ms for smoother animation
    }

    function stopTimer() {
        if (timerInterval) {
            clearInterval(timerInterval);
            timerInterval = null;
        }
    }

    function updateTimerUI() {
        const now = Date.now();
        const remaining = Math.max(0, (roundEndAt - now) / 1000);
        const pct = (remaining / totalTime) * 100;
        const bar = document.getElementById('timerBar');
        bar.style.width = pct + '%';

        if (pct > 50) bar.className = 'timer-bar green';
        else if (pct > 25) bar.className = 'timer-bar yellow';
        else bar.className = 'timer-bar red';

        document.getElementById('timerText').textContent = Math.ceil(remaining) + 's';
    }

    // ─── Guessing ───
    document.getElementById('submitGuessBtn').addEventListener('click', submitGuess);
    document.getElementById('guessInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submitGuess();
    });

    function submitGuess() {
        const input = document.getElementById('guessInput');
        const guess = input.value.trim();
        if (!guess) return;
        socket.emit('submit-guess', { roomCode, guess });
        input.value = '';
        input.focus();
    }

    function handleGuessResult(data) {
        const feedback = document.getElementById('guessFeedback');

        if (data.match === 'correct') {
            showAnswered(data.score);
            feedback.className = 'guess-feedback correct';
            feedback.textContent = `✅ Correct! +${data.score} points`;
        } else if (data.match === 'partial') {
            showAnswered(data.score);
            feedback.className = 'guess-feedback partial';
            feedback.textContent = `🔶 Close! +${data.score} points (partial credit)`;
        } else {
            feedback.className = 'guess-feedback wrong';
            feedback.textContent = '❌ Wrong! Try again...';
            setTimeout(() => feedback.textContent = '', 2000);
        }
    }

    function showAnswered(score) {
        document.getElementById('guessSection').style.display = 'none';
        document.getElementById('answeredSection').style.display = 'flex';
        document.getElementById('earnedScore').textContent = score;
        stopTimer();
    }

    function showGuessNotification(playerName, match) {
        const icon = match === 'correct' ? '✅' : '🔶';
        const notif = document.createElement('div');
        notif.className = 'guess-notif';
        notif.textContent = `${icon} ${playerName} guessed ${match === 'correct' ? 'correctly' : 'partially'}!`;
        document.body.appendChild(notif);
        setTimeout(() => notif.remove(), 3000);
    }

    // ─── Mini Leaderboard ───
    function renderMiniLeaderboard(leaderboard) {
        const list = document.getElementById('miniLbList');
        if (!list) return;
        list.innerHTML = leaderboard.slice(0, 10).map((p, i) => {
            const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`;
            const isMe = p.id === playerId;
            return `
        <div class="mini-lb-row ${isMe ? 'is-me' : ''} ${p.guessedThisRound ? 'guessed' : ''}">
          <span class="lb-rank">${medal}</span>
          <span class="lb-name">${escapeHtml(p.name)}${!p.online ? ' 💤' : ''}</span>
          <span class="lb-score">${p.score}</span>
        </div>
      `;
        }).join('');
    }

    // ─── Round Results ───
    function showRoundResults(data) {
        stopTimer();
        showView('roundResultView');
        document.getElementById('resultRound').textContent = data.roundNum;
        document.getElementById('correctAnswerText').textContent = data.correctAnswer;

        const lb = document.getElementById('resultLeaderboard');
        lb.innerHTML = data.leaderboard.slice(0, 10).map((p, i) => {
            const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`;
            const isMe = p.id === playerId;
            return `
        <div class="result-lb-row ${isMe ? 'is-me' : ''}">
          <span class="lb-rank">${medal}</span>
          <span class="lb-name">${escapeHtml(p.name)}</span>
          <span class="lb-score">${p.score} pts</span>
        </div>
      `;
        }).join('');

        const nextText = data.isLastRound
            ? 'Final results coming...'
            : `Next round starting in ${data.nextRoundIn || 5} seconds...`;
        document.getElementById('nextRoundText').textContent = nextText;
    }

    // ─── Game Over ───
    function showGameOver(data) {
        stopTimer();
        showView('gameOverView');
        launchConfetti();

        const lb = data.leaderboard;

        // Podium
        const podium = document.getElementById('podiumSection');
        const top3 = lb.slice(0, 3);
        const podiumOrder = [1, 0, 2]; // silver, gold, bronze display order
        podium.innerHTML = '<div class="podium-row">' + podiumOrder.map(idx => {
            const p = top3[idx];
            if (!p) return '';
            const heights = ['160px', '120px', '90px'];
            const medals = ['🥇', '🥈', '🥉'];
            const places = ['1st', '2nd', '3rd'];
            const isMe = p.id === playerId;
            return `
        <div class="podium-item ${isMe ? 'is-me' : ''}">
          <div class="podium-medal">${medals[idx]}</div>
          <div class="podium-name">${escapeHtml(p.name)}</div>
          <div class="podium-score">${p.score} pts</div>
          <div class="podium-block podium-${idx + 1}" style="height:${heights[idx]}">
            <span>${places[idx]}</span>
          </div>
        </div>
      `;
        }).join('') + '</div>';

        // Full leaderboard
        const flb = document.getElementById('finalLeaderboard');
        flb.innerHTML = '<h3>Full Rankings</h3>' + lb.map((p, i) => {
            const isMe = p.id === playerId;
            return `
        <div class="final-lb-row ${isMe ? 'is-me' : ''}">
          <span class="lb-rank">#${i + 1}</span>
          <span class="lb-name">${escapeHtml(p.name)}${!p.online ? ' 💤' : ''}</span>
          <span class="lb-score">${p.score} pts</span>
        </div>
      `;
        }).join('');
    }

    // ─── Confetti ───
    function launchConfetti() {
        const canvas = document.getElementById('confettiCanvas');
        canvas.style.display = 'block';
        const ctx = canvas.getContext('2d');
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;

        const pieces = [];
        const colors = ['#ff6b6b', '#ffd93d', '#6bcb77', '#4d96ff', '#ff6bcb', '#c76bff'];
        for (let i = 0; i < 150; i++) {
            pieces.push({
                x: Math.random() * canvas.width,
                y: Math.random() * canvas.height - canvas.height,
                w: 8 + Math.random() * 8,
                h: 4 + Math.random() * 4,
                color: colors[Math.floor(Math.random() * colors.length)],
                vx: (Math.random() - 0.5) * 4,
                vy: 2 + Math.random() * 4,
                rot: Math.random() * 360,
                rotSpeed: (Math.random() - 0.5) * 10
            });
        }

        let frame = 0;
        function animate() {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            pieces.forEach(p => {
                p.x += p.vx;
                p.y += p.vy;
                p.rot += p.rotSpeed;
                ctx.save();
                ctx.translate(p.x, p.y);
                ctx.rotate(p.rot * Math.PI / 180);
                ctx.fillStyle = p.color;
                ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
                ctx.restore();
            });
            frame++;
            if (frame < 200) requestAnimationFrame(animate);
            else canvas.style.display = 'none';
        }
        animate();
    }

    // ─── Helpers ───
    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // ─── Start ───
    init();
})();
