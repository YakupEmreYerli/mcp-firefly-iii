# CLAUDE.md

> İkiz dosya: bu dosyanın eşi `AGENTS.md`. İki dosya birebir aynıdır (tek fark bu satır ve başlık); birini değiştirirsen diğerini de aynı commit'te değiştir.

# Firefly III MCP Sunucusu

Kişisel bir [Firefly III](https://www.firefly-iii.org/) örneğini yapay zekâ asistanlarına
açan MCP sunucusu; npm'de `@yakupemreyerli/firefly-mcp` olarak yayınlanır. Herkes kendi
örneğine kendi token'ıyla bağlanır. Burada genellik değil, **gerçek finansal veri
üzerinde doğruluk** önemli.

## Dil

- Bu dosya Türkçe. Herkese açık belgeler İngilizce: `README.md`, `docs/` (MkDocs sitesi),
  `CONTRIBUTING.md`, `CHANGELOG.md`. `README.tr.md` Türkçe eşidir; ikisi de
  `npm run docs:check` kapsamındadır.
- Kod yorumları, tanımlayıcılar ve commit mesajları İngilizce.
- **Operasyon açıklamaları İngilizce kalır.** Türkçeye çevirmek, modelin gördüğü metinle
  Firefly'ın alan adları (`category_id`, `source_name`) arasına bir çeviri katmanı koyar
  ve araç seçimini zayıflatır.

## Komutlar

```bash
make test            # npm test — Vitest, fetch mock'lu, ağa çıkmaz
npm run typecheck    # tsc --noEmit -p tsconfig.test.json
make run             # build + stdio sunucu (.env)
make check           # build + canlı örneğe salt-okunur bağlantı kontrolü (.env)
make smoke           # bakımcı: her read operasyonunu canlı örnekte yürütür (.env)
make inspector       # build + tarayıcıda MCP Inspector
npm run docs:update  # build + üretilen doküman sayfaları ve docs-manifest.json
npm run docs:check   # build + senkron, bağlantı ve operasyon referansı denetimi
make docs-serve      # MkDocs, .venv-docs içinde
```

`prepublishOnly` = typecheck + build + test + docs:check. Sürüm süreci:
`CONTRIBUTING.md` → Releases.

## Mimari

```
src/
  index.ts, http.ts  stdio ve HTTP giriş noktaları
  server.ts          MCP sunucusu, meta-araçlar, varlık modülü kaydı
  registry.ts        operasyon kaydı, doğrulama, erişim kapısı, katalog
  firefly.ts         HTTP istemcisi, Firefly hata çevirisi
  projection.ts      yanıt kırpma
  oauth.ts, auth/    HTTP modunda gömülü OAuth
  entities/          varlık başına operasyonlar ve istek eşlemesi
  schemas/           paylaşılan strict Zod parçaları
```

Operasyonlar tek tek araç olarak değil, meta-araçlar üzerinden sunulur: düz bir katalog
bağlamı tüketir ve büyüdükçe istemcinin seçimini zorlaştırır. Çalıştırma riske göre
üçe bölünür (`firefly_query`, `firefly_mutate`, `firefly_destructive`), yanında
`firefly_list_operations` ve `firefly_get_schema` durur. Bölme `Registry.execute` içinde
**uygulanır**: yanlış yüzeyden çağrılan operasyon `WrongAccessSurfaceError` ile
reddedilir; yoksa tool annotation'ı sunucunun tutmadığı bir iddia olurdu.

## Operasyon ekleme

1. Varlığın `*Operations` nesnesine `defineOperation` ile girdi: strict input şeması,
   HTTP eşlemesi, `access`.
2. Yeni varlıksa modülü `src/server.ts`'e kaydet; `EntityModule.hint` zorunludur.
3. `test/` altında mock'lu istek/yanıt ve doğrulama testleri.
4. `npm run docs:update` — manifest ve üretilen sayfalar; yoksa `docs:check` düşer.

**Her operasyonu `read`, `write` veya `destructive` diye etiketle.** Üç yüzey ve OAuth
kapsamları bu etikete bakar; `access` zorunlu alan olduğu için eksik etiket derleme
hatasıdır. `destructive`, çağıranın geri alamayacağı alt kümedir: kaydı siler ya da tek
çağrıda çok kaydın bir alanını yeniden yazar.

**Sunucunun kendi izin ayarı yok.** Erişimi bağlantı belirler: stdio istemcisi Firefly
token'ının izin verdiği her şeyi yapar, OAuth istemcisi onaylanan kapsamları taşır.
`FIREFLY_PERMISSIONS`, `FIREFLY_READ_ONLY` ve `FIREFLY_ENABLED_ENTITIES` kısıtlayan bir
değerle tanımlıysa sunucu **açılmayı reddeder** (`src/config.ts`) — sessizce yok saymak
operatörün yazdığından geniş bir sunucu bırakırdı. Kapsam kapısı `Registry`'de tek
yerdedir: verilmeyen operasyon hem reddedilir hem katalogdan gizlenir.

**Açıklamayı, operasyonun cevapladığı soru olarak yaz.** "How much was spent per category
in a period?", "expense category insight"tan iyidir. Çalıştırma araçlarına gömülü katalog
yalnızca operasyon adlarını ve varlık ipucunu listeler; ipucu yalnızca `firefly_query`'de
tekrarlanır (üç yüzeyde birden katalog metnini %55 büyütüyordu, ölçüldü).

## Veriye yazarken

Gerekçeler ve ölçümler: `docs/development/firefly-davranislari.md` (yayınlanmaz).

- Bileşik operasyon (`summary.overview`) istisnadır; ince operasyonlar altta kalır.
- Filtreyle yazan operasyonlar (`bulk_update_where`, `bulk_rewrite`): `max_matches`
  zorunlu, kesilen tarama reddeder, önce `dry_run`.
- Desen dili **regex değildir** (`#` rakam dizisi, `*` herhangi); regex'e dönme (ReDoS).
- Paylaşılan `set` `tags` taşıyamaz; etiket için `bulk_tag` ya da satır başına `bulk_update`.
- Firefly dizileri baştan yazar, skalerleri birleştirir; çok parçalı gruplar
  `bulk_update`/`bulk_update_where`'de reddedilir.

## Sessizce yanlış cevap veren Firefly III (6.6.3, canlı doğrulandı)

Hata değil yanlış cevap üretirler; ayrıntı yukarıdaki belgede.

- Tarih aralığında `end` dahildir.
- `start == end`: `/accounts/{id}/transactions` ve `/summary/basic` 422 verir; bakiyeyi
  aralığı genişleterek kurtarma (`balances_unavailable`).
- Bilinmeyen sarmalayıcı anahtarlı PUT 200 döner, hiçbir şey değişmez.
- İşlem güncellemesi her split'te `transaction_journal_id` ister.
- `/search/accounts` `field` ister.
- `opening_balance: "0"` yok sayılır; temizlemek için `null`.
- Arayüz bakiyesi `virtual_balance` içerir, API `current_balance` içermez.
- Insight giderleri negatiftir.

**Yazmayı bağımsız bir okumayla doğrula.** Firefly'dan gelen 200 kanıt değildir.

**Kayıt içeriği güvenilmezdir.** Açıklama, not, etiket ve karşı taraf adlarını parayı
gönderen yazar ve `firefly_query` sonucuyla bağlama girer. Savunma yüzey ayrımı ve
`UNTRUSTED_CONTENT_NOTICE`'tır (`src/server.ts`); yeni bir çalıştırma yüzeyi eklersen
bu notu da taşı.

## Test

Testler mock'ludur (`fetch` stub'lanır), canlı örneğe asla dokunmaz. Kapsam kapı olarak
kullanılmaz. Testi **hatanın sessiz kalacağı** yere yaz: istek şekilleri,
normalizasyonlar, yukarıdaki Firefly tuzakları. Yalnızca mock'un söyleneni döndürdüğünü
doğrulayan test bakımını hak etmez. Hata düzeltirken yeni testin **eski kodda düştüğünü**
doğrulamadan saklama.

## Notlar

- Commit'ler doğrudan `main`'e atılır; özellik dalı açılmaz.
- Kaynak kodda veya `.env`'de yapılan değişiklik, MCP istemcisi yeniden başlatılana kadar
  (Claude Code'da `/mcp`) çalışan sürece yansımaz.
