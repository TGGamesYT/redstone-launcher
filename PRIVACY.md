# Redstone Launcher — Privacy Policy

**Last updated: 10 November 2026**

Redstone Launcher is a desktop application for managing and playing Minecraft.
It runs on your own computer. This policy covers the optional **Cloud syncing**
feature, which signs in with a Google account so that your launcher settings
and game data can follow you between computers through your own Google Drive.

Cloud syncing is **off until you turn it on**. If you never sign in with
Google, no part of this policy applies to you and the launcher never contacts
Google.

---

## 1. Who we are

Redstone Launcher is a free, open-source project. Its complete source code,
including every line described here, is published at
<https://github.com/TGGamesYT/redstone-launcher> and can be inspected and
verified by anyone.

Contact: <contact@redstone-launcher.com>

---

## 2. What we ask Google for, and why

When you turn on Cloud syncing, the launcher asks for exactly two permissions:

| Scope | What it allows | Why we ask |
|---|---|---|
| `https://www.googleapis.com/auth/drive.file` | Access **only to files this application itself creates** in your Drive | To create one folder, named **Redstone Launcher**, and read and write the sync files inside it |
| `https://www.googleapis.com/auth/userinfo.email` | Your Google account's email address | To show you which account is signed in, on the launcher's settings page |

We do not request any broader Drive scope. `drive.file` **cannot** see, list,
open, modify or delete anything in your Drive that the launcher did not create
itself. Your other documents, photos and files are not visible to this
application, and no amount of use of the launcher will make them visible to it.

We request no other Google scopes, and we use no other Google services.

---

## 3. What is stored in your Drive

Only inside the folder the launcher creates, and only the kinds you switch on.
Each is a separate switch and all of them start off:

- **Settings** — theme, colours, layout and similar preferences. Settings that
  belong to the computer rather than to you — where Java is, how much memory
  to use, which Google account this machine is signed in with — are
  deliberately excluded and never leave it.
- **Themes** you have made or installed.
- **Server list** — your saved multiplayer servers, as entries, so two
  computers' lists merge rather than one replacing the other.
- **Instances** — each one sent by name, as a *description* rather than a
  copy: the mods are recorded by hash and fetched again from Modrinth or
  CurseForge on the other computer, and only the part that is yours (the
  config, your options) is actually uploaded. Other people's mod files are
  not put in your Drive.
- **Worlds** — each one sent by name. A world is the opposite case: every
  byte of it is yours and none of it can be fetched from anywhere, so all of
  it goes, compressed.
- **Signed-in Minecraft accounts**, including the tokens that keep them
  signed in.

When you play a synced world, the launcher also writes a small note into the
folder saying that this computer has it open, so that another computer is
warned before you both edit the same world. The note holds the world's name
and the name of this computer, is encrypted like everything else, is renewed
while the game runs, and is removed when it closes. A note nobody has renewed
for ten minutes is ignored.

**Everything in that folder except one file is encrypted on your computer
before it is uploaded**, using AES-256-GCM. Google receives only ciphertext
and cannot read any of it. The file listing what you have synced is encrypted
too, so the folder does not disclose what you own even to someone who can see
it.

The single exception is a small file named `key.json`, which holds *one half*
of the encryption key and is of no use by itself — see the next section.

---

## 4. How the encryption key works

The key your data is encrypted with is split into two halves that are kept in
different places and belong to different accounts:

- **One half lives in the Drive folder** (`key.json`), created on the first
  computer you sync from.
- **The other half never touches Google.** It is derived by the Redstone
  Launcher relay server from your *Minecraft* account's UUID, and is handed to
  the launcher only over a connection on which Mojang has verified that you
  are signed in as that Minecraft account.

Neither half can decrypt anything on its own:

- Someone who obtains your Drive folder — including Google — has the first
  half and cannot get the second without being able to sign in to Minecraft as
  you.
- Someone who compromises our relay server has the second half for accounts
  that have asked for it, and no Drive to take the first half from.

The relay server never receives, stores or sees any of your synced data, your
Google account, your Google email address, or your Google tokens.

---

## 5. What is stored on your computer

- Your Google **refresh token** and **access token**, used to reach the folder
  the launcher created. These are stored locally, in the launcher's own
  settings, and are **never uploaded, never synced, and never sent to our
  relay or to anyone else**. The launcher deliberately excludes them from
  everything it syncs.
- Your Google account's email address, to display on the settings page.
- A random identifier and a name for this computer, so that when the same
  thing is changed on two computers the launcher can tell you which one.

---

## 6. What we do *not* do

- We do not sell, rent or trade your data. There is nobody to sell it to.
- We do not use your Google data for advertising, profiling or marketing.
- We do not use your Google data to train any model, including AI or machine
  learning models.
- We do not transfer your Google data to any third party, except that it is
  stored in your own Google Drive, by you, at your request.
- We operate no server that receives your Google data. The sync is between
  your computer and your own Drive.
- We do not read, scan or index the contents of what you sync. We could not:
  it is encrypted before it leaves your computer with a key we do not hold
  both halves of.

---

## 7. Limited Use

Redstone Launcher's use and transfer of information received from Google APIs
adheres to the
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
including the Limited Use requirements.

---

## 8. Keeping and deleting your data

You are in control of all of it, and nothing is kept anywhere we could delete
it for you, because nothing is kept anywhere but your own Drive and your own
computer.

**To stop syncing one thing** — the *Stop syncing* button beside it in
*Settings → Cloud syncing*. It is removed from your Drive and stays on your
computer.

**To stop syncing on one computer** — *Settings → Cloud syncing → Sign out*.
The launcher revokes its Google token with Google and deletes its local copy.
What is in your Drive is left alone, so your other computers keep working.

**To delete everything** — *Settings → Cloud syncing → Sign out and empty the
folder*. This deletes the launcher's folder and all its contents from your
Drive, including the key half. Nothing on your computer is touched.

**To revoke access at any time, from outside the launcher** — visit
<https://myaccount.google.com/permissions> and remove Redstone Launcher. The
launcher then loses access immediately. Files already in your Drive folder
remain yours and can be deleted from Drive like any others.

We apply no retention period of our own because we hold nothing: there is no
copy of your synced data on any server we run.

---

## 9. Children

Redstone Launcher is not directed at children under 13, and we do not
knowingly collect personal information from them.

---

## 10. Changes to this policy

If this policy changes, the date at the top changes with it, and the previous
versions remain visible in the project's public commit history at
<https://github.com/TGGamesYT/redstone-launcher/commits/main/PRIVACY.md>.

---

## 11. Contact

Questions about this policy, or about what the launcher does with your data:
<contact@redstone-launcher.com>, or open an issue at
<https://github.com/TGGamesYT/redstone-launcher/issues>.

This document is published at <https://github.com/TGGamesYT/redstone-launcher/blob/main/PRIVACY.md>.
