import QRCode from 'qrcode';

/**
 * Remove acentos e caracteres fora do padrão ASCII exigido pelo EMV/BACEN Pix.
 */
function sanitizeAscii(str, maxLength) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9 @._-]/g, '')
    .trim()
    .slice(0, maxLength);
}

function sanitizeTxId(txid) {
  const cleaned = String(txid || '')
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 25);
  return cleaned || '***';
}

function tlv(id, value) {
  const str = String(value);
  const len = String(Buffer.byteLength(str, 'utf8')).padStart(2, '0');
  return `${id}${len}${str}`;
}

/**
 * Calcula CRC16-CCITT (polinômio 0x1021, inicial 0xFFFF) padrão oficial BACEN Pix.
 */
export function computeCrc16Ccitt(payload) {
  let crc = 0xffff;
  const bytes = Buffer.from(payload, 'utf8');

  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }

  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * Valida a integridade do CRC16 de um código Pix Copia e Cola.
 */
export function verifyPixPayloadCrc(payload) {
  if (!payload || payload.length < 8) return false;
  const body = payload.slice(0, -4);
  const providedCrc = payload.slice(-4).toUpperCase();
  return computeCrc16Ccitt(body) === providedCrc;
}

/**
 * Gera um BR Code Pix oficial (padrão EMVCo / Banco Central do Brasil).
 */
export function generatePixPayload({
  pixKey,
  merchantName = 'GEMINI HUB DIGITAL',
  merchantCity = 'SAO PAULO',
  amountCents = 0,
  txid = '***',
  description = '',
}) {
  const cleanKey = String(pixKey || '').trim();
  if (!cleanKey) {
    throw new Error('PIX_KEY não configurada.');
  }

  const cleanName = (sanitizeAscii(merchantName, 25) || 'GEMINI HUB').toUpperCase();
  const cleanCity = (sanitizeAscii(merchantCity, 15) || 'SAO PAULO').toUpperCase();
  const cleanTxId = sanitizeTxId(txid);
  const cleanDesc = sanitizeAscii(description, 40);

  let merchantAccountInfo = tlv('00', 'br.gov.bcb.pix') + tlv('01', cleanKey);
  if (cleanDesc) {
    merchantAccountInfo += tlv('02', cleanDesc);
  }

  let payload = '';
  payload += tlv('00', '01'); // Payload Format Indicator
  payload += tlv('26', merchantAccountInfo); // Merchant Account Information (Pix)
  payload += tlv('52', '0000'); // Merchant Category Code
  payload += tlv('53', '986'); // Currency BRL

  if (amountCents && amountCents > 0) {
    payload += tlv('54', (amountCents / 100).toFixed(2));
  }

  payload += tlv('58', 'BR'); // Country Code
  payload += tlv('59', cleanName);
  payload += tlv('60', cleanCity);
  payload += tlv('62', tlv('05', cleanTxId)); // Additional Data Field (TXID)
  payload += '6304'; // CRC16 tag + length

  return payload + computeCrc16Ccitt(payload);
}

/**
 * Gera um buffer PNG de QR Code nítido para envio direto no Telegram.
 */
export async function generatePixQrCodeBuffer(pixPayload) {
  return QRCode.toBuffer(pixPayload, {
    type: 'png',
    width: 512,
    margin: 2,
    errorCorrectionLevel: 'M',
    color: {
      dark: '#090E22',
      light: '#FFFFFF',
    },
  });
}
