# Arka Plan Bildirimleri Kurulumu

Bu proje PWA kapalıyken bildirim göndermek için Firebase Cloud Messaging ve Firebase Cloud Functions kullanır.

## 1. VAPID anahtarı oluştur

Firebase Console > Project settings > Cloud Messaging bölümünden Web Push certificates altında bir VAPID key oluşturun.

## 2. Admin paneline kaydet

Canlı sitede `admin.html` paneline giriş yapın.

1. Ayarlar sekmesine gidin.
2. Arka Plan Bildirimleri kartına VAPID anahtarını yapıştırın.
3. Bildirim Ayarını Kaydet butonuna basın.
4. Bu Cihazda Bildirimleri Aç butonuna basıp tarayıcı iznini verin.

Bu işlem cihazın FCM token bilgisini Firestore `pushTokens` koleksiyonuna kaydeder.

## 3. Firebase Functions deploy et

Firebase CLI kurulu ve giriş yapılmış bir terminalde:

```sh
npm --prefix functions install
firebase deploy --only firestore:rules,functions
```

Fonksiyon `Europe/Istanbul` saat diliminde her 30 dakikada bir çalışır. Yaklaşan ajanda notlarını ve yeni/yaklaşan teklifleri okuyup kayıtlı cihazlara FCM bildirimi gönderir.

## Notlar

- PWA kapalıyken bildirim için tarayıcı bildirim izni verilmiş olmalıdır.
- iPhone/iPad tarafında web push desteği ana ekrana eklenmiş PWA üzerinden çalışır.
- Firebase Functions için proje tarafında Cloud Functions, Cloud Scheduler ve Cloud Messaging servislerinin etkin olması gerekir.
