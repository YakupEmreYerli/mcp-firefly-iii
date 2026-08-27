# Firefly III MCP Sunucusu

Kişisel bir [Firefly III](https://www.firefly-iii.org/) örneğini yapay zekâ
asistanlarına açan bir MCP sunucusu. Tek bir canlı örnek için geliştiriliyor;
bu yüzden burada genellik değil, **gerçek finansal veri üzerinde doğruluk** önemli.

Proje dili Türkçe: dokümantasyon ve bu dosya Türkçe yazılır. Kod içi docstring ve
yorumlar İngilizce kalır.

## Komutlar

```bash
make test        # tüm testler, mock'lu, ağa çıkmaz        (~3sn)
make check       # canlı örneğe karşı salt-okunur sağlık kontrolü
make run         # sunucuyu stdio üzerinden çalıştır
make coverage    # kapsam raporu (kapı yok, isteğe bağlı)
make inspector   # tarayıcıda interaktif araç gezgini
```

Her şey Node.js/npm üzerinden çalışır. Testler `.env.test`, `run`, `check` ve
`parity` ise `.env` dosyasını okur.

## Mimari

```
src/
  entities/  entity operations and Firefly request mapping
  schemas/   hand-written strict Zod input schemas
  registry   operation registration, validation, read-only gate, projection
  firefly    HTTP client and Firefly error translation
```

Operasyonlar `defineOperation` ile tanımlanır ve üç meta-araç
(`firefly_execute`, `firefly_list_operations`, `firefly_get_schema`) üzerinden
sunulur — çoğu MCP istemcisi ~40 aracın üzerinde bozulduğu için.

## Operasyon ekleme

1. `src/schemas/` — strict input schema
2. `src/entities/<varlık>.ts` — `defineOperation` ile operation ve HTTP mapping
3. `src/server.ts` — yeni module kaydı
4. `test/` — mocked request/response and validation tests

İki şeyi atlamak kolay:

**Her operasyonu `read` veya `write` diye etiketleyin.** Salt-okunur mod bu
etiketlere bakar. Etiketlenmemiş bir yazma operasyonu, salt-okunur modda sessizce
çağrılabilir kalır — bu eksikliği yakalayacak ikinci bir isim listesi yok.

**Açıklamaları, operasyonun cevapladığı soru olarak yazın.**
`"Dönemde kategoriye göre ne kadar harcandı?"`, `"Gider kategori insight'ı"`ndan
iyidir. Bu açıklamalar `firefly_list_operations` ve `firefly_get_schema`
üzerinden görünür.

`firefly_execute` açıklamasına gömülü katalog ise açıklamaları değil, yalnızca
**operasyon adlarını** listeler — yanına `registry._ENTITY_HINTS`'ten gelen tek
satırlık varlık ipucunu ekler. Model çoğu zaman varlığı bu ipuçlarına bakarak
seçer, o yüzden yeni bir varlık eklerken ipucunu da ekleyin (bir test bunu
zorunlu kılıyor).

**Açıklamalar İngilizce kalır.** Türkçeye çevirmek, modelin gördüğü metinle
Firefly'ın kendi alan adları (`category_id`, `source_name`) arasına bir çeviri
katmanı daha koyar ve araç seçimini zayıflatır. Türkçe olan yer dokümanlardır.

## İnce operasyonlar ve bileşik operasyonlar

Operasyonların çoğu tek bir Firefly ucunu aynalar. `summary.overview` bilerek
aynalamaz: dört insight ucuna dağılıp tek bir normalize edilmiş nesne döndürür,
çünkü "bu ay nasıl geçti?" sorusu aksi hâlde ajana dört gidiş-dönüş artı elle
toplama maliyeti çıkarıyor.

Bileşim kural değil, istisnadır. Bir soru hem *sık* soruluyorsa *hem de* ham uçlar
birleştirme işini çağırana yıkıyorsa hak eder. İnce operasyonlar her hâlükârda
altta durmaya devam eder.

## Sessizce yanlış sonuç veren Firefly III davranışları

Firefly III 6.6.3 üzerinde canlı doğrulandı. Hepsinin ortak özelliği **hata değil,
yanlış cevap** üretmeleri — yazılı olmalarının sebebi bu.

- **Tarih aralıklarında `end` dahildir.** `start=2026-08-25&end=2026-08-26` iki
  günü birden döndürür. "Tek gün" demek için `end`'i bir gün ileri almayın; ertesi
  günü içeri alır.
- **`start == end` bazı uçlarda reddedilir** (422). `/accounts/{id}/transactions`
  ve `/summary/basic` reddeder; insight uçlarının hepsi kabul eder. İlkinin geçici
  çözümü `src/entities/accounts.ts` içinde. İkincisi için aralığı genişletmek
  **çözüm değil**: `balance-in-*` dönem hareketidir, anlık bakiye değil — canlı
  ölçüldü, `start` değişince değer değişiyor. `buildOverview` bu yüzden bakiye
  çağrısını ölümcül saymaz ve kaybı `balances_unavailable` ile açıkça bildirir.
- **Bilinmeyen bir sarmalayıcı anahtarıyla yapılan PUT 200 döner ve hiçbir şeyi
  değiştirmez.** Firefly tanımadığı üst düzey anahtarları reddetmez; bozuk bir
  güncelleme başarılı görünür. Bu bir kez gerçek bir hata olarak yayınlandı,
  bkz. `tests/test_transaction_update.py`.
- **İşlem güncellemeleri her split içinde `transaction_journal_id` ister**, yoksa
  split eşleşmez ve hiçbir şey olmaz.
- **`/search/accounts` `field` parametresi ister**, yoksa 422 döner.
- **Insight giderleri negatiftir**; gelir ve transferler pozitif.

**Yazma işlemlerini bağımsız bir okumayla doğrulayın.** Firefly'dan gelen 200,
bir şeyin değiştiğinin kanıtı değildir.

## Test

Testler mock'ludur ve canlı örneğe asla dokunmaz. `core.<varlık>.client` ve
`core.<varlık>.raise_api_error_if_any` yamalanır.

Kapsam ölçülür ama kapı olarak kullanılmaz — eşik, neyin test edildiğini raporlamak
yerine şekillendiriyordu. Testi, **hatanın sessiz kalacağı** yerlere yazın: istek
şekilleri, normalizasyonlar ve yukarıdaki geçici çözümler. Yalnızca bir mock'un
kendisine söyleneni döndürdüğünü doğrulayan test, bakım maliyetini hak etmez.

Bir hatayı düzeltirken, yeni testin **eski kodda düştüğünü** doğrulamadan
saklamayın.

## Notlar

- `README.md` ve `LICENSE` bilerek silindi. İstenmeden geri eklenmez. README
  eklenecek olursa Türkçe birincil, İngilizce ikincil dil olur.
- Commit'ler doğrudan `main`'e atılır. Özellik dalı açılmaz.
- Kaynak kodda veya `.env`'de yapılan değişiklikler, MCP istemcisi yeniden
  başlatılana kadar (Claude Code'da `/mcp`) çalışan sürece yansımaz.
