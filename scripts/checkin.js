/**
 * Natfreecloud 自动登录 + 每日签到脚本
 *
 * 流程：
 *   1. 打开登录页，填写邮箱/密码，识别图形验证码并登录（最多重试 20 次，
 *      每次失败都会点击验证码图片刷新后重新识别）。
 *   2. 登录成功后跳转到签到页面。
 *   3. 点击"我要签到"，读取数学验证公式；如果不是加法（+）就反复点击
 *      刷新，直到出现加法公式为止。
 *   4. 计算结果并填入答案框，点击"验证答案"。
 *   5. 根据弹窗判断成功/失败：成功则点击确定并结束；失败则点击确定后
 *      重新开始（最多重试 20 轮）。
 *   6. 记录签到前后的账户余额积分，并通过 Telegram 机器人发送通知。
 */

const { chromium } = require('playwright');
const { createWorker } = require('tesseract.js');
const fs = require('fs');
const path = require('path');
const https = require('https');

const LOGIN_URL = 'https://nat.freecloud.ltd/login';
const CHECKIN_URL =
  'https://nat.freecloud.ltd/addons?_plugin=19&_controller=index&_action=index';

const EMAIL = process.env.EMAIL;
const PASSWORD = process.env.PASSWORD;
const USE_PROXY = process.env.USE_PROXY === 'true';
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

const SCREENSHOT_DIR = path.join(process.cwd(), 'screenshots');
if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

let shotIndex = 0;
async function shot(page, name) {
  shotIndex += 1;
  const file = path.join(SCREENSHOT_DIR, `${String(shotIndex).padStart(2, '0')}-${name}.png`);
  try {
    await page.screenshot({ path: file, fullPage: true });
  } catch (e) {
    console.log('截图失败：', e.message);
  }
}

function sendTelegram(text) {
  return new Promise((resolve) => {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
      console.log('未配置 Telegram，跳过通知，内容如下：\n' + text);
      resolve();
      return;
    }
    const data = JSON.stringify({
      chat_id: TG_CHAT_ID,
      text,
      parse_mode: 'Markdown'
    });
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${TG_BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        console.log('Telegram 响应：', res.statusCode, body);
        resolve();
      });
    });
    req.on('error', (e) => {
      console.log('Telegram 发送失败：', e.message);
      resolve();
    });
    req.write(data);
    req.end();
  });
}

async function ocrCaptcha(buffer, worker) {
  const { data } = await worker.recognize(buffer);
  const raw = data.text || '';
  return raw.replace(/[^A-Za-z0-9]/g, '').trim();
}

async function login(page, worker) {
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
  await shot(page, 'login-page');

  const emailInput = page.getByPlaceholder('请输入您的邮箱');
  const passwordInput = page.getByPlaceholder('请输入您的密码');
  const captchaInput = page.getByPlaceholder('请输入验证码');
  const loginButton = page.getByRole('button', { name: '登录' });
  // 验证码图片假设为页面上最后一个 <img>（登录页 Logo 之外唯一的图片）
  // 如果实际页面结构不同，请根据登录页 HTML 调整这里的选择器。
  const captchaImg = page.locator('img').last();

  await emailInput.fill(EMAIL);
  await passwordInput.fill(PASSWORD);

  const maxAttempts = 20;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    console.log(`[登录] 第 ${attempt} 次尝试...`);

    await page.waitForTimeout(500);
    let code = '';
    const imgHandle = await captchaImg.elementHandle().catch(() => null);
    if (imgHandle) {
      const buffer = await imgHandle.screenshot();
      code = await ocrCaptcha(buffer, worker);
    }
    console.log('识别到验证码：', code);

    await captchaInput.fill('');
    if (code) await captchaInput.fill(code);

    await loginButton.click();
    await page.waitForTimeout(1500);
    await shot(page, `login-attempt-${attempt}`);

    const url = page.url();
    if (!url.includes('/login')) {
      console.log('✅ 登录成功。');
      return true;
    }

    console.log(`第 ${attempt} 次登录未成功，仍停留在登录页。`);

    if (attempt < maxAttempts) {
      try {
        await captchaImg.click();
      } catch (e) {
        console.log('点击验证码刷新失败：', e.message);
      }
      await page.waitForTimeout(800);
    }
  }
  return false;
}

function parseFormula(text) {
  const match = text.match(/请计算[：:]\s*(-?\d+)\s*([+\-*/×÷])\s*(-?\d+)/);
  if (!match) return null;
  return { a: Number(match[1]), op: match[2], b: Number(match[3]) };
}

function computeAnswer(a, op, b) {
  switch (op) {
    case '+':
      return a + b;
    case '-':
      return a - b;
    case '*':
    case '×':
      return a * b;
    case '/':
    case '÷':
      return a / b;
    default:
      return null;
  }
}

function extractBalance(text) {
  const match = text.match(/账户余额剩余\s*([\d.]+)\s*积分/);
  return match ? match[1] : null;
}

async function checkin(page) {
  await page.goto(CHECKIN_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  await shot(page, 'checkin-page');

  const bodyTextBefore = await page.textContent('body').catch(() => '');
  const balanceBefore = extractBalance(bodyTextBefore || '') || '未知';
  console.log('续期前积分：', balanceBefore);

  const checkinButton = page.getByRole('button', { name: '我要签到' });
  const answerInput = page.getByPlaceholder('请输入答案');
  const verifyButton = page.getByRole('button', { name: '验证答案' });

  const maxOuterAttempts = 20;
  const maxFormulaRefresh = 30;
  let finalSuccess = false;
  let lastModalText = '';

  for (let outer = 1; outer <= maxOuterAttempts; outer += 1) {
    console.log(`[签到] 第 ${outer} 轮验证...`);

    await checkinButton.click().catch(() => {});
    await page.waitForTimeout(800);

    let formula = null;
    for (let r = 0; r < maxFormulaRefresh; r += 1) {
      const text = await page.textContent('body').catch(() => '');
      formula = parseFormula(text || '');
      if (formula && formula.op === '+') break;
      console.log('当前公式不是加法或未识别到，刷新中...', formula);
      await checkinButton.click().catch(() => {});
      await page.waitForTimeout(700);
    }

    if (!formula || formula.op !== '+') {
      console.log('多次刷新仍未获得加法公式，进入下一轮。');
      continue;
    }

    const answer = computeAnswer(formula.a, formula.op, formula.b);
    console.log(`公式：${formula.a} + ${formula.b} = ${answer}`);

    await answerInput.fill('');
    await answerInput.fill(String(answer));
    await verifyButton.click();
    await page.waitForTimeout(1000);
    await shot(page, `checkin-verify-${outer}`);

    let modalText = '';
    try {
      modalText = await page.locator('body').innerText();
    } catch (e) {
      modalText = '';
    }
    lastModalText = modalText;

    const confirmButton = page.getByRole('button', { name: '确定' });
    const hasConfirm = await confirmButton.count();
    if (hasConfirm) {
      await confirmButton.first().click().catch(() => {});
      await page.waitForTimeout(800);
    }

    const isSuccess = modalText.includes('验证成功') || (modalText.includes('成功') && !modalText.includes('失败'));
    if (isSuccess) {
      console.log('✅ 签到验证成功。');
      finalSuccess = true;
      break;
    }

    console.log('❌ 本轮验证失败，准备重试。');
    await page.waitForTimeout(800);
  }

  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1000);
  const bodyTextAfter = await page.textContent('body').catch(() => '');
  const balanceAfter = extractBalance(bodyTextAfter || '') || '未知';
  console.log('续期后积分：', balanceAfter);

  return { finalSuccess, balanceBefore, balanceAfter, lastModalText };
}

(async () => {
  if (!EMAIL || !PASSWORD) {
    await sendTelegram('❌ 自动签到失败：未配置 EMAIL 或 PASSWORD 这两个 Secret。');
    process.exit(1);
  }

  const launchOptions = { headless: true };
  if (USE_PROXY) {
    launchOptions.proxy = { server: 'socks5://127.0.0.1:1080' };
    console.log('使用本地 Socks5 代理：127.0.0.1:1080');
  } else {
    console.log('未配置代理（VLESS_LINK 为空），使用直连模式。');
  }

  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  const worker = await createWorker('eng');

  try {
    const loggedIn = await login(page, worker);
    if (!loggedIn) {
      await sendTelegram('❌ 自动签到失败：登录尝试 20 次后仍未成功，请检查账号密码，或验证码识别是否正常（可查看构建产物中的截图）。');
      await browser.close();
      await worker.terminate();
      process.exit(1);
    }

    const result = await checkin(page);
    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

    if (result.finalSuccess) {
      const msg = [
        '✅ *Natfreecloud 自动签到成功*',
        `续期前积分：${result.balanceBefore}`,
        `续期后积分：${result.balanceAfter}`,
        `时间：${now}`
      ].join('\n');
      await sendTelegram(msg);
    } else {
      const msg = [
        '⚠️ *Natfreecloud 自动签到未成功*',
        '尝试 20 轮后仍未通过验证。',
        `续期前积分：${result.balanceBefore}`,
        `续期后积分：${result.balanceAfter}`,
        `最后一次弹窗内容片段：${(result.lastModalText || '').slice(0, 100)}`,
        `时间：${now}`
      ].join('\n');
      await sendTelegram(msg);
    }
  } catch (err) {
    console.error('运行出错：', err);
    await sendTelegram(`❌ 自动签到脚本运行出错：${err.message}`);
    process.exitCode = 1;
  } finally {
    await worker.terminate();
    await browser.close();
  }
})();
