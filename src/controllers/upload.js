import crypto from 'crypto';
import { asyncHandler } from '../middleware/error.js';
import { config } from '../config/index.js';

// Cloudinary'ga TO'G'RIDAN frontend'dan yuklash uchun imzo (signature) beradi.
// Muhim: API SECRET hech qachon frontendга yuborilmaydi — faqat imzo hisoblanadi.
// Bu Cloudinary token/trafikni tejaydi (rasm serverdan o'tmaydi, to'g'ridan Cloudinary'ga).

export const uploadController = {
  // GET /api/upload/signature?folder=lokmago/dishes
  // Faqat autentifikatsiyalangan foydalanuvchi (restoran/admin) so'raydi.
  signature: asyncHandler(async (req, res) => {
    const { cloudName, apiKey, apiSecret } = config.cloudinary;
    if (!cloudName || !apiKey || !apiSecret) {
      return res.status(503).json({ error: 'Cloudinary sozlanmagan (env)' });
    }

    // Papka — taom yoki banner uchun ajratamiz (tartib uchun)
    const folder = req.query.folder === 'banners' ? 'lokmago/banners' : 'lokmago/dishes';
    const timestamp = Math.round(Date.now() / 1000);

    // Cloudinary imzo qoidasi: parametrlarni alifbo tartibida, secret bilan SHA-1
    const params = { folder, timestamp };
    const toSign = Object.keys(params)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join('&');
    const signature = crypto
      .createHash('sha1')
      .update(toSign + apiSecret)
      .digest('hex');

    // Frontend shu ma'lumotlar bilan to'g'ridan Cloudinary'ga POST qiladi
    res.json({
      cloudName,
      apiKey,
      timestamp,
      folder,
      signature,
    });
  }),
};
