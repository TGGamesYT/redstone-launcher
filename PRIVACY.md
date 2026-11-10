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

Only inside the folder the launcher creates. Nothing goes without being asked
for, in one of two ways.

**Switched on in *Settings → Cloud syncing*.** Each is a separate switch and
all of them start off. Once on, these are kept in step every time you sync:

- **Settings** — theme, colours, layout and similar preferences. Settings that
  belong to the computer rather than to you — where Java is, how much memory
  to use, which Google account this machine is signed in with — are
  deliberately excluded and never leave it.
- **Themes** you have made or installed.
- **Server list** — your saved multiplayer servers, as entries, so two
  computers' lists merge rather than one replacing the other.
- **Signed-in Minecraft accounts**, including the tokens that keep them
  signed in.

**Sent one at a time, when you ask for that one.** There is no switch for
these and no sweep that collects them: an instance goes when you choose *Save
to cloud* on that instance, and a world goes when you send that world.

- **Instances** — sent as a *description* rather than a copy: the mods are
  recorded by hash and fetched again from Modrinth or CurseForge on the other
  computer, and only the part that is yours (the config, your options) is
  actually uploaded. Other people's mod files are not put in your Drive —
  with one exception you choose yourself. When an instance holds a file that
  neither Modrinth nor CurseForge knows, it cannot be fetched again, so the
  launcher offers to carry its bytes instead; it names those files and their
  size, and it is off unless you tick it. Declining is a real option: the
  file is then recorded but not stored, and the other computer says it could
  not be found rather than building the instance without it.
- **Worlds** — each sent as an ordinary `.zip` you can download and use
  anywhere, either on its own or alongside the instance it belongs to, which
  asks you which of its worlds should come. A world is the opposite case to
  an instance: every byte of it is yours and none of it can be fetched from
  anywhere, so all of it goes.

When you play a synced world, the launcher also writes a small note into the
folder saying that this computer has it open, so that another computer is
warned before you both edit the same world. The note holds the world's name
and the name of this computer, is renewed while the game runs, and is removed
when it closes. A note nobody has renewed for ten minutes is ignored.

### What is encrypted, and what is not

The folder is a folder of ordinary files, on purpose. Your worlds are stored
as real `.zip` files and everything else as `.json`, so you can open the
folder in Drive, download a world, and drop it into your `saves/` directory
by hand — without this launcher, and without this launcher still existing.
Locking your own data inside a format only one program can read is not a
service we are willing to do you.

**The one exception is the file holding your signed-in Minecraft accounts**
(`accounts.rlc`). That one is encrypted on your computer before it is
uploaded, using AES-256-GCM, because it is the one piece that is worth
stealing: a Microsoft refresh token is not a password that can be changed
afterwards — it *is* the account. Google receives only ciphertext for that
file and cannot read it.

The small file named `key.json` holds *one half* of the key that file is
encrypted with, and is of no use by itself — see the next section.

**The trade, said plainly:** because the rest is readable, the folder
discloses *what you have* — your world names, your instance names, your
settings — to anyone who can see it. That is you, Google, and anyone you
choose to share the folder with. Nothing in it can be used to sign in as
you, and nothing in it is read by us. If you would rather not have that
visible, leave the switches off for the kinds you care about; each is
separate.

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

This document is published at <https://redstone-launcher.com/privacy>, which
renders this file. Its source, and every earlier version of it, is at
<https://github.com/TGGamesYT/redstone-launcher/blob/main/PRIVACY.md>.
