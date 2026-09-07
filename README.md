# TON Lottery — Version 2 Termux Shell

این پروژه یک پوسته واقعی Telegram Mini App است: رابط فارسی، Telegram WebApp session validation، و TON Connect با تأیید صریح کاربر.

## اجرا در Termux
```bash
pkg update -y
pkg install nodejs git -y
unzip ton-lottery-v2-termux.zip
cd tonlottery2
npm install
cp .env.example .env
nano .env
npm start
```

برای استفاده عمومی، Mini App باید روی دامنه HTTPS منتشر شود. مقدار `PUBLIC_APP_URL` و URL داخل `web/tonconnect-manifest.json` را با دامنه واقعی خود جایگزین کنید.

## متغیرها
- `TELEGRAM_BOT_TOKEN`: توکن ربات؛ فقط روی سرور.
- `PUBLIC_APP_URL`: آدرس HTTPS برنامه.
- `TREASURY_ADDRESS`: فقط آدرس عمومی خزانه؛ کلید خصوصی هرگز داخل پروژه قرار ندهید.

## نکته مهم
این نسخه عمداً **دریافت TON واقعی برای قرعه‌کشی، انتخاب خودکار برندگان و پرداخت خودکار جوایز** را پیاده‌سازی نمی‌کند. endpoint پرداخت با 501 پاسخ می‌دهد. بنابراین این فایل برای اتصال واقعی کیف پول و ساخت زیرساخت Mini App است، نه موتور عملیاتی قرعه‌کشی با پول واقعی.
