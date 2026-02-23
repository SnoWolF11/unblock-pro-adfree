#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

const listsDir = path.join(__dirname, '..', 'lists');
fs.mkdirSync(listsDir, { recursive: true });

const HOST_LIST_GENERAL = [
  'cloudflare-ech.com', 'encryptedsni.com', 'cloudflareaccess.com', 'cloudflareapps.com',
  'cloudflarebolt.com', 'cloudflareclient.com', 'cloudflareinsights.com', 'cloudflareok.com',
  'cloudflarepartners.com', 'cloudflareportal.com', 'cloudflarepreview.com', 'cloudflareresolve.com',
  'cloudflaressl.com', 'cloudflarestatus.com', 'cloudflarestorage.com', 'cloudflarestream.com',
  'cloudflaretest.com', 'dis.gd', 'discord-attachments-uploads-prd.storage.googleapis.com',
  'discord.app', 'discord.co', 'discord.com', 'discord.design', 'discord.dev', 'discord.gift',
  'discord.gifts', 'discord.gg', 'discord.media', 'discord.new', 'discord.store', 'discord.status',
  'discord-activities.com', 'discordactivities.com', 'discordapp.com', 'discordapp.net',
  'discordcdn.com', 'discordmerch.com', 'discordpartygames.com', 'discordsays.com',
  'discordsez.com', 'discordstatus.com',
  'gateway.discord.gg', 'cdn.discordapp.com', 'media.discordapp.net',
  'images-ext-1.discordapp.net', 'images-ext-2.discordapp.net',
  'dl.discordapp.net', 'updates.discord.com', 'router.discordapp.net',
  'sentry.io', 'sentry-cdn.com',
  'frankerfacez.com', 'ffzap.com', 'betterttv.net',
  '7tv.app', '7tv.io', 'localizeapi.com'
].join('\n');

const HOST_LIST_GOOGLE = [
  'yt3.ggpht.com', 'yt4.ggpht.com', 'yt3.googleusercontent.com',
  'googlevideo.com', 'jnn-pa.googleapis.com', 'stable.dl2.discordapp.net',
  'wide-youtube.l.google.com', 'youtube-nocookie.com', 'youtube-ui.l.google.com',
  'youtube.com', 'youtubeembeddedplayer.googleapis.com', 'youtubekids.com',
  'youtubei.googleapis.com', 'youtu.be', 'yt-video-upload.l.google.com',
  'ytimg.com', 'ytimg.l.google.com'
].join('\n');

const HOST_LIST_DISCORD = [
  'discord.com', 'discord.gg', 'discordapp.com', 'discordapp.net', 'discord.media',
  'discord.co', 'discord.gift', 'discord.gifts', 'discord.new', 'discord.store', 'discord.status',
  'discord.app', 'discord.design', 'discord.dev', 'discord-activities.com', 'discordactivities.com',
  'discordcdn.com', 'discordmerch.com', 'discordpartygames.com', 'discordsays.com', 'discordsez.com',
  'discordstatus.com', 'dis.gd', 'gateway.discord.gg', 'cdn.discordapp.com', 'dl.discordapp.net',
  'updates.discord.com', 'discord-attachments-uploads-prd.storage.googleapis.com',
  'media.discordapp.net', 'images-ext-1.discordapp.net', 'images-ext-2.discordapp.net',
  'router.discordapp.net'
].join('\n');

const HOST_LIST_EXCLUDE = [
  'pusher.com', 'live-video.net', 'ttvnw.net', 'twitch.tv',
  'mail.ru', 'citilink.ru', 'yandex.com', 'nvidia.com', 'donationalerts.com',
  'vk.com', 'yandex.kz', 'mts.ru', 'multimc.org', 'ya.ru', 'dns-shop.ru',
  'habr.com', '3dnews.ru', 'sberbank.ru', 'ozon.ru', 'wildberries.ru',
  'microsoft.com', 'msi.com', 'akamaitechnologies.com', '2ip.ru', 'yandex.ru',
  'boosty.to', 'tanki.su', 'lesta.ru', 'korabli.su', 'tanksblitz.ru', 'reg.ru'
].join('\n');

const IPSET_EXCLUDE = [
  '0.0.0.0/8', '10.0.0.0/8', '127.0.0.0/8', '172.16.0.0/12',
  '192.168.0.0/16', '169.254.0.0/16', '224.0.0.0/4', '100.64.0.0/10',
  '::1', 'fc00::/7', 'fe80::/10'
].join('\n');

const IPSET_ALL = '203.0.113.113/32';

fs.writeFileSync(path.join(listsDir, 'list-general.txt'), HOST_LIST_GENERAL, 'utf8');
fs.writeFileSync(path.join(listsDir, 'list-google.txt'), HOST_LIST_GOOGLE, 'utf8');
fs.writeFileSync(path.join(listsDir, 'list-discord.txt'), HOST_LIST_DISCORD, 'utf8');
fs.writeFileSync(path.join(listsDir, 'list-exclude.txt'), HOST_LIST_EXCLUDE, 'utf8');
fs.writeFileSync(path.join(listsDir, 'ipset-exclude.txt'), IPSET_EXCLUDE, 'utf8');
fs.writeFileSync(path.join(listsDir, 'ipset-all.txt'), IPSET_ALL, 'utf8');

const all = HOST_LIST_GENERAL + '\n' + HOST_LIST_GOOGLE + '\n' + HOST_LIST_DISCORD;
fs.writeFileSync(path.join(listsDir, 'list-all.txt'), all, 'utf8');

console.log('Lists generated in', listsDir);
console.log('Files:', fs.readdirSync(listsDir).join(', '));
