// Importing necessary modules
import OpenAI from "openai";
import TelegramBot from "node-telegram-bot-api";
import config from "./config.json" assert {type: 'json'};

// Setting up the Telegram bot using the token from the config file
const token = config.telegram_token;
const bot = new TelegramBot(token, {polling: true});
const isBotBusy = new Map();
// Initializing the OpenAI API with the token from the config file
const openai = new OpenAI({
  apiKey: config.openai_token,
  baseURL: config.baseURL || `https://api.openai.com/v1`
});

// Creating a new Map to store the last messages for each chat
const lastMessages = new Map();

function splitMessage(message, maxLength) {
  const chunks = [];
  let remainingMessage = message;

  while (remainingMessage.length > 0) {
    let chunk;

    if (remainingMessage.length <= maxLength) {
      chunk = remainingMessage;
      remainingMessage = '';
    } else {
      let splitIndex = maxLength;

      // Ищем ближайший перенос строки или тег внутри текущей части
      const newlineIndex = remainingMessage.lastIndexOf('\n', maxLength);
      const codeBlockIndex = remainingMessage.lastIndexOf('```', maxLength);

      // Выбираем наибольший индекс, чтобы не разрывать теги или переносы строк
      splitIndex = Math.max(splitIndex, newlineIndex, codeBlockIndex);

      chunk = remainingMessage.slice(0, splitIndex + 1);
      remainingMessage = remainingMessage.slice(splitIndex + 1);
    }

    chunks.push(chunk);
  }

  // Проверяем и корректируем теги Markdown после разбиения на части
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];

    const codeBlockCount = (chunk.match(/```/g) || []).length;

    if (codeBlockCount % 2 !== 0) {
      chunks[i] += '```';
      if (i < chunks.length - 1) {
        chunks[i + 1] = '```' + chunks[i + 1];
      }
    }
  }

  return chunks;
}

// Setting up a listener for incoming messages
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userMessage = msg.text;
  const userName = msg.from.username;

  if (msg.document || msg.photo || msg.sticker || msg.video || msg.audio || msg.voice) {
    // If the message contains unsupported content, send a message about unsupported message types
    await bot.sendMessage(chatId, config.unsupported_message_type);
    return;
  }

  if (!userMessage) {
    // If the message doesn't contain text, ignore it
    await bot.sendMessage(chatId, config.unsupported_message_type);
    return;
  }

  if (isBotBusy.get(chatId)) {
    await bot.sendMessage(chatId, config.is_bot_busy_message);
    return;
  }

  let typing;
  try {
    if(config.allowed_users.length && !config.allowed_users.includes(userName)){
      await bot.sendMessage(chatId, config.forbidden_message);
      return;
    }
    // Check if the message is '/start'
    if (userMessage === '/start') {
      // Send a welcome message
      await bot.sendMessage(chatId, config.welcome_message);
      return;
    }
    // If the message is '/reset', it clears the chat history and sends a message to the user
    if (userMessage === '/reset') {
      lastMessages.set(chatId, []);
      await bot.sendMessage(chatId, config.clear_context_message);
      return;
    }

    // If the chat history for the current chat does not exist, it creates an empty array for it
    if (!lastMessages.has(chatId)) {
      lastMessages.set(chatId, []);
    }

    // Adds the user's message to the chat history
    lastMessages.get(chatId).push({role: "user", content: userMessage});

    // If the chat history is longer than 20 messages, it removes the oldest message
    if (lastMessages.get(chatId).length > 20) {
      lastMessages.get(chatId).shift();
    }

    // Sends a typing action to the user to indicate that the bot is working on a response
    await bot.sendChatAction(chatId, 'typing');
    typing = setInterval(() => {
      bot.sendChatAction(chatId, 'typing');
    }, 5000)

    isBotBusy.set(chatId, true);
    // Sends a request to the OpenAI API to generate a response based on the chat history
    const completion = await openai.chat.completions.create({
      messages: [
        {role: "system", content: config.bot_personalize},
        ...lastMessages.get(chatId),
      ],
      model: config.model,
    });

    // Extracts the bot's response from the OpenAI API response
    const botResponse = completion.choices[0].message.content;

    // Разбиваем ответ бота на части с помощью функции splitMessage
    const messageParts = splitMessage(botResponse, 4096);

    // Отправляем каждую часть ответа бота с форматированием Markdown
    for (const part of messageParts) {
      lastMessages.get(chatId).push({ role: "assistant", content: part });
      await bot.sendMessage(chatId, part, {parse_mode: 'Markdown'});
    }

    clearInterval(typing);
    isBotBusy.set(chatId, false);
  } catch (error) {
    console.error(`An error occurred: ${error.message}`);
    // You can also send an error message to the user here
    await bot.sendMessage(chatId, config.error_message);
    isBotBusy.set(chatId, false);
    clearInterval(typing)
  }
});