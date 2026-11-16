# Putting the launcher on the Microsoft Store

Every push that releases a new version already builds Windows, Linux and
macOS. Once the settings below are in place, the Windows job also packs the
same app as an **MSIX** (`scripts/build-msix.mjs`) and **submits it to the
Microsoft Store** with Microsoft's own Store CLI. Until they are in place,
those steps are skipped and nothing else changes.

There are four parts: a Partner Center account, the app reserved in it, an
Entra ID (Azure AD) app that lets GitHub submit on your behalf, and the
first submission, which has to be made by hand.

---

## 1. A Partner Center developer account

1. **As an individual** (free): go to <https://storedeveloper.microsoft.com>,
   press **Get started for free** and pick **Individual developer**. Sign in
   with a **personal** Microsoft account (outlook.com, hotmail, Xbox and so
   on). A work or school account does not work for this.
   **As a company**: the same page, **Company**, and here it is a work
   (Entra ID) account.
2. Keep using that same account. Only the account that signed up owns the
   developer account: any other one gets **"Access restricted"** on every
   Partner Center page, and so does the old
   `partner.microsoft.com/dashboard/registration` link, which is not the way
   in for individuals any more.
3. Finish the identity verification it asks for. **Apps & Games** can take
   5 to 30 minutes to appear afterwards; refresh until it does. Company
   accounts can take a few days. Problems with the sign-up itself go to
   storesupport@service.microsoft.com.

## 2. Reserve the app and read its identity

1. Partner Center → **Apps and games** → **New product** → **MSIX or PWA app**.
2. Reserve the name **Redstone Launcher**, or whatever it should be called in
   the Store.
3. Open the product → **Product management** → **Product identity**. Four of
   the values on that page are needed:

   | On the page                         | What it looks like                         |
   |-------------------------------------|--------------------------------------------|
   | Package/Identity/Name               | `12345YourName.RedstoneLauncher`           |
   | Package/Identity/Publisher          | `CN=1A2B3C4D-....`                         |
   | Package/Properties/PublisherDisplayName | `Your Name`                            |
   | Store ID                            | `9NXXXXXXXXXX` (12 characters)             |

## 3. Let GitHub submit for you

The Store CLI uses the Partner Center submission API, which signs in as an
Entra ID application rather than as you.

> **An individual account has no Entra directory**, so User management says
> to sign in with Microsoft Entra ID and then turns your personal account
> away ("You can't sign in here with a personal account"). Two ways on:
>
> - **Skip this part.** Set only the three variables in step 4, leave the
>   secrets out, and every release still builds the MSIX as a workflow
>   artifact (`redstone-launcher-msix`), which you upload in Partner Center
>   on a new submission. Nothing else changes.
> - **Make a directory of your own** and associate it: a free Azure account
>   (<https://azure.microsoft.com/free>) creates one; in
>   <https://entra.microsoft.com> add a user such as
>   `admin@<directory>.onmicrosoft.com` with the Global Administrator role;
>   then in Partner Center **Account settings → Tenants → Associate**, sign in
>   as that user. It is not certain an individual account accepts one; if it
>   does not, the first way is what is left.

1. Partner Center → the gear icon → **Account settings** → **User
   management** → **Microsoft Entra applications** → **Create Microsoft
   Entra application**. If it asks you to associate a tenant first, follow
   its link and do that.
2. Give it the role **Manager**. **Developer** may also work; Manager is
   the one Microsoft's own instructions use.
3. On the app's page:
   - copy the **Tenant ID** and the **Client ID**;
   - **Add new key** and copy the key immediately. That is the **client
     secret**, and it is shown only once.
4. Partner Center → **Account settings** → **Legal info** → **Developer**
   tab → copy the **Seller ID**.

## 4. Put them in GitHub

Repository → **Settings** → **Secrets and variables** → **Actions**.

**Variables** (not secret: anyone can see them on the Store listing). Secrets
under the same names also work:

| Name                              | Value                                      |
|-----------------------------------|--------------------------------------------|
| `MS_STORE_IDENTITY_NAME`          | Package/Identity/Name                      |
| `MS_STORE_PUBLISHER`              | Package/Identity/Publisher (with `CN=`)    |
| `MS_STORE_PUBLISHER_DISPLAY_NAME` | Package/Properties/PublisherDisplayName    |

**Secrets**:

| Name                       | Value                              |
|----------------------------|------------------------------------|
| `MS_STORE_PRODUCT_ID`      | the Store ID (`9N...`)             |
| `MS_STORE_TENANT_ID`       | the Entra application's Tenant ID  |
| `MS_STORE_CLIENT_ID`       | the Entra application's Client ID  |
| `MS_STORE_CLIENT_SECRET`   | the key from step 3                |
| `MS_STORE_SELLER_ID`       | the Seller ID                      |

With only the three variables set, every release builds the MSIX and keeps
it as a workflow artifact (`redstone-launcher-msix`) without submitting it.
With the secrets set as well, it is submitted.

## 5. The first submission is made by hand

The submission API can only *update* an app that already has a submission.
The first one is done in Partner Center:

1. Set the three variables from step 4 and let a release run, or re-run the
   last one. Download the `redstone-launcher-msix` artifact from that run.
2. Partner Center → the product → **Start your submission**, and fill in:
   - **Pricing and availability**: Free; the markets.
   - **Properties**: category *Utilities & tools* or *Games → Simulation*.
     Privacy policy URL: the published PRIVACY.md.
   - **Age ratings**: the IARC questionnaire.
   - **Packages**: upload the `.msix` from step 1.
   - **Store listings**: description, screenshots (at least one, 1366×768
     or larger), the logo.
   - **Submission options → Restricted capabilities**: the package asks for
     two, and certification wants a reason for each. Something like:
     - `runFullTrust`: *"A desktop (Win32) application packaged with MSIX;
       it starts the Java runtime and the game as separate processes."*
     - `unvirtualizedResources`: *"The launcher keeps game installations,
       Java runtimes and worlds in %APPDATA%\Redstone Launcher. The game
       process, Java, Gradle and File Explorer must all see those same
       files at their real location, which file-system write
       virtualization would hide from them."*
3. Submit. Certification usually takes from a few hours to three working
   days.

After that, every release that bumps the version submits itself.

---

## Does MSIX break anything in the launcher?

Not after the changes that went in with this. Each of the points below would
have broken something:

- **Self-updating.** The launcher downloads and runs its NSIS installer.
  From the Store that would put a second copy of the launcher beside the
  first, the install folder is read-only, and the Store's rules forbid it
  anyway. A Store copy (Electron reports `process.windowsStore`) now never
  checks for, downloads or installs an update; the Store updates it.
- **`redstonelauncher://` links**, which is what desktop shortcuts to
  instances and servers are. A packaged app cannot register a protocol at
  run time. The protocol is declared in the package manifest instead.
- **Where its files are.** By default a packaged app's writes to `%APPDATA%`
  are quietly redirected to a private copy. The launcher, the game it starts
  and its Java would see them; File Explorer ("Open folder"), shortcut icon
  files and anything outside the package would not. The manifest turns that
  redirection off, which is what `unvirtualizedResources` is for. If
  certification refuses it, the launcher still runs, but "Open folder"
  would show an empty folder and shortcut icons would be missing.
- **Nothing writes into the install folder**, which is read-only under MSIX.
  This was checked: the launcher only reads from it.

Things that work differently but do not break:

- The **app icon** setting still changes the window and taskbar icon while
  the launcher is open. The Start menu tile, and the icon of a pinned
  taskbar entry, are the package's own and stay the launcher's logo.
- The Store version and an NSIS-installed one can both be on a computer at
  the same time. They share the same `%APPDATA%\Redstone Launcher` folder,
  so they see the same instances and accounts.

One thing worth knowing before submitting: Store policy 10.2.2 forbids an app
from downloading code that changes what the app itself does. A launcher
downloads the game, mods and Java, which is the app's described purpose
rather than a change to it, and launchers such as CurseForge's are on the
Store. Certification still decides case by case, so the description should
say plainly that the launcher downloads and runs Minecraft, mod loaders and
mods.
