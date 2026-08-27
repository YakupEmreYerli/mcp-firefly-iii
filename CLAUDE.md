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

Operasyonlar `defineOperation` ile tanımlanır ve meta-araçlar üzerinden sunulur
— çoğu MCP istemcisi ~40 aracın üzerinde bozulduğu için. Çalıştırma riske göre
üçe bölünmüştür (`firefly_query`, `firefly_mutate`, `firefly_destructive`),
yanına `firefly_list_operations` ve `firefly_get_schema` gelir. Bölme
`Registry.execute` içinde **uygulanır**: yanlış yüzeyden çağrılan bir operasyon
`WrongAccessSurfaceError` ile reddedilir, yoksa tool annotation'ı sunucunun
tutmadığı bir iddia olurdu.

## Operasyon ekleme

1. `src/schemas/` — strict input schema
2. `src/entities/<varlık>.ts` — `defineOperation` ile operation ve HTTP mapping
3. `src/server.ts` — yeni module kaydı
4. `test/` — mocked request/response and validation tests

İki şeyi atlamak kolay:

**Her operasyonu `read`, `write` veya `destructive` diye etiketleyin.**
`FIREFLY_PERMISSIONS` ve üç çalıştırma yüzeyi bu etiketlere bakar.
`destructive`, çağıranın geri alamayacağı alt kümedir: kaydı siler, ya da tek
çağrıda çok kaydın bir alanını yeniden yazar. Kapı tek bir yerde, `permits` ile
seviye karşılaştırarak çalışır — etiketi tamamen unutulmuş bir operasyonu
yakalayacak ikinci bir isim listesi yok, ama `access` zorunlu alan olduğu için
eksik etiket derleme hatası olur.

İzin ayarı tektir: `FIREFLY_READ_ONLY` ve `FIREFLY_ENABLED_ENTITIES` 2.0.0'da
kaldırıldı, ikisi de `FIREFLY_PERMISSIONS`'ın alt kümesiydi. Kısıtlayan bir
değerle hâlâ tanımlıysalar sunucu **açılmayı reddeder** — sessizce yok saymak,
operatörün yazdığından daha geniş bir sunucu bırakırdı.

**Açıklamaları, operasyonun cevapladığı soru olarak yazın.**
`"Dönemde kategoriye göre ne kadar harcandı?"`, `"Gider kategori insight'ı"`ndan
iyidir. Bu açıklamalar `firefly_list_operations` ve `firefly_get_schema`
üzerinden görünür.

Çalıştırma araçlarının açıklamasına gömülü katalog ise açıklamaları değil,
yalnızca **operasyon adlarını** listeler — yanına `EntityModule.hint`'ten gelen
tek satırlık varlık ipucunu ekler. İpucu yalnızca `firefly_query` yüzeyinde
tekrarlanır: üç yüzeyde birden tekrarlamak katalog metnini %55 büyütüyordu,
ölçüldü. Model çoğu zaman varlığı bu ipuçlarına bakarak seçer, o yüzden yeni bir
varlık eklerken ipucunu da ekleyin (tip sistemi zorunlu kılıyor).

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
- **`opening_balance: "0"` sessizce yok sayılır.** Hesap PUT'u 200 döner ve
  açılış bakiyesi olduğu gibi kalır. `"0.01"` uygulanır, `null` ise alanı
  gerçekten temizler. Yani bir açılış bakiyesini sıfırlamak isteyen kod, `"0"`
  gönderdiğinde başarılı görünüp hiçbir şey değiştirmez — canlı ölçüldü.
- **Diziler baştan yazılır, skalerler birleşir.** Bir `PUT`'ta göndermediğiniz
  skaler alan korunur (kategori notu ölçüldü), ama gönderdiğiniz dizi kümenin
  tamamının yerine geçer: iki trigger'lı bir kurala tek trigger göndermek onu
  tek trigger'lı bırakır, iki etiketli bir işleme tek etiket göndermek diğerini
  siler. `bulk_tag` bu yüzden bir kez veri sildi. Etiket/trigger/action/accounts
  gibi alanların şemasında bu yazılıdır, `test/replace-semantics.test.ts`
  düşmesini engeller.
- **Insight giderleri negatiftir**; gelir ve transferler pozitif.

## Kayıt içeriği güvenilmezdir

İşlem açıklaması, notlar, etiketler ve karşı taraf hesap adları parayı hareket
ettiren kişi tarafından yazılır — gelen bir ödemede bu, hesap sahibi değildir.
Bu metin `firefly_query` sonucuyla modelin context'ine girer ve aynı oturumda
`firefly_mutate` ile `firefly_destructive` hazırdır.

Yapısal savunma yüzey ayrımıdır: enjekte edilmiş bir talimatın işe yaraması için
host'un annotation'la işaretlediği ve onay isteyebildiği bir aracı çağırması
gerekir. Metinsel savunma ise `UNTRUSTED_CONTENT_NOTICE` — üç çalıştırma
çalıştırma yüzeyinin açıklamasında durur. Araç açıklaması
sunucunun yazdığı, dolayısıyla güvenilir metindir; araç **sonucu** değildir.
Yeni bir çalıştırma yüzeyi eklerseniz bu notu da taşıyın.

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
