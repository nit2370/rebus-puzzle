/**
 * 🤖 Rebus Puzzle - Bot Simulator
 * 
 * Simulates multiple fake players joining a room and playing the game.
 * Bots will join, wait for rounds, and submit guesses at random times.
 * 
 * Usage:
 *   node simulate-players.js <ROOM_CODE> [NUM_BOTS]
 * 
 * Examples:
 *   node simulate-players.js ABC123         # 40 bots (default)
 *   node simulate-players.js ABC123 20      # 20 bots
 */

const { io } = require('socket.io-client');

const ROOM_CODE = process.argv[2];
const NUM_BOTS = parseInt(process.argv[3]) || 40;
const SERVER_URL = process.argv[4] || 'http://localhost:3000';

if (!ROOM_CODE) {
    console.log('❌ Usage: node simulate-players.js <ROOM_CODE> [NUM_BOTS] [SERVER_URL]');
    console.log('   Example: node simulate-players.js ABC123 40');
    process.exit(1);
}

// Fun bot names
const FIRST_NAMES = [
    'Speedy', 'Brainy', 'Lucky', 'Clever', 'Swift', 'Quick', 'Smart', 'Witty',
    'Bright', 'Sharp', 'Keen', 'Bold', 'Cool', 'Epic', 'Pro', 'Mega',
    'Super', 'Ultra', 'Hyper', 'Turbo', 'Ninja', 'Pixel', 'Cyber', 'Neo',
    'Ace', 'Star', 'Flash', 'Storm', 'Thunder', 'Blaze', 'Shadow', 'Fury',
    'Mystic', 'Cosmic', 'Atomic', 'Iron', 'Golden', 'Silver', 'Crystal', 'Dark',
    'Mighty', 'Royal', 'Elite', 'Chief', 'Alpha', 'Omega', 'Delta', 'Sigma',
    'Zen', 'Neon'
];

const LAST_NAMES = [
    'Fox', 'Wolf', 'Hawk', 'Bear', 'Lion', 'Tiger', 'Eagle', 'Shark',
    'Panda', 'Cobra', 'Raven', 'Phoenix', 'Dragon', 'Falcon', 'Viper', 'Panther',
    'Gamer', 'Player', 'Solver', 'Thinker', 'Genius', 'Master', 'Wizard', 'Legend',
    'Boss', 'King', 'Queen', 'Champ', 'Hero', 'Knight', 'Sage', 'Guru',
    'Bot', 'Droid', 'Unit', 'Agent', 'Spark', 'Blitz', 'Pulse', 'Wave',
    'Byte', 'Node', 'Core', 'Bit', 'Code', 'Data', 'Link', 'Grid',
    'Chip', 'Dash'
];

// Wrong guesses for bots to try before getting it right (sometimes)
const WRONG_GUESSES = [
    'banana', 'sunshine', 'rainbow', 'pizza', 'rocket', 'flower', 'mountain',
    'butterfly', 'ocean', 'castle', 'dinosaur', 'unicorn', 'penguin', 'tornado',
    'firework', 'diamond', 'treasure', 'waterfall', 'lightning', 'galaxy',
    'popcorn', 'jellyfish', 'volcano', 'avalanche', 'telescope', 'paradox',
    'symphony', 'labyrinth', 'silhouette', 'kaleidoscope'
];

function getRandomName(index) {
    const first = FIRST_NAMES[index % FIRST_NAMES.length];
    const last = LAST_NAMES[Math.floor(index / FIRST_NAMES.length) % LAST_NAMES.length];
    return `${first}${last}`;
}

function randomBetween(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Bot Class ───
class Bot {
    constructor(id, name) {
        this.id = id;
        this.name = name;
        this.socket = null;
        this.playerId = null;
        this.connected = false;
        this.guessTimer = null;
    }

    connect() {
        return new Promise((resolve, reject) => {
            this.socket = io(SERVER_URL, {
                reconnection: false,
                forceNew: true
            });

            this.socket.on('connect', () => {
                this.connected = true;
                this.socket.emit('join-room', {
                    roomCode: ROOM_CODE.toUpperCase(),
                    playerName: this.name,
                    sessionId: `bot-session-${this.id}`
                });
            });

            this.socket.on('joined', (data) => {
                this.playerId = data.playerId;
                resolve();
            });

            this.socket.on('error-msg', ({ message }) => {
                console.log(`  ❌ ${this.name}: ${message}`);
                reject(new Error(message));
            });

            this.socket.on('new-round', (data) => {
                this.onNewRound(data);
            });

            this.socket.on('guess-result', (data) => {
                if (data.match === 'correct') {
                    console.log(`  ✅ ${this.name} guessed CORRECT! +${data.score} pts (total: ${data.totalScore})`);
                } else if (data.match === 'partial') {
                    console.log(`  🔶 ${this.name} got PARTIAL credit! +${data.score} pts`);
                }
                // If wrong, bot might try again
            });

            this.socket.on('round-end', (data) => {
                if (this.guessTimer) clearTimeout(this.guessTimer);
            });

            this.socket.on('game-over', (data) => {
                const myRank = data.leaderboard.findIndex(p => p.id === this.playerId) + 1;
                const myScore = data.leaderboard.find(p => p.id === this.playerId)?.score || 0;
                console.log(`  🏁 ${this.name} finished #${myRank} with ${myScore} pts`);
            });

            this.socket.on('connect_error', (err) => {
                reject(err);
            });

            // Timeout
            setTimeout(() => {
                if (!this.connected) reject(new Error('Connection timeout'));
            }, 10000);
        });
    }

    onNewRound(data) {
        // Bot behavior: 
        // - 30% chance to never guess (simulate AFK players)
        // - 40% chance to guess wrong first, then maybe get it right
        // - 30% chance to try a random wrong guess only

        const behavior = Math.random();
        const roundTime = data.timePerRound * 1000;

        if (behavior < 0.15) {
            // AFK - don't guess at all
            return;
        }

        // Submit 1-3 wrong guesses at random times
        const numWrongGuesses = randomBetween(1, 3);
        let lastGuessTime = 0;

        for (let i = 0; i < numWrongGuesses; i++) {
            const guessTime = randomBetween(lastGuessTime + 1000, Math.min(lastGuessTime + 5000, roundTime - 2000));
            lastGuessTime = guessTime;

            this.guessTimer = setTimeout(() => {
                const wrongGuess = WRONG_GUESSES[randomBetween(0, WRONG_GUESSES.length - 1)];
                this.socket.emit('submit-guess', { roomCode: ROOM_CODE.toUpperCase(), guess: wrongGuess });
            }, guessTime);
        }
    }

    disconnect() {
        if (this.guessTimer) clearTimeout(this.guessTimer);
        if (this.socket) this.socket.disconnect();
    }
}

// ─── Main ───
async function main() {
    console.log('');
    console.log('🤖 ═══════════════════════════════════════════════════');
    console.log(`   Rebus Puzzle Bot Simulator`);
    console.log(`   Room: ${ROOM_CODE.toUpperCase()} | Bots: ${NUM_BOTS} | Server: ${SERVER_URL}`);
    console.log('═══════════════════════════════════════════════════════');
    console.log('');

    // Check room exists
    try {
        const fetch = require('http');
        const url = new URL(`${SERVER_URL}/api/room/${ROOM_CODE}/status`);
        await new Promise((resolve, reject) => {
            fetch.get(url, (res) => {
                if (res.statusCode !== 200) {
                    reject(new Error(`Room ${ROOM_CODE} not found (HTTP ${res.statusCode})`));
                }
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    const info = JSON.parse(data);
                    console.log(`📡 Room ${info.code}: ${info.state} | ${info.playerCount} players | ${info.totalRounds} rounds`);
                    resolve();
                });
            }).on('error', reject);
        });
    } catch (err) {
        console.error(`❌ ${err.message}`);
        process.exit(1);
    }

    console.log('');
    console.log(`🚀 Connecting ${NUM_BOTS} bots (staggered over ${Math.ceil(NUM_BOTS / 5)}s)...`);
    console.log('');

    const bots = [];

    // Connect bots in batches of 5 to avoid overwhelming the server
    for (let i = 0; i < NUM_BOTS; i++) {
        const name = getRandomName(i);
        const bot = new Bot(i, name);
        bots.push(bot);

        try {
            await bot.connect();
            console.log(`  ✓ ${name} joined (${i + 1}/${NUM_BOTS})`);
        } catch (err) {
            console.log(`  ✗ ${name} failed: ${err.message}`);
        }

        // Small delay between connections
        if ((i + 1) % 5 === 0) {
            await delay(200);
        }
    }

    const connected = bots.filter(b => b.connected).length;
    console.log('');
    console.log(`✅ ${connected}/${NUM_BOTS} bots connected! Waiting for game to start...`);
    console.log('   (Press Ctrl+C to disconnect all bots)');
    console.log('');

    // Keep process alive
    process.on('SIGINT', () => {
        console.log('');
        console.log('🔌 Disconnecting all bots...');
        bots.forEach(b => b.disconnect());
        setTimeout(() => process.exit(0), 1000);
    });
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
