import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame } from '../src/game.js';
const words = [{ zh: '苹果', en: 'apple' }, { zh: '猫', en: 'cat' }, { zh: '狗', en: 'dog' }, { zh: '书', en: 'book' }];
const create = () => createGame(words, () => 0.5);

test('start, pause, resume and restart reset game state', () => {
  const g = create(); assert.equal(g.state.phase, 'ready');
  g.start(); assert.equal(g.state.phase, 'playing'); assert.equal(g.state.lives, 3);
  g.pause(); assert.equal(g.state.phase, 'paused');
  g.hit(g.state.targets[0].id); assert.equal(g.state.score, 0);
  g.pause(); assert.equal(g.state.phase, 'playing');
  g.start(); assert.equal(g.state.score, 0); assert.equal(g.state.lives, 3);
});
test('correct target scores and advances; wrong target loses a life', () => {
  const g = create(); g.start(); const round = g.state.round;
  g.hit(g.state.targets.find(t => t.word.en === g.state.target.en).id);
  assert.equal(g.state.score, 10); assert.equal(g.state.round, round + 1);
  g.hit(g.state.targets.find(t => t.word.en !== g.state.target.en).id);
  assert.equal(g.state.score, 10); assert.equal(g.state.lives, 2);
});
test('projectile collision judges target; a missed answer ends the game after three lives', () => {
  const g = create(); g.start();
  const correct = g.state.targets.find(t => t.word.en === g.state.target.en);
  g.move(correct.x + 0.1); g.fire();
  for (let i = 0; i < 100 && g.state.score === 0; i++) g.tick(0.05);
  assert.equal(g.state.score, 10);
  for (let i = 0; i < 3; i++) g.miss();
  assert.equal(g.state.phase, 'over'); assert.equal(g.state.lives, 0);
  g.fire(); assert.equal(g.state.bullets.length, 0);
  g.start(); assert.equal(g.state.phase, 'playing'); assert.equal(g.state.score, 0);
});
test('invalid dictionary fails fast', () => assert.throws(() => createGame(words.slice(0, 2))));
