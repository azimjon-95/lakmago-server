import { config } from '../config/index.js';
import { User } from '../models/User.js';

// Server ishga tushganda default admin (dastur egasi) akkauntini
// .env dagi ADMIN_LOGIN / ADMIN_PASSWORD asosida yaratadi (agar mavjud bo'lmasa).
export async function ensureDefaultAdmin() {
  const login = config.adminLogin.toLowerCase().trim();
  const existing = await User.findOne({ login, role: 'admin' });

  if (!existing) {
    await User.create({
      login,
      passwordHash: User.hashPassword(config.adminPassword),
      role: 'admin',
      firstName: 'Administrator',
      isActive: true,
    });
    console.log(`✓ Default admin yaratildi — login: "${login}"`);
  } else {
    // Parolni .env bilan sinxron ushlab turamiz (parol o'zgartirilsa yangilanadi)
    existing.passwordHash = User.hashPassword(config.adminPassword);
    await existing.save();
    console.log(`✓ Admin akkaunti tayyor — login: "${login}"`);
  }
}
