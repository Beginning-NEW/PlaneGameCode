import { test, expect } from '@playwright/test';

async function shoot(page, correct) {
  const word = (await page.locator('#prompt').textContent())?.trim();
  const answers = { '苹果': 'apple', '书': 'book', '猫': 'cat', '狗': 'dog', '太阳': 'sun', '月亮': 'moon', '水': 'water', '树': 'tree', '鸟': 'bird', '花': 'flower' };
  const en = answers[word];
  const target = correct ? page.locator(`.target[data-word="${en}"]`) : page.locator(`.target:not([data-word="${en}"])`).first();
  await expect(target).toBeVisible();
  const selector = correct ? `.target[data-word="${en}"]` : `.target:not([data-word="${en}"])`;
  const position = async () => page.evaluate(selector => {
    const target = document.querySelector(selector)?.getBoundingClientRect();
    const field = document.getElementById('field').getBoundingClientRect();
    return target && { x: target.x + target.width / 2 - field.x, y: target.y - field.y, height: field.height };
  }, selector);
  await expect.poll(async () => (await position())?.y ?? -100, { timeout: 14000 }).toBeGreaterThan(65);
  const p = await position();
  await page.locator('#field').click({ position: { x: p.x, y: p.height - 30 }, force: true });
}

test('start, correct and incorrect hits, game over and restart', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '飞机打英语' })).toBeVisible();
  await page.getByRole('button', { name: /开始游戏/ }).click();
  await shoot(page, true);
  await expect(page.locator('#score')).toHaveText('10', { timeout: 5000 });
  await shoot(page, false);
  await expect(page.locator('#lives')).toHaveText('♥ ♥', { timeout: 5000 });
  await page.getByRole('button', { name: '暂停' }).click();
  await expect(page.getByRole('heading', { name: '游戏已暂停' })).toBeVisible();
  await page.getByRole('button', { name: /继续游戏/ }).click();
  await expect(page.locator('#lives')).toHaveText('0', { timeout: 30000 });
  await expect(page.getByRole('heading', { name: /飞行结束/ })).toBeVisible();
  await page.getByRole('button', { name: /再玩一次/ }).click();
  await expect(page.locator('#score')).toHaveText('0');
  await expect(page.locator('#lives')).toHaveText('♥ ♥ ♥');
  if (testInfo.project.name === 'mobile') {
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(page.viewportSize().width);
  }
});
