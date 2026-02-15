# Диагностика Discord (итоги тестирования)

## Что проверяли

1. **С обходом (winws запущен)**  
   - DNS: все Discord-домены резолвятся.  
   - TCP: discord.com:443, gateway, cdn, discord.media (443, 2053, 2083, 2087, 2096, 8443), YouTube — все поднимаются.  
   - TLS: discord.com, gateway.discord.gg, cdn.discordapp.com, discord.media, youtube.com — рукопожатие успешно (Tls13).  
   - HTTPS: discord.com/api/gateway — 200, discord.com/app — 200, youtube.com — 200.  
   - cdn.discordapp.com вернул 403 — типичная защита Cloudflare от прямых запросов без браузера, не DPI.

2. **Без обхода (winws выключен)**  
   - TCP до тех же хостов — везде OK.  
   - TLS: **discord.com — FAIL**, **gateway.discord.gg — FAIL**, **youtube.com — FAIL** (соединение режется во время TLS — типичное DPI).  
   - discord.media TLS без обхода — OK (провайдер не режет discord.media).

**Вывод:** DPI режет TLS до discord.com и gateway.discord.gg. С обходом наши тесты показывают, что соединения до Discord по TCP/TLS проходят.

## Почему Discord у тебя мог не работать

- Для всего TCP 443 использовался один жёсткий обход: **syndata+multidisorder**.  
- На части сетей такой обход может портить или иначе влиять на трафик Discord (формат пакетов, тайминги), из‑за чего клиент Discord ведёт себя как «не работает», хотя до других сайтов (YouTube) всё доходит.

## Что сделано в коде

1. **Стратегия «Discord first»**  
   Для трафика **только** Discord (по hostlist) по TCP 443 теперь применяется более мягкий обход (fake+badseq или multisplit/md5sig/split2), а для всего остального 443 (в т.ч. YouTube) по‑прежнему syndata+multidisorder.

2. **Отдельный hostlist для Discord**  
   - Файл `list-discord.txt` (в `userData/lists/`) с доменами: discord.com, discord.gg, discordapp.com, discord.media, gateway.discord.gg, cdn.discordapp.com и др.  
   - В комбо-стратегиях сначала идёт правило: `--filter-tcp=443 --hostlist=list-discord.txt` → обход для Discord, затем правило «весь остальной 443» → syndata для YouTube и прочих.

3. **Скрипты диагностики**  
   - `C:\Temp\discord-full-diagnostic.ps1` — полная проверка (DNS, TCP, TLS, HTTPS, UDP) при запущенном обходе.  
   - `C:\Temp\discord-diagnostic-no-bypass.ps1` — та же проверка без обхода (сначала убивает winws).  
   Результаты дописываются в `C:\Temp\discord-diagnostic-report.txt`.

## Что сделать у себя

1. Перезапусти приложение UnblockPro и заново подключись (чтобы подхватились новые стратегии и list-discord.txt).  
2. Полностью закрой Discord (в том числе из трея) и запусти его снова.  
3. Проверь: заходит ли в приложение, грузятся ли серверы/чаты, работает ли войс.  
4. Если что-то снова не работает — запусти диагностику и пришли вывод:
   ```powershell
   powershell -ExecutionPolicy Bypass -File "C:\Temp\discord-full-diagnostic.ps1"
   type C:\Temp\discord-diagnostic-report.txt
   ```
