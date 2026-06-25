# Arka Plan Bildirimleri Kurulumu

Bu proje PWA kapalıyken bildirim göndermek için Firebase Cloud Messaging ve Vercel API/Cron kullanır. Firebase Functions kullanılmadığı için Blaze plan gerekli değildir.

## 1. VAPID anahtarı oluştur

Firebase Console > Project settings > Cloud Messaging bölümünden Web Push certificates altında bir VAPID key oluşturun.

## 2. Admin paneline kaydet

Canlı sitede `admin.html` paneline giriş yapın.

1. Ayarlar sekmesine gidin.
2. Arka Plan Bildirimleri kartına VAPID anahtarını yapıştırın.
3. Bildirim Ayarını Kaydet butonuna basın.
4. Bu Cihazda Bildirimleri Aç butonuna basıp tarayıcı iznini verin.

Bu işlem cihazın FCM token bilgisini Firestore `pushTokens` koleksiyonuna kaydeder.

## 3. Vercel ortam değişkenlerini ekle

Firebase servis hesabı JSON dosyası oluşturun:

1. Firebase Console > Project settings > Service accounts bölümüne gidin.
2. Generate new private key butonuna basın.
3. İndirilen JSON dosyasını base64 metne çevirin:

```sh
base64 -i ~/Downloads/service-account.json | tr -d '\n' | pbcopy
```

Vercel projesine şu environment variable değerlerini ekleyin:

```txt
FIREBASE_PROJECT_ID=bekadavet-bfe6f
FIREBASE_SERVICE_ACCOUNT_BASE64=<pbcopy ile kopyalanan uzun metin>
CRON_SECRET=<uzun rastgele gizli anahtar>
```

Manuel test için:

```sh
curl "https://bekadavet.com/api/send-reminders?secret=<CRON_SECRET>"
```

## 4. Firestore kurallarını deploy et

Firebase tarafında sadece Firestore rules deploy edilir:

```sh
npx -y firebase-tools deploy --only firestore:rules --project bekadavet-bfe6f
```

Vercel cron Türkiye saatiyle yaklaşık 09:00 ve 18:00 saatlerinde çalışır. Yeni fiyat teklifleri ise `/api/create-offer` üzerinden kaydedildiği anda bildirim gönderir.

## Notlar

- PWA kapalıyken bildirim için tarayıcı bildirim izni verilmiş olmalıdır.
- iPhone/iPad tarafında web push desteği ana ekrana eklenmiş PWA üzerinden çalışır.
- Daha sık hatırlatma için Vercel Pro veya harici zamanlayıcı gerekir.
