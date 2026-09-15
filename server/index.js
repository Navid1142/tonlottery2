const { Bot } = require('node-telegram-bot-api');
const { Address } = require('@ton/core');
require('dotenv').config();

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const botToken = process.env.TELEGRAM_BOT_TOKEN;
const publicAppUrl = String(process.env.PUBLIC_APP_URL || '').trim();

const TREASURY_ADDRESS = String(process.env.TREASURY_ADDRESS || '').trim();
const TONCENTER_API_KEY = String((() => {
  try {
    return fs.readFileSync(path.join(__dirname, '.toncenter-key'), 'utf8').trim();
  } catch {
    return process.env.TONCENTER_API_KEY || '';
  }
})()).trim();

const DATA_DIR = path.join(__dirname, 'data');
const PURCHASES_FILE = path.join(DATA_DIR, 'purchases.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

function readPurchases() {
  try {
    if (!fs.existsSync(PURCHASES_FILE)) return [];
    const data = JSON.parse(fs.readFileSync(PURCHASES_FILE, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writePurchases(data) {
  fs.writeFileSync(
    PURCHASES_FILE,
    JSON.stringify(data, null, 2),
    { mode: 0o600 }
  );
}

const TICKETS = {
  Bronze: { price: 1, chances: 1 },
  Silver: { price: 3, chances: 5 },
  Purple: { price: 7, chances: 10 },
  Ice: { price: 9, chances: 15 },
  Golden: { price: 11, chances: 20 }
};

const round = {
  id: 1,
  targetTon: 20000,
  maxPerUserTon: 11,
  minPerEntryTon: 1,
  winners: 1000,
  status: 'OPEN',
  totalConfirmedTon: 0
};

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'web')));

function normalizeAddress(value) {
  try {
    return Address.parse(String(value).trim()).toRawString().toLowerCase();
  } catch {
    return String(value || '').trim().toLowerCase();
  }
}

function validateInitData(initData) {
  if (!initData || !botToken) {
    return {
      ok: false,
      error: 'Telegram validation is not configured'
    };
  }

  const p = new URLSearchParams(initData);
  const hash = p.get('hash');
  const authDate = Number(p.get('auth_date') || 0);

  if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) {
    return {
      ok: false,
      error: 'Invalid Telegram hash'
    };
  }

  if (!authDate) {
    return {
      ok: false,
      error: 'Missing auth_date'
    };
  }

  const age = Math.floor(Date.now() / 1000) - authDate;

  if (age < -60 || age > 3600) {
    return {
      ok: false,
      error: 'Telegram session expired'
    };
  }

  p.delete('hash');

  const dataCheck = [...p.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secret = crypto
    .createHmac('sha256', 'WebAppData')
    .update(botToken)
    .digest();

  const calc = crypto
    .createHmac('sha256', secret)
    .update(dataCheck)
    .digest('hex');

  const valid =
    calc.length === hash.length &&
    crypto.timingSafeEqual(
      Buffer.from(calc, 'utf8'),
      Buffer.from(hash, 'utf8')
    );

  return {
    ok: valid,
    error: valid ? undefined : 'Invalid Telegram session',
    data: p
  };
}

function getTelegramUser(initData) {
  const session = validateInitData(initData);

  if (!session.ok) {
    return {
      ok: false,
      error: session.error
    };
  }

  let user = null;

  try {
    user = JSON.parse(session.data.get('user') || 'null');
  } catch {}

  if (!user?.id) {
    return {
      ok: false,
      error: 'Telegram user not found'
    };
  }

  return {
    ok: true,
    user
  };
}

function ticketFromName(type) {
  return TICKETS[String(type || '')] || null;
}

async function toncenter(pathname, params = {}) {
  if (!TONCENTER_API_KEY) {
    throw new Error('TONCENTER_API_KEY is not configured');
  }

  const url = new URL(
    `https://toncenter.com/api/v3${pathname}`
  );

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    headers: {
      'X-API-Key': TONCENTER_API_KEY
    }
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data?.error || data?.message || `TON Center HTTP ${response.status}`
    );
  }

  return data;
}

async function findConfirmedPayment(intent, boc = '') {
  if (!TREASURY_ADDRESS) {
    throw new Error('TREASURY_ADDRESS is not configured');
  }

  const expectedNano = BigInt(
    Math.round(intent.price * 1000000000)
  );

  const sender = normalizeAddress(intent.walletAddress);
  const treasury = normalizeAddress(TREASURY_ADDRESS);
  const expectedComment = String(intent.paymentComment || '');

  const start = Math.floor(intent.createdAt / 1000) - 120;
  const end = Math.floor(Date.now() / 1000) + 120;

  const data = await toncenter('/messages', {
    destination: treasury,
    source: sender,
    direction: 'in',
    start_utime: start,
    end_utime: end,
    limit: 100,
    offset: 0
  });

  const messages = Array.isArray(data?.messages)
    ? data.messages
    : [];

  for (const message of messages) {
    if (message?.bounced === true) {
      continue;
    }

    const destination = normalizeAddress(message?.destination);
    const source = normalizeAddress(message?.source);

    if (destination !== treasury) continue;
    if (source !== sender) continue;

    let value;
    try {
      value = BigInt(String(message?.value || '0'));
    } catch {
      continue;
    }

    if (value !== expectedNano) continue;

    const body =
      message?.message_content?.body ||
      message?.body ||
      '';

    let comment = '';

    if (body) {
      try {
        const raw = Buffer.from(String(body), 'base64');

        if (raw.length >= 4) {
          const opcode = raw.readUInt32BE(0);

          if (opcode === 0) {
            comment = raw
              .subarray(4)
              .toString('utf8')
              .replace(/\0+$/g, '');
          }
        }
      } catch {
        comment = '';
      }
    }

    if (expectedComment && comment !== expectedComment) {
      continue;
    }

    console.log(
      '[payment/verify] matched payment',
      'commentMatch:', comment === expectedComment,
      'hasBoc:', Boolean(boc)
    );

    return {
      found: true,
      txHash:
        message?.in_msg_tx_hash ||
        message?.out_msg_tx_hash ||
        message?.hash ||
        null,
      messageHash: message?.hash || null,
      source: message?.source || intent.walletAddress,
      destination: message?.destination || TREASURY_ADDRESS,
      valueNano: value.toString(),
      createdAt: Number(message?.created_at || 0),
      paymentComment: comment
    };
  }

  return {
    found: false
  };
}


function makeTonCommentPayload(text) {
  const bytes = Buffer.from(String(text), 'utf8');

  if (bytes.length > 120) {
    throw new Error('Payment comment is too long');
  }

  // Cell body:
  // 32-bit zero opcode + UTF-8 comment bytes.
  //
  // We use a tiny handcrafted BoC containing one ordinary cell.
  const data = Buffer.alloc(4 + bytes.length);
  data.writeUInt32BE(0, 0);
  bytes.copy(data, 4);

  // This helper intentionally returns null until the frontend
  // uses a wallet-compatible BoC builder.
  return null;
}

function buildLeaderboard() {
  const purchases = readPurchases()
    .filter(x =>
      x &&
      x.status === 'confirmed' &&
      x.userId
    );

  const users = new Map();

  for (const purchase of purchases) {
    const key = String(purchase.userId);

    if (!users.has(key)) {
      users.set(key, {
        userId: key,
        firstName: purchase.firstName || '',
        lastName: purchase.lastName || '',
        username: purchase.username || '',
        photoUrl: purchase.photoUrl || '',
        totalChances: 0,
        totalTon: 0,
        tickets: [],
        purchases: 0
      });
    }

    const user = users.get(key);

    if (purchase.firstName) user.firstName = purchase.firstName;
    if (purchase.lastName) user.lastName = purchase.lastName;
    if (purchase.username) user.username = purchase.username;
    if (purchase.photoUrl) user.photoUrl = purchase.photoUrl;

    user.totalChances += Number(purchase.chances || 0);
    user.totalTon += Number(purchase.price || 0);
    user.purchases += 1;

    user.tickets.push({
      type: purchase.type,
      chances: Number(purchase.chances || 0),
      price: Number(purchase.price || 0),
      confirmedAt: purchase.confirmedAt
    });
  }

  return [...users.values()]
    .sort((a, b) => {
      if (b.totalChances !== a.totalChances) {
        return b.totalChances - a.totalChances;
      }

      if (b.totalTon !== a.totalTon) {
        return b.totalTon - a.totalTon;
      }

      return String(a.userId).localeCompare(String(b.userId));
    })
    .map((user, index) => ({
      rank: index + 1,
      ...user,
      totalTon: Number(user.totalTon.toFixed(3))
    }));
}

function updateRoundTotal() {
  const purchases = readPurchases()
    .filter(x => x?.status === 'confirmed');

  round.totalConfirmedTon = Number(
    purchases
      .reduce((sum, x) => sum + Number(x.price || 0), 0)
      .toFixed(3)
  );
}

if (botToken) {
  const bot = new Bot(botToken);

  bot.command('start', async ctx => {
    try {
      await ctx.reply(
        '🎯 Welcome to TON Lottery!\n\nTap the button below to open the Mini App.',
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '🎯 Open App',
                  web_app: { url: publicAppUrl }
                }
              ]
            ]
          }
        }
      );
    } catch (error) {
      console.error('[bot] /start failed:', error.message);
    }
  });

  if (publicAppUrl) {
    bot.api.setChatMenuButton({
      menu_button: {
        type: 'web_app',
        text: '🎯 Open App',
        web_app: { url: publicAppUrl }
      }
    })
      .then(() => console.log('[bot] Menu Button configured'))
      .catch(error =>
        console.error('[bot] Menu Button setup failed:', error.message)
      );
  }

  bot.catch(error =>
    console.error('[bot] handler error:', error.message)
  );

  bot.startPolling()
    .then(() => console.log('[bot] Telegram bot started'))
    .catch(error =>
      console.error('[bot] polling start failed:', error.message)
    );
} else {
  console.warn('[bot] TELEGRAM_BOT_TOKEN is missing; bot disabled');
}

app.get('/api/config', (req, res) => {
  updateRoundTotal();

  res.json({
    round,
    publicAppUrl: process.env.PUBLIC_APP_URL || null,
    treasuryAddress: TREASURY_ADDRESS || null,
    realPaymentEnabled: Boolean(TREASURY_ADDRESS)
  });
});

app.post('/api/telegram/session', (req, res) => {
  const result = getTelegramUser(req.body?.initData);

  if (!result.ok) {
    return res.status(401).json(result);
  }

  res.json({
    ok: true,
    user: result.user
  });
});


app.get('/api/my-tickets', (req, res) => {
  try {
    const session = getTelegramUser(req.query?.initData);

    if (!session.ok) {
      return res.status(401).json(session);
    }

    const userId = String(session.user.id);

    const tickets = readPurchases()
      .filter(x =>
        x &&
        x.status === 'confirmed' &&
        String(x.userId) === userId &&
        Number(x.roundId) === Number(round.id)
      )
      .sort((a, b) =>
        Number(b.confirmedAt || 0) - Number(a.confirmedAt || 0)
      )
      .map(x => ({
        id: x.id,
        type: x.type,
        price: Number(x.price || 0),
        chances: Number(x.chances || 0),
        confirmedAt: x.confirmedAt || null,
        txHash: x.txHash || null
      }));

    res.json({
      ok: true,
      round,
      tickets
    });
  } catch (error) {
    console.error('[my-tickets]', error);

    res.status(500).json({
      ok: false,
      error: error.message || 'Could not load tickets'
    });
  }
});

app.get('/api/leaderboard', (req, res) => {
  updateRoundTotal();

  res.json({
    ok: true,
    round,
    leaderboard: buildLeaderboard()
  });
});

app.post('/api/payment/intent', (req, res) => {
  try {
    const session = getTelegramUser(req.body?.initData);

    if (!session.ok) {
      return res.status(401).json(session);
    }

    const ticket = ticketFromName(req.body?.type);

    if (!ticket) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid ticket type'
      });
    }

    const walletAddress = String(
      req.body?.walletAddress || ''
    ).trim();

    if (!walletAddress) {
      return res.status(400).json({
        ok: false,
        error: 'Wallet address is required'
      });
    }

    try {
      Address.parse(walletAddress);
    } catch {
      return res.status(400).json({
        ok: false,
        error: 'Invalid TON wallet address'
      });
    }

    const purchases = readPurchases();

    const intent = {
      id: crypto.randomUUID(),
      status: 'pending',
      roundId: round.id,
      userId: String(session.user.id),
      firstName: session.user.first_name || '',
      lastName: session.user.last_name || '',
      username: session.user.username || '',
      photoUrl: session.user.photo_url || '',
      walletAddress,
      type: req.body.type,
      price: ticket.price,
      chances: ticket.chances,
      createdAt: Date.now(),
      confirmedAt: null,
      txHash: null,
      paymentComment: 'TONLOTTERY:' + crypto.randomUUID()
    };

    purchases.push(intent);
    writePurchases(purchases);

    res.json({
      ok: true,
      intentId: intent.id,
      price: ticket.price,
      chances: ticket.chances,
      paymentComment: intent.paymentComment,
      paymentPayload: makeTonCommentPayload(intent.paymentComment)
    });
  } catch (error) {
    console.error('[payment/intent]', error);

    res.status(500).json({
      ok: false,
      error: error.message || 'Payment intent failed'
    });
  }
});

app.post('/api/payment/verify', async (req, res) => {
  try {
    const session = getTelegramUser(req.body?.initData);

    if (!session.ok) {
      return res.status(401).json(session);
    }

    const intentId = String(req.body?.intentId || '');
    const boc = String(req.body?.boc || '');

    if (!intentId) {
      return res.status(400).json({
        ok: false,
        error: 'Missing payment intent'
      });
    }

    const purchases = readPurchases();

    const index = purchases.findIndex(
      x =>
        x?.id === intentId &&
        String(x.userId) === String(session.user.id)
    );

    if (index === -1) {
      return res.status(404).json({
        ok: false,
        error: 'Payment intent not found'
      });
    }

    const intent = purchases[index];

    if (intent.status === 'confirmed') {
      updateRoundTotal();

      return res.json({
        ok: true,
        confirmed: true,
        purchase: intent,
        round,
        leaderboard: buildLeaderboard()
      });
    }

    const result = await findConfirmedPayment(intent, boc);

    if (!result.found) {
      return res.json({
        ok: true,
        confirmed: false,
        message: 'Payment is not confirmed on-chain yet.'
      });
    }

    purchases[index] = {
      ...intent,
      status: 'confirmed',
      confirmedAt: Date.now(),
      txHash: result.txHash,
      messageHash: result.messageHash
    };

    writePurchases(purchases);
    updateRoundTotal();

    res.json({
      ok: true,
      confirmed: true,
      purchase: purchases[index],
      round,
      leaderboard: buildLeaderboard()
    });
  } catch (error) {
    console.error('[payment/verify]', error);

    res.status(500).json({
      ok: false,
      error: error.message || 'Payment verification failed'
    });
  }
});

app.post('/api/channel/status', async (req, res) => {
  try {
    if (!botToken || !process.env.TELEGRAM_CHANNEL) {
      return res.status(503).json({
        ok: false,
        error: 'Channel membership check is not configured'
      });
    }

    const session = getTelegramUser(req.body?.initData);

    if (!session.ok) {
      return res.status(401).json(session);
    }

    const channel = process.env.TELEGRAM_CHANNEL.trim();

    const url =
      `https://api.telegram.org/bot${botToken}` +
      `/getChatMember?chat_id=${encodeURIComponent(channel)}` +
      `&user_id=${encodeURIComponent(String(session.user.id))}`;

    const telegramResponse = await fetch(url);
    const data = await telegramResponse.json();

    if (!data.ok) {
      return res.status(502).json({
        ok: false,
        error: data.description || 'Telegram API error'
      });
    }

    const member = data.result || {};
    const status = member.status;

    const joined =
      status === 'creator' ||
      status === 'administrator' ||
      status === 'member' ||
      (status === 'restricted' && member.is_member === true);

    res.json({
      ok: true,
      joined,
      status
    });
  } catch (error) {
    console.error('[membership]', error);

    res.status(500).json({
      ok: false,
      error: error.message || 'Membership check failed'
    });
  }
});

app.get('/*splat', (req, res) => {
  res.sendFile(
    path.join(__dirname, '..', 'web', 'index.html')
  );
});

app.listen(PORT, () => {
  console.log(
    `Mini App shell running on http://127.0.0.1:${PORT}`
  );
});
