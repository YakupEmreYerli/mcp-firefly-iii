# Firefly III MCP Sunucusu

Bu projenin ajan talimatları tek bir dosyada tutulur: **[`CLAUDE.md`](CLAUDE.md)**.
Hangi ajanla çalışıyor olursanız olun, okunacak dosya orası.

Burada içerik yok çünkü iki kopya tutmayı denedik ve kopyalar ayrıştı: bu dosya,
`firefly_execute` üç ayrı çalıştırma yüzeyine bölündükten sonra da onu
anlatmaya devam etti — `read`/`write` ikili etiketini, `registry._ENTITY_HINTS`
diye artık var olmayan bir sembolü ve yalnızca tek bir uçta görüldüğü sanılan bir
Firefly hatasını da. Talimatların yanlış olması, hiç olmamasından kötüdür; o
yüzden burası artık bir işaret, bir kopya değil.

Harness'a özel tek not: kaynak kodda veya `.env`'de yapılan değişiklikler, MCP
istemcisi yeniden başlatılana kadar çalışan sürece yansımaz. Hem Claude Code'da
hem Codex'te bu `/mcp` komutu.
