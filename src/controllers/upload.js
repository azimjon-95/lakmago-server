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

    /*
     * XAVFSIZLIK (2026-08 audit): faqat rasm formatlariga ruxsat.
     *
     * Bu qiymat IMZOGA kiritiladi — Cloudinary signed so'rovda
     * BARCHA imzolangan parametrlar aynan bir xil qiymat bilan
     * qaytarilishini talab qiladi. Demak frontend buni chetlab
     * o'ta olmaydi: agar boshqa formatni yuborsa yoki bu
     * parametrni o'zgartirsa/olib tashlasa, Cloudinary imzoni
     * "noto'g'ri" deb rad etadi.
     *
     * Fayl HAJMI chegarasi Cloudinary hisobingizning "Upload
     * presets" sozlamalarida (dashboard) alohida o'rnatilishi
     * kerak — signed so'rov parametrlari orqali bu cheklanmaydi.
     */
    const allowedFormats = 'jpg,jpeg,png,webp';

    // Cloudinary imzo qoidasi: parametrlarni alifbo tartibida, secret bilan SHA-1
    const params = { allowed_formats: allowedFormats, folder, timestamp };
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
      allowedFormats,
      signature,
    });
  }),
};
