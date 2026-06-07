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

## 4. Keep legacy access only during transition

The old `admin / beka2025` fallback remains in the code so the working panel is not locked out during setup. After Firebase Auth is confirmed in production, remove the fallback password path from `admin.html`.
