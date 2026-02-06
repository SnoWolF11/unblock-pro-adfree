# UnblockPro — Обход блокировок Discord и YouTube

<p align="center">
  <img src="assets/banner.png" alt="UnblockPro Banner" width="600">
</p>

<p align="center">
  <strong>Автоматический DPI bypass для macOS и Windows</strong><br>
  Разблокируй Discord, YouTube и другие сервисы в один клик
</p>

<p align="center">
  <a href="https://github.com/aspect-build/unblock-pro/releases/latest"><img src="https://img.shields.io/github/v/release/aspect-build/unblock-pro?style=for-the-badge&color=blue&label=Скачать" alt="Latest Release"></a>
  <a href="https://github.com/aspect-build/unblock-pro/releases/latest"><img src="https://img.shields.io/github/downloads/aspect-build/unblock-pro/total?style=for-the-badge&color=green&label=Скачиваний" alt="Downloads"></a>
  <a href="https://github.com/aspect-build/unblock-pro/blob/main/LICENSE"><img src="https://img.shields.io/github/license/aspect-build/unblock-pro?style=for-the-badge&color=purple" alt="License"></a>
</p>

---

## Скачать

| Платформа | Тип | Ссылка |
|-----------|-----|--------|
| **macOS** | DMG (установщик) | [UnblockPro-mac.dmg](https://github.com/aspect-build/unblock-pro/releases/latest) |
| **macOS** | ZIP (портативная) | [UnblockPro-mac.zip](https://github.com/aspect-build/unblock-pro/releases/latest) |
| **Windows** | Установщик | [UnblockPro-win-setup.exe](https://github.com/aspect-build/unblock-pro/releases/latest) |
| **Windows** | Портативная | [UnblockPro-win-portable.exe](https://github.com/aspect-build/unblock-pro/releases/latest) |

> Перейдите в [Releases](https://github.com/aspect-build/unblock-pro/releases/latest) и скачайте версию для вашей ОС

---

## Что это?

**UnblockPro** — десктопное приложение для обхода DPI-блокировок, которое позволяет пользоваться Discord, YouTube и другими сервисами без VPN. Работает на macOS и Windows.

### Ключевые возможности

- **Один клик** — нажмите «Подключить» и всё заработает
- **Автоматический подбор стратегии** — приложение само находит рабочий метод обхода для вашего провайдера
- **Проверка подключения** — стратегия проверяется реальным запросом, а не гаданием
- **macOS + Windows** — полная поддержка обеих платформ
- **Автозапуск** — запускается вместе с системой
- **Автоподключение** — подключается автоматически при старте
- **Системный трей** — работает в фоне, не мешает
- **Безопасная очистка** — прокси-настройки автоматически сбрасываются при выходе

---

## Как это работает

UnblockPro использует технологию [zapret](https://github.com/bol-van/zapret) для обхода Deep Packet Inspection (DPI):

| Платформа | Метод |
|-----------|-------|
| **macOS** | `tpws` — SOCKS5 прокси с модификацией пакетов. Приложение автоматически настраивает системный прокси |
| **Windows** | `winws` — перехватывает пакеты на уровне драйвера через WinDivert. Не требует настройки прокси |

Приложение последовательно тестирует несколько стратегий (split+disorder, split-tls, methodeol, oob и другие), пока не найдёт работающую для вашего провайдера.

---

## Установка

### macOS

1. Скачайте `.dmg` файл из [Releases](https://github.com/aspect-build/unblock-pro/releases/latest)
2. Откройте `.dmg` и перетащите UnblockPro в «Программы»
3. При первом запуске: **ПКМ → Открыть** (обход Gatekeeper)
4. Нажмите «Подключить»

### Windows

1. Скачайте установщик или портативную версию из [Releases](https://github.com/aspect-build/unblock-pro/releases/latest)
2. Запустите от имени администратора
3. Нажмите «Подключить»

> **Важно:** На Windows требуются права администратора для работы WinDivert

---

## Скриншоты

<p align="center">
  <em>Главный экран — статус подключения, управление в один клик</em>
</p>

---

## FAQ

<details>
<summary><strong>Это VPN?</strong></summary>
Нет. UnblockPro не шифрует трафик и не маршрутизирует его через удалённый сервер. Он модифицирует сетевые пакеты локально, чтобы DPI-системы провайдера не могли распознать и заблокировать запросы к Discord/YouTube.
</details>

<details>
<summary><strong>Безопасно ли это?</strong></summary>
Да. Приложение open-source, не собирает данные, не отправляет трафик через сторонние серверы. Весь код доступен для аудита.
</details>

<details>
<summary><strong>Что если приложение крашнется?</strong></summary>
Прокси-настройки автоматически сбрасываются при любом завершении: штатном, аварийном или через kill. При следующем запуске настройки также очищаются для надёжности.
</details>

<details>
<summary><strong>Discord/YouTube всё ещё не работает</strong></summary>
Попробуйте отключиться и подключиться заново — приложение переберёт другие стратегии. Если ни одна не помогла, возможно, ваш провайдер использует продвинутый DPI — создайте Issue.
</details>

<details>
<summary><strong>macOS просит разрешение</strong></summary>
При первом запуске macOS может показать предупреждение Gatekeeper. Нажмите ПКМ → Открыть, затем подтвердите.
</details>

---

## Разработка

```bash
# Клонировать репозиторий
git clone https://github.com/aspect-build/unblock-pro.git
cd unblock-pro

# Установить зависимости
npm install

# Запустить в режиме разработки
npm start

# Собрать для текущей ОС
npm run build

# Собрать для macOS
npm run build:mac

# Собрать для Windows
npm run build:win
```

---

## Стек

- **Electron** — кроссплатформенный фреймворк
- **zapret** — движок обхода DPI ([bol-van/zapret](https://github.com/bol-van/zapret))
- **electron-builder** — сборка и дистрибуция
- **GitHub Actions** — автоматические билды при релизе

---

## Лицензия

[MIT](LICENSE) — свободное использование, модификация и распространение.

---

<p align="center">
  <strong>by sonic</strong><br>
  <sub>Если проект помог — поставь ⭐️</sub>
</p>

---

### Ключевые слова / Keywords

> discord разблокировка, youtube разблокировка, обход блокировки discord, обход блокировки youtube, dpi bypass, антиблокировка, разблокировать дискорд, discord россия, youtube россия, zapret gui, обход dpi, discord unblock russia, youtube unblock russia, anti dpi, bypass discord block, unblock discord, unblock youtube
