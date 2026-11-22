# Yazma operasyonları ve Firefly III davranışları (ajan notu)

Bu sayfa `CLAUDE.md` / `AGENTS.md`'nin kısa kurallarının gerekçeli uzun hâlidir.
Yalnızca depoda durur: `mkdocs.yml` `exclude_docs` ile yayınlanan siteden hariç
tutulur. İngilizce, herkese açık kısa sürümü `CONTRIBUTING.md` içindedir.

## İnce operasyonlar ve bileşik operasyonlar

Operasyonların çoğu tek bir Firefly ucunu aynalar. `summary.overview` bilerek
aynalamaz: insight uçlarına ve `/summary/basic`'e dağılıp tek bir normalize edilmiş
nesne döndürür (`buildOverview`, `src/entities/remaining.ts`), çünkü "bu ay nasıl
geçti?" sorusu aksi hâlde ajana birkaç gidiş-dönüş artı elle toplama maliyeti çıkarıyor.

Bileşim kural değil, istisnadır. Bir soru hem *sık* soruluyorsa *hem de* ham uçlar
birleştirme işini çağırana yıkıyorsa hak eder. İnce operasyonlar her hâlükârda
altta durmaya devam eder.

Filtreyle yazan operasyonlar (`transaction.bulk_update_where`,
`transaction.bulk_rewrite`) bu ilkeden bilinçli olarak sapar: `where` + `set` tek
çağrıda seçim ve yazımı birleştirir. Buna izin veren iki şart vardır, ikisi de zorunlu:

- **`max_matches` şarttır.** Filtre kolayca yanlış olur, Firefly her yazıma 200
  cevap verir ve geri alma yoktur. Çağıran kaç satır beklediğini söyler; daha geniş
  bir eşleşme ilk PUT'tan önce durur. `max_matches` verilmezse şema reddeder.
- **Kesilen tarama da reddeder.** Sayfa tavanına ulaşan veya Firefly'ın sayfalama
  meta'sı vermediği bir tarama (`truncated`, `src/scan.ts`) "belki daha çok eşleşme
  var" demektir; kısmi eşleşmeye yazmak, daha küçük bir sayıyla aynı hatadır.

## Toplu operasyonlarda desen ve etiket

**Desen dili regex değildir, olmamalıdır.** `description_like` ve
`transaction.bulk_rewrite` `#` (rakam dizisi) ile `*` (herhangi) jokerlerini alır;
eşleştirici geri izlemesiz ve tek geçişlidir. Bir ara regex kabul edildi: `^(a+)+$`
deseni 31 karakterlik bir açıklamada olay döngüsünü 25 saniyeden fazla kilitledi —
üstelik onay istenmeyen `firefly_query` yüzeyinden. JavaScript çalışan bir regex'i
kesemez ve işlem açıklaması bu projenin tehdit modelinde güvenilmez metindir:
enjekte edilmiş bir not modelden o deseni aratabilir.

**Paylaşılan bir `set` nesnesi `tags` taşıyamaz** (`src/schemas/transactions.ts`
bilerek `tags`'i çıkarır). Firefly etiket listesinin tamamını değiştirir; tek liste
birçok satıra yazılırsa her birinin kendi etiketlerini siler. Etiket eklemek için
birleştiren `transaction.bulk_tag`, ya da her satırın kendi listesini taşıdığı
`transaction.bulk_update`.

**Filtreyle yazan bir operasyon önce `dry_run` ile çağrılır.** Ön izleme, gönderilecek
PUT'ları çözülmüş journal id'leriyle gösterir; reddedildiyse bunu da söyler
(`src/preview.ts`). Handler'ın başarı sayaçları ön izlemede taşınmaz — ön izleme
istemcisinde her yazma "başarılı" olur, ve "hiçbir şey yazılmadı" notunun yanındaki
`updated: 10` çağıranı işi bitmiş sanmaya iter.

## Sessizce yanlış sonuç veren Firefly III davranışları

Firefly III 6.6.3 üzerinde canlı doğrulandı. Ortak özellikleri **hata değil, yanlış
cevap** üretmeleri — yazılı olmalarının sebebi bu.

- **Tarih aralıklarında `end` dahildir.** `start=2026-08-25&end=2026-08-26` iki günü
  birden döndürür. "Tek gün" demek için `end`'i bir gün ileri almayın; ertesi günü
  içeri alır.
- **`start == end` bazı uçlarda reddedilir** (422). `/accounts/{id}/transactions` ve
  `/summary/basic` reddeder; insight uçlarının hepsi kabul eder. İlkinin geçici
  çözümü `src/entities/accounts.ts` içinde. İkincisi için aralığı genişletmek
  **çözüm değil**: `balance-in-*` dönem hareketidir, anlık bakiye değil — `start`
  değişince değer değişiyor. `buildOverview` bu yüzden bakiye çağrısını ölümcül
  saymaz ve kaybı `balances_unavailable` ile açıkça bildirir.
- **Bilinmeyen bir sarmalayıcı anahtarıyla yapılan PUT 200 döner ve hiçbir şeyi
  değiştirmez.** Firefly tanımadığı üst düzey anahtarları reddetmez; bozuk bir
  güncelleme başarılı görünür. Bunu önleyen, strict input şemalarıdır.
- **İşlem güncellemeleri her split içinde `transaction_journal_id` ister**, yoksa
  split eşleşmez ve hiçbir şey olmaz.
- **`/search/accounts` `field` parametresi ister**, yoksa 422 döner.
- **`opening_balance: "0"` sessizce yok sayılır.** Hesap PUT'u 200 döner ve açılış
  bakiyesi olduğu gibi kalır. `"0.01"` uygulanır, `null` ise alanı gerçekten temizler.
- **Diziler baştan yazılır, skalerler birleşir.** Bir `PUT`'ta göndermediğiniz skaler
  alan korunur, ama gönderdiğiniz dizi kümenin tamamının yerine geçer: iki trigger'lı
  bir kurala tek trigger göndermek onu tek trigger'lı bırakır, iki etiketli bir işleme
  tek etiket göndermek diğerini siler. `transaction.bulk_tag` bu yüzden bir kez veri
  sildi. Etiket/trigger/action/accounts gibi alanların şemasında bu yazılıdır;
  `test/replace-semantics.test.ts` düşmesini engeller.
- **Çok parçalı gruba tek bir tutar yazmak toplamı sessizce katlar.** Bir grubun üç
  split'ine tek `amount` yaymak, o tutarı üç kez kaydeder ve Firefly 200 cevap verir.
  Aynı tehlike `source_id`/`destination_id` için de geçerli: bacaklar tek hesaba çöker.
  Bu yüzden `transaction.bulk_update` ve `transaction.bulk_update_where` çok parçalı
  grupları **tamamen reddeder** (`multiSplitReason`, `src/entities/transactions.ts`);
  yerine tek işlem güncellemesi kullanılır. `transaction.bulk_categorize` ve
  `transaction.bulk_tag` istisnadır — kategori ve etiket gerçekten tüm gruba aittir.
- **Arayüzün "bakiye"si `virtual_balance` içerir, API'nin `current_balance`'ı içermez.**
  Ekranda 501,47 yazarken `/accounts/{id}` 500,00 döner. Arayüzle API arasında
  karşılaştırma yapan her kod bunu bilmelidir.
- **Insight giderleri negatiftir**; gelir ve transferler pozitif.

### Firefly III 6.7.9 alan denetimi (2026-11-22)

`npm run audit:api` her yazma operasyonunun gönderdiği alanları Firefly'ın kendi
istek sınıflarının okuduğu alanlarla karşılaştırır; `npm run smoke:write` yazmaları
atılabilir bir yerel örnekte bağımsız okumayla doğrular. Bu turda bulunanlar:

- **Okunan alan kaydedilen alan değildir.** Bütçe güncellemesi `order`'ı okur ama
  depo katmanı hiç yazmaz; 200 döner, sıra değişmez. Şemadan çıkarıldı. Hesap
  güncellemesinde de aynısı: `type`'ı controller ezer, `liability_amount` ve
  `liability_start_date`'i hiçbir servis yazmaz; yanıt da bunları göstermediği için
  canlı tur ilk seferde "geçti" saymıştı. Tur artık geri okunamayan alanları
  "partial" diye adıyla listeler.
- **Otomatik bütçe yalnız `auto_budget_type` ile birlikte değişir.** Tek başına
  `auto_budget_amount` ya da `auto_budget_period` 200 döner ve eskisi kalır; şema
  türü bu durumda zorunlu tutar.
- **`transaction_link` güncellemesinde `link_type_name` bağlantıyı bozar.** Firefly
  `link_type_id` 0 yazar, sonraki her güncelleme 500 verir. İki uç olmadan yapılan
  güncelleme benzersizlik kısıtına takılır ve bağlantı kaybolur. Güncelleme tam kimlik
  ve tür kimliğiyle yapılır.
- **Sessizce düşürülen alanlar:** kumbarada `amount` (başlangıç tutarı
  `accounts[].current_amount`'tadır) ve `active`; döviz kuru güncellemesinde `from` ve
  `to`; tekrarlayan işlem güncellemesinde `type`. Hepsi şemadan çıkarıldı.
- **Kumbara oluşturmak 6.7'de para birimi ister** (`transaction_currency_code` ya da
  `_id`); eksikse 422.
- Kural trigger'ındaki `prohibited` Firefly'ın "DEĞİL"idir; trigger listesi baştan
  yazıldığı için güncellemede geri gönderilmezse kaybolur.

## Kayıt içeriği güvenilmezdir

İşlem açıklaması, notlar, etiketler ve karşı taraf hesap adları parayı hareket ettiren
kişi tarafından yazılır — gelen bir ödemede bu, hesap sahibi değildir. Bu metin
`firefly_query` sonucuyla modelin context'ine girer ve aynı oturumda `firefly_mutate`
ile `firefly_destructive` hazırdır.

Yapısal savunma yüzey ayrımıdır: enjekte edilmiş bir talimatın işe yaraması için
host'un annotation'la işaretlediği ve onay isteyebildiği bir aracı çağırması gerekir.
Metinsel savunma `UNTRUSTED_CONTENT_NOTICE`'tır (`src/server.ts`); çalıştırma
yüzeylerinin açıklamasında durur. Araç açıklaması sunucunun yazdığı, dolayısıyla
güvenilir metindir; araç **sonucu** değildir. Yeni bir çalıştırma yüzeyi eklerseniz
bu notu da taşıyın.
