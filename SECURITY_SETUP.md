# Security Setup

This project now supports Firebase Authentication and Firestore rules without changing the current visual flow.

## 1. Create the admin user

In Firebase Console:

1. Open Authentication.
2. Enable Email/Password sign-in.
3. Create an admin user.
4. Recommended email for the existing login screen: `admin@bekadavet.com`.

The admin panel accepts either an email address or the existing `admin` username. When `admin` is used, it maps to `admin@bekadavet.com`.

## 2. Mark the user as admin

After creating the user, copy its Firebase Auth UID and create this Firestore document:

```text
admins/{uid}
```

Example fields:

```json
{
  "role": "admin",
  "createdAt": "manual"
}
```

## 3. Deploy rules

Install and authenticate Firebase CLI, then run:

```bash
firebase deploy --only firestore:rules
```

Until these rules are deployed, the live database keeps using the current Firebase Console rules.

## 4. Legacy access removed

The old local fallback password path has been removed. The admin panel now requires Firebase Authentication and the matching `admins/{uid}` document.

## 5. Public offer form

The public offer form writes through the Vercel API route `/api/create-offer`. Firestore no longer allows public writes to `teklifler`; only admins and server-side Firebase Admin SDK can write there.
