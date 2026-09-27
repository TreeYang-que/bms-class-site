export function internalTestUsers(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === 'string' && id.length > 0))] : [];
}

export function hasDailyPracticeAccess(settings: { enabled: boolean; internalTestUserIds?: unknown } | null, userId?: string) {
  return Boolean(settings?.enabled || (userId && internalTestUsers(settings?.internalTestUserIds).includes(userId)));
}
