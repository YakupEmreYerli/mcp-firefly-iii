# Firefly III MCP Sunucusu

[![npm version](https://img.shields.io/npm/v/%40yakupemreyerli%2Ffirefly-mcp)](https://www.npmjs.com/package/@yakupemreyerli/firefly-mcp) [![CI](https://github.com/YakupEmreYerli/mcp-firefly-iii/actions/workflows/ci.yml/badge.svg)](https://github.com/YakupEmreYerli/mcp-firefly-iii/actions/workflows/ci.yml) [![license](https://img.shields.io/npm/l/%40yakupemreyerli%2Ffirefly-mcp)](LICENSE) [![MCP Registry](https://img.shields.io/badge/MCP%20Registry-active-brightgreen)](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.YakupEmreYerli%2Fmcp-firefly-iii/versions/latest) [![Glama](https://img.shields.io/badge/Glama-listed-6f42c1)](https://glama.ai/mcp/servers/@YakupEmreYerli/mcp-firefly-iii)

Kendi [Firefly III](https://www.firefly-iii.org/) örneğinize bir yapay zekâ asistanının erişmesini sağlayan bir Model Context Protocol sunucusu — 152 operasyon, 5 yetkilendirilmiş araç arkasında; okuma, yazma ve silme hepsini birden yapabilen tek bir araçta değil, ayrı ayrı yetkilendirilen üç ayrı yüzeyde.

> English: [README.md](README.md)

- *"Geçen ay en çok neye harcadım?"*
- *"Ağustos'taki kategorisiz işlemleri bul, kategori öner."*
- *"Tutarı artan abonelikleri göster."*

Herkes kendi Firefly örneğine, kendi token'ıyla bağlanır — arada barındırılan bir sunucu ya da aktarıcı yoktur.

Resmî [MCP Registry](https://registry.modelcontextprotocol.io/)'de `io.github.YakupEmreYerli/mcp-firefly-iii` adıyla, [Glama](https://glama.ai/mcp/servers/@YakupEmreYerli/mcp-firefly-iii)'da ve Firefly III'ün kendi [üçüncü-parti uygulamalar](https://docs.firefly-iii.org/references/firefly-iii/third-parties/apps/) belgesinde listelidir. Her sürüm etiketli bir commit'ten CI tarafından derlenip yayınlanır; [npm provenance](https://docs.npmjs.com/generating-provenance-statements) tarball'ın bu depodan çıktığını doğrular.

## Demo

https://github.com/user-attachments/assets/4452cc05-387d-44c6-8db4-c71bf3cf21cc

38 saniyelik demo: finansal bir soru sor, cevabı MCP üzerinden oku, değişikliği `dry_run` ile önizle, onayla ve Firefly III'e yaz. Sentetik bir örneğe karşı kaydedildi — görünen tüm finansal veriler uydurmadır.

## Özellikler

- **152 değil, 5 meta-tool.** `firefly_query`, `firefly_mutate`, `firefly_destructive`, keşif için de `firefly_list_operations` ve `firefly_get_schema` — tipli bir registry her Firefly ucunu bunların üzerine eşler, modelin araç listesini şişirmek yerine.
- **Her yazmada `dry_run`**; gönderilecek isteği — çözülmüş kayıt id'leriyle birlikte — hiç göndermeden döndürür.
- **Toplu yazmalar körlemesine çalışamaz.** Filtreyle çalışan güncellemeler `max_matches` ister ve eksik kalan bir taramayı ilk yazımdan önce reddeder; çok parçalı işlem gruplarını, tutarlarını katlama riskine girmektense tamamen reddeder.
- **Okuma/yazma/silme ayrı ayrı yetkilendirilir ve uygulanır**, yalnızca ilan edilmez — stdio'da Firefly token'ı, HTTP'de OAuth kapsamı ya da sabit token belirler.
- **Gömülü OAuth 2.1 authorization server**: Claude web, Claude mobil ve ChatGPT için ayrı bir Keycloak ya da Authentik kurmaya gerek yok.
- **Docker imajları** (`linux/amd64`/`linux/arm64`) ve araç kataloğunu kodla eşzamanlı tutan kendi kendini denetleyen bir dokümantasyon hattı.
- **Eskidiğini kendisi söyler.** Günde bir kez yeni sürüm var mı diye bakar; varsa bunu bir kez söyler — stderr'e bir satır, bir sonraki cevabın yanına bir cümle. `MCP_UPDATE_CHECK=false` ile kapanır.

## Ön koşullar

- Çalışan bir Firefly III örneği ve bir Personal Access Token (Firefly III → **Options → Profile → OAuth → Create New Personal Access Token**)
- Docker kullanmıyorsanız Node.js 20.6+

## Kullanım

| Yöntem | Taşıma | En uygun olduğu yer |
| --- | --- | --- |
| [`npx` — stdio](#1-stdio-claude-code-claude-desktop-cursor) | stdio | Claude Code, Claude Desktop, Cursor — en basit kurulum |
| [Sabit token](#2-uzak-http-sabit-token-ile) | HTTP | n8n, otomasyon, tarayıcısız çağıranlar |
| [OAuth](#3-uzak-http-oauth-ile-claude-web-claude-mobil-chatgpt) | HTTP + OAuth | Claude web, Claude mobil, ChatGPT — sabit token tutamazlar |
| [Docker](#4-docker) | HTTP | Kendi sunucunuzda, yukarıdaki iki moddan biriyle |

### 1. stdio (Claude Code, Claude Desktop, Cursor)

Kurulumu ona bırakın — Firefly III adresinizi ve token'ınızı sorar, gerçekten çalışıp çalışmadıklarını sınar, sonra bulursa Claude Code ve Claude Desktop'ı yapılandırır: `npx -y @yakupemreyerli/firefly-mcp setup`. Başka bir istemci kullanıyorsanız yapıştırmanız için yapılandırmayı ekrana basar.

Elle, Claude Code:

```bash
claude mcp add firefly --env FIREFLY_API_URL=kendi-firefly-adresiniz --env FIREFLY_API_TOKEN=token-degeriniz -- npx -y @yakupemreyerli/firefly-mcp
```

Elle, Claude Desktop / Cursor / diğer istemciler — MCP yapılandırma dosyasına ekleyin:

```json
{
  "mcpServers": {
    "firefly": {
      "command": "npx",
      "args": ["-y", "@yakupemreyerli/firefly-mcp"],
      "env": { "FIREFLY_API_URL": "kendi-firefly-adresiniz", "FIREFLY_API_TOKEN": "token-degeriniz" }
    }
  }
}
```

### 2. Uzak HTTP, sabit token ile

n8n, otomasyon ya da tarayıcı üzerinden OAuth akışı yürütemeyen her çağıran için. `.env` içinde `MCP_HTTP_TOKEN` ayarlayın, sonra `npx -y -p @yakupemreyerli/firefly-mcp firefly-mcp-http` çalıştırın. `/mcp`'ye gelen her istek `Authorization: Bearer <token>` taşımak zorundadır — tek token, tam erişim, bağlantı başına yetki kapsamı yok.

### 3. Uzak HTTP, OAuth ile (Claude web, Claude mobil, ChatGPT)

Bu istemcilerin hiçbiri sabit token tutamaz, hiçbiri yerel bir süreç de başlatamaz — herkese açık bir HTTPS adresine bağlanır ve OAuth beklerler. `MCP_AUTH_PASSWORD` ayarlıyken bu sunucu OAuth 2.1 authorization server'ın *kendisidir*: istemci kaydını, PKCE'yi ve token değişimini kendi yürütür, yani ne Keycloak gerekir, ne Google ile giriş, ne de bir yere kopyalanacak bir token.

**Adım 1 — sunucuya herkese açık bir HTTPS adresi verin.** Ev sunucusu için en kolay yol Cloudflare Tunnel (port yönlendirme yok, sertifika yok); VPS'te Caddy ya da Traefik iş görür. `compose.example.yml` tam bunun için `cloudflare` ve `caddy` profilleriyle gelir. Sonucun `https://mcp.example.com` olduğunu varsayalım.

**Adım 2 — `.env`'i yapılandırın:**

```dotenv
MCP_AUTH_PASSWORD=en-az-12-karakterlik-guclu-bir-parola
MCP_RESOURCE_URL=https://mcp.example.com
MCP_AUTH_STATE_DIR=/data/firefly-mcp-auth
```

`MCP_RESOURCE_URL`, **dışarıdan görünen origin'dir; birebir, yolsuz** — ne içerideki `http://firefly-mcp:3000`, ne de `/mcp` ile biten bağlantı URL'i. Uyuşmazsa token'ın audience kontrolü başarısız olur ve istemci yalnızca "invalid token" der. `MCP_AUTH_STATE_DIR` kalıcı bir volume üzerinde olmalı (`compose.example.yml` birini bağlıyor), yoksa her yeniden başlatma tüm istemcilerin yetkisini iptal eder.

**Adım 3 — başlatın ve doğrulayın:**

```bash
docker compose -f compose.example.yml up -d
curl https://mcp.example.com/health     # {"ok":true,"auth":"oauth-builtin"}
```

`auth` bunun yerine `bearer` diyorsa parola sürece hiç ulaşmamış demektir ve istemci sunucunun OAuth desteklemediğini bildirir.

**Adım 4a — Claude (web, Desktop, iOS/Android).** **Settings → Connectors → Add custom connector**, URL `https://mcp.example.com/mcp`. Kimlik doğrulama seçeneklerini tespit edildiği gibi bırakın — Claude sunucuyu yoklayıp desteklediği akışı kendisi seçer. Connector sonrasında giriş yaptığınız her Claude yüzeyinde çalışır, telefon dahil.

**Adım 4b — ChatGPT.** Özel connector / MCP ekranında aynı `https://mcp.example.com/mcp` adresini girin ve kimlik doğrulama yöntemi olarak **OAuth**'u seçin.

**Adım 5 — parolayı girin.** Tarayıcıda bir Firefly giriş ekranı açılır; `MCP_AUTH_PASSWORD` değerini yazın. Karar tümüyle o tek ekrandır — bağlantıya, istemcinin ne istediğine bakılmaksızın üç yetki kapsamının (`firefly:read`, `firefly:write`, `firefly:destructive`) tamamı verilir. İkinci bir onay ekranı yoktur: parolayı elinde tutan kişi zaten o ekrandaki her kutuyu işaretleyebilirdi. Gerçekten yazamayan bir bağlantı vermek istiyorsanız, sunucuya salt-okunur bir Firefly Personal Access Token verin.

Tüm TLS tarifleri ve sorun giderme: [docs/oauth.md](https://github.com/YakupEmreYerli/mcp-firefly-iii/blob/main/docs/oauth.md) (İngilizce).

### 4. Docker

Yukarıdaki iki HTTP modu için de önerilen yol:

```bash
cp .env.example .env    # ihtiyacınız olan moda göre değerleri doldurun
docker compose -f compose.example.yml up -d
```

Hazır imajı kullanmak için `compose.example.yml` içindeki `build: .` yerine `image: ghcr.io/yakupemreyerli/mcp-firefly-iii:latest` yazın — bağımlı olduğunuz bir yerde `:latest` değil, bir sürüm etiketi sabitleyin. Compose olmadan tek container: `docker run -d --env-file .env -p 3000:3000 ghcr.io/yakupemreyerli/mcp-firefly-iii:latest`. Yukarıdaki iki kimlik doğrulama modundan biri olmadan başlamaz, ve `/mcp`'nin önünde TLS gerekir — `compose.example.yml` bunun için isteğe bağlı `cloudflare` ve `caddy` profilleri taşır. `/health` açıktır, container probe'ları içindir.

## Yapılandırma

| Değişken | Varsayılan | İşlevi |
| --- | --- | --- |
| `FIREFLY_API_URL` | — | Zorunlu. Yalnızca alan adı, ya da `/api/v1` dahil tam URL. |
| `FIREFLY_API_TOKEN` | — | Zorunlu. Personal Access Token. |
| `FIREFLY_DISABLE_SSL_VERIFY` | `false` | Yalnızca kendinden imzalı sertifikalı yerel örnek için. |
| `MCP_UPDATE_CHECK` | `true` | Günlük yeni sürüm kontrolü. Sunucunun Firefly örneğiniz dışında yaptığı tek istek, ve hiçbir veri taşımaz. |

HTTP ve OAuth modu dahil tüm değişkenler: [docs/configuration.md](https://github.com/YakupEmreYerli/mcp-firefly-iii/blob/main/docs/configuration.md).

## Araçlar

| Araç | Cevapladığı soru | Risk |
| --- | --- | --- |
| `firefly_query` | Her şeyi oku. Açıklaması kataloğu taşır, seçim ek bir çağrıya mal olmaz. | salt-okunur |
| `firefly_mutate` | Kayıt oluştur veya değiştir. | yazar |
| `firefly_destructive` | Kayıt sil, ya da tek çağrıda çok kaydın bir alanını değiştir. | geri alınamaz |
| `firefly_list_operations` | Bu varlıkla ne yapabilirim? | salt-okunur |
| `firefly_get_schema` | Bu operasyon hangi parametreleri alıyor? | salt-okunur |

Ayrım yalnızca ilan edilmiyor, uygulanıyor — `firefly_query` üzerinden çağrılan bir silme reddedilir, yalnızca `firefly:read` verilmiş bir bağlantı yazan iki aracı hiç görmez. Yanıtlar modele ulaşmadan kırpılır: boş ve null alanlar her zaman düşer, çalıştırma araçlarının hepsi bir `fields` listesi alır — büyük bir işlem listesinde yaklaşık %90 küçülme. Tam referans: [docs/api/operations.md](https://github.com/YakupEmreYerli/mcp-firefly-iii/blob/main/docs/api/operations.md).

## Güvenlik

Bu sunucu verinizi üçüncü bir tarafa göndermez, ama bağladığınız yapay zekâ istemcisinin veya modelin eline geçen yanıtla ne yapacağını kontrol etmez. Tam tehdit modeli: [SECURITY.md](https://github.com/YakupEmreYerli/mcp-firefly-iii/blob/main/SECURITY.md). Güvenlik açığı bulduysanız lütfen oradan özel olarak bildirin.

## Dokümantasyon

| Sayfa | İçeriği |
| --- | --- |
| [Quickstart](https://github.com/YakupEmreYerli/mcp-firefly-iii/blob/main/docs/quickstart.md) | Token alma, istemciyi bağlama, ilk denemeler, sorun giderme |
| [Configuration](https://github.com/YakupEmreYerli/mcp-firefly-iii/blob/main/docs/configuration.md) | Tüm ortam değişkenleri, izin politikası, HTTP modu |
| [Remote access with embedded OAuth](https://github.com/YakupEmreYerli/mcp-firefly-iii/blob/main/docs/oauth.md) | Claude web, Claude mobil ve ChatGPT için deploy |
| [MCP Integration](https://github.com/YakupEmreYerli/mcp-firefly-iii/blob/main/docs/integrations.md) | Claude Code, Claude Desktop, Cursor, VS Code, n8n ve uzak HTTP |
| [Operations](https://github.com/YakupEmreYerli/mcp-firefly-iii/blob/main/docs/api/operations.md) | 152 operasyonun tamamı, yanıt kırpma, Firefly'ın tuzakları |
| [Analysis Operations](https://github.com/YakupEmreYerli/mcp-firefly-iii/blob/main/docs/api/analysis.md) | `summary.overview`, arama ve sekiz insight ucu |
| [MCP Inspector](https://github.com/YakupEmreYerli/mcp-firefly-iii/blob/main/docs/development/mcp-inspector.md) | Geliştirirken sunucuyu interaktif kurcalama |

Dokümantasyon sayfaları İngilizcedir.

## Geliştirme

```bash
git clone https://github.com/YakupEmreYerli/mcp-firefly-iii.git && cd mcp-firefly-iii
npm install
cp .env.example .env    # kendi örneğinizi girin
npm test                # mock'lu; canlı örneğe hiç dokunmaz
npm run build
npm run check           # .env'deki örneğe salt-okunur bağlantı kontrolü
```

Testler mock'ludur ve ağa hiç çıkmaz. `npm run smoke:live`, `.env`'deki örneğe karşı her okuma operasyonunu gezen bir bakım aracıdır; salt-okunurdur ve yayınlanan pakette yer almaz. Hata bildirimleri ve pull request'ler açığa — [CONTRIBUTING.md](https://github.com/YakupEmreYerli/mcp-firefly-iii/blob/main/CONTRIBUTING.md).

## Lisans

MIT — bkz. [LICENSE](https://github.com/YakupEmreYerli/mcp-firefly-iii/blob/main/LICENSE).
