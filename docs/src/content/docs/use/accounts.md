---
title: Accounts
description: Signing up, passwords and word passwords, backup phrases, guests, several accounts and deleting an account.
sidebar:
  order: 1
---

An account lives on one instance. It has a username and a password, and no email address or phone number.

## Signing up

Open the instance and choose Create account. A username has 1 to 100 characters, matches in any case, and can't pass for another account's name in look-alike characters. Sign-up is open, closed, or only through single sign-on, as the instance chooses.

The password is any non-empty text. A word password is the other choice: every username has a fixed set of 20 words, anyone can see that set, and the password is your pick of 7 of them, in order.

## Signing in

Each account admits one sign-in attempt every 3 seconds and 1000 a day (UTC). Past that, it stays locked until the next day. A session lasts until you sign out, unless the instance limits session age or idle time. Changing your password signs out every other session.

An account created by the instance's admin starts with a temporary password, and the app asks you to choose your own at the first sign-in.

## Backup phrase

Settings → Profile → Sign-in sets a backup phrase, when the instance allows it. Signing in with the phrase sets a new password and signs out every other session. Without a backup phrase or a linked sign-in provider, a lost password can only be reset by the instance's admin.

## Profile

Settings → Profile → Your profile holds the display name, picture, avatar, banner and about me. Upload picture takes a PNG, JPEG, GIF or WebP image and a square crop of it. The identicon or color avatar stays and shows while the picture loads. Members can also set a name, picture, avatar, banner and description for one server, where the server and the instance allow it. Who sees your profile and can find you by name is under Settings → Privacy.

## Guests

On instances that allow it, Continue as a guest on the sign-in page opens servers that anyone can read, without an account. Guests read and get live updates. They send text and join voice only in servers whose managers turned that on, on sites that allow it. Guests stay out of the online member list.

## Several accounts and instances

The app holds several accounts, on one instance or many, side by side. The account switcher (Ctrl+Shift+L, or ⌘+Shift+L on Apple devices) moves between them. Add an instance from the server rail.

## Deleting your account

Settings → Profile → Sign-in deletes the account after 14 days and signs it out everywhere. Signing in again within those days keeps it. After 14 days the account, its messages and its direct messages are deleted.
