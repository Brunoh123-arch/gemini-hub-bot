const brlFormatter = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
});

export function formatBRL(cents) {
  const safe = Number.isFinite(Number(cents)) ? Number(cents) : 0;
  return brlFormatter.format(safe / 100);
}

/**
 * Converte strings como "15", "15,90", "15.90", "R$ 1.250,50" em centavos inteiros.
 * Retorna null se inválido ou <= 0.
 */
export function parseBRLToCents(input) {
  if (input === null || input === undefined) return null;
  let str = String(input).trim().replace(/^R\$\s*/i, '').replace(/\s+/g, '');
  if (!str) return null;

  if (str.includes('.') && str.includes(',')) {
    str = str.replace(/\./g, '').replace(',', '.');
  } else if (str.includes(',')) {
    str = str.replace(',', '.');
  }

  if (!/^\d+(\.\d{1,2})?$/.test(str)) {
    return null;
  }

  const value = Number(str);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 100);
}

export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatDateBR(dateValue) {
  if (!dateValue) return '-';
  const date =
    dateValue instanceof Date
      ? dateValue
      : new Date(String(dateValue).includes('T') ? dateValue : String(dateValue).replace(' ', 'T') + 'Z');

  if (Number.isNaN(date.getTime())) return String(dateValue);

  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function truncate(str, maxLength = 32) {
  const s = String(str ?? '');
  if (s.length <= maxLength) return s;
  return `${s.slice(0, Math.max(1, maxLength - 1))}…`;
}

/**
 * Nome amigável mesmo quando o cliente usa "." ou caracteres curtos no perfil do Telegram.
 */
export function formatDisplayName(user) {
  const rawFirst = String(user?.first_name || '').trim();
  const hasReadableName = /[A-Za-zÀ-ÿ0-9]{2,}/.test(rawFirst);
  if (hasReadableName) {
    return escapeHtml(rawFirst);
  }
  if (user?.username) {
    return `@${escapeHtml(user.username)}`;
  }
  return escapeHtml(rawFirst || 'Cliente');
}

export function formatUserLabel(user) {
  const display = formatDisplayName(user);
  const handle = user?.username && !display.startsWith('@') ? ` (@${escapeHtml(user.username)})` : '';
  return `${display}${handle}`;
}

/**
 * Calcula nível VIP e % de cashback automático conforme o total investido na loja.
 */
export function getVipTier(totalSpentCents = 0) {
  const spent = Number(totalSpentCents || 0);
  if (spent >= 30000) {
    return { name: 'VIP Ultra', badge: '💎', cashbackPct: 8, nextTierCents: null };
  }
  if (spent >= 15000) {
    return { name: 'VIP Ouro', badge: '🥇', cashbackPct: 6, nextTierCents: 30000 };
  }
  if (spent >= 5000) {
    return { name: 'VIP Prata', badge: '🥈', cashbackPct: 4, nextTierCents: 15000 };
  }
  return { name: 'Membro', badge: '🔹', cashbackPct: 2, nextTierCents: 5000 };
}

export function renderStars(rating = 5) {
  const r = Math.max(1, Math.min(5, Math.round(Number(rating) || 5)));
  return '⭐'.repeat(r);
}
