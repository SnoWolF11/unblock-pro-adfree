# Почему Discord не работал, хотя тесты говорили «ОК» — разбор и исправление UnblockPro v2.0

**TL;DR:** Обновил UnblockPro до v2.0. Discord теперь реально работает — не только проходит тесты, но и загружает приложение, подключается к голосовым каналам и ведёт себя как положено. Разобрался, почему «всё ОК» в тестах, но Discord молча висит на «Проблемы с подключением». Оказалось, проблема была в архитектуре фильтрации — не хватало трёх ключевых правил, и DPI тихо дропал соединения, которые тесты не проверяли. Код на GitHub — [by-sonic/unblock-pro](https://github.com/by-sonic/unblock-pro).

---

### Предыстория

Два месяца назад я [выложил UnblockPro](https://habr.com/ru/articles/994412/) — Electron-приложение, которое в один клик обходит DPI-блокировки Discord и YouTube. Статья набрала 50к+ просмотров, 22к звёзд на GitHub, 192 закладки на Хабре. Люди скачивали, пользовались, ставили звёзды.

И параллельно писали в issues: **«YouTube работает, а Discord — нет»**.

Причём у части пользователей всё работало отлично. А у другой части — Discord висел на «Connecting...» или «Проблемы с подключением», хотя приложение рапортовало: «Стратегия X работает!». Тесты проходили. Логи были зелёные. Но Discord — нет.

Я потратил неделю на поиск причины. И нашёл. Проблема оказалась гораздо глубже, чем я думал.

---

### Детективная история: «Тесты ОК, Discord не ОК»

#### Что проверяли тесты

Мой тестовый алгоритм проверял:

1. **YouTube TLS** — `https://www.youtube.com/`, CDN-картинки, API
2. **Discord API** — `https://discord.com/api/v10/gateway`
3. **Discord WebSocket** — TLS-рукопожатие с `gateway.discord.gg:443`, проверка ответа `101 Switching Protocols`
4. **Discord media** — попытка соединения с `discord.media:443`

Все четыре проверки проходили. Стратегия объявлялась рабочей. Но Discord-приложение не загружалось.

#### Что на самом деле нужно Discord

Discord — это не просто «один сайт на 443 порту». Это целая экосистема соединений:

| Тип трафика | Протокол | Порты | Что делает |
|---|---|---|---|
| Web API | TCP | 443 | REST API, авторизация, загрузка данных |
| WebSocket Gateway | TCP | 443 | Real-time события (сообщения, статусы) |
| CDN | TCP | 443 | Аватарки, вложения, эмодзи |
| Voice/Video | UDP | 19294–19344 | Голосовые и видеозвонки |
| Voice Extended | UDP | 50000–50100 | Дополнительные голосовые порты |
| Media Gateway | TCP | 2053, 2083, 2087, 2096, 8443 | Альтернативные TLS-порты для медиа |
| QUIC | UDP | 443 | HTTP/3 для быстрой загрузки |

Мои тесты проверяли первые три строки. Остальные — **нет**.

#### Шесть причин, почему Discord не работал

Я взял проект [Flowseal/zapret-discord-youtube](https://github.com/Flowseal/zapret-discord-youtube) (22к+ звёзд, де-факто стандарт для обхода DPI в России) и побайтово сравнил каждый `.bat`-файл стратегии с моим кодом. Нашёл **шесть** критических отличий.

---

### Причина 1: Архитектура «5 правил» vs. «8 правил»

Это был главный баг.

Flowseal использует **8 правил фильтрации** на каждую стратегию. Каждое правило — отдельный `--new` блок в winws, каждое отвечает за свой тип трафика:

```
Правило 1: UDP 443 + список доменов     → QUIC-трафик Discord/YouTube
Правило 2: UDP 19294–50100 + L7=discord  → Голосовой чат
Правило 3: TCP 2053,2083,2087,2096,8443  → Discord media
Правило 4: TCP 443 + список Google       → YouTube (с ip-id=zero)
Правило 5: TCP 80,443 + список Discord   → Discord web/API
Правило 6: UDP 443 + IP-сет             → QUIC для IP без домена  ← НЕ БЫЛО
Правило 7: TCP 80,443 + IP-сет          → TCP для IP без домена   ← НЕ БЫЛО
Правило 8: UDP game + any-protocol       → Catch-all для UDP       ← НЕ БЫЛО
```

У меня было только **5 правил**. Правила 6, 7 и 8 отсутствовали.

Почему это критично? Discord и YouTube используют CDN и серверы, IP-адреса которых **не всегда резолвятся через домены из хост-листа**. Например, `googlevideo.com` может отдать IP, который потом используется для стриминга видео без повторного DNS-резолва. Эти «безымянные» соединения по IP проваливались через DPI без обработки.

Правило 6 и 7 — это **IPSet-fallback**: если трафик не поймался по доменному имени (правила 1–5), он ловится по набору IP-адресов. А правило 8 — catch-all для UDP с `--dpi-desync-any-protocol=1`, которое обрабатывает вообще любой UDP-трафик по известным IP.

### Причина 2: Отсутствие `--hostlist-exclude` и `--ipset-exclude`

Flowseal исключает из обработки:

**Домены:** `yandex.ru`, `vk.com`, `mail.ru`, `ozon.ru`, `wildberries.ru`, `sberbank.ru` и ещё 30+ российских сервисов.

**IP-диапазоны:** `10.0.0.0/8`, `192.168.0.0/16`, `127.0.0.0/8`, `172.16.0.0/12` и другие приватные сети.

Без этих исключений winws мог пытаться обрабатывать пакеты, адресованные локальным сервисам, роутеру или VPN. Это создавало ложные срабатывания и замедляло обработку целевого трафика.

### Причина 3: Отсутствие `--hostlist-domains=discord.media` на медиа-портах

На портах 2053, 2083, 2087, 2096, 8443 Flowseal фильтрует **только** домен `discord.media`. Мой код ловил **весь** трафик на этих портах. Казалось бы, больше = лучше? Нет. Без доменного фильтра winws мог случайно обработать трафик других сервисов, использующих те же порты (например, Cloudflare API на порту 2053).

### Причина 4: Отсутствие семейства FAKE TLS AUTO

Flowseal имеет целое семейство стратегий `FAKE TLS AUTO`, которые используют:

```
--dpi-desync=fake,multidisorder
--dpi-desync-fake-tls=0x00000000
--dpi-desync-fake-tls=!
--dpi-desync-fake-tls-mod=rnd,dupsid,sni=www.google.com
```

Это генерация фейковых TLS-пакетов с рандомизацией, дублированием Session ID и подменой SNI на `www.google.com`. DPI видит, что клиент «идёт на Google», пропускает, а реальный трафик уходит в другом пакете. Эти стратегии работают на провайдерах с продвинутым DPI (некоторые регионы МТС, Ростелеком с новым оборудованием).

У меня их не было вообще.

### Причина 5: Неполный список доменов Google/YouTube

В моём `list-google.txt` не хватало:

- `yt4.ggpht.com` — CDN YouTube-аватарок
- `jnn-pa.googleapis.com` — YouTube analytics
- `stable.dl2.discordapp.net` — Discord updates через Google CDN
- `wide-youtube.l.google.com` — YouTube wide format streams
- `youtubekids.com` — YouTube Kids
- `yt-video-upload.l.google.com` — загрузка видео
- `ytimg.l.google.com` — CDN превью

А в `list-general.txt` были YouTube-домены, хотя по архитектуре Flowseal они должны быть **только** в `list-google.txt`. Правило 4 (Google TCP 443) использует `--ip-id=zero`, а правило 5 (General TCP) — нет. Смешивая списки, я ломал эту логику.

### Причина 6: Ненадёжное обновление hosts

Discord голосовой чат подключается к серверам вида `finland10042.discord.media`. Провайдеры могут блокировать DNS-резолв этих доменов. Flowseal решает это записью в файл `hosts`:

```
104.25.158.178 finland10000.discord.media
104.25.158.178 finland10001.discord.media
...
104.25.158.178 finland10199.discord.media
```

Мой код скачивал этот файл с GitHub при каждом подключении. Но если интернет ещё не работал (мы же только подключаемся!) или GitHub был недоступен — скачивание молча падало, hosts не обновлялся, и голосовой чат Discord не мог зарезолвить сервера.

---

### Что я сделал в v2.0

#### 1. Архитектура 8 правил

Каждая стратегия теперь следует полной 8-правильной архитектуре Flowseal:

```javascript
function std8(method, r3extra, r4extra, r5extra, r7extra, opts = {}) {
  return [
    ...WF_FULL,
    ...rule1_udpQuic(opts.quicRepeats || 6),    // QUIC по домену
    ...rule2_udpDiscordVoice(),                   // Discord voice + STUN
    ...rule3_discordMedia(method, r3extra),        // Discord media ports
    ...rule4_google(method, r4extra),              // YouTube (ip-id=zero)
    ...rule5_generalTcp(method, r5extra),          // Discord web/API
    ...rule6_ipsetUdpFallback(opts.quicRepeats),   // QUIC IP fallback
    ...rule7_ipsetTcpFallback(method, r7extra),    // TCP IP fallback
    ...rule8_gameUdp(opts.gameRepeats, opts.cutoff) // UDP catch-all
  ];
}
```

Теперь ни один тип трафика не проскакивает мимо DPI bypass.

#### 2. Полный набор списков

```javascript
// Отдельные списки — как в Flowseal
ensureHostLists() создаёт:
  list-general.txt    // Discord + Cloudflare (БЕЗ YouTube!)
  list-google.txt     // YouTube + Google (17 доменов)
  list-discord.txt    // Только Discord (для combo-стратегий)
  list-exclude.txt    // Российские сервисы (32 домена)
  ipset-exclude.txt   // Приватные IP-диапазоны
  ipset-all.txt       // IP-сет для fallback-правил
```

#### 3. 19 стратегий из Flowseal + combo-стратегии

Полный набор из Flowseal v1.9.6:

| # | Название | Метод | Особенность |
|---|---|---|---|
| 1 | general | multisplit 681/568 | Дефолт Flowseal, работает у большинства |
| 2 | ALT | fake,fakedsplit | С TLS-паттернами |
| 3 | ALT2 | multisplit 652 | С seqovl-паттерном |
| 4 | ALT3 | fake,hostfakesplit | TLS mod rnd,dupsid,sni |
| 5 | ALT4 | fake,multisplit | badseq increment=1000 |
| 6 | ALT5 | syndata,multidisorder | Агрессивный (не рекомендуется) |
| 7 | ALT6 | multisplit 681 | 681 везде (без разделения) |
| 8 | ALT7 | fake badseq=2 | Простой fake с badseq |
| 9 | ALT8 | fake badseq=10M | Большой increment |
| 10 | ALT9 | hostfakesplit | С подменой хоста |
| 11 | ALT10 | multisplit 652 | Без паттерна |
| 12 | ALT11 | fake,multisplit 681 | С ts fooling, repeats=8 |
| 13 | SIMPLE FAKE | fake ts | Простейший |
| 14 | SIMPLE FAKE ALT | fake,fakedsplit ts | Простой + fakedsplit |
| 15 | SIMPLE FAKE ALT2 | fake badseq=2 | Простой + badseq |
| 16 | FAKE TLS AUTO | fake,multidisorder | TLS mod + sni=google |
| 17 | FAKE TLS AUTO ALT | fake,multidisorder | Вариант с repeats=11 |
| 18 | FAKE TLS AUTO ALT2 | fake,multidisorder | + badseq increment=2 |
| 19 | FAKE TLS AUTO ALT3 | fake,multidisorder | + ts,badseq fooling |

Плюс 2 combo-стратегии, которые используют разные методы для Discord и YouTube одновременно (Discord получает мягкий desync, YouTube — агрессивный syndata).

#### 4. Встроенный fallback для hosts

Если GitHub недоступен при подключении, hosts-данные генерируются из встроенных в приложение данных:

```javascript
function generateFallbackHostsData() {
  const lines = [];
  // Telegram web — 30 доменов
  for (const d of tgDomains) lines.push(`149.154.167.220 ${d}`);
  // Discord voice — 200 серверов
  for (let i = 10000; i <= 10199; i++) {
    lines.push(`104.25.158.178 finland${i}.discord.media`);
  }
  return lines.join('\n');
}
```

Также добавлена проверка: если hosts уже содержит наш маркер — пропускаем обновление полностью. Нет лишних запросов, нет лишних UAC-диалогов.

---

### Как это выглядит в цифрах

| Метрика | v1.0 | v2.0 |
|---|---|---|
| Стратегий Windows | 16 | 21 (19 Flowseal + 2 combo) |
| Правил фильтрации | 5 | 8 |
| Списков доменов | 3 | 6 |
| Доменов YouTube | 11 | 17 |
| Исключённых доменов | 0 | 32 |
| IP-диапазонов исключений | 0 | 11 |
| Голосовых серверов Discord в hosts | 0 (скачивание) | 200 (встроено) |
| Discord реально работает | Не всегда | Да |

---

### Технический разбор: как работает правило 6 (IPSet fallback)

Допустим, YouTube отдал вам IP `142.250.185.46` для стриминга видео. Ваш браузер начинает лить трафик на этот IP через QUIC (UDP 443).

**v1.0:** Правило 1 проверяет UDP 443 по хост-листу (`list-general.txt`). Но в UDP-пакете нет заголовка `Host` — это QUIC, он зашифрован. Если IP не резолвится обратно в домен из списка — пакет **пролетает мимо**. DPI видит его, распознаёт как YouTube, дропает.

**v2.0:** Правило 1 не поймало → Правило 6 ловит по IP-сету. Даже если домен неизвестен, но IP входит в набор — пакет обрабатывается. Фейковый QUIC Initial отправляется, DPI обманут.

Та же логика для TCP (правило 7): Discord может подключаться к CDN-серверам по IP, минуя DNS. Правило 7 ловит эти соединения.

---

### Как обновиться

Если у вас уже установлен UnblockPro — он обновится автоматически (встроенный auto-updater). Или скачайте вручную:

**GitHub:** [github.com/by-sonic/unblock-pro](https://github.com/by-sonic/unblock-pro)
**Releases:** [Скачать последнюю версию](https://github.com/by-sonic/unblock-pro/releases)

---

### Что дальше

- **Linux** — tpws нативно работает на Linux, осталось сделать GUI
- **Whitelist/blacklist** — выбор, какие сайты обходить
- **Автоматическое обновление стратегий** — подтягивание новых .bat из Flowseal без обновления приложения
- **Диагностика** — встроенный тест всех эндпоинтов Discord и YouTube с детальным отчётом

---

### Вместо заключения

Эта история — классический пример того, как «зелёные тесты» не означают «работающий продукт». Мои тесты проверяли HTTP API и TLS handshake, но Discord — это не REST API. Это WebSocket, QUIC, UDP voice, CDN, media gateways на нестандартных портах. И каждый из этих каналов может быть заблокирован независимо.

Урок простой: **тестируй то, что тестирует пользователь**, а не то, что удобно тестировать тебе.

Проект полностью open-source. Код открыт, стратегии из проверенного Flowseal. Если нашли баг — заводите issue. Если помогло — звезда на GitHub.

**GitHub:** [github.com/by-sonic/unblock-pro](https://github.com/by-sonic/unblock-pro)

**by sonic**

---

*Теги: discord, youtube, dpi, bypass, zapret, electron, windows, обход блокировок, deep packet inspection, windivert*
