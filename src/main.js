import { createGame } from './game.js';
import { words } from './words.js';

const game = createGame(words);
const $ = id => document.getElementById(id);
const field = $('field');
let last = performance.now();
let feedbackUntil = 0;
let previousFeedback = '';
let announced = null;

function announce(message) {
  $('sr-status').textContent = message;
}

function announceState(s) {
  const current = { phase: s.phase, target: s.target?.zh ?? '', score: s.score, lives: s.lives, feedback: s.feedback };
  if (announced === null) {
    announce('准备开始。按开始游戏开始。');
  } else if (current.phase !== announced.phase) {
    if (current.phase === 'paused') announce(`游戏已暂停。当前得分 ${s.score} 分，生命 ${s.lives}。`);
    else if (current.phase === 'over') announce(`游戏结束。最终得分 ${s.score} 分，生命 0。`);
    else if (current.phase === 'playing') {
      const prefix = announced.phase === 'paused' ? '继续游戏。' : '游戏开始。';
      announce(`${prefix}题目：${s.target?.zh ?? '准备起飞'}。分数 ${s.score} 分，生命 ${s.lives}。`);
    }
  } else if (current.target !== announced.target || current.score !== announced.score || current.lives !== announced.lives || current.feedback !== announced.feedback) {
    const feedback = s.feedback ? `${s.feedback} ` : '';
    announce(`${feedback}题目：${s.target?.zh ?? '准备起飞'}。分数 ${s.score} 分，生命 ${s.lives}。`);
  }
  announced = current;
}

function render() {
  const s = game.state;
  $('score').textContent = String(s.score);
  $('lives').textContent = String(s.lives);
  $('prompt').textContent = s.target?.zh ?? '准备起飞';
  $('plane').style.left = `${s.planeX * 100}%`;
  $('targets').replaceChildren(...s.targets.map(t => {
    const el = document.createElement('div');
    el.className = 'target';
    el.dataset.word = t.word.en;
    el.textContent = t.word.en;
    el.style.left = `${t.x * 100}%`;
    el.style.top = `${t.y * 100}%`;
    return el;
  }));
  $('bullets').replaceChildren(...s.bullets.map(b => {
    const el = document.createElement('i');
    el.className = 'bullet';
    el.style.left = `${b.x * 100}%`;
    el.style.top = `${b.y * 100}%`;
    return el;
  }));
  if (s.feedback !== previousFeedback) { previousFeedback = s.feedback; feedbackUntil = performance.now() + 1400; }
  $('feedback').textContent = performance.now() < feedbackUntil ? s.feedback : '';
  const shown = s.phase !== 'playing';
  $('overlay').hidden = !shown;
  $('pause').disabled = s.phase === 'ready' || s.phase === 'over';
  $('pause').textContent = s.phase === 'paused' ? '继续' : '暂停';
  if (s.phase === 'ready') { $('overlay-kicker').textContent = '准备好了吗？'; $('overlay-title').textContent = '开启你的单词飞行'; $('overlay-message').textContent = '找到中文题目对应的英文词，瞄准并发射！'; $('primary').firstChild.textContent = '开始游戏 '; }
  if (s.phase === 'paused') { $('overlay-kicker').textContent = '休息一下'; $('overlay-title').textContent = '游戏已暂停'; $('overlay-message').textContent = `当前得分：${s.score}。准备好就继续飞行。`; $('primary').firstChild.textContent = '继续游戏 '; }
  if (s.phase === 'over') { $('overlay-kicker').textContent = '本局结束'; $('overlay-title').textContent = '飞行结束，继续加油！'; $('overlay-message').textContent = `本局获得 ${s.score} 分，再挑战一次吧。`; $('primary').firstChild.textContent = '再玩一次 '; }
  announceState(s);
}

function frame(now) {
  game.tick(Math.min((now - last) / 1000, 0.05));
  last = now;
  render();
  requestAnimationFrame(frame);
}

function point(event) {
  const box = field.getBoundingClientRect();
  game.move((event.clientX - box.left) / box.width);
}
field.addEventListener('pointermove', point);
field.addEventListener('pointerdown', event => { if (game.state.phase === 'playing') { point(event); game.fire(); event.preventDefault(); } });
field.addEventListener('keydown', event => {
  if (game.state.phase !== 'playing') return;
  const key = event.key.toLowerCase();
  if (key === 'arrowleft' || key === 'a') {
    event.preventDefault();
    game.move(game.state.planeX - 0.08);
    render();
  } else if (key === 'arrowright' || key === 'd') {
    event.preventDefault();
    game.move(game.state.planeX + 0.08);
    render();
  } else if (event.key === ' ' || event.key === 'Spacebar') {
    event.preventDefault();
    game.fire();
    render();
  }
});
$('primary').addEventListener('click', () => { if (game.state.phase === 'paused') game.pause(); else game.start(); render(); });
$('pause').addEventListener('click', () => { game.pause(); render(); });
$('restart').addEventListener('click', () => { game.start(); render(); });
render();
requestAnimationFrame(frame);
