// ⚠️ LOAD ENVIRONMENT VARIABLES FROM .env FILE
require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const paypalSdk = require('@paypal/checkout-server-sdk');

// Get API keys from environment variables
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_SECRET = process.env.PAYPAL_SECRET;
const PORT = process.env.PORT || 3000;

// Validate required keys
if (!TELEGRAM_TOKEN || !PAYPAL_CLIENT_ID || !PAYPAL_SECRET) {
  console.error('❌ ERROR: Missing required environment variables!');
  process.exit(1);
}

// PayPal Environment
const environment = new paypalSdk.core.LiveEnvironment(
  PAYPAL_CLIENT_ID,
  PAYPAL_SECRET
);
const client = new paypalSdk.core.PayPalHttpClient(environment);

// Initialize Telegram Bot
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const app = express();
app.use(express.json());

console.log('✅ DICE RUSH Payment Bot initialized');
console.log('✅ Stripe connected');
console.log('✅ PayPal connected');

// ==================== WALLET SYSTEM ====================
const wallets = {};

function getBalance(userId) {
  if (!wallets[userId]) {
    wallets[userId] = {
      userId: userId,
      balance: 100,
      deposited: 0,
      winnings: 0,
      lastUpdated: new Date()
    };
  }
  return wallets[userId];
}

function updateBalance(userId, amount, type = 'add') {
  const wallet = getBalance(userId);
  const oldBalance = wallet.balance;
  
  switch(type) {
    case 'add':
      wallet.balance += amount;
      break;
    case 'subtract':
      wallet.balance -= amount;
      break;
    case 'deposit':
      wallet.balance += amount;
      wallet.deposited += amount;
      break;
    case 'win':
      wallet.balance += amount;
      wallet.winnings += amount;
      break;
  }
  
  wallet.lastUpdated = new Date();
  console.log(`💰 User ${userId}: $${oldBalance.toFixed(2)} → $${wallet.balance.toFixed(2)} (${type})`);
  return wallet;
}

function getLeaderboard(limit = 10) {
  return Object.values(wallets)
    .sort((a, b) => b.winnings - a.winnings)
    .slice(0, limit);
}

// ==================== STRIPE PAYMENT ====================
app.post('/create-payment-intent', async (req, res) => {
  try {
    const { userId, amount } = req.body;
    
    if (!userId || !amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid userId or amount' });
    }
    
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency: 'usd',
      metadata: { userId: String(userId) }
    });
    
    res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id
    });
  } catch (error) {
    console.error('❌ Stripe error:', error.message);
    res.status(400).json({ error: error.message });
  }
});

app.post('/confirm-stripe-payment', async (req, res) => {
  try {
    const { paymentIntentId, userId, amount, chatId } = req.body;
    const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
    
    if (intent.status === 'succeeded') {
      const wallet = updateBalance(userId, amount, 'deposit');
      
      // Notify user
      try {
        await bot.sendMessage(
          userId,
          `✅ <b>Deposit Successful!</b>\n💰 +$${amount}\n🏦 New: $${wallet.balance.toFixed(2)}`,
          { parse_mode: 'HTML' }
        );
      } catch (err) {}
      
      // Post to group
      if (chatId) {
        try {
          await bot.sendMessage(chatId, `💰 User ${userId} deposited $${amount}!`, { parse_mode: 'HTML' });
        } catch (err) {}
      }
      
      res.json({ success: true, balance: wallet.balance });
    } else {
      res.status(400).json({ error: 'Payment not confirmed' });
    }
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/confirm-paypal-payment', async (req, res) => {
  try {
    const { orderId, userId, amount, chatId } = req.body;
    
    if (!orderId || !userId || !amount) {
      return res.status(400).json({ error: 'Invalid order data' });
    }
    
    // Verify order with PayPal
    const request = new paypalSdk.orders.OrdersGetRequest(orderId);
    const order = await client.execute(request);
    
    if (order.result.status === 'COMPLETED') {
      const wallet = updateBalance(userId, amount, 'deposit');
      
      // Notify user
      try {
        await bot.sendMessage(
          userId,
          `✅ <b>PayPal Deposit Successful!</b>\n💰 +$${amount}\n🏦 New: $${wallet.balance.toFixed(2)}`,
          { parse_mode: 'HTML' }
        );
      } catch (err) {}
      
      // Post to group
      if (chatId) {
        try {
          await bot.sendMessage(chatId, `💰 User ${userId} deposited $${amount} via PayPal!`, { parse_mode: 'HTML' });
        } catch (err) {}
      }
      
      res.json({ success: true, balance: wallet.balance });
    } else {
      res.status(400).json({ error: 'Order not completed' });
    }
  } catch (error) {
    console.error('❌ PayPal error:', error.message);
    res.status(400).json({ error: error.message });
  }
});

// ==================== TELEGRAM COMMANDS ====================

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const userName = msg.from.first_name || 'Player';
  const wallet = getBalance(userId);
  
  bot.sendMessage(chatId, 
    `🎲 <b>Welcome to DICE RUSH!</b>\n\nHey ${userName}!\n\n` +
    `💰 Balance: $${wallet.balance.toFixed(2)}\n` +
    `💳 Deposited: $${wallet.deposited.toFixed(2)}\n` +
    `🏆 Winnings: $${wallet.winnings.toFixed(2)}\n\n` +
    `Commands: /play /deposit /balance /leaderboard /help`,
    { 
      parse_mode: 'HTML', 
      reply_markup: {
        inline_keyboard: [
          [{ text: '💳 Deposit', callback_data: 'btn_deposit' }],
          [{ text: '🎲 Play', callback_data: 'btn_play' }],
          [{ text: '💰 Balance', callback_data: 'btn_balance' }]
        ]
      }
    }
  );
});

bot.onText(/\/play/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  bot.sendMessage(chatId, `🎲 Select bet:`, { 
    reply_markup: {
      inline_keyboard: [
        [{ text: '$1', callback_data: `play_bet_1_${userId}` }],
        [{ text: '$5', callback_data: `play_bet_5_${userId}` }],
        [{ text: '$10', callback_data: `play_bet_10_${userId}` }],
        [{ text: '$25', callback_data: `play_bet_25_${userId}` }]
      ]
    }
  });
});

bot.onText(/\/balance/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const wallet = getBalance(userId);
  
  bot.sendMessage(chatId,
    `💰 Your Wallet\n\n💵 $${wallet.balance.toFixed(2)}\n💳 Deposited: $${wallet.deposited.toFixed(2)}\n🏆 Winnings: $${wallet.winnings.toFixed(2)}`,
    { parse_mode: 'HTML' }
  );
});

bot.onText(/\/leaderboard/, (msg) => {
  const chatId = msg.chat.id;
  const leaderboard = getLeaderboard(10);
  
  let message = `🏆 <b>Leaderboard</b>\n\n`;
  if (leaderboard.length === 0) {
    message += `No players yet!`;
  } else {
    leaderboard.forEach((w, i) => {
      message += `${i+1}. User ${w.userId}: $${w.winnings.toFixed(2)}\n`;
    });
  }
  
  bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
});

bot.onText(/\/deposit/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  bot.sendMessage(chatId, `💳 Choose payment:`, { 
    reply_markup: {
      inline_keyboard: [
        [{ text: '💳 Stripe', callback_data: `dep_stripe_${userId}` }],
        [{ text: '🅿️ PayPal', callback_data: `dep_paypal_${userId}` }]
      ]
    }
  });
});

bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, `/play - Play\n/deposit - Deposit\n/balance - Balance\n/leaderboard - Top players`);
});

// ==================== CALLBACK HANDLER ====================
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data = query.data;
  
  console.log(`🔘 Callback from user ${userId}: ${data}`);
  
  try {
    // DEPOSIT - Choose payment method
    if (data.startsWith('dep_stripe_')) {
      const depUserId = parseInt(data.split('_')[2]);
      if (depUserId !== userId) {
        return bot.answerCallbackQuery(query.id, { text: 'Not your button!', show_alert: true });
      }
      
      bot.editMessageText(`💳 Select amount:`, {
        chat_id: chatId,
        message_id: query.message.message_id,
        reply_markup: {
          inline_keyboard: [
            [{ text: '$5', callback_data: `stripe_amt_5_${userId}` }],
            [{ text: '$10', callback_data: `stripe_amt_10_${userId}` }],
            [{ text: '$25', callback_data: `stripe_amt_25_${userId}` }],
            [{ text: '$50', callback_data: `stripe_amt_50_${userId}` }],
            [{ text: '$100', callback_data: `stripe_amt_100_${userId}` }]
          ]
        }
      });
    }
    
    if (data.startsWith('dep_paypal_')) {
      const depUserId = parseInt(data.split('_')[2]);
      if (depUserId !== userId) {
        return bot.answerCallbackQuery(query.id, { text: 'Not your button!', show_alert: true });
      }
      
      bot.editMessageText(`🅿️ Select amount:`, {
        chat_id: chatId,
        message_id: query.message.message_id,
        reply_markup: {
          inline_keyboard: [
            [{ text: '$5', callback_data: `paypal_amt_5_${userId}` }],
            [{ text: '$10', callback_data: `paypal_amt_10_${userId}` }],
            [{ text: '$25', callback_data: `paypal_amt_25_${userId}` }],
            [{ text: '$50', callback_data: `paypal_amt_50_${userId}` }],
            [{ text: '$100', callback_data: `paypal_amt_100_${userId}` }]
          ]
        }
      });
    }
    
    // STRIPE AMOUNT selected
    if (data.startsWith('stripe_amt_')) {
      const parts = data.split('_');
      const amount = parseInt(parts[2]);
      const depUserId = parseInt(parts[3]);
      
      if (depUserId !== userId) {
        return bot.answerCallbackQuery(query.id, { text: 'Not your button!', show_alert: true });
      }
      
      bot.sendMessage(chatId,
        `💳 Deposit $${amount}\n\n<a href="https://dice-rush-production.up.railway.app/stripe-checkout.html?userId=${userId}&amount=${amount}&chatId=${chatId}">Complete Payment</a>`,
        { parse_mode: 'HTML' }
      );
    }
    
    // PAYPAL AMOUNT selected
    if (data.startsWith('paypal_amt_')) {
      const parts = data.split('_');
      const amount = parseInt(parts[2]);
      const depUserId = parseInt(parts[3]);
      
      if (depUserId !== userId) {
        return bot.answerCallbackQuery(query.id, { text: 'Not your button!', show_alert: true });
      }
      
      bot.sendMessage(chatId,
        `🅿️ Deposit $${amount}\n\n<a href="https://dice-rush-production.up.railway.app/paypal-checkout.html?userId=${userId}&amount=${amount}&chatId=${chatId}">Complete Payment</a>`,
        { parse_mode: 'HTML' }
      );
    }
    
    // PLAY - Game bet selected
    if (data.startsWith('play_bet_')) {
      const parts = data.split('_');
      const bet = parseInt(parts[2]);
      const gameUserId = parseInt(parts[3]);
      
      if (gameUserId !== userId) {
        return bot.answerCallbackQuery(query.id, { text: 'Not your game!', show_alert: true });
      }
      
      const wallet = getBalance(userId);
      if (wallet.balance < bet) {
        bot.sendMessage(chatId, `❌ Insufficient balance! Need $${bet}, have $${wallet.balance.toFixed(2)}`);
        return;
      }
      
      const playerRoll = Math.floor(Math.random() * 6) + 1;
      const botRoll = Math.floor(Math.random() * 6) + 1;
      
      let result = '';
      if (playerRoll > botRoll) {
        result = `🎉 YOU WIN! +$${bet * 2}`;
        updateBalance(userId, bet, 'subtract');
        updateBalance(userId, bet * 2, 'win');
      } else if (playerRoll < botRoll) {
        result = `❌ YOU LOST -$${bet}`;
        updateBalance(userId, bet, 'subtract');
      } else {
        result = `🤝 TIE! Money back`;
        updateBalance(userId, bet, 'add');
      }
      
      const wallet2 = getBalance(userId);
      bot.sendMessage(chatId,
        `🎲 Your: ${playerRoll} | Bot: ${botRoll}\n\n${result}\nNew balance: $${wallet2.balance.toFixed(2)}`,
        { parse_mode: 'HTML' }
      );
    }
    
    // Button clicks
    if (data === 'btn_deposit') {
      bot.sendMessage(chatId, `💳 Choose:`, { 
        reply_markup: {
          inline_keyboard: [
            [{ text: '💳 Stripe', callback_data: `dep_stripe_${userId}` }],
            [{ text: '🅿️ PayPal', callback_data: `dep_paypal_${userId}` }]
          ]
        }
      });
    }
    
    if (data === 'btn_play') {
      bot.sendMessage(chatId, `🎲 Select bet:`, { 
        reply_markup: {
          inline_keyboard: [
            [{ text: '$1', callback_data: `play_bet_1_${userId}` }],
            [{ text: '$5', callback_data: `play_bet_5_${userId}` }],
            [{ text: '$10', callback_data: `play_bet_10_${userId}` }],
            [{ text: '$25', callback_data: `play_bet_25_${userId}` }]
          ]
        }
      });
    }
    
    if (data === 'btn_balance') {
      const wallet = getBalance(userId);
      bot.sendMessage(chatId, `💰 Balance: $${wallet.balance.toFixed(2)}`);
    }
    
  } catch (error) {
    console.error('❌ Callback error:', error.message);
    bot.sendMessage(chatId, '❌ Error');
  }
});

// ==================== SERVER ====================

app.get('/health', (req, res) => {
  res.json({ status: 'Running!' });
});

bot.on('polling_error', (error) => {
  console.error('❌ Polling error:', error.message);
});

app.listen(PORT, () => {
  console.log(`🚀 DICE RUSH Bot on port ${PORT}`);
  console.log(`✅ Telegram bot is listening...`);
});
