/**
 * Normalizes a human-entered phone number (e.g. "010 15678913", "+201204457813")
 * into digits-only international format suitable for WhatsApp Web JIDs.
 */
export function normalizeWhatsAppDigits(rawInput: string, defaultCountryCode = '20'): string {
  const trimmed = rawInput.trim();
  const hasPlus = trimmed.startsWith('+');
  let digits = trimmed.replace(/\D/g, '');
  const cleanCountry = defaultCountryCode.replace(/\D/g, '') || '20';

  if (!digits) {
    return '';
  }

  // Handle international 00 prefix (e.g., 002010...)
  if (digits.startsWith('00')) {
    digits = digits.slice(2);
    return digits;
  }

  // If user explicitly provided +<country>..., trust digits directly
  if (hasPlus) {
    return digits;
  }

  // If number starts with single leading 0 (local national format like 01015678913 or 01204457813)
  if (digits.startsWith('0')) {
    return `${cleanCountry}${digits.slice(1)}`;
  }

  // If already starts with country code or is full international digits
  return digits;
}

export function toWhatsAppJid(rawInput: string, defaultCountryCode = '20'): string {
  const digits = normalizeWhatsAppDigits(rawInput, defaultCountryCode);
  if (!digits) {
    throw new Error('Invalid WhatsApp phone number');
  }
  return `${digits}@c.us`;
}

export function isValidPhoneInput(rawInput: string): boolean {
  const digits = rawInput.replace(/\D/g, '');
  return digits.length >= 8 && digits.length <= 15;
}

export function maskPhone(phone: string): string {
  const clean = phone.trim();
  if (clean.length <= 4) return '****';
  return `${clean.slice(0, 3)}****${clean.slice(-2)}`;
}
