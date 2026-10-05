# Launcher TODO

Everything asked for across the rounds of feedback so far, in one place. The
headings are kept even once done, so anything that turns out not to work can be
reopened against the right description.

`[x]` = shipped. `[~]` = shipped once but reported broken again. `[ ]` = not
started.

---

## 0. Round 12

### Importing (stop guessing — read the actual source)
- [x] Modrinth App: find out how it REALLY stores profiles instead of guessing
      at the schema. Version and loader are still wrong much of the time
- [x] No launcher's instance icons come through at all

### Friends
- [x] Use the launcher's existing player-head rendering, not the sample's
- [x] The panel's names/icons are tiny next to the account rows
- [x] Switching accounts must mark the previous one offline
- [x] Switching to an offline account only blanks the list — changing tabs
      brings the old account's data back
- [x] The list reorders a moment after presence arrives

### Players page
- [x] "Add New Player" is sticky but sits OVER the scroll area — rows show
      through above and below it, with the shadow of the row behind

### Settings
- [x] Import skins / import accounts can't be started from anywhere
- [x] The font dropdown still spans the full width
- [x] The colour cards have no titles
- [x] A refresh that needs a fresh sign-in is swallowed — surface it

### Layout
- [x] Pages are still cut off; it only corrects itself after visiting Settings
      or resizing, so the fit isn't being applied everywhere on load

### Icons
- [x] Panorama is still grey and NOTHING is logged, in either console

### Skins
- [x] When "Add skin" is alone on its row it should take the whole row

---

## 0. Round 11

### Importing
- [x] Modrinth App: version is found now, but the loader still comes back
      "vanilla" for an obvious modpack

### Onboarding
- [x] The "Your instances" step points at the wrong place on the instances page

### Icons
- [x] The version panorama is still fully grey
- [x] Round corners should be a SLIDER (square → slightly rounded → circle),
      not an on/off toggle

### Skins page
- [x] Applying a skin still blanks the skin renders for a moment
- [x] Leaving the skins page flashes the main render white for under a second

### Settings
- [x] Drop the description under the "share skins between accounts" toggle —
      only sections get descriptions
- [x] Pooled skins must never be cloud-saved against the wrong account
- [x] Theme tab: the colour pickers and hex inputs span the full page width;
      they should be cards side by side
- [x] The version line at the bottom clips off-screen — sometimes only its top
      2-3 pixel rows show

### Layout
- [x] Scroll areas still leave a gap at the bottom on home, instances, the mod
      browser, servers, skins and players

### Instances
- [x] A mod's "change version" button appears late
- [x] Tabbing out of the launcher and back reloads the instance detail
- [x] The mod icon changes depending on whether change-version has loaded —
      the platform it came from is already known, so cache it instead of
      re-checking every time
- [x] Grid view: cards overlap and aren't centred in their cells

### Players page
- [x] "Add new player" should stick to the top, like the headings on the skins page
- [x] A friends panel down the right using Minecraft's friends API: list with
      presence, tabs for friends / incoming / outgoing, and a badge on incoming

---

## 0. Round 10

### Instance creation
- [x] The sidebar "+" opens the OLD creator from any page other than Instances
- [x] Starting an instance from a mod must limit the version AND loader lists to
      what that mod actually supports
- [x] "Import from another launcher" opened from the creation chooser should pick
      ONE instance, not mass-import like the Settings/tour one

### Importing
- [x] Rebuild the import UI to look like the mod/modpack search — icons, rows,
      the same styling
- [x] Modrinth App: "doesn't record the Minecraft version" DISABLES the row
      entirely. Find where the version really lives instead of giving up
- [x] Vanilla launcher versions are ids, not versions:
      `fabric-loader-0.16.14-1.20.1`, `1.12.2-forge-14.23.5.2860`,
      `1.19.2-forge-43.1.1`, `vivecraft-1.19.2-jrbudda-VR-2-b8`. Parse the real
      MC version + loader out of them, and carry the version jar across so the
      imported instance can actually launch
- [x] Vanilla snapshot installations are not listed at all
- [x] Unnamed installations show a 32-char hash as their name
- [x] Player profiles / accounts still can't be imported in practice — check the
      path end to end
- [x] Import skins too, after the account (Modrinth, vanilla and others keep them)

### Onboarding
- [x] First launch: a welcome panel ("Welcome to Redstone Launcher…") before the
      tour, and before it when started from Settings too
- [x] After the welcome: offer account import; if no accounts were found in any
      launcher, show the sign-in from the Accounts page instead
- [x] Clicking the highlighted item must NOT auto-advance the tour
- [x] "Skip this" should read "Next"
- [x] The import modal's blur covers the corner where the top bar meets the
      sidebar — same for the tour-end modal

### Mod browser / project pages
- [x] Opening a project page from an instance doesn't load downloads, followers,
      creator or summary
- [x] Project title is too big (see screenshot)

### Icons
- [x] The version panorama icon source just shows grey

### Skin animations
- [x] `--flip` is the right way round — regenerate with it
- [x] After a devtools-played animation the hand idle never resumes
- [x] Returning to idle snaps. It should ease the hands to the point in the idle
      where they are closest to the body, then carry on from there
- [x] Only start a random animation when the idle has the hands closest to the
      body, ease into the clip's first pose, then play it

---

## 0. Round 9

- [x] **The Blockbench animations were badly broken** — positions applied as
      absolute instead of rest-relative, so the figure sat low and collapsed
      into itself; every clip looped forever instead of playing once.
- [x] Reloading skins/capes looked like a full page reload, and the button kept
      spinning after the work had finished
- [x] Reset skin / reset cape cards removed from the lists (the headings have
      buttons now)
- [x] Onboarding: "click this" text was red on red, and read as filler
- [x] Onboarding: two tours could start at once
- [x] Onboarding: clicking a pinned instance opened it and killed the tour
- [x] Onboarding: ended on Settings with no send-off; now finishes and goes home
- [x] Icon picker: everything goes through the cropper, so nothing is stretched
- [x] Icon picker: mod/pack cells previewed the CurseForge banner but picked the
      jar icon
- [x] Icon picker: dragging worked but nothing said so; wheel zoom added
- [x] Mod icons no longer flash a wrong image before the real one loads
- [x] Resourcepacks tab always shown — every instance can take a resource pack

**Answered, not a bug:** the cloud badge means "this skin is on *Mojang's*
servers", not "synced between your computers". There is no account system or
server-side storage in this launcher — the skin library is a local
`skinlibrary.json`, and `relay-server` is a Minecraft TCP relay with no API.
Syncing libraries across machines would need a backend that does not exist yet.

---

## 1. Regressions — shipped before, reported still broken

- [x] **Modpack instances don't get the modpack icon.** Reported three times.
      Both `icon = data:image/png;base64,...` sites in `backend/main.js` were
      patched; the icon still never lands on the instance. Needs tracing from
      `mrpack()` through profile save, not another blind patch.
- [x] **Grid view is a single full-width column,** not a grid. Screenshot shows
      stacked rows at 100% width.
- [x] **Scroll areas still cut off mid-page.** `fitheight.js` replaced the
      `calc(100vh - N)` heights but the panes are still wrong.
- [x] **Crash modal shows the whole log** instead of the crash report.
      `reportInstanceCrash` sends `report` and `tail`; the modal is rendering the
      tail even when a report exists.
- [x] **Mod browser persists the active type tab.** Query restore now works, but
      the tab should only be restored when arriving via back-navigation
      (`performance.getEntriesByType('navigation')[0].type === 'back_forward'`),
      never on a fresh visit.
- [x] **Onboarding tour dies when a sidebar tab is clicked.** It should survive
      the navigation, carry over to the new page, and on each tab both *prompt*
      the click and *explain* what the tab is.
- [x] **Onboarding highlight is smaller for the Skins and Settings tabs.** Their
      selectors (`a[href="profile-manager.html"]`, `a[href="settings.html"]`)
      match an `<a>` that wraps only the `<i>`; every other row's `<a>` wraps the
      whole `<li>`. Highlight the `<li>` instead.
- [x] **Settings shows the app version as `...`** in dev mode, even though the
      logs report 1.17.0.
- [x] **Server merge doesn't group same-IP entries.** Servers that share an IP
      but differ in name should render as `NAME A / NAME B / NAME C`, with the IP
      under the name line and the instances that have it listed below that.
- [x] **Opening a modpack instance from the instances list just reloads.**
      Opening the same instance from the sidebar works.
- [x] **Modrinth App instances are not found by the importer.**
- [x] **Skins-page bounce-back is too fast and too short.** Wait 3–4 s before
      returning (currently 2.2 s) and return more slowly.

## 2. New work

### Instances & servers
- [x] Replace every remaining Electron `confirm`/`alert` with a launcher modal.
      Start with the instance-delete confirm; `pmConfirm` already exists in
      `profile-manager.html` and should be promoted to a shared helper.
- [x] **Actually delete instance files on delete.** Deleting an instance and then
      importing one with the same name surfaces the deleted instance's logs, so
      the directory is surviving.
- [x] **Instance/server creation type selector**, styled like the sync instance
      picker, offering: custom setup (the current creator, stripped down), mod or
      modpack, upload a modpack, import an instance.
- [x] **Mod-or-modpack search** in that same style — mostly modpacks but mods
      too, sorted by downloads. Choosing a *mod* gives the new instance that
      mod's icon and name and opens the custom setup pre-filled to the mod's
      latest supported version.
- [x] **Play button becomes "Cancel" while launching** and cancels the launch
      when clicked, before it turns into "Stop".
- [x] **Stop instance tabs from refreshing while modpack mods download** — with
      the Mods tab open it lags badly.
- [x] **Auto-select the newest version** in the modpack install picker.
- [x] **Import player refresh/access tokens** from other launchers, alongside the
      instance import.

### Skins & capes
- [x] **Cape selection is over-cached.** Applying a cape still shows the old one
      as selected; after a reload the list is right but the 3D render is still
      wrong; it survives an app restart.
- [x] **Skin upload can stamp apply/undo onto the actually-selected skin.**
- [x] **Skin upload sometimes forgets to set the skin back,** and triggers an
      annoying full reload.
- [x] **Cloud icon should show the skin's location on Mojang's servers** once it
      has been uploaded.
- [x] **Add a skin from its Mojang texture URL / id.**
- [x] **Edit-skin menu shows the Mojang texture id** when uploaded, and lets you
      set it when not — verifying the texture actually matches and warning that
      setting it will override.
- [x] **Don't reload capes on every skins-page open** (rate limiting makes them
      vanish). Add reload buttons next to the "Capes" and "Your Skins" title rows.
- [x] **Reset buttons next to those reload buttons** — skins resets to the default
      skin, capes removes the cape. Both are removed from their lists but stay
      applyable/undoable exactly as now.

### Animations tooling
- [x] **`bbmodelconvert.js` at the repo root**, separate from the launcher: run it
      with a path to a `.bbmodel` and it converts every animation in the file into
      the random skins-page animations, saved where the Electron app can read them.
- [x] **Devtools commands `playerRenderAnimList()` and
      `playerRenderAnimPlay("animationname")`.**

## 3. Investigations — diagnose before changing anything

- [x] **NeoForge installs the wrong version.** Create+ crashes on launch here but
      runs in other launchers. The launch line carries
      `--fml.neoForgeVersion 21.1.1` while the pack's mods require `[21.1.169,)`,
      ending in
      `NoClassDefFoundError: net/neoforged/fml/loading/moddiscovery/ModFileParser$MixinConfig`.
      So the pack's `loaderVersion` isn't reaching the installer — find where it's
      dropped.
- [x] **CurseForge mod downloads return 500** and show "unavailable", even though
      the Cloudflare Worker is up. The worker only 500s from its outer `catch` or
      the "Unable to fetch download URL" branch, so identify the failing request
      before touching the worker.

---

## 4. Done in the previous rounds

Kept for the record so nothing gets re-reported as missing.

- [x] Top toolbar draggable across the whole bar, not just the title text
- [x] Mod browser restores the search query when navigating back
- [x] Play button not clickable while an install is running
- [x] Modpack install reuses the existing progress UI instead of its own bar
- [x] "Update all" on the instance and server mod tabs
- [x] Modpack install offers instance *or* server
- [x] Install button opens the versions tab with a version/target modal
- [x] Browsed skins detect slim vs wide (MineSkin's list response has no variant
      field; read off the pixel column at `x=55`, `y=20..32`)
- [x] Cloud button pinned top-right, above the drag layer, with a real modal
- [x] Cloud badge no longer renders over everything (`isolation: isolate`)
- [x] Bounciness and momentum on the player render's return-to-centre
- [x] Drag-reorder works away from the extreme page edge
- [x] Unmoderated-API warning on the skin browser
- [x] Screenshots thumbnailed via `sharp` instead of rendering full-size
- [x] Crop / circle-mask on a selected screenshot, defaulting on for opaque squares
- [x] Version banner section (`minecraft.wiki/images/<version>_banner.png|jpg`,
      png preferred, nothing shown if neither exists) plus the seven edition icons
- [x] Version panorama, facing forward, with a stitched crop view
- [x] Server-list merge mode across instances
- [x] Crash modal on unexpected instance exit
- [x] Queued cloud uploads that respect the rate limit
- [x] Import modal for Modrinth / CurseForge / MultiMC / Prism / vanilla
- [x] First-launch onboarding tour of the sidebar, both re-runnable from Settings
- [x] Slim/wide toggle on the skins-page rename dialog
- [x] Auth refresh consolidated behind one throttle (the 429 storm)
- [x] Config sync stops severing `servers.dat` hard links on every sync
