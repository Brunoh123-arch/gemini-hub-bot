const MP_BASE_URL = 'https://api.mercadopago.com';

/**
 * Cria uma cobrança Pix automática via Mercado Pago Payments API.
 */
export async function createMercadoPagoPix({
  accessToken,
  amountCents,
  description,
  externalReference,
  payerEmail = 'cliente@geminihub.store',
  payerFirstName = 'Cliente',
  expirationMinutes = 30,
}) {
  if (!accessToken) {
    throw new Error('MERCADOPAGO_ACCESS_TOKEN não configurado.');
  }

  const expiresAtDate = new Date(Date.now() + expirationMinutes * 60 * 1000);
  const body = {
    transaction_amount: Number((amountCents / 100).toFixed(2)),
    description: String(description || 'Recarga de saldo Gemini Hub').slice(0, 120),
    payment_method_id: 'pix',
    external_reference: String(externalReference),
    date_of_expiration: expiresAtDate.toISOString(),
    payer: {
      email: payerEmail,
      first_name: String(payerFirstName || 'Cliente').slice(0, 60),
    },
  };

  const response = await fetch(`${MP_BASE_URL}/v1/payments`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': String(externalReference),
    },
    body: JSON.stringify(body),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data?.message || data?.cause?.[0]?.description || `HTTP ${response.status}`;
    throw new Error(`Mercado Pago erro ao criar Pix: ${detail}`);
  }

  const txData = data?.point_of_interaction?.transaction_data || {};
  if (!txData.qr_code) {
    throw new Error('Mercado Pago não retornou o código Pix Copia e Cola.');
  }

  return {
    providerPaymentId: String(data.id),
    status: data.status || 'pending',
    qrCode: txData.qr_code,
    qrCodeBase64: txData.qr_code_base64 || null,
    ticketUrl: txData.ticket_url || null,
    expiresAt: data.date_of_expiration || expiresAtDate.toISOString(),
  };
}

/**
 * Consulta o status atual de uma cobrança Pix no Mercado Pago.
 */
export async function getMercadoPagoPaymentStatus({ accessToken, providerPaymentId }) {
  if (!accessToken || !providerPaymentId) {
    throw new Error('Parâmetros inválidos para consultar pagamento no Mercado Pago.');
  }

  const response = await fetch(`${MP_BASE_URL}/v1/payments/${encodeURIComponent(providerPaymentId)}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data?.message || `HTTP ${response.status}`;
    throw new Error(`Mercado Pago erro ao consultar status: ${detail}`);
  }

  return {
    status: data.status, // 'pending', 'approved', 'rejected', 'cancelled', 'expired'
    statusDetail: data.status_detail || '',
    paidAt: data.date_approved || null,
  };
}
