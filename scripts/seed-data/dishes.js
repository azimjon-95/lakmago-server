// Kategoriya bo'yicha taom shablonlari.
// Har restoran o'z kategoriyasidan menyu oladi (nom, narx, tavsif, bo'lim).

export const DISH_TEMPLATES = {
  milliy: [
    { section: 'Asosiy taomlar', name: 'To\'y oshi', price: 45000, weightGram: 450, calories: 620, description: 'Devzira guruch, mol go\'shti, sabzi va no\'xat bilan' },
    { section: 'Asosiy taomlar', name: 'Chayonli osh', price: 38000, weightGram: 400, calories: 580, description: 'An\'anaviy usulda tayyorlangan osh' },
    { section: 'Asosiy taomlar', name: 'Norin', price: 35000, weightGram: 350, calories: 480, description: 'Qo\'l bilan kesilgan xamir, go\'sht' },
    { section: 'Asosiy taomlar', name: 'Lag\'mon', price: 32000, weightGram: 400, calories: 520, description: 'Qo\'lda cho\'zilgan lag\'mon, sabzavotlar bilan' },
    { section: 'Asosiy taomlar', name: 'Mastava', price: 28000, weightGram: 350, calories: 390, description: 'Guruchli sho\'rva, mol go\'shti' },
    { section: 'Somsa va manti', name: 'Tandir somsa', price: 12000, weightGram: 150, calories: 320, description: 'Tandirda pishirilgan, go\'shtli' },
    { section: 'Somsa va manti', name: 'Manti (5 dona)', price: 30000, weightGram: 400, calories: 560, description: 'Bug\'da pishirilgan, go\'sht va piyoz' },
    { section: 'Somsa va manti', name: 'Chuchvara', price: 26000, weightGram: 350, calories: 420, description: 'Sho\'rvada, smetana bilan' },
    { section: 'Salatlar', name: 'Achchiq-chuchuk', price: 15000, weightGram: 200, calories: 90, description: 'Pomidor, piyoz, ko\'katlar' },
    { section: 'Salatlar', name: 'Olivye', price: 18000, weightGram: 250, calories: 280, description: 'Klassik retsept' },
    { section: 'Ichimliklar', name: 'Ko\'k choy', price: 8000, weightGram: 500, description: 'Bir choynak' },
    { section: 'Ichimliklar', name: 'Ayron', price: 10000, weightGram: 400, calories: 120, description: 'Uy sharoitida tayyorlangan' },
  ],

  osh: [
    { section: 'Osh turlari', name: 'Devzira osh', price: 48000, weightGram: 450, calories: 650, description: 'Devzira guruch, mol go\'shti' },
    { section: 'Osh turlari', name: 'Chayonli osh', price: 42000, weightGram: 420, calories: 600, description: 'An\'anaviy usul' },
    { section: 'Osh turlari', name: 'Qo\'y go\'shtli osh', price: 55000, weightGram: 450, calories: 720, description: 'Qo\'y go\'shti bilan' },
    { section: 'Osh turlari', name: 'Bedana oshi', price: 62000, weightGram: 400, calories: 580, description: 'Bedana go\'shti bilan' },
    { section: 'Qo\'shimchalar', name: 'Achchiq-chuchuk', price: 15000, weightGram: 200, calories: 90, description: 'Osh bilan' },
    { section: 'Qo\'shimchalar', name: 'Non (1 dona)', price: 5000, weightGram: 300, description: 'Tandir non' },
    { section: 'Ichimliklar', name: 'Ko\'k choy', price: 8000, weightGram: 500 },
    { section: 'Ichimliklar', name: 'Qora choy', price: 8000, weightGram: 500 },
  ],

  choyxona: [
    { section: 'Choy', name: 'Ko\'k choy', price: 8000, weightGram: 500, description: 'Bir choynak' },
    { section: 'Choy', name: 'Qora choy', price: 8000, weightGram: 500 },
    { section: 'Choy', name: 'Limonli choy', price: 12000, weightGram: 500, description: 'Asal va limon bilan' },
    { section: 'Taomlar', name: 'Somsa', price: 12000, weightGram: 150, calories: 320 },
    { section: 'Taomlar', name: 'Osh', price: 38000, weightGram: 400, calories: 580 },
    { section: 'Taomlar', name: 'Sho\'rva', price: 25000, weightGram: 350, calories: 320 },
    { section: 'Shirinliklar', name: 'Halva', price: 15000, weightGram: 200, calories: 480 },
    { section: 'Shirinliklar', name: 'Parvarda', price: 12000, weightGram: 150, calories: 420 },
  ],

  shashlik: [
    { section: 'Shashlik', name: 'Mol go\'shti shashlik', price: 25000, weightGram: 150, calories: 380, description: '1 sixcha' },
    { section: 'Shashlik', name: 'Qo\'y shashlik', price: 30000, weightGram: 150, calories: 420 },
    { section: 'Shashlik', name: 'Tovuq shashlik', price: 20000, weightGram: 150, calories: 280 },
    { section: 'Shashlik', name: 'Jigar shashlik', price: 22000, weightGram: 150, calories: 320 },
    { section: 'Shashlik', name: 'Qiyma shashlik', price: 24000, weightGram: 150, calories: 400 },
    { section: 'Kabob', name: 'Tandir kabob', price: 45000, weightGram: 300, calories: 620 },
    { section: 'Qo\'shimchalar', name: 'Achchiq-chuchuk', price: 15000, weightGram: 200, calories: 90 },
    { section: 'Qo\'shimchalar', name: 'Non', price: 5000, weightGram: 300 },
    { section: 'Ichimliklar', name: 'Coca-Cola 0.5', price: 10000, weightGram: 500 },
  ],

  fastfood: [
    { section: 'Lavash', name: 'Mol go\'shtli lavash', price: 32000, weightGram: 350, calories: 680, description: 'Mol go\'shti, sabzavot, sous' },
    { section: 'Lavash', name: 'Tovuqli lavash', price: 28000, weightGram: 350, calories: 620 },
    { section: 'Lavash', name: 'Mini lavash', price: 22000, weightGram: 250, calories: 450 },
    { section: 'Burger', name: 'Chizburger', price: 30000, weightGram: 250, calories: 560 },
    { section: 'Burger', name: 'Double burger', price: 42000, weightGram: 350, calories: 780 },
    { section: 'Kombo', name: 'Lavash kombo', price: 45000, weightGram: 600, calories: 950, description: 'Lavash + fri + ichimlik', oldPrice: 52000 },
    { section: 'Kombo', name: 'Burger kombo', price: 48000, weightGram: 600, calories: 1020, oldPrice: 56000 },
    { section: 'Garnir', name: 'Kartoshka fri', price: 15000, weightGram: 150, calories: 340 },
    { section: 'Garnir', name: 'Nagets (6 dona)', price: 22000, weightGram: 180, calories: 420 },
    { section: 'Ichimliklar', name: 'Pepsi 0.5', price: 10000, weightGram: 500 },
    { section: 'Ichimliklar', name: 'Choy', price: 6000, weightGram: 300 },
  ],

  lavash: [
    { section: 'Lavash', name: 'Mol go\'shtli lavash', price: 32000, weightGram: 350, calories: 680 },
    { section: 'Lavash', name: 'Tovuqli lavash', price: 28000, weightGram: 350, calories: 620 },
    { section: 'Lavash', name: 'Achchiq lavash', price: 34000, weightGram: 350, calories: 700 },
    { section: 'Shaurma', name: 'Klassik shaurma', price: 30000, weightGram: 400, calories: 720 },
    { section: 'Shaurma', name: 'Pishloqli shaurma', price: 35000, weightGram: 420, calories: 820 },
    { section: 'Kombo', name: 'Lavash + fri + Pepsi', price: 45000, weightGram: 650, calories: 1050, oldPrice: 52000 },
    { section: 'Garnir', name: 'Kartoshka fri', price: 15000, weightGram: 150, calories: 340 },
    { section: 'Ichimliklar', name: 'Pepsi 0.5', price: 10000, weightGram: 500 },
  ],

  burger: [
    { section: 'Burger', name: 'Chizburger', price: 30000, weightGram: 250, calories: 560 },
    { section: 'Burger', name: 'Double cheese', price: 45000, weightGram: 380, calories: 850 },
    { section: 'Burger', name: 'Chicken burger', price: 32000, weightGram: 260, calories: 520 },
    { section: 'Burger', name: 'BBQ burger', price: 38000, weightGram: 300, calories: 680 },
    { section: 'Garnir', name: 'Kartoshka fri', price: 15000, weightGram: 150, calories: 340 },
    { section: 'Garnir', name: 'Onion rings', price: 18000, weightGram: 140, calories: 380 },
    { section: 'Ichimliklar', name: 'Coca-Cola 0.5', price: 10000, weightGram: 500 },
  ],

  pitsa: [
    { section: 'Pitsa', name: 'Margarita', price: 45000, weightGram: 450, calories: 890, description: 'Pomidor, mosarella, rayhon' },
    { section: 'Pitsa', name: 'Pepperoni', price: 55000, weightGram: 480, calories: 1050 },
    { section: 'Pitsa', name: '4 pishloq', price: 58000, weightGram: 470, calories: 1120 },
    { section: 'Pitsa', name: 'Go\'shtli', price: 62000, weightGram: 520, calories: 1180 },
    { section: 'Pitsa', name: 'Tovuqli BBQ', price: 56000, weightGram: 500, calories: 1020 },
    { section: 'Pasta', name: 'Karbonara', price: 42000, weightGram: 350, calories: 680 },
    { section: 'Pasta', name: 'Bolonez', price: 40000, weightGram: 350, calories: 620 },
    { section: 'Ichimliklar', name: 'Coca-Cola 1L', price: 15000, weightGram: 1000 },
  ],

  sushi: [
    { section: 'Rollar', name: 'Filadelfiya', price: 65000, weightGram: 250, calories: 420, description: 'Losos, krem-pishloq, bodring' },
    { section: 'Rollar', name: 'Kaliforniya', price: 58000, weightGram: 240, calories: 380 },
    { section: 'Rollar', name: 'Dragon roll', price: 72000, weightGram: 280, calories: 460 },
    { section: 'Rollar', name: 'Tovuqli rol', price: 48000, weightGram: 230, calories: 400 },
    { section: 'Setlar', name: 'Set "Yapon"', price: 180000, weightGram: 900, calories: 1560, description: '4 xil rol, 32 dona', oldPrice: 210000 },
    { section: 'Setlar', name: 'Set "Losos"', price: 145000, weightGram: 700, calories: 1180 },
    { section: 'Qo\'shimcha', name: 'Soya sousi', price: 3000, weightGram: 30 },
    { section: 'Ichimliklar', name: 'Yashil choy', price: 12000, weightGram: 400 },
  ],

  kafe: [
    { section: 'Qahva', name: 'Amerikano', price: 18000, weightGram: 250, calories: 15 },
    { section: 'Qahva', name: 'Kapuchino', price: 24000, weightGram: 300, calories: 120 },
    { section: 'Qahva', name: 'Latte', price: 26000, weightGram: 350, calories: 150 },
    { section: 'Qahva', name: 'Raf', price: 30000, weightGram: 300, calories: 220 },
    { section: 'Nonushta', name: 'Omlet', price: 28000, weightGram: 250, calories: 380 },
    { section: 'Nonushta', name: 'Sirniki', price: 32000, weightGram: 280, calories: 420 },
    { section: 'Nonushta', name: 'Avokado tost', price: 38000, weightGram: 220, calories: 340 },
    { section: 'Deserт', name: 'Chizkeyk', price: 32000, weightGram: 150, calories: 420 },
    { section: 'Deserт', name: 'Tiramisu', price: 35000, weightGram: 160, calories: 450 },
    { section: 'Deserт', name: 'Napoleon', price: 28000, weightGram: 150, calories: 480 },
  ],

  shirinlik: [
    { section: 'Tortlar', name: 'Napoleon (1 kg)', price: 145000, weightGram: 1000, calories: 3200 },
    { section: 'Tortlar', name: 'Medovik (1 kg)', price: 155000, weightGram: 1000, calories: 3400 },
    { section: 'Tortlar', name: 'Chizkeyk (1 kg)', price: 180000, weightGram: 1000, calories: 3800 },
    { section: 'Bo\'laklar', name: 'Napoleon bo\'lagi', price: 22000, weightGram: 150, calories: 480 },
    { section: 'Bo\'laklar', name: 'Chizkeyk bo\'lagi', price: 28000, weightGram: 150, calories: 420 },
    { section: 'Non', name: 'Tandir non', price: 5000, weightGram: 300, calories: 720 },
    { section: 'Non', name: 'Patir', price: 8000, weightGram: 350, calories: 850 },
    { section: 'Milliy shirinlik', name: 'Halva', price: 25000, weightGram: 300, calories: 1200 },
    { section: 'Milliy shirinlik', name: 'Parvarda', price: 18000, weightGram: 200, calories: 780 },
  ],

  restoran: [
    { section: 'Asosiy', name: 'Steyk (mol)', price: 145000, weightGram: 300, calories: 620 },
    { section: 'Asosiy', name: 'Losos file', price: 128000, weightGram: 250, calories: 480 },
    { section: 'Asosiy', name: 'Tovuq filesi', price: 78000, weightGram: 280, calories: 420 },
    { section: 'Asosiy', name: 'Qo\'zi qovurg\'asi', price: 165000, weightGram: 350, calories: 780 },
    { section: 'Sho\'rvalar', name: 'Qo\'ziqorin krem-sho\'rva', price: 42000, weightGram: 300, calories: 280 },
    { section: 'Salatlar', name: 'Sezar', price: 48000, weightGram: 280, calories: 420 },
    { section: 'Salatlar', name: 'Grek salati', price: 42000, weightGram: 260, calories: 320 },
    { section: 'Deserт', name: 'Tiramisu', price: 38000, weightGram: 160, calories: 450 },
    { section: 'Ichimliklar', name: 'Yangi siqilgan sharbat', price: 25000, weightGram: 300, calories: 140 },
  ],

  klub: [
    { section: 'Kokteyllar', name: 'Mojito', price: 45000, weightGram: 350, calories: 220 },
    { section: 'Kokteyllar', name: 'Pina Colada', price: 52000, weightGram: 350, calories: 380 },
    { section: 'Kokteyllar', name: 'Long Island', price: 65000, weightGram: 400, calories: 420 },
    { section: 'Snack', name: 'Nachos', price: 42000, weightGram: 250, calories: 620 },
    { section: 'Snack', name: 'Tovuq qanotchalari', price: 58000, weightGram: 400, calories: 780 },
    { section: 'Snack', name: 'Pishloq assorti', price: 85000, weightGram: 300, calories: 920 },
    { section: 'Ichimliklar', name: 'Energetik', price: 25000, weightGram: 250 },
  ],

  tovuq: [
    { section: 'Strips', name: 'Strips 0.5 portsiya', price: 25000, weightGram: 130, calories: 380 },
    { section: 'Strips', name: 'Strips 1 portsiya', price: 45000, weightGram: 260, calories: 720 },
    { section: 'Strips', name: 'Strips 1 kg', price: 110000, weightGram: 1000, calories: 2800 },
    { section: 'Wings', name: 'Achchiq qanotchalar (6)', price: 38000, weightGram: 300, calories: 580 },
    { section: 'Wings', name: 'BBQ qanotchalar (6)', price: 38000, weightGram: 300, calories: 620 },
    { section: 'Kombo', name: 'Chicken kombo', price: 62000, weightGram: 550, calories: 1180, oldPrice: 72000 },
    { section: 'Garnir', name: 'Kartoshka fri', price: 15000, weightGram: 150, calories: 340 },
    { section: 'Souslar', name: 'Sarimsoqli sous', price: 5000, weightGram: 50 },
  ],

  magazin_oziq: [
    { section: 'Non va nonushta', name: 'Non (tandir)', price: 5000, weightGram: 300 },
    { section: 'Non va nonushta', name: 'Tuxum (10 dona)', price: 22000, weightGram: 600 },
    { section: 'Sut mahsulotlari', name: 'Sut 1L', price: 14000, weightGram: 1000 },
    { section: 'Sut mahsulotlari', name: 'Qatiq 0.5L', price: 12000, weightGram: 500 },
    { section: 'Sut mahsulotlari', name: 'Smetana 200g', price: 15000, weightGram: 200 },
    { section: 'Ichimliklar', name: 'Coca-Cola 1.5L', price: 18000, weightGram: 1500 },
    { section: 'Ichimliklar', name: 'Suv 1.5L', price: 5000, weightGram: 1500 },
    { section: 'Shirinliklar', name: 'Shokolad', price: 15000, weightGram: 100 },
  ],

  magazin_meva: [
    { section: 'Mevalar', name: 'Olma (1 kg)', price: 18000, weightGram: 1000 },
    { section: 'Mevalar', name: 'Banan (1 kg)', price: 28000, weightGram: 1000 },
    { section: 'Mevalar', name: 'Uzum (1 kg)', price: 32000, weightGram: 1000 },
    { section: 'Mevalar', name: 'Anor (1 kg)', price: 35000, weightGram: 1000 },
    { section: 'Sabzavotlar', name: 'Pomidor (1 kg)', price: 15000, weightGram: 1000 },
    { section: 'Sabzavotlar', name: 'Bodring (1 kg)', price: 12000, weightGram: 1000 },
    { section: 'Sabzavotlar', name: 'Kartoshka (1 kg)', price: 8000, weightGram: 1000 },
    { section: 'Ko\'katlar', name: 'Ko\'kat to\'plami', price: 10000, weightGram: 200 },
  ],

  salqin: [
    { section: 'Muzqaymoq', name: 'Plombir', price: 12000, weightGram: 100, calories: 220 },
    { section: 'Muzqaymoq', name: 'Shokoladli', price: 14000, weightGram: 100, calories: 260 },
    { section: 'Muzqaymoq', name: 'Meva ta\'mli', price: 13000, weightGram: 100, calories: 180 },
    { section: 'Muzqaymoq', name: 'Muzqaymoq torti', price: 85000, weightGram: 700, calories: 1800 },
    { section: 'Salqin ichimlik', name: 'Milkshake', price: 25000, weightGram: 350, calories: 380 },
    { section: 'Salqin ichimlik', name: 'Limonad', price: 18000, weightGram: 400, calories: 160 },
    { section: 'Salqin ichimlik', name: 'Smuzi', price: 28000, weightGram: 350, calories: 220 },
  ],
};

// Kategoriya mos kelmasa — umumiy menyu
export const DEFAULT_DISHES = DISH_TEMPLATES.milliy;
