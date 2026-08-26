# Firefly III MCP Sunucusu

Kendi [Firefly III](https://www.firefly-iii.org/) örneğinize bir yapay zekâ
asistanının okuma — izin verirseniz yazma — erişimi kazanmasını sağlar. Model
Context Protocol üzerinden çalışır.

24 varlıkta 139 operasyon: işlemler, hesaplar, bütçeler, kategoriler, etiketler,
faturalar, kumbaralar, kurallar; ayrıca arama ve dönem analizi.

> English: [README.md](README.md)

Herkes **kendi** Firefly örneğine, **kendi** token'ıyla bağlanır. Ortak bir hesap
yoktur, veri üçüncü bir taraftan geçmez.

## Kurulum

Node.js 20.6+ gerekir. En kısa yol, kurulumu ona bırakmak:

```bash
npx -y @yakupemreyerli/firefly-mcp setup
```

Firefly III adresinizi ve API token'ınızı sorar, **gerçekten çalışıp
çalışmadıklarını** örneğinize karşı sınar, sonra bulursa Claude Code ve Claude
Desktop'ı yapılandırır — dokunduğu her dosyanın yedeğini alır ve diğer MCP
sunucularınıza ilişmez. Başka bir istemci kullanıyorsanız yapıştırmanız için
yapılandırmayı ekrana basar.

Elle yapmayı tercih ederseniz:

### Claude Code

```bash
claude mcp add firefly \
  --env FIREFLY_API_URL=https://kendi-firefly-adresiniz/api/v1 \
  --env FIREFLY_API_TOKEN=token-degeriniz \
  -- npx -y @yakupemreyerli/firefly-mcp
```

### Claude Desktop, Cursor ve diğer istemciler

İstemcinin MCP yapılandırma dosyasına ekleyin:

```json
{
  "mcpServers": {
    "firefly": {
      "command": "npx",
      "args": ["-y", "@yakupemreyerli/firefly-mcp"],
      "env": {
        "FIREFLY_API_URL": "https://kendi-firefly-adresiniz/api/v1",
        "FIREFLY_API_TOKEN": "token-degeriniz"
      }
    }
  }
}
```

Token'ı Firefly III → **Options → Profile → OAuth → Create New Personal Access
Token** yolundan alırsınız. URL'nin sonundaki `/api/v1` zorunludur.

## Salt-okunur mod

Yazma varsayılan olarak açık: asistandan bir harcamayı kaydetmesini veya bir
işlemi kategorilendirmesini isteyebilirsiniz, yapar.

Yalnızca soru cevaplayan bir oturum isterseniz `FIREFLY_READ_ONLY=true` verin.
O zaman her oluşturma, güncelleme ve silme reddedilir ve araç kataloğundan
gizlenir, böylece asistan denemez bile.

```json
"env": {
  "FIREFLY_API_URL": "https://kendi-firefly-adresiniz/api/v1",
  "FIREFLY_API_TOKEN": "token-degeriniz",
  "FIREFLY_READ_ONLY": "true"
}
```

## Asistanın gördüğü yüzey

139 değil, üç araç:

| Araç | Cevapladığı soru |
| --- | --- |
| `firefly_execute` | Herhangi bir operasyonu çalıştır. Açıklaması tüm kataloğu taşır, seçim ek bir çağrıya mal olmaz. |
| `firefly_list_operations` | Bu varlıkla ne yapabilirim? |
| `firefly_get_schema` | Bu operasyon hangi parametreleri alıyor? |

Çoğu MCP istemcisi ~40 aracın üzerinde bozulduğu için yüzey üç araçta tutuldu.
Operasyon başına ayrı araç isterseniz `FIREFLY_DIRECT_MODE=true`.

Yanıtlar modele ulaşmadan kırpılır: boş ve null alanlar her zaman düşer,
`firefly_execute` ise yalnızca adını verdiğiniz alanları tutan bir `fields`
listesi alır — büyük bir işlem listesinde bu yaklaşık %90 küçülme demektir.

## Yapılandırma

| Değişken | Varsayılan | İşlevi |
| --- | --- | --- |
| `FIREFLY_API_URL` | — | Zorunlu. `/api/v1` dahil temel URL. |
| `FIREFLY_API_TOKEN` | — | Zorunlu. Personal Access Token. |
| `FIREFLY_READ_ONLY` | `false` | Tüm yazma operasyonlarını reddeder ve gizler. |
| `FIREFLY_DIRECT_MODE` | `false` | Üç meta-araç yerine operasyon başına bir araç. |
| `FIREFLY_ENABLED_ENTITIES` | `all` | Açılacak varlıklar, virgülle ayrılmış. |
| `FIREFLY_DISABLE_SSL_VERIFY` | `false` | Yalnızca kendinden imzalı sertifikalı yerel örnek için. |

## Uzak HTTP modu

Süreç başlatmak yerine HTTP üzerinden bağlanan istemciler için — örneğin n8n —
aynı sunucu streamable HTTP konuşur:

```bash
export MCP_HTTP_TOKEN=$(openssl rand -hex 32)
npx -y -p @yakupemreyerli/firefly-mcp firefly-mcp-http
```

`firefly-mcp-http`, aynı paketin içindeki ikinci bir çalıştırılabilirdir; `npx`
bu yüzden `-p` ile paketi ve komutu ayrı ayrı ister.

`MCP_HTTP_TOKEN` verilmeden başlamaz ve `/mcp` uçlarına gelen her istek
`Authorization: Bearer <token>` taşımak zorundadır. `/health` açıktır, container
probe'ları içindir. Depoda bir `Dockerfile` ve `compose.example.yml` bulunur.

TLS arkasına koyun. Bu token, internet ile finansal geçmişinize yazma erişimi
arasındaki tek şey — portu doğrudan açmayın.

## Dokümantasyon

| Sayfa | İçeriği |
| --- | --- |
| [Quickstart](https://github.com/YakupEmreYerli/mcp-firefly-iii/blob/main/docs/quickstart.md) | Token alma, istemciyi bağlama, ilk denemeler, sorun giderme |
| [Configuration](https://github.com/YakupEmreYerli/mcp-firefly-iii/blob/main/docs/configuration.md) | Tüm ortam değişkenleri, salt-okunur mod, varlık filtresi, HTTP modu |
| [MCP Integration](https://github.com/YakupEmreYerli/mcp-firefly-iii/blob/main/docs/integrations.md) | Claude Code, Claude Desktop, Cursor, VS Code, n8n ve uzak HTTP |
| [Operations](https://github.com/YakupEmreYerli/mcp-firefly-iii/blob/main/docs/api/operations.md) | 139 operasyonun tamamı, yanıt kırpma, Firefly'ın tuzakları |
| [Analysis Operations](https://github.com/YakupEmreYerli/mcp-firefly-iii/blob/main/docs/api/analysis.md) | `summary.overview`, arama ve sekiz insight ucu |
| [MCP Inspector](https://github.com/YakupEmreYerli/mcp-firefly-iii/blob/main/docs/development/mcp-inspector.md) | Geliştirirken sunucuyu interaktif kurcalama |

Dokümantasyon sayfaları İngilizcedir.

## Geliştirme

```bash
git clone https://github.com/YakupEmreYerli/mcp-firefly-iii.git
cd mcp-firefly-iii
npm install
cp .env.example .env    # kendi örneğinizi girin
npm test                # mock'lu; canlı örneğe hiç dokunmaz
npm run build
npm run check           # .env'deki örneğe salt-okunur bağlantı kontrolü
```

## Katkı

Hata bildirimleri ve pull request'ler açığa. Kodun düzeni, testlerin nasıl
çalıştırılacağı ve dokunmadan önce bilinmesi gereken Firefly III tuhaflıkları
için [CONTRIBUTING.md](https://github.com/YakupEmreYerli/mcp-firefly-iii/blob/main/CONTRIBUTING.md).

Güvenlik açığı bulduysanız lütfen özel olarak bildirin —
[SECURITY.md](https://github.com/YakupEmreYerli/mcp-firefly-iii/blob/main/SECURITY.md).

## Lisans

MIT — bkz. [LICENSE](https://github.com/YakupEmreYerli/mcp-firefly-iii/blob/main/LICENSE).
