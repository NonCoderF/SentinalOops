/**
 * Development recovery targets. RECOVERY_ALLOWED_SERVICES is preferred, but
 * the singular variable remains supported for existing installations.
 */
export function allowedRecoveryServices(): string[] {
  const configured = process.env.RECOVERY_ALLOWED_SERVICES ?? process.env.RECOVERY_ALLOWED_SERVICE ?? 'test-service';
  return [...new Set(configured.split(',').map((value) => value.trim()).filter((value) => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value)))];
}

export function isAllowedRecoveryService(service: string): boolean {
  return allowedRecoveryServices().includes(service);
}

export function normalizeRecoveryService(service: string): string {
  const value = service.trim();
  if (value === 'Test Service' || value === 'localhost') return 'test-service';
  return value;
}
