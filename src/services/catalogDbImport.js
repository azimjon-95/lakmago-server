import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CatalogSeedCategory } from '../models/CatalogSeedCategory.js';
import { CatalogSeedGroup } from '../models/CatalogSeedGroup.js';
import { CatalogAsset } from '../models/CatalogAsset.js';

/*
 * DO'KON KATALOGINI DB GA YUKLASH (idempotent).
 * Manba: seed/catalog/{categories,groups}.json va seed/catalog-groups/*.webp (repo ichida).
 * Mavjud yozuvlarga TEGMAYDI ($setOnInsert): admin keyin o'zgartirgan nom/tartib saqlanadi.
 * Qaytaradi: { categories, groups, assets } — yangi qo'shilganlar soni.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEED = path.resolve(HERE, '..', '..', 'seed');

export async function importCatalogToDb({ seedDir = SEED } = {}) {
  const cats = JSON.parse(fs.readFileSync(path.join(seedDir, 'catalog', 'categories.json'), 'utf8'));
  const groups = JSON.parse(fs.readFileSync(path.join(seedDir, 'catalog', 'groups.json'), 'utf8'));
  const imgDir = path.join(seedDir, 'catalog-groups');
  const files = fs.existsSync(imgDir) ? fs.readdirSync(imgDir).filter((f) => f.endsWith('.webp')) : [];

  let categories = 0; let groupsN = 0; let assets = 0;
  for (const c of cats) {
    const r = await CatalogSeedCategory.updateOne({ key: c.key }, { $setOnInsert: { ...c, nameUzc: c.nameUzc || '', nameRu: c.nameRu || '', isActive: true } }, { upsert: true });
    if (r.upsertedCount) categories += 1;
  }
  for (const g of groups) {
    const r = await CatalogSeedGroup.updateOne({ id: g.id }, { $setOnInsert: { ...g, coverAsset: g.cover ? `${g.cover}@720.webp` : '' } }, { upsert: true });
    if (r.upsertedCount) groupsN += 1;
  }
  for (const f of files) {
    const data = fs.readFileSync(path.join(imgDir, f));
    const r = await CatalogAsset.updateOne({ name: f }, { $setOnInsert: { name: f, mime: 'image/webp', bytes: data.length, data } }, { upsert: true });
    if (r.upsertedCount) assets += 1;
  }
  return { categories, groups: groupsN, assets };
}
