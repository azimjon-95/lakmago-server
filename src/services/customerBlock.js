/*
 * Bloklangan mijozga yagona javob: kod + mijozga ko'rsatiladigan sabab
 * (admin qarorida yozilgan — services/customerIncidents.js). Mijoz ilovasi
 * USER_BLOCKED kodini ko'rib, butun ekranli "Hisob bloklangan" oynasini chiqaradi.
 */
export function blockedPayload(user) {
  const reason = user?.blockInfo?.reason || '';
  return {
    error: reason ? `Hisobingiz bloklangan: ${reason}` : 'Akkauntingiz bloklangan',
    code: 'USER_BLOCKED',
    reason,
    blockedAt: user?.blockInfo?.at || null,
  };
}
