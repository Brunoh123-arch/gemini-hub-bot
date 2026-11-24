import fs from 'node:fs';
import { InputFile } from 'grammy';
import { config } from '../config.js';

// Cacheia file_id do Telegram após o primeiro envio para trocas instantâneas de tela
const bannerFileIdCache = new Map();
const messageBannerMap = new Map();

/**
 * Responde callbackQueries sem nunca estourar erro caso o clique seja antigo (ex: após reinício).
 */
export async function safeAnswer(ctx, options = undefined) {
  if (!ctx?.callbackQuery) return;
  try {
    await ctx.answerCallbackQuery(options);
  } catch {
    // ignora 'query is too old' com segurança
  }
}

function resolveBannerPath(bannerType) {
  if (bannerType === 'home') return config.bannerHomePath;
  if (bannerType === 'catalog') return config.bannerCatalogPath;
  return null;
}

function getMediaInput(filePath) {
  if (bannerFileIdCache.has(filePath)) {
    return bannerFileIdCache.get(filePath);
  }
  return new InputFile(filePath);
}

function rememberFileId(filePath, sentMessage) {
  const photos = sentMessage?.photo;
  if (Array.isArray(photos) && photos.length > 0) {
    const bestPhoto = photos[photos.length - 1];
    if (bestPhoto?.file_id) {
      bannerFileIdCache.set(filePath, bestPhoto.file_id);
    }
  }
}

/**
 * Renderiza uma tela no Telegram com suporte fluido aos banners oficiais da Gemini Hub.
 */
export async function renderScreen(ctx, { text, keyboard, bannerType = null, forceNew = false }) {
  const bannerPath = bannerType ? resolveBannerPath(bannerType) : null;
  const canUseBanner = Boolean(bannerPath && fs.existsSync(bannerPath) && text.length <= 990);
  const callbackMsg = ctx.callbackQuery?.message;

  if (forceNew || !callbackMsg) {
    if (canUseBanner) {
      const sent = await ctx.replyWithPhoto(getMediaInput(bannerPath), {
        caption: text,
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
      rememberFileId(bannerPath, sent);
      messageBannerMap.set(`${sent.chat.id}:${sent.message_id}`, bannerType);
      return sent;
    }

    return ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
      link_preview_options: { is_disabled: true },
    });
  }

  const msgKey = `${callbackMsg.chat.id}:${callbackMsg.message_id}`;
  const isCurrentPhoto = Array.isArray(callbackMsg.photo) && callbackMsg.photo.length > 0;

  if (canUseBanner) {
    if (isCurrentPhoto) {
      const previousBanner = messageBannerMap.get(msgKey);
      try {
        if (previousBanner === bannerType) {
          await ctx.editMessageCaption({
            caption: text,
            parse_mode: 'HTML',
            reply_markup: keyboard,
          });
          return callbackMsg;
        }

        const edited = await ctx.editMessageMedia(
          {
            type: 'photo',
            media: getMediaInput(bannerPath),
            caption: text,
            parse_mode: 'HTML',
          },
          { reply_markup: keyboard }
        );
        rememberFileId(bannerPath, edited);
        messageBannerMap.set(msgKey, bannerType);
        return edited;
      } catch (err) {
        if (String(err?.description || '').includes('message is not modified')) {
          return callbackMsg;
        }
      }
    }

    await ctx.deleteMessage().catch(() => {});
    const sent = await ctx.replyWithPhoto(getMediaInput(bannerPath), {
      caption: text,
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
    rememberFileId(bannerPath, sent);
    messageBannerMap.set(`${sent.chat.id}:${sent.message_id}`, bannerType);
    return sent;
  }

  if (!isCurrentPhoto) {
    try {
      return await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
        link_preview_options: { is_disabled: true },
      });
    } catch (err) {
      if (String(err?.description || '').includes('message is not modified')) {
        return callbackMsg;
      }
    }
  }

  await ctx.deleteMessage().catch(() => {});
  return ctx.reply(text, {
    parse_mode: 'HTML',
    reply_markup: keyboard,
    link_preview_options: { is_disabled: true },
  });
}
