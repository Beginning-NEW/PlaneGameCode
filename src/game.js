export const START_LIVES = 3;
export const TARGET_WIDTH = 0.23;
export const TARGET_HEIGHT = 0.085;

export function createGame(dictionary, random = Math.random) {
  if (dictionary.length < 3 || new Set(dictionary.map(w => w.en)).size !== dictionary.length) throw new Error('词库需要至少三个不同英文单词');
  const game = { phase: 'ready', score: 0, lives: START_LIVES, round: 0, target: null, choices: [], targets: [], bullets: [], planeX: 0.5, feedback: '' };
  let sequence = [];
  let serial = 0;
  function nextRound() {
    if (!sequence.length) sequence = [...dictionary].sort(() => random() - 0.5);
    game.target = sequence.pop();
    game.choices = [game.target, ...dictionary.filter(w => w.en !== game.target.en).sort(() => random() - 0.5).slice(0, 2)];
    game.targets = game.choices.sort(() => random() - 0.5).map((word, i) => ({ id: ++serial, word, x: 0.06 + i * 0.33, y: -0.12 - i * 0.13 }));
    game.bullets = [];
    game.round++;
  }
  return {
    state: game,
    start() { game.phase = 'playing'; game.score = 0; game.lives = START_LIVES; game.round = 0; game.feedback = ''; sequence = []; nextRound(); },
    pause() { if (game.phase === 'playing') game.phase = 'paused'; else if (game.phase === 'paused') game.phase = 'playing'; },
    move(x) { if (game.phase === 'playing') game.planeX = Math.max(0.04, Math.min(0.96, x)); },
    fire() { if (game.phase === 'playing') game.bullets.push({ id: ++serial, x: game.planeX, y: 0.86 }); },
    // Deterministic step; coordinates normalized to the field for viewport-independent tests.
    tick(dt) {
      if (game.phase !== 'playing') return;
      for (const bullet of game.bullets) bullet.y -= 1.25 * dt;
      for (const target of game.targets) target.y += 0.14 * dt;
      for (const bullet of [...game.bullets]) {
        const hit = game.targets.find(t => bullet.x >= t.x && bullet.x <= t.x + TARGET_WIDTH && bullet.y >= t.y && bullet.y <= t.y + TARGET_HEIGHT);
        if (hit) { game.bullets = game.bullets.filter(b => b !== bullet); this.hit(hit.id); if (game.phase !== 'playing') return; }
      }
      game.bullets = game.bullets.filter(b => b.y > -0.1);
      if (game.targets.some(t => t.y > 0.92 && t.word.en === game.target.en)) this.miss();
      else game.targets = game.targets.filter(t => t.y <= 1.1);
    },
    hit(id) {
      if (game.phase !== 'playing') return;
      const target = game.targets.find(t => t.id === id);
      if (!target) return;
      if (target.word.en === game.target.en) { game.score += 10; game.feedback = '答对了！+10 分'; nextRound(); }
      else { game.targets = game.targets.filter(t => t.id !== id); game.feedback = '打错了！失去 1 颗生命'; this.loseLife(); }
    },
    miss() { if (game.phase !== 'playing') return; game.feedback = '漏掉正确单词！失去 1 颗生命'; this.loseLife(); if (game.phase === 'playing') nextRound(); },
    loseLife() { game.lives--; if (game.lives <= 0) { game.lives = 0; game.phase = 'over'; game.targets = []; game.bullets = []; } }
  };
}
