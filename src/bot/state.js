/**
 * Gerenciador leve em memória para fluxos conversacionais multi-etapas
 * e cupom de desconto ativo na sessão do cliente.
 */
const sessions = new Map();

export function getSession(userId) {
  const id = Number(userId);
  if (!sessions.has(id)) {
    sessions.set(id, {
      step: null,
      data: {},
      activeDiscountCoupon: null,
    });
  }
  return sessions.get(id);
}

export function setStep(userId, step, data = {}) {
  const session = getSession(userId);
  session.step = step;
  session.data = { ...data };
}

export function clearStep(userId) {
  const session = getSession(userId);
  session.step = null;
  session.data = {};
}

export function setActiveDiscountCoupon(userId, couponCode) {
  const session = getSession(userId);
  session.activeDiscountCoupon = couponCode ? String(couponCode).toUpperCase() : null;
}

export function getActiveDiscountCoupon(userId) {
  return getSession(userId).activeDiscountCoupon;
}
