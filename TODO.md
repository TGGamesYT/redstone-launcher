# Launcher TODO

Everything asked for across the rounds of feedback so far, in one place. The
headings are kept even once done, so anything that turns out not to work can be
reopened against the right description.

`[x]` = shipped. `[~]` = shipped once but reported broken again. `[ ]` = not
started.

---

## 0. Round 34

A large batch. Ordered roughly as it was given, but worked through by how much
it hurts: the crashes first, then the things that are actively broken, then
the new features.

### A. Crashes and launching
- [x] **`3221225477` STILL, across computers, and now `3221226356` too.**
      Round 28 found one real cause (unverified library jars) and fixed it;
      it is still happening, so there is at least one more. — *Found it, and
      it is the same bug one level down: mclc's `downloadAsync` pipes the
      response straight into the file's final name and resolves on the write
      stream's `finish`, so a transfer cut halfway leaves a truncated file
      sitting where everything afterwards takes it for complete. Its own
      error handler resolves without deleting it. For assets that is fatal
      every launch, because `getAssets` checks the hash BEFORE downloading
      and never again after — so a truncated `.ogg` goes to OpenAL and a
      truncated `.png` to stb_image, which is a read off the end of a native
      buffer: an access violation (`0xC0000005`) outside the heap, heap
      corruption (`0xC0000374`) inside it. Both reported codes, from native
      code, with no Java stack trace, and it travels between computers
      because the assets folder is what gets copied. The download is now
      replaced wholesale: bytes go to a `.part` file, the SHA-1 is checked as
      it streams whenever the name is the hash (which is every asset), four
      tries with backoff, and only a verified file is renamed into place. A
      failure leaves nothing, which every caller already handles. Also gates
      concurrency at 8 — mclc asked for all 4000 assets at once and leaned on
      `request`'s 2-socket pool, which `fetch` does not have.*
- [x] **The download progress bar jumps about.** Each individual asset's
      progress is being mixed into the total, so the bar goes back and forth
      and only shows the real total for a moment as each file finishes. Either
      fix it or put the per-file progress on a second bar underneath. —
      *Both were being written to the same bar, last one wins: `progress`
      counts tasks done out of a total, `download-status` reports one file's
      bytes. 30%, then one `.ogg`'s 34%, then 30% again. While a counted task
      is running the bar is the counter and nothing else, and the file being
      fetched only names itself in the label; per-file bytes drive the bar
      only when there is no counter, which is the one-big-file case where
      they are what you want. The counter can no longer go backwards either.*
- [x] **Resource-pack syncing uses symlinks, which Minecraft refuses.**
      `Found forbidden symlinks: ...resourcepacks\epicmc->...Downloads\epicmc`
      — *The launcher makes no symlinks; this was one made by hand, and since
      1.20 the game validates every link under the game directory against
      `allowed_symlinks.txt` and skips what is not listed. Each instance's
      links are now found at launch and their targets written as `[prefix]`
      rules. Two details decide whether it works: the rule matches where the
      link POINTS, not where it sits, and the target must be the resolved
      path. Narrow rules rather than the blanket `[regex].+` the internet
      suggests, which would let the game follow a link anywhere on the disk.
      Anything the user wrote in the file themselves is kept, and a link that
      cannot be resolved is left out rather than written half-formed — a file
      the game cannot parse disables every symlink.*
- [x] **An auto-updating instance's version cannot be changed** — it is set
      back instantly. — *Three separate things, and "instantly" was the third.
      (1) The sweep only ever moves forward, so it landed back on the latest
      within 15 minutes; picking a version by hand is the clearer of two
      contradictory instructions, so it now wins and version-following is
      switched off, unless the pick IS what it would have followed to anyway.
      (2) `edit-profile` took a SORTED copy of every profile, held it across
      an await, and saved the whole array back — the edit dialog sends that
      and then changes the version, and since the message carries no version
      field its snapshot still held the old one, so whichever finished last
      won. That is the instant revert. Both paths now read the raw file at the
      moment of writing. (3) Saving that sorted copy also wrote whatever sort
      was on display over the user's own instance order.*
- [x] **A loader is offered for versions it has no build for.** It only fails
      at launch. Offer only loaders that actually have a build for the chosen
      version, and where NO loader does, skip the loader step entirely and go
      straight to finalize. — *New `loader:supported`, which asks Fabric's and
      Quilt's metadata and Forge's and NeoForge's maven, cached per version.
      The creation flow skips the loader page outright when only vanilla can
      run the version (and Back from the last page then goes to the version
      page, not forward again). The edit dialog greys the others out and says
      "no build for 1.12.2" rather than having them vanish, hides the whole
      section when only vanilla is left, and drops a selected loader that has
      no build. A loader whose check could not be reached is still offered:
      hiding Fabric over a timed-out request would be worse than the bug.*

Also found and fixed while in there: an instance named after its version was
only renamed on the `edit-profile` path, which never carries a version, so
"my 1.21 instance" kept saying 1.21 on every other route into a version
change — the version dropdown included.

### B. Dev mods
- [x] **Adding a dev mod does not show it in the mods list** until Refresh is
      pressed. — *`devmod:add` fired the jar copy off without waiting, so it
      returned before the jar was in the folder and the list reloaded just too
      early to see it. It is awaited now, and the main process says
      `mods-changed` afterwards, which the page redraws on.*
- [x] **A proper "add dev mod" modal**: the dev mods already added and still
      valid, with the project/path picker at the top. — *The picker is at the
      top; under it every dev mod registered anywhere that is still a valid
      mod, with its newest build, which instances already use it, and one
      click to add. The ones already in this instance are marked and not
      clickable, and a folder that has gone is not offered. It used to open
      the folder dialog immediately with none of this in sight.*
- [x] **Accept a project ROOT** (containing `build/`), the `build` folder, or
      `build/libs` as it does now. — *Any of the three, and the project root
      is recorded separately because that is what a rebuild runs in. A
      subproject's `build/libs` resolves to the top-level project, where the
      wrapper is. A plain folder of jars still works as before.*
- [x] **Rebuild a mod from the launcher**, with gradle/gradlew from the project
      root, the project's required Java version but the launcher's own
      download of it, and the failure shown when it fails. — *`gradlew build
      -x test` in the project root, on the Java the build script asks for
      (toolchain, `JavaVersion.VERSION_*`, `sourceCompatibility`, `release`,
      or failing all of those the Minecraft version in `gradle.properties`),
      taken from the launcher's own downloads — as a JDK, since Gradle needs
      javac and the download preferred a JRE, which has none. Output streams
      into the dialog as it goes and stays on screen when it fails. Falls back
      to `gradle` on the PATH where there is no wrapper, and chmods a wrapper
      that came out of git without its executable bit.*

### C. Remod
- [x] **Edit what the mod declares it NEEDS** too: dependencies,
      incompatibilities, version requirements. — *Every manifest states this
      differently — Fabric has five objects keyed by mod id, Forge a
      `[[dependencies.<modid>]]` table apiece, a plugin.yml three lists — so
      they are read into one shape (`id`, `kind`, `versions`) and written back
      into whichever the archive speaks. Five kinds: requires, optional,
      recommends, breaks with, conflicts with, and only the ones a format can
      actually state are offered. Where it cannot say exactly what was asked
      (Forge has only mandatory true/false, mcmod.info only "required", a
      plugin.yml has nowhere for a version) the nearest thing is written and
      the dialog says so rather than dropping it quietly. Forge's and
      NeoForge's `loaderVersion` is editable as its own field, and the Minecraft
      range is simply a dependency row. The TOML is still edited in place, so
      the author's comments and ordering survive everywhere except inside the
      dependency tables, which are rewritten.*

### D. Themes and the background
- [x] **Replace the gradient settings with a Background section** — *Five
      modes, one setting, each keeping its own details so switching to a
      picture and back does not lose the gradient you had. The gradient was a
      toggle writing three top-level settings; the mode is the choice now.
      Every page's `<head>` had its own copy of the boot script that paints
      the background before anything renders, and they had drifted — some
      checked the wrong setting, some set the class on `<html>` only and some
      on `<body>` too, which is how a page could open with no background over
      a transparent body: a white window until the next navigation. One
      `theme-boot.js` now, and one `backgroundCss()` in sidebar.js that the
      settings page previews through, so what is previewed is what is
      painted. The notch between the bars is drawn back for all five modes,
      not only for a gradient.*
- [x] **A picture, with stretched / fitted / covered** — *Covered by default.
      The file is copied into the launcher's own folder, so a background does
      not vanish when the picture is moved out of Downloads.*
- [x] **A block's face, tiled, with a size slider, pixel-sharp** — *Flat face
      textures rather than rendered cubes: a wall of dirt, not a wall of
      little dirt cubes in perspective. Only full blocks are offered, which is
      a real test rather than a guess — some element of the model runs the
      whole 0–16 cube — so a slab, a fence or a flower is left out. "Some
      element", not "one": a grass block is the cube plus a second cube
      carrying its tinted side overlay, and demanding a single element threw
      away every block drawn that way. The side texture is preferred over the
      top, so a wall of grass is the grassy side. `image-rendering: pixelated`
      on the background keeps a 16-pixel texture sharp at any tile size.*
- [x] **Fix the predefined theme sync** so it matches what the background
      actually is — *There was a table of two BRIGHT colours per theme, which
      is why syncing quartz gave a near-white gradient over a dark panel:
      those are a theme's accent colours, not its background. It is derived
      from the theme's own secondary colour now — the panel is
      `color-mix(secondary 30%, black)`, so the synced gradient is that mix a
      little lighter to a little darker. It works for themes nobody wrote a
      table entry for, including one mixed by hand, and it follows a
      hand-picked colour and not just the presets.*
- [x] **Save a custom theme under a name**, listed with the built-in ones. —
      *A theme is every setting that decides how the launcher looks: the
      colours, the font, the corner radius, the whole Background section and
      the app icon. Saved ones appear under the built-in list, apply on a
      click and can be forgotten again. Importing or applying one reloads the
      page, so every field, the Background section and the icon all agree
      rather than half the page still showing the old theme.*
- [x] **Set the app's icon.** — *The shipped icon's red is the launcher's own
      theme colour, so it follows the base colour: every pixel whose hue is
      within 35° of the icon's red and has some saturation is turned the same
      distance around to the theme's hue, keeping its own lightness — so all
      38 shades of shading survive and the 235,136 grey pixels and the
      outline are left exactly as they are. A picture can be used instead,
      and whichever is in use is saved with the theme.*
- [x] **Export and import a theme** (background settings included), carrying
      the original author — a premium account — fused into the data so it
      cannot be edited to say somebody else. — *Anybody can edit a JSON file,
      so a name written in one is worth nothing; it had to be impossible both
      to put your own name on someone else's theme and to keep their name on
      something you changed. The relay signs it, because it is the only party
      that knows who anybody is — the connection has already proved its
      Minecraft account with Mojang's hasJoined, so the author is taken from
      the CONNECTION and never from the request (asking it to sign as
      somebody else is simply ignored). An Ed25519 signature covers the
      author and the theme's hash together, which is the fusing: change
      either and it stops verifying, and a new hash needs a new signature,
      which only the relay can make. Its public key is fetched over the same
      verified TLS as everything else and then remembered, so a theme can be
      checked again offline. A theme that cannot be signed still exports —
      it just says it does not know who made it, rather than claiming
      somebody — and one whose author does not check out is imported with
      "author unverified" rather than being trusted.*

### E. Settings
- [x] **Drop the long inline descriptions.** A short description on hover
      instead, and the dev-mode toggle loses its "(...)" part. — *Each group
      carried a paragraph above it explaining several settings at once, so
      the page was a wall of text to read through to find the one switch you
      came for. The explanation belongs to the switch: a `data-tip`, a faint
      `?` on the label, and a tooltip positioned by script so it is never
      clipped by a scrolling section and flips above a setting near the
      bottom of the window. The dev-mode toggle's bracketed sentence became
      its tooltip.*
- [x] **Custom CSS**, when developer mode is on, able to rearrange elements. —
      *A textarea in the Developer section, saved as you type, applied to
      every page from the end of `<body>` so it beats the page's own styles.
      Only applied while developer mode is on — a page that will not render
      because of a typo somebody forgot about is much harder to explain
      otherwise. (The panel's own `display` had to be set to `block` rather
      than `''`: the stylesheet hides it by default, so clearing the inline
      style fell back to that and it could never be shown.)*

### F. Accounts
- [x] **A dragged account should follow the pointer**, not sit still until the
      row it would displace is reached. — *It stayed in the list's flow, so it
      only ever moved when the DOM reordered: a jump of one row's height at a
      time, never under the cursor dragging it. Its transform is set on every
      pointer move now — measured against where the row would rest with its
      own transform off, so following does not feed back into the
      measurement, and recomputed after each reorder so it does not jump when
      its slot moves under it. No transition on transform while dragging, or
      it would trail behind the pointer; letting go turns one back on so it
      slides into its slot.*
- [x] **An info button on incoming and outgoing requests' players**, as the
      friends list has. — *Deciding whether to accept somebody is exactly when
      you want to see who they are, and a request's row was the one place in
      the list with no way to look.*

### G. The admin window
- [x] **A Users panel**: everyone with a record of using the launcher and when
      they last did, shown the way the friend-info modal shows a player. —
      *The `seen` record the friends list already reads, shown whole: name,
      first and last seen in words, banded so the filter can narrow it to
      today / this week / this month, marked where an account is an admin or
      timed out, with how many other accounts have connected from somewhere it
      has and which relay addresses are its. The detail pane shows the player
      as a render you can turn — a new `player` block in the admin window,
      using the same bundle as the accounts page, falling back to the head
      when the skin cannot be fetched.*
- [x] **A Relay panel**: recent relay usage — who, when, and whether it is
      still up. Everything the server knows. — *Every address ever registered:
      the live ones from the connection table with their owner, how many are
      playing through them, the port they point at and whether they are
      hosting a pack; the rest from the file that outlives a restart, with
      when each was last used. An address can be disconnected (everybody
      playing through it is let go rather than left on a stream with no route)
      or forgotten. The registration now records its owner, since the
      connection was the only thing that knew it — a state file from before
      that holds a bare timestamp and still reads, ownerless.*

Both are relay-side only: the admin window draws whatever panels the relay
declares, which is what that was built for.

### H. The main page, editable
- [x] **An edit button, bottom left** — *Marks every segment out, gives each
      one move/settings/remove controls, and offers Add a segment and Start
      over. There is no fixed layout left in the page: it draws whatever the
      saved layout says, and until somebody edits it the layout is null, which
      means "what the launcher has always shown" — so an existing install
      opens on the page it opened on before.*
- [x] **Segments**, all of them, each customisable — *recent instances, your
      player as a render you can turn, the Java friends list (online first,
      optionally online only), projects from Modrinth or CurseForge with the
      type, order (including at random), count, search, version, loader and
      categories all settable, launcher news from the launcher's own releases,
      snapshot news from the version manifest, a clock (any time zone, 12 or
      24 hour, seconds, date, size), countdowns, playtime, and a picture, gif
      or video. The main process declares the types and their options, and the
      editor's controls are built from that list — so a new segment type is
      described once there and drawn once in `home.js`, and the editor picks
      it up without being told about it. A segment that fails to draw says so
      in its own box rather than taking the page with it; a clock with a
      nonsense time zone and a countdown with no date both say what is wrong
      instead of showing NaN; and every timer and 3D viewer a segment owns is
      disposed of when the page redraws, so nothing is left ticking into an
      element that has gone.*
- [x] **Playtime has to be tracked** per instance first, and shown on the
      instance's own page as well. — *Counted from the tracker that already
      knows when a game starts and stops, so nothing new is watched. All three
      exits count it: stopped from the launcher, killed by pid, and — the
      usual one — quit from inside the game, which the poller notices. A
      session under ten seconds is a failed launch rather than time played,
      and one over a fortnight is a lost start time rather than a fortnight at
      the keyboard; neither is counted. Shown in the instance's header and as
      a home-page segment, with a per-instance breakdown.*

### I. Resource-pack tools
- [x] **A Tools button on an instance's Resourcepacks tab** — *Both
      generators live behind it. A pack either of them makes is marked in the
      list the way a dev mod is, because it is the same kind of thing: not
      something you installed, but something the launcher keeps up to date.*
- [x] **A totem resource-pack generator**, 1:1 with the site's tool, updating
      to the right skin at launch, or pinned to a chosen skin. — *Ported as it
      stands: every draw in its original order at its original coordinates,
      since the totem is a hand-made arrangement of a skin's pixels and moving
      any one of them changes it. The original runs on a 2D canvas, which
      composites source-over; there is no canvas in the backend, so the same
      compositing is done on raw pixels — which is what makes a part-
      transparent hat work. "1:1" is checked rather than claimed: the test
      lifts the original's own `test()` into a real canvas and compares the
      two pixel for pixel on five skins, including a 64×32 one (the other
      branch of every `height > 32`), one where every pixel is unique (so a
      single wrong coordinate would show) and one with a half-transparent hat
      (so replacing instead of blending would show). All five match exactly.
      A pack set to follow the account is rebuilt before every launch, so
      changing your skin changes your totem; one pinned to a skin from the
      library is built once and left alone.*
- [x] **Vanilla Tweaks**, the whole generator, with a customise button. —
      *Their own API: the categories as JSON, then a POST naming the packs
      wanted, which answers with a link to a zip they build on the spot.
      Nothing is scraped and nothing is reimplemented, so a pack added on
      their side turns up without a launcher release. Customise lists their
      categories as they group them, searchable, and a pack from a
      sub-category is posted under its top category's name — which is what
      their own site does. The version is the instance's, cut to the minor one
      they publish for.*

### J. Onboarding
- [x] **It still tells you to click the tab.** — *Each step put up an "Open
      Instances" prompt and armed that tab's click, which with a Next button
      sitting beside it was two instructions for one step. The sidebar is on
      every page, so the ring lands on the right row wherever you are and
      there was never anything to click for. Next moves the tour on; the
      handoff that keeps the tour alive when you navigate of your own accord
      is kept, because clicking a tab or a pinned instance still has to leave
      it standing.*
- [x] **On the instances page, the "my instances" highlight lands in the
      middle of the page** instead of on the same thing it highlights
      elsewhere. — *A typo, and only on that one page: `instances.html` called
      the sidebar's middle list `menu medium` where all eleven other pages
      call it `menu middle`. The step's selector found nothing, and a step
      whose target is missing dims everything and centres the popup — which is
      exactly what was being seen. Renamed, along with the one script that
      had matched the typo.*

## 0. Round 33

- [x] **The import chooser's player render is not a proper one, and stretched.**
      *A player render is about twice as tall as it is wide, the same as the
      ones on the skins page; this one was in a 110x150 box, which is the
      wrong shape for a figure. The canvas is no longer given a size in CSS
      either — skinview3d owns its own dimensions, and forcing one on it from
      a stylesheet is the other way to stretch a render. Same zoom as the
      rest, and turned slightly off square the way a character is posed for a
      portrait.*
- [x] **Reordering should look like the card is being picked up.**
      *It lifts: scaled, shadowed and tinted, with a little bounce the moment
      it is taken hold of, and the rows it displaces slide out of its way from
      where they were rather than appearing in their new places.*
- [x] **The QR code still changes the dialog's height.**
      *The width was settled last round; the premium half now keeps the room
      the code needs whether it is showing or not, so the dialog is the same
      size before, during and after. Measured at every stage: 340x595
      throughout.*

## 0. Round 32

- [x] **"What it installs" is a bare list of file names**, where it should be
      a proper list with the mods' and packs' icons.
      *A Modrinth pack's every download is a CDN path carrying the project's
      own id, so one bulk request turns the file names into titles and icons —
      no lookup per mod, and no hashes to resolve. A pack whose names cannot
      be fetched still lists what it installs, by file name. An instance made
      for a single mod shows that mod with its own picture.*
- [x] **"Add New Player" should offer accounts already signed in elsewhere**
      on this computer first, as cards with skin renders, and only fall
      through to the sign-in dialog when there is nothing to offer.
      *Somebody who has used another launcher is already signed in there and
      the refresh token is on disk, so making them scan a QR code to get back
      an account the launcher could see all along is work for nothing.
      Accounts this launcher already has are left out — offering one of those
      would be offering nothing — so with none to offer, or only ones already
      here, it opens the ordinary dialog exactly as before.*
- [x] **The sign-in dialog jumps wider when the QR code appears**, and "use a
      browser window instead" is an ugly link.
      *It is wide enough for the code from the start, and using a browser is a
      button beside Cancel, because it is a thing you do rather than a
      footnote.*
- [x] **Holding an account in the list should let it be dragged up or down.**
      *Half a second, so an ordinary click still selects and a scroll still
      scrolls — moving before the hold is up is taken as a scroll and never
      picks the row up. The order is saved by account id rather than by
      position, so a list a render behind what is on disk cannot drop an
      account it did not know about.*
- [x] **The friend-details render allows zooming.**
      *The skins page's render already refused it; this one had been left out.
      It is a picture of somebody to turn around, not something to scroll
      into.*

## 0. Round 31

- [x] **wide -> slim -> wide does not give back the original pixels**, and the
      conversion should only happen if the arm parts that get stretched were
      modified.
      *Narrowing an arm THROWS A COLUMN AWAY — that is what making it narrower
      is — so widening cannot invent it again: it repeats an edge, and what
      comes back is not what went in. The arms are remembered as they were in
      each model now, and going back to a model you have already been in puts
      those pixels back rather than converting. Converting is for when the
      arms were actually worked on in the other model, where there is
      something new to carry across — which is exactly the rule asked for.
      Only the four arm boxes are remembered and compared, so painting
      anywhere else neither blocks the restore nor gets undone by it.*
- [x] **The colour-shift dialog should take typed numbers**, not only sliders.
      *A number box beside each slider, each driving the other. A shift is
      often a round figure somebody already has in mind, and finding 30
      degrees of hue by dragging is a nuisance.*
- [x] **The loading bar should show under the "X instances" pill too** — the
      bar only, not the text.
      *Two pixels under the pill, so the toolbar's height does not change when
      it appears. The furthest along of whatever is starting, since that is
      the one about to finish, and an indeterminate sweep when there is no
      figure to show. What each one is doing stays in the pop-down.*
- [x] **Version icons are re-rendered every time the launcher opens.**
      *The drawing WAS kept — the second ask takes a millisecond where the
      first takes seven seconds — but the answer was the picture itself, sent
      back as base64, so every list of instances shipped its icons across
      between the processes and decoded them again on every page. The answer
      is a file: URL now: the window reads the PNG straight off disk and keeps
      it in its own cache. Which version resolved to which URL is remembered
      for the session as well, so a page revisit does not even ask.*

- [x] **Installing a modpack from the browser should still open the finalize
      page**, and that page should put the name and the running sections at
      the top of their column with what it will install below them.
      *Both browser routes — the project page's picker and the search page's
      own version list — went straight to the download. They end on the same
      last page the launcher's own flow does now, through one shared helper
      rather than a third copy of the wiring.
      What it installs is read WITHOUT downloading the pack: the mod list is
      an index a few kilobytes into a file that is often hundreds of
      megabytes, and the launcher already reads a zip over HTTP by ranges for
      a version's jar. Two kilobytes of an eight-megabyte pack, measured. A
      CurseForge pack lists ids rather than names, so that one says how many
      files it will fetch instead of naming them.
      Found while building it: that ranged reader could take the whole process
      down. It pushes into a stream the consumer may abandon the moment it has
      what it wants, and the aborted fetch then emitted an `error` with
      nothing listening.*

## 0. Round 30

- [x] **The pick-colour tool does not work on the 3D render** in the skin
      editor.
      *The ray hits the second layer first, and on most skins the jacket is
      fully transparent over the body — so the pick read a texel with no
      colour in it and gave up without saying anything. The eyedropper now
      carries on through anything see-through to the surface actually showing,
      which is the colour you were pointing at. Painting still takes the
      nearest hit: drawing on the jacket is drawing on the jacket.*
- [x] **The "update all" modal resizes when a changelog opens.** With one item
      in it, opening the dropdown makes the modal taller and everything moves.
      *Its height is settled before anything opens and does not change after —
      worked out from the number of rows, so one mod does not get a dialog
      full of nothing either.*
- [x] **The new version is red on red** in the "old -> new" line, which is hard
      to read.
      *It was `--accent`, which on this dialog's own background is red on red.
      The new version is told apart by weight and brightness instead of by a
      colour, so it reads on any theme, and the old one is dimmed.*
- [x] **The changelog dropdown should animate** open and closed rather than
      appearing instantly.
      *A grid row from `0fr` to `1fr`, which collapses and expands smoothly
      without anything having to measure the content first.*
- [x] **A toggle next to each mod** so it can be left out of "update all".
      *A tick per row, all on to begin with. The button says how many it would
      do and goes dead at none, and the dialog hands back the mods still
      ticked rather than a yes or no, so the caller updates what came back.*
- [x] **Some mods take 5-10 seconds to open in Remod**, and freeze the app
      while they do.
      *AdmZip is synchronous, and that unpacking was happening on the main
      process's one thread, so every window in the launcher was frozen for the
      whole of it. Unpacking and packing both run in a utilityProcess now, the
      same way a launch and the default-skin extraction already do.*
- [x] **Dev mods are caught up on every app start and every launch**, even
      when none of the jars has changed.
      *The catch-up copied the jar again whatever had happened — which meant
      first waiting for the file to settle, up to six seconds a mod, for
      nothing. It notes which build it copied and skips when that build is
      unchanged and still in the instance. Comparing the two FILES cannot
      answer this: a copy has the same size by definition, and its timestamp
      is the moment it was made, which for a small jar can be the same
      millisecond the build was written — so a rebuild would read as already
      in place.*
- [x] **The running-instances pop-down has no animation.**
      *It fades and lifts into place now, and the caret turns with it.*
- [x] **The progress bar shows beside the status pill as well**, where it
      belongs only under the instance's name in the pop-down.
      *A second bar, fed by the same events, sat to the left of the pill. It
      said what the pop-down already says, and because it grew and shrank with
      its own text it kept changing the pill's width — which moves the
      pop-down anchored to it. Gone; the pop-down is the one place progress is
      shown.*
- [x] **A row's hover is instant and far too strong a colour.**
      *It was `--menu-hover-bg`, the sidebar's hover, which is far too much
      for a row this small. A light wash, eased in.*
- [x] **The progress bar makes the pop-down change width** as it goes, so it
      shifts left and right.
      *Two causes: the pill moving (above), and the panel sizing itself to its
      content, so "Checking assets" growing into "Downloading files — 5.0 MB
      of 20.0 MB" moved the whole thing. The panel has a fixed width now and
      the status line truncates.*
- [x] **Clicking "N instances" does not open the pop-down while installing.**
      *Every progress frame rebuilt the pill's contents, so the element under
      the cursor was replaced between mousedown and click and the click never
      landed — exactly when you most wanted it. The pill and the rows are
      built once now and only their text changes.
      Found with it: a row outlives its action now, so the guard that stops a
      double click had to be let go of afterwards, or Stop and Cancel worked
      once per row and never again.*
- [x] **A "Run again" item in an instance's three-dot menu**, which launches it
      whether or not it is already running.
      *Minecraft is happy to run twice over one game directory — that is what
      a second launcher window does — so the "already running" guard is there
      to catch accidents, and asking for this deliberately steps past it. The
      double-click guard is not stepped past: that one is never deliberate.*
- [x] **An instance named `<LOADER> <VERSION>` should be renamed** when its
      version or its loader is changed.
      *Not only a name that is ONLY that. "my 1.21 instance" becomes "my 1.19
      instance" and "vaniLLA instance" becomes "fabrIC instance": whichever of
      the two changed is swapped out wherever it appears, written the way it
      was written — the usual spelling stays usual, all-lower and all-upper
      carry across whole, and anything else is traced letter by letter. A name
      with neither in it is left exactly as it is, because then it is not
      about either, and so is one being typed in the same edit. The version is
      matched bounded, or the "1.21" of an instance on 1.21 would rewrite the
      middle of "1.21.9" in its own name.*
- [x] **Changing the theme turns the global gradient on** by itself.
      *"Predefined Theme Sync" means a theme brings its own gradient COLOURS.
      It was also deciding whether you had a gradient at all: switching one on
      for anybody with the sync ticked, and switching one OFF — one they had
      built themselves — for everybody else. Whether the gradient is on is the
      gradient toggle's business and nothing else's, and turning the sync off
      no longer throws the gradient away with it.*
- [x] **Turning the gradient off leaves the background white** until the page
      is reloaded or you navigate away.
      *Turning it off set `--app-gradient` to none but left the
      `gradient-enabled` class on, so `<html>` had the class and no gradient
      and `<body>` was see-through over it — a white window. The class comes
      off with it now, and the CSS is keyed off ONE element instead of a class
      on `<html>` and a matching one on `<body>` that every piece of code
      touching the gradient had to keep in step. (The settings page's own head
      script only ever set the one on `<html>`, and it also refused to draw
      the gradient at all unless the theme-sync setting was on, which is a
      different setting entirely.)*
- [x] **With the gradient on, the notch where the top and left bars meet
      vanishes.**
      *With no gradient the notch is free: `<html>` paints its top tenth in
      the toolbar's colour, and the bit of that showing through the rounded
      corner `<body>` cuts out of itself is what joins the two bars. Turn the
      gradient on and `<html>` paints the gradient instead, so the corner
      fills with gradient. It is drawn back as just that wedge — a circle
      centred on the inside of the corner, transparent within the radius and
      the toolbar's colour outside it — so the gradient still shows
      everywhere `<body>` is see-through.*

## 0. Round 29

Sent while Round 28's section D was being built.

- [x] **The accounts page says "No friends" while the friends are loading.**
      *An empty list and a list that has not arrived look identical from the
      outside, and the panel reported the second as the first: switching
      account emptied the lists and painted "No friends yet. Add someone by
      their username above." for as long as the round trip took. It says
      "Loading friends…" now — and the matching line on the incoming and
      outgoing tabs — until there is an answer to report.*

- [x] **"Update all" should ask first.** A modal listing the mods that would be
      updated, each one's changelog shown when it is clicked.
      *It used to start downloading the moment it was clicked, so the only way
      to find out what had changed was to go through the mods one at a time
      afterwards. It now lists what would be replaced and what each one is
      going from and to, and opens that version's changelog when the row is
      clicked — fetched for the row opened and nothing else, since the update
      check already knows which published version it found. On instances and
      on servers, both of which get their updates from the same place.*
- [x] **An instance getting ready to launch should show in the status bar**
      top-right, on every page, the same way a running one does — downloading
      or checking counts as running for this.
      *It only ever listed instances whose game process already existed, so the
      minutes a big modpack spends checking assets and downloading libraries
      showed as "No running instances". Anything starting counts now, with
      what it is doing on it — and the main process keeps the newest progress
      frame per instance, because a renderer only hears the frames sent while
      it exists and every page change is a new renderer, so the bar used to
      have nothing to say until the next frame happened along.*
- [x] **That status bar's menu should be a proper pop-down**, not the dropdown
      that only appears when more than one instance is running: each entry says
      what the instance is doing, and clicking it opens that instance.
      *A native `<select>` cannot show an icon, cannot show two lines, and
      opens as an OS menu that looks like nothing else in the launcher. It is
      a panel of the launcher's own now, for one instance or for six: a row
      each with the instance's icon, its name, what it is doing ("Checking
      assets — 1200 / 4000", "Running") and a thread of a progress bar under
      it. The row opens that instance; its button stops it, or cancels the
      launch when the game is not up yet. Progress frames land as they
      happen, so the line keeps up instead of being up to three seconds
      stale.
      Two things it had to get past: the toolbar styles every `<button>`
      inside it as a 36x36 window control at a specificity nothing here can
      beat, so the pill and the row buttons are divs; and
      `#instance-processes` is `overflow:hidden` so a long name truncates
      rather than shoving the window controls along, which clipped the panel
      to the height of the toolbar until it was made `position:fixed`.*
- [x] **The custom-setup finalize page scrolls.** Its content is slightly
      taller than the room it has, so it becomes scrollable for a few pixels.
      *3 to 27 pixels, measured in a real browser at the usual window sizes.
      The icon frame is a square meant to be capped by the height left in its
      column, and the rule that capped it — a percentage against a column of
      automatic height — resolves to nothing at all, so it was only ever sized
      by width. A square bounded on both axes is one constraint more than CSS
      can express, so its side is measured now: the smaller of the room across
      the column and the room left down it. Nothing scrolls at any size, and
      the frame is square at all of them, which it was not before either.*
- [x] **Cancel in finalize's "more settings" goes back to the first modal** of
      the creation flow rather than back to finalize.
      *"More settings" is a detour off the last page, the same as changing the
      version or the loader, and cancelling a detour was dropping you at the
      very first modal with the whole flow to walk again. It comes back to the
      last page now — and comes back to it as it was, because the name and the
      icon are carried through all three detours rather than the page being
      rebuilt from what the flow started with.*

## 0. Round 28

Asked for in one batch, with "write a todo and do everything".

### A. The icon renderer, finishing Round 27
- [x] **A slime's eyes still draw over everything.**
      *The body and the gel are painted on ONE sheet -- the body out of the
      opaque part, the gel out of the part at two thirds alpha -- so asking
      the sheet as a whole made the eyes translucent too, and a translucent
      surface writes no depth. Which part of the sheet a face is unwrapped
      onto is what decides it now.*
- [x] **Below 1.17 there are no entities at all** — use the oldest version
      whose models DO resolve and draw those shapes.
      *`createRoots` belongs to the model-layer system, which arrived in 1.17;
      before it every model was built in its own class's constructor and there
      is no catalogue to walk. 1.16 and older borrow 1.17.1's shapes and wear
      their own version's textures, so 1.12 has its old cow, its old villager
      and its old zombie.*
- [x] **Changing the render variant empties the variant list** and the dropdown
      disappears — picking anything but the default on the player loses it.
      *Twice over. Asking for a named texture answered with that texture and no
      list of the others, so there was nothing to rebuild from; and the list
      belongs to the THING, not to the variant of it you are looking at -- a
      cold cow is its own layer and its own list is just itself. The list is
      built once and kept, and only replaced by a longer one.*
- [x] **Let the player model and the player head wear any skin**, chosen the
      way the editor's "copy faces from a skin" picker chooses one.
      *Every skin in the library is a variant of the player, the slim player
      and the player head, handed over as the picture itself rather than as a
      path into the jar.*
- [x] **Modded renders are still backwards.** Picking another facing does not
      fix it; turning it 180° by hand does.
      *Because there was no other facing to pick: a mod's block is usually one
      variant and one model, and a front authored on the model's north face
      then points away with no state that would bring it round. The turn is
      applied directly now where there is no facing to do it with. Only where
      exactly one side is painted unlike the other three, so a crafting table,
      which has a front AND a back, is left alone.*
- [x] **Toggling a source switch scrolls the model list back to the top** and
      does not put you back, even when the count is unchanged.
      *A reload starts at the first page again, so getting back means loading
      back: it fetches as many pages as were showing before and then returns
      to where you were.*

### B. The skin pages
- [x] **The big skin render and the friend-details one are too slidy** when
      flung — nothing like the small card renders.
      *The decay had gone too far the other way answering "a flick dies too
      fast". It halves in about half a second now and is done inside two and a
      half: a flick that carries, rather than one that is stopped dead or one
      that never stops.*
- [x] **Slim and wide do not convert.** Changing which one a skin is leaves the
      pixels where they were.
      *The two models are not the same picture with a different label on it: a
      slim arm is three pixels across where a wide one is four, so the arm's
      faces sit at different places in the texture and the front and back
      faces are a column narrower. Setting the label and leaving the pixels
      alone left the arms unwrapped from the wrong parts of the image.
      WHICH column an arm loses was not guessed. Mojang ship the same nine
      characters in both models, drawn by their own artists, so the answer is
      in the client jar: scoring both possibilities for every face across all
      nine says the right arm's front keeps columns 1,2,3 and the left arm's
      keeps 0,1,2 — each arm narrows on the side facing the body — and the
      back faces mirror the front ones. Against their slim art the conversion
      matches 93% of the texels a slim arm reads, where leaving the pixels
      where they are matches 83%; the two characters that prefer the old way
      are the two Mojang made by truncating the wide art rather than
      converting it, so their "slim" arm reads different pixels than any
      remap would.
      Round trips are exact: a slim skin through the wide model and back is
      the same skin, byte for byte, because widening puts back a copy of the
      column narrowing took. Nothing outside the four arm boxes is touched,
      and a 64x32 skin — which has no slim form — is left alone.*
- [x] **Saving a skin from the editor as slim does not save it as slim.**
      *Picking a model in the editor only moved the face rectangles it paints
      through; the pixels stayed laid out for the old one, so what was saved
      was a wide image wearing a slim label. It converts now, and converts
      every LAYER rather than the flattened image — converting only the
      flattened one would leave the stack holding the old arms and the next
      compose() would put them straight back. The change is undoable, and the
      undo step carries the model with it so the label and the pixels cannot
      come apart.*
- [x] **Changing an APPLIED skin's model is not noticed** — it needs applying
      again, or undoing.
      *Changing the model converts the pixels, so the skin on Mojang's servers
      is no longer this one. The page decides what is applied by pixel hash,
      so the card simply stopped matching and nothing said so. Converting the
      applied skin now offers it for applying — the figure on the left shows
      the converted skin, Apply and Undo appear, and a line says what
      happened — instead of leaving the library and the account quietly
      disagreeing.*

### C. Launching
- [x] **The Cancel/Stop button goes back to Play** when you leave the instance
      page or reload it, until the game actually starts.
      *The button's state lived in the page, so a reload started from nothing
      and the launch it belonged to was invisible. The main process is asked
      which instances are starting up, so the page draws the button from what
      is actually happening rather than from what it remembers.*
- [x] **Every launch re-downloads all the resources.**
      *It never downloaded them -- it HASHED them, which looks the same from
      the outside and takes about as long. The library's asset check reads and
      SHA-1s every object in the index on every launch: four thousand files
      and most of a gigabyte, with the progress bar sitting on a step labelled
      "assets" throughout. Nothing in its options turns that off, so the check
      itself now remembers: a file whose size and modified time are what they
      were when its hash was last verified is taken as still verified, and
      anything that has moved at all is hashed properly. The steps say
      "Checking assets" and "Checking libraries" too, because that is what
      they are.*
- [x] **A crash shows only the exit code**, not what went wrong. Even the
      vanilla launcher shows the details.
      *A JVM that dies on a bad memory access writes no Minecraft crash report
      and prints no Java stack trace -- there is no Java left to print one --
      so all that ever reached the dialog was a number. It now says what the
      number means, and it reads Java's OWN crash file (`hs_err_pid*.log`,
      which the game leaves behind and nothing was looking at), down to the
      end of the header, with the "problematic frame" -- the library that
      actually fell over -- pulled out and put at the top.*
- [x] **`3221225477` crashes, very frequently**, and only with this launcher.
      *A real bug, and it is the launcher's. The library downloader verifies a
      jar like this:*

      if (!this.checkSum(library.downloads.artifact.sha1, file)) await get(lib)

      *`checkSum` is async, so the test is `!Promise`, which is never true: no
      library jar has ever been verified. And the downloader resolves when its
      write stream finishes without ever comparing what arrived against
      Content-Length, so a transfer cut halfway through leaves a truncated jar
      that only has to pass `fs.existsSync` -- forever.
      From 1.19 on the LWJGL natives ARE library jars: lwjgl.dll and glfw.dll
      are unpacked out of them at startup. A truncated jar is a truncated DLL,
      and a truncated DLL is an access violation (0xC0000005 = 3221225477) the
      moment the game touches OpenGL, on every launch, with no crash report.
      Every library is checked against its published hash now and the wrong
      ones are replaced, which costs one full read and a stat per launch after
      that thanks to the memo above.
      Two more of the same kind, found with it: below 1.19 the natives are
      unpacked once and the test for "again?" is whether the folder is empty,
      so an extraction interrupted halfway was never redone -- there is a
      stamp now, written last, naming the zips the folder was built from. And
      the client jar was downloaded without being checked and re-downloaded
      only if it had vanished altogether; one that is not the length Mojang
      published is now fetched again.*

### D. Mods
- [x] **Disabling a dev mod does not disable it** — it picks the new one up and
      puts it back in the enabled slot.
      *A mod is disabled by renaming its jar with a `.disabled` suffix, and the
      dev swap deleted whatever copy of the mod it found and wrote the enabled
      name back — so switching a dev mod off lasted until the next build,
      refresh or launch, whichever came first. The build going in keeps the
      state of the one coming out, and picking a specific build is not taken
      as switching the mod back on. A disabled jar's mod id was never read
      either: the lookup stripped `.disabled` off the path first and asked
      about a file that does not exist.*
- [x] **Remod.** With developer mode on, an Edit button on a mod jar or a
      resource pack: its declared name, description, version and icon (and a
      pack's description and icon), the file's name, and an "Edit assets"
      button that unpacks it into the in-launcher file browser. Save re-zips it
      in the SAME structure so it still works.
      *None of that is launcher metadata — it is declared inside the archive,
      in whichever manifest the loader reads — so the file is unpacked into a
      workspace, that manifest is edited, and the workspace is packed back up.
      Six manifests: `fabric.mod.json`, `quilt.mod.json`, Forge's and
      NeoForge's `mods.toml`, the old `mcmod.info`, a plugin's `plugin.yml`
      and a pack's `pack.mcmeta`. Each one is offered exactly the fields it
      actually holds, so a resource pack is asked for a description and a
      picture and not for a version no pack format reads. The TOML ones are
      edited as text rather than parsed and re-emitted — a mods.toml is
      hand-written, with comments and an order its author chose — and the edit
      is confined to the first `[[mods]]` block, because `version` means
      something else in a `[[dependencies]]` one.
      "Edit assets" is the launcher's own file browser, pointed at the
      unpacked copy, so editing a JSON in a tree or adding and deleting files
      works on a mod's insides with no new code. Nothing touches the installed
      file until Save; closing the dialog throws the workspace away.
      Packing back up reproduces the archive: every path relative to the root,
      forward slashes, no wrapper folder, and a folder entry wherever the
      original had one — which an unpacked folder cannot tell you, so the list
      is carried across from the unpack. The new zip is written beside its
      destination and moved into place, so a failure halfway through leaves
      the installed mod alone. Verified on the real test mod and test pack:
      every entry comes back byte-identical bar the manifest that was edited,
      and the mod still indexes and flattens exactly as it did.
      Renaming is there too, and it keeps the `.disabled` suffix out of it —
      that suffix is how the launcher stores "switched off", not part of the
      name — and a renamed resource pack is renamed in `options.txt` with it,
      or it would have switched itself off.*

## 0. Round 27

- [x] **Vanilla / modded / resource-pack switches** over the block, item and
      entity list. Vanilla on by default; modded shows what the instance's mods
      add; resource packs off by default, and on means the models are drawn
      with the instance's enabled packs and mods on top.
      *The index remembers which source every entry was found in, so the first
      two are a filter. The third changes the stack itself: with it off the jar
      goes FIRST, so the packs and mods are still there for anything vanilla
      does not have and nothing vanilla has gets replaced. Thumbnails are keyed
      by the version, the instance and that switch now, so one drawn with a
      pack on is not served back for a different instance.*
- [x] **An instance made from a mod or modpack does not offer the pack's own
      icon** the way it offers a mod's or a resource pack's.
      *Installing a pack now records the pack's icon apart from the instance's,
      so it is still there after the instance's has been changed, and the
      picker offers it under "This version". An instance installed before this
      falls back to the icon it was given, which for a pack is the pack's.*
- [x] **Modded blocks render backwards.**
      *The turn that brings a block's front round to the camera was "prefer the
      state called facing=south", which is right only because vanilla authors a
      front on the model's NORTH face. A mod that authored its front on the
      south face and turned it in the blockstate instead got turned away again.
      Which side is the front is now read off the model -- the one painted
      unlike the other three -- and the state picked is whichever turn lands it
      on south. Every vanilla block comes out exactly as before.*
- [x] **A wither rose, potted or not, renders as the wither.**
      *A cross is two upright planes with no thickness, so by VOLUME it was
      nothing, which is the test for "this model is only a placeholder, look
      for the entity the game draws it with" -- and the rose's own words cover
      the layer called `wither`. Measured by surface area instead, a bell's
      fitting is 2% of a block where a wither rose is 60%.*

- [x] **No entity renders at all on 1.20.1 or 1.19.4** (and none below 1.17).
      *One bad layer took the whole catalogue with it: a ModelLayerLocation
      whose name the interpreter could not work out threw out of `String()`,
      and that exception escaped the lot. A location with no name it can read
      is dropped now, and 1.20.1, 1.19.4 and 1.17.1 all read their catalogues —
      163, 163 and 154 layers where they had none.
      Below 1.17 there is nothing to read: the model layer system is what
      `createRoots` belongs to, and before it every model was built in its own
      class's constructor. That is a separate job.*
- [x] **A fix to the renderer does not show, because the picture is cached.**
      *Both caches -- a version's icon and the picker's thumbnails -- are keyed
      by WHAT was drawn, never by how. They carry a generation number now, which
      goes up whenever the drawing changes, and the stale files are swept the
      first time either is used.*
- [x] **A slime's back shows through its front.**
      *A mob is drawn both-sided, because a cutout box is routinely painted on
      one side only. A cutout is opaque, though, so it never showed what was
      behind it -- where a see-through one does, and the far side of the
      slime's gel, writing no depth, landed on top of the face in front of it.
      A see-through surface is drawn front-side only, which is what the game
      does with it too.*

- [x] **The adjust dialog's buttons scroll away.** They belong at the bottom,
      outside the scrolling part, the way the heading already is.
      *The dialog is a column now: heading, a scrolling middle, buttons.*
- [x] **The shulker bullet wears the shulker's texture** — and, found with it,
      forty-odd layers that had no texture at all.
      *Every `_baby` layer: only a handful of mobs have a baby texture of their
      own, and insisting on a name with "baby" in it left thirty of them with
      nothing, which in the picker is an entry that errors when you click it. A
      baby wears its grown-up's skin where it has none of its own.
      A size or a place on the end or the front of a name is not part of what
      the thing is, so `armor_stand_small` and `wall_banner` find the armour
      stand's wood and the banner's base. The folder and the file together
      name a thing even where neither does alone, which is a tropical fish
      (`fish/tropical_a.png`) and a player (`player/wide/steve.png`). A word
      that is what distinguishes ANOTHER layer is that layer's, so the plain
      player stops taking the slim one's folder and a llama stops wearing the
      trader llama's blanket. And three -- a giant, a shulker's bullet, the
      spin attack -- plus a nameless player head have textures with nothing to
      do with their names, which the game hardcodes too.*

## 0. Round 26

- [x] **A pack with only `panorama_overlay.png` is not offered.** The overlay
      alone is still a picture of that pack's title screen.
      *It is offered now, as the flat picture it is — there is no cube behind
      it to look around, so it goes straight to the cropper, and it is labelled
      "title screen" rather than "panorama".*
- [x] **`entity models: carried on past length of JOpaque(…​.clone)`**, on
      `EquipmentSlot`, `Direction` and `Direction$Axis`.
      *`X.values()` compiles to `$VALUES.clone()`, and `$VALUES` is filled in by
      the enum's `<clinit>`, which builds every constant through a constructor
      the interpreter does not model. So the field stayed opaque, taking its
      length gave the "length of a non-array" that lenient mode reads as zero,
      and every loop over `Direction.values()` ran no times at all. Nothing
      needs running: an enum has exactly one static field of its own type per
      constant, so the count is in the class's own field table. Both versions
      now read their whole layer catalogue with nothing waved through.*
- [x] **`Failed to parse servers.dat: PartialReadError`**, with fifteen frames
      of stack, three times over.
      *The file is empty. A zero-byte buffer comes out of the NBT reader as
      "Read error for undefined : undefined" from inside the protocol compiler,
      with no mention of which file it was. The smallest real servers.dat is
      nineteen bytes — a compound holding an empty list — so anything shorter is
      a file that was never finished, and is read as no servers at all. A
      genuinely corrupt one is still reported, once per file and in one line.*
- [x] **A skins-page entry called "undefined" that cannot be deleted.**
      *A record with no picture in it, merged in from the relay or left by an
      older version. Nothing checked that what came back was a skin, and having
      no id either, nothing could be done with it — renaming, applying and
      deleting all look it up by id and found nothing. The library drops
      anything with no picture, on the way in and on the way through the merge,
      and fills in an id and a name for an old entry that lacks them. The file
      is written back once, so the next sync carries the tidy list.*

## 0. Round 25

- [x] **The two-block plants' lower halves look wrong**, and so does short
      grass next to the others' tops — render a cross normally and stop
      messing with it.
      *The messing was the model's own 45°. A cross is two upright planes
      turned a quarter of a right angle so a plant reads from wherever you
      happen to be standing in the world; this view is not wherever you happen
      to be standing, it looks down the same diagonal every time, and that turn
      put one plane exactly across the screen and the other exactly edge-on.
      So a flower was ONE plane seen flat, 41% wider than the block from the
      `rescale` that comes with the turn and 82% of its height from the
      projection: a poppy as a red disc on a stick, short grass as a wide low
      mat. The pair is drawn unturned now, meeting the camera at equal angles,
      and the poppy is half as wide as it is tall. Only the pair, and only that
      angle: a brewing stand's bottles and a hanging sign's board keep theirs.*

- [x] **Found while working: a bed, a decorated pot and a dragon head render
      as plain cubes.** They are blocks the game draws itself, and the assets
      hold nothing but a particle texture for them.
      *None of their layers is named for the block — a bed is `bed_head` and
      `bed_foot`, a pot is `decorated_pot_base` and `decorated_pot_sides`, a
      dragon head is `dragon_skull` — so the lookup, which wanted a layer made
      of the block's own words, found nothing. A layer made of those words plus
      one naming a PIECE of a thing counts now.
      A bed is drawn as both halves, stood up and laid end to end the way the
      game does it, in any of its sixteen colours. A pot is its base and its
      walls together: the base reaches a few sixteenths above the block, and
      insisting a block entity fit inside 0..16 in every direction had it read
      as a mob and turned upside down. What actually tells the two apart is
      that a mob is built around its pivot and always has boxes at negative
      coordinates, where a block is built from its own corner and never does.*
- [x] **Found while working: a rail's default state is a piece of track
      standing on end.** *Its `shape` has no "straight" among its values and
      nothing else matched one either, so the file's first state won — which is
      an ascending rail, seen edge-on and all but invisible. A flat one is the
      plain state now.*
- [ ] **Found while working: a sign renders as a plain cube.** Unlike the bed
      and the pot there is nothing to draw it with — the version's layer list
      has no sign in it at all, so there is no model to find.

## 0. Round 24

Sent while Round 23 was still being worked through.

- [x] **`entity models: createRoots stopped early — length of a non-array`**,
      logged on several versions. The interpreter gives up part way through the
      layer catalogue, so whatever comes after the bail is simply missing.
      *It was an enum's `values()` — which compiles to `$VALUES.clone()` — on
      `Direction`, `Direction$Axis` and `EquipmentSlot`. The interpreter does
      not model that call, so in lenient mode it is an opaque value, and taking
      its length stopped everything. Array operations on an opaque now give an
      empty array, which is the same bargain lenient mode already makes
      everywhere else, and what it waved through is logged once at the end
      instead of silently.*
- [x] **The pistons move linearly**, where the game's ease in and out.
      *Each one fires now: the travel happens over the first half of its window,
      fastest as it leaves, and then it stands there extended for a quarter of
      a second before coming back. Its retract still coincides exactly with the
      next one's push.*
- [x] **An older instance with no icon of its own shows redstone ore.** It
      should show its version's own render — and so should the latest snapshot.
      *An instance with nothing stored now draws its version's icon on demand,
      in the lists, the sidebar, the home page and the settings preview. And a
      snapshot is no longer a dead end: it takes the icon of the version it is
      on the way to — the first release out after it, or, when it is ahead of
      every release, whatever the icon list names as coming.*
- [x] **Cropping a picture that is not square still will not move off the
      sides**, and still has odd edges.
      *The limit was "however much of it hangs over the edge", so a wide
      picture could slide along but its ends could never be brought inside the
      square. It can now go right out past the edges, stopped only by having to
      leave a tenth of the square covered. The odd edges were the drawn
      rectangle landing on half pixels, which makes the canvas blend the
      outermost row with what is behind it; it is snapped to whole pixels.*
- [x] **The creeper's charge texture is in the wrong place.**
      *It is the charge layer, which a creeper only wears after a lightning
      strike. It is a switch now, off to begin with.*
- [x] **A chicken's legs are still only drawn from one side.**
      *The game draws mobs with backface culling off, because their boxes are
      routinely painted on one side only — a chicken's leg is a 3x5x3 box with
      one one-pixel column of art on one face and nothing on the other three.
      Mobs are drawn both-sided now; blocks keep culling, which is what stops
      glass and leaves showing the inside of their own far faces.*
- [x] **Whatever the copper chest is rendering as, it is badly wrong.** *It was a decorated pot in pieces: its sides layer is called
      `decorated_pot_sides` and its texture `decorated_pot_side.png`, and the
      plural matched nothing, so the pot had no walls.*

## 0. Round 23

Asked for in one batch, with "do everything else before the icon renderer
stuff" — so the list is in two halves and the first half is done first.

### A. Everything that is not the renderer
- [x] **The loading animation fires one piston at a time.** The next should
      start as the one before it comes back, not after.
      *The push and the pull back are each a quarter of the cycle, so the next
      piston leaves as this one starts coming home: 98% of frames now have two
      moving.*
- [x] **A modal's blur covers the corner where the top and left bars meet** —
      the friend details one, again.
      *Every dimming layer stops at the chrome now, and a sweep of the frontend
      fails the test if a new one does not. The two that live on every page —
      `uiConfirm`/`uiAlert` and the notification popup — follow each bar that is
      actually there, since the splash has neither and the admin windows have no
      sidebar.*
- [x] **The loader cards are too small**: the five of them should fill the
      page, and the last page leaves too much of it empty.
      *The loaders get a column each, full height, with the art scaled to
      match. The last page is a composition down the middle: the icon as big
      as the page allows, the name and the chips beside it.*
- [x] **Clicking the version or the loader on the last page** should be a
      re-pick of that one thing that comes straight back, not a restart of
      the sequence.
      *Both chips are detours now and say "Change" on them; Back is still the
      step before, which is the loaders rather than the versions.*
- [x] **The latest-snapshot icon** should be the newest version named in the
      JSON *unless that version has been released* — and the plain snapshot
      mark when there is nothing newer named.
- [x] **"Use this" in the adjust dialog** should say it goes on to the
      cropping. *It says "Continue to cropping".*

### B. The renderer
- [x] **Block entities are upside down** (chests, bells).
      *A mob is built around its pivot with +Y pointing down and the game turns
      it over to draw it; a chest and a bell are built the way a block model is,
      +Y up inside the 0..16 cube, and get no such turn. Which kind a layer is
      can be read off the model, because the two spaces do not overlap. They
      also stop being spun to face the camera — their front already is one,
      which is why the chest showed its back.*
- [x] **The breeze's wind should be see-through, not left out** — let a part
      be transparent instead.
      *A texture with part-way alpha is now drawn blended and without writing
      depth, and the cutout ones say they are opaque so they go in the pass
      before it. With everything in the blended pass the wind and the breeze
      raced — they share a centre, so nothing decided the order — and whichever
      went first cut the other away.*
- [x] **A part of the breeze's body is a snippet of texture that is not it.**
      *One mesh is registered as several layers with a texture each, and every
      registration carries every box. A box whose unwrap runs off the layer's
      own texture belongs to another layer of the same mesh — that is where the
      slabs of grey came from. Only dropped when another layer does have room
      for it, because a model that merely overflows its own texture (the
      decorated pot's top and bottom) must keep its boxes.*
- [x] **Variants that are not variants.** The ender dragon has an "ender" one
      wearing the ender chest's texture; the armadillo has "scute"; the dragon
      skull has two wrong "skull" ones; the evoker has "fangs"; the llama has
      "trader" (an overlay) and "spit" (its own entity); the iron golem has
      the iron armour and tools; the happy ghast has the ghast; a banner has
      five "brown" ones and wears a bed's texture.
      *Past the best match, a texture is disqualified if it is in another
      folder, if its name is part of this one's rather than an addition to it,
      or if a differently-shaped layer of its own is named for it.*
- [x] **Tell an overlay from a variant by rendering it**: an overlay is mostly
      transparent where a variant is not.
      *By measuring it: a skin covers roughly what the first one covers, an
      overlay a fraction of it.*
- [x] **Cracked iron golem, drowned armour and the like should be toggles
      over the mob**, not entries of their own — and armour it never wears
      should not be there at all.
      *Overlays are parts now, laid over the same boxes and switched off to
      begin with. The armour it never wears was in another folder, so it is
      gone. A creeper's charge arrives as a layer rather than a texture, and
      the words that mean "only sometimes" are listed deliberately.*
- [x] **Block states that change the texture do nothing** — the anvil's
      facing, the creaking heart, the icicle, the bell's block form.
      *The state was listed, the choice was passed in, and nothing ever looked
      at it: a bare id like `minecraft:anvil` was being handed its ITEM's model
      before the blockstate was even consulted, and almost every block is also
      an item. A bare id is a block now; an item is listed with `item/` in its
      id and still reads its own definition.*
- [x] **A bell has three entries** (item, block, block entity); an item model
      that is the same as its block's should not be a second entry, and the
      one that is kept is the one with the states.
      *Anything sharing a block's name is dropped and the block is kept — it is
      the one you can turn, set and adjust.*
- [x] **An item model that is a block, or more than one picture, should still
      be adjustable** — and turning and tilting a flat item does nothing, so
      the dialog should not offer it.
      *Turn and tilt are hidden for a flat item. (A multi-picture item was
      already adjustable through its variants.)*
- [x] **Tilt does not go all the way round**, and it tilts from the original
      angle rather than the current one.
      *The slider is ±180, and a tilt is about the screen's horizontal applied
      last, so a turned model leans back instead of going sideways. The model's
      own x rotation stays Minecraft's.*
- [x] **Chest variants do nothing**, and a double chest should be drawn as
      both halves.
      *A chest is listed as a BLOCK, because that is what it is, and a block's
      variant was only ever read as an item's — so the choice was made, passed
      in and dropped. It reaches the block entity now, and ender, trapped,
      christmas and the four coppers all work.
      `normal_left` and `normal_right` were two more of those variants, which
      drew half a chest with its lock in the corner. They are not a chest each:
      they are the two halves of one double chest, fifteen wide apiece, and the
      pair is now one entry that draws it whole.*
- [x] **All the armour trims render as the plain item.**
      *A trim's picture is not in the jar. `..._gold_trim` asks for
      `trims/items/chestplate_trim_gold`, and all the jar holds is the grey
      mask and a row of eight colours per material; the game stitches them at
      load time, and now so does this. Where the palettes live moved in 26.1 —
      an atlas file used to declare them and now the folder speaks for itself —
      so both are read.*
- [x] **Every clock variant is also its own search result.**
      *From 1.21.4 an item is a definition file and the models beside it are
      the pictures it chooses between. The definitions are the catalogue now;
      "clock" finds one thing instead of 65, "chestplate" seven instead of 84,
      and the faces and trims are still there as variants.*
- [x] **Bush, fern and large fern have no tint**, and the tint should be
      changeable in the render settings. Leather armour too, in its colours.
      *They had no tint because they had no block: a bare name was handed its
      ITEM's model, which is a flat sprite with nothing tinted on it. Leather
      armour is dyed rather than tinted — the colour is in the item's
      definition, one per layer, and was going unread. Both are now a colour
      in the adjust dialog, with the sixteen dyes beside it for the things
      that are dyed, and an off switch.
      Which blocks are tinted at all is read better too: the median pixel
      rather than the average one, because jungle leaves have a few bright
      pixels and averaged out MORE colourful than pale oak leaves, which are
      not tinted at all. Pale oak leaves stay grey, cherry stays pink.*
- [x] **A face pointing at the camera should be fully lit**, which settles the
      lighting generally.
      *Whichever is brighter wins, the shade table or how squarely the face
      meets the camera — so nothing changes at the standing angle and a face
      lifts as it comes round.*
- [x] **A cross model's rotation settings do nothing.**
      *Because it was not a cross model. `short_grass` is a bare name, and a
      bare name was handed its ITEM's model — a flat sprite, which has nothing
      to turn. It is the block now, and the slider turns it.*
- [x] **Parts that only render from one side** — the axolotl's tail, a
      chicken's legs, some fish tails. *All one cause: mobs are drawn with
      culling off in the game, and were not here.*
- [x] **A variant that is also its own entry** can differ from it — the cold
      chicken has no beak; the warm cow has no horns.
      *Those variants carry the layer they belong to, and picking one brings
      its model.*
- [x] **Minecart variants have no block in them** and are not offered as
      variants.
      *The block in a cart is not in the model: the game draws the entity's own
      block state inside it. The name says which — strip `_minecart` — and it
      goes in at the game's three quarters size, turned a quarter and standing
      on the cart's floor. The seven of them are one mesh and one texture, so
      they are each other's variants now, which needed the variant list to be
      keyed by name rather than by texture.*
- [x] **The bogged's parts all use one texture.**
      *The word on the layer and the word on the file are not always the same
      one: `bogged/outer` is drawn with `bogged_overlay.png`. Where the two
      mean the same thing either will do, so the clothes find their own
      picture instead of falling back to the body's. Same for the stray, the
      drowned and the wither.*
- [x] **The wither's armour layer is in the wrong place** — the right texture,
      mapped onto its head.
      *It is not a skin. A charged creeper's crackle and the wither's shield
      are the game's "energy swirl": the sheet is scrolled across the mob and
      ADDED to what is behind it, and it is not unwrapped to the model at all —
      wither_armor.png is a scatter of little skull faces over the whole
      square. Drawn as a skin it painted one on the wither's head; added, it
      lights the mob up and leaves it recognisable. The game has the same two
      and no more, and nothing in the assets separates them from an ordinary
      overlay, so they are named here too.*
- [x] **A cross model on the second block of a two-block block is turned 45°**,
      and a two-block block with no upper half draws something there anyway.
      *Same cause as above for the turn: tall grass, large ferns and the tall
      flowers were all being drawn from their item sprite. The something in the
      air was a pitcher crop: its top half is a model with NO geometry until
      the plant is tall enough, and a model without geometry falls back to a
      cube of its particle texture, so a seedling had a block of soil floating
      over it. An upper half that is nothing in the game is nothing here.*
- [x] **The dried ghast's default rotation is wrong**, which matters because it
      is a version's default icon.
      *It had no rotation at all, and no textures of its own either: the icon
      list names it `block/dried_ghast`, which looks like a model and is one —
      but that model is only the template its blockstate fills in, with every
      texture still a `#north`. A path under block/ is now read as the block
      where a blockstate goes by that name, so the ghast faces the viewer, the
      observer and the bee nest show their fronts, and the pieces that are only
      ever part of something else stay the models they are.*

## 0. Round 22

### A. Modals and the new-instance flow
- [x] **Every modal should animate in and out**, not appear and vanish.
- [x] **"Set it up myself" is too small for what it is.** The version and loader
      pages should fill the window rather than sitting in a small box in the
      middle, with bigger cards.
- [x] **Drop Cancel and Continue from those pages.** Cancel does what the ✕
      already does, and clicking a version (or a snapshot) should go straight on.
- [x] **After the version and loader, open a finalize page**, not the old
      create-instance modal. A mod and a modpack end on the same page.

### B. Block and entity rendering
- [x] **Some things cannot be found at all** in the icon picker's search —
      ender dragon, cushions, pigs, cows. Their textures are not named after
      them; every texture under entity/ is scored against the name now.
- [ ] **An armadillo shows curled up and standing at the same time.**
      Guessing which parts are alternatives broke far more than it fixed, so
      every part is drawn and each one is a switch in the adjust dialog.
      Doing it properly means reading `setupAnim` out of the model class.
- [x] **An elder guardian's side has a hole in it**, the way the ender dragon did.
- [ ] **An evoker's hands are both together and held out at once.** Same as
      the armadillo: a switch rather than a guess, for now.
- [x] **A baby drowned has the same missing layer the drowned had.**
- [x] **A block with block states cannot be shown in a different state.**
      Pick one in the adjust dialog.
- [x] **Tinting must be detected, not listed by hand.** Some tall and short grass
      variants, water and jungle leaves still come out grey. A `tintindex` is
      the whole test now, and the colour is read out of the game's own
      colormaps in the jar.
- [x] **Cross models on a wall are lit wrongly and turned 45°.** The models
      say which direction to shade from; that was being ignored.
- [x] **The bell comes out wrong**, with parts missing or cropped off.
- [x] **One entity is split into several** — breeze, breeze/eyes, breeze/wind.
      Parts are drawn with the mob and are switches, not entries of their own.
- [x] **Two-block blocks do not render as one** (beds, doors).
- [x] **Trimmed armour shows as the untrimmed armour.** Every trim is a
      variant in the adjust dialog, with the plain one as the default.
- [x] **Item variants should be offered** the way a mod's pictures are — every
      clock, every compass and so on.
- [x] **Chests, ender chests and copper chests render as plain cubes.**
- [x] **Mob heads render as plain cubes** rather than the head model.
- [x] **The red mushroom block renders as nothing** — it is six separate
      faces in a multipart blockstate, and only the first was drawn.
- [x] **Mushroom cross models are lit wrongly, and so is the cross model
      inside a flower pot** — fix the lighting itself rather than the cases.
- [x] **Some entities get the wrong texture**, and an outer layer is often
      rendered as its own thing with the texture all over the place. Each
      layer resolves its own, and the others are offered as variants.

### C. The icon picker
- [x] **The title stays above the scrolling area, and Custom image / Cancel stay
      below it.**
- [x] **The cropper will not let you move the image once it is zoomed out.**
- [x] **Searching "ice ball" does not find `ice_ball`.**
- [x] **A render resolution slider and a render angle slider** in the cropper
      — in an adjust step before it, along with the part switches.
- [x] **An icon out of a mod file can still come out blurred.** The cropper
      was interpolating on the way up to 256.
- [x] **A big modpack's icons should appear as they are rendered**, not all at
      once after a "Loading…".
- [x] **Scrolling to the end loads more.**

### D. Elsewhere
- [x] **Changing what a page is showing has no loading transition** — the
      instance detail to the instance list is instant where a page change is not.
- [x] **The render in a friend's details has no physics** and never returns to
      facing forward.
      *The skins page's camera physics is in `skin-animations.js` now, so both
      renders share one copy — and one copy of the springs with it. Two things
      came out of it: a drag that left the narrow canvas killed the loop, so a
      flick never carried; and the springs stepped per frame, so they ran at
      the speed of the display — three times too fast at 144Hz and slow enough
      on a struggling machine to read as never coming back. A frame counts for
      how long it took now.*
- [x] **The admin password file should hold the hash, not the password.**
- [x] **Switching instance leaves the old instance's modals open.**
- [x] **The skins page's "Loading your skins & capes" should be the ordinary
      page-change loading**, saying what it is waiting for.
- [x] **With one skin saved, Add skin does not take the rest of the row.**
- [x] **A modpack picked in "from a mod or modpack" does not get the confirm
      page** that a mod gets.
- [x] **Some versions have no panorama** — `1.12.2 asset index has 0/6 faces
      downloaded`, `no panorama_0`.
      *Before 1.13 the title screen was not an asset at all, it was in the jar,
      so an index with no `panorama_0` in it is an old version rather than a
      failure and the jar is where to look. It was being read out of the wrong
      jar, though: below 1.14 the TEXTURE stack reads from the 1.13 jar first,
      for the blocks and items 1.13 renamed, so every old version was handed
      1.13's underwater title screen. The version's own files are read now, and
      1.8 and 1.12 get the beach they ought to.*
- [x] **An instance made from a mod or modpack still has no way back to its
      version's default icon** — that icon is missing from "This version".
      *The section is drawn from the version the caller names, and the places
      that open the picker for one of those instances do not always name one.
      Where the caller is silent and there is an instance, the instance is
      asked, so its version's own icon, banner and panorama are all there.*

## 0. Round 21

Everything asked for across this round, **in the order it was asked**, which is
the order it is being built in.

### A. The block/item renderer, as reported from the test sheet
- [x] **Some models render turned half a turn** from the angle they should be
      seen at — dried ghast and bee nest definitely; stairs face the right way.
- [x] **A transparent render shows what is behind it.** By default nothing
      should be visible through a face.
- [x] **Cherry leaves are already pink and must not be tinted**, the same as
      orange poplar leaves.

### B. Entities
- [x] **An entity renderer**: read/simulate the entity renderer classes and,
      with the entity texture, render entities too.
- [x] **Cross-modelled blocks render dark** — `shade` is an element property,
      not a face one.
- [x] **26.x ships deobfuscated**, so no mapping file is needed there.

### C. After the rendering work
- [x] **Panorama overlays are missed.** A version's panorama — and a modded one
      — can have still images laid over it in game; those are not being drawn.
- [x] **New-instance modals: cancel/back closes everything** instead of going
      back to the modal it came from.
- [x] **The icon picker takes a while to fill in** every time it is opened.
- [x] **Censor the access token, the xuid and the like in the logs** as `****`.
- [x] **An imported modpack should show the modpack's icon.**

### D. The friends panel
- [x] **The status dropdown is MY OWN status** — the one reported through the
      API — not a filter over the list.
- [x] **"Search or add by username"**: the box searches the list it is over; the
      Add button (or Enter) does not add straight away — it opens the player's
      details first.
- [x] **A player details modal**: on the left their skin as a player render,
      the same as the skins page's main render, with their cape and no random
      animations. On the right, the same head/name/status line the list shows,
      and under it a remove-friend button, a NameMC button (their uuid's page),
      and a label saying whether they have used Redstone Launcher before and on
      what day — detected on the server.
- [x] **The list's remove button becomes an info button** that opens that page.

### E. Suggestions
- [x] **A Suggestions tab in settings**, with a form icon, the blurb about not
      needing sketchy websites for things a launcher should include, an input
      section and a submit button.
- [x] **A confirm modal** on submit, and a premium account is required — the
      server verifies it.
- [x] **`viewSuggestions("password")` in devtools** for admins, against a
      password the server holds in a file that is not in git.
      (`viewAdmin("password")` too — suggestions are one panel of several.)
- [x] **An admin page** listing suggestions like the accounts page: the
      submitter's name, their face, the title; clicking one shows the body.
      It holds no layout of its own: it asks the relay what panels exist and
      draws them, so a second panel is a change to the relay alone.
- [x] **Admin actions**: time out the submitter (and every account of theirs)
      from submitting for a set period; accept or deny with a reason.
- [x] **A submitter sees their own suggestions and their status.**

### F. Icons for a project
- [x] **Mods, resource packs and the rest should offer their Modrinth or
      CurseForge icon and banner, and their gallery images** — clicking the icon
      first shows a choice between the in-file icon, the site icon, the banner
      and the gallery, and only then the cropper.
- [x] **Creating an instance from a mod or modpack only shows Modrinth results.**
      Both sites are searched now, and a CurseForge pack or mod installs the
      same way. A CurseForge pack cannot be set up as a *server* — that means
      reading its manifest and working out which mods are client-only, which
      the launcher only knows how to do for a .mrpack — so that one option is
      greyed out with the reason on it.
- [x] **The + button can open more than one new-instance modal.**

### G. The new-instance flow
- [x] **Keep the per-version banners.** Kept on disk, and the snapshot shape
      of the wiki's path (`25w31a.jpg`) is tried as well as the release one.
- [x] **"Set it up myself" starts with a version picker**: a card per version
      with the wiki banner behind it and the rendered version icon above the
      name.
- [x] **A "latest snapshot" card**: the icon of the newest version named in the
      JSON even if it is not out yet, over the newest snapshot's banner
      (`.../26.4-snapshot-2.jpg`, `.../26.3-pre1.jpg`, `.../26.3-rc1.jpg`).
- [x] **A "select snapshot" button** bottom-left, beside Continue bottom-right
      and outside the scrolling area, opening the same modal listing every
      snapshot with no icons or banners.
- [x] **Continue goes to the same kind of page for loaders**, their icons being
      the loaders' icons and the backgrounds their logos' edge pixels stretched.

### H. The skin editor
- [x] **The colour picker takes no hex** and forgets the colours just used.
      A hex box beside the swatch, and a Recent row kept across sessions.
- [x] **The fill tool has no tolerance** for nearly-equal colours.
- [x] **Delete does nothing to a selected area.** Delete, and Ctrl+A, Escape.
- [x] **No copy or paste of a selection.** Copy, Cut and Paste, on the
      selection bar and on Ctrl+C / Ctrl+X / Ctrl+V.
- [x] **Moving a selection leaves the original behind** until the button is
      released; the original should be shown in place while it moves.

### I. Cloud skins
- [x] **A cloud-synced skin cannot be deleted at all.** Deletions are recorded
      and travel with the library, so one stays deleted — here and on the
      account's other computers. The image itself stays on Mojang's servers,
      because texture ids are permanent, and the dialog says so.
- [x] **Editing a cloud-saved skin saves a new one** instead of changing it.
      The merge matches on the skin's id as well as its pixels, so an edit is
      still the same skin; the image it was before is retired with it.

### J. The loading indicator
- [x] **Replace every page's spinner** with a 4×4 grid of blocks that loops
      round: `#RP# / P##R / R##P / #PR#`, where `#` is empty, `R` is a redstone
      block and `P` a piston facing the redstone block beside it. The top piston
      extends — swapped for the headless piston with its head sliding along
      ahead of the redstone block — giving `RHP# / P##R / R##P / #PR#`, then the
      next one fires while the first retracts, round and round. Real textures.

### K. The skin renders
- [x] **Not every skin render has the physics** — the skin editor's does not.
      *The three in the editor that are only looked at — the image import, the
      merge preview and the creator — have it now. The paintable one is
      deliberately left out: springing back to the front while you are drawing
      on the back of a head is not help, and a flick carrying on under the
      brush is worse.*
- [x] **Stabilising a fling eats its momentum.** It should keep spinning and be
      levelled separately.
      *They were already separate — a flick with no lift in it runs down at
      exactly the same rate as one that gets levelled — so what was wrong was
      how long a flick lasts at all: it halved every 0.4s and was standing
      still inside two and a half seconds, which is about as long as the
      levelling takes, so the two read as one thing. A flick is still turning
      at 1.7 rad/s two seconds later now, and still going when the spring takes
      it home.*
- [x] **A random animation must not start while the render is being moved.**
      Only after it has been left alone in the default position for a while, and
      then at random intervals; playing one by hand from devtools resets the
      timer.
      *Being dragged was the whole test, which let a gesture start on a figure
      still spinning from a flick, halfway home, or turned to its back and sat
      on. The physics now says when it last came to rest facing forward with
      nobody on it, and a gesture wants six seconds of that. One played by hand
      from devtools starts the wait again.*

---

## 0. Round 20

### Heads
- [x] **Store one 8×8 head texture, not a cache per size.** Right now a 38×38,
      a 34×34, a 32×32, a 24×24 and so on get written for the same player. Build
      the 8×8 face+hat composite once and let the page draw it at whatever size,
      unsmoothed — the texture itself never changes size.

### Pixel art
- [x] **Low-resolution icons should render sharp everywhere**, not just player
      heads: mod icons, resource-pack icons, and the same image when it has been
      set as an instance's icon.

### The icon picker
- [x] **The panorama drags the wrong way** — grabbing and pulling turns it in
      the opposite direction (or by the wrong amount).
- [x] **A server added after the picker was opened doesn't appear.** Pick an
      icon, add and ping a server, and that server's icon still isn't offered.
- [x] **Allow zooming out in the cropper** when part of the image is outside the
      crop area.
- [x] **Hold right-click on an icon to preview it larger**, so you can tell what
      it is.

### Version-based default icons
Unparked — *"Do the icons and the block / item model rendering aswell. Maybe get
the jar when getting it anyway for the default skins."* The full spec is in
§Round 20 Appendix below; this is the work list.

- [x] **Keep the client jar that the default-skins build already downloads**,
      instead of throwing it away, so the icon renderer has one to read.
- [x] **A ranged zip reader**, so a version whose jar is not on disk costs a few
      hundred kilobytes of range requests rather than a 40 MB download.
- [x] **Resolve a version to an icon**: fetch `versions.json`, order the entries,
      apply the carry-forward rule, the half-year staleness guard, the snapshot
      rule and the too-old-release rule.
- [x] **Flatten a model out of the jar**: walk the `parent` chain, merge
      `textures` and `elements`, resolve `#refs`, and read the texture PNGs —
      from the 1.13 jar when the version is below 1.14.
- [x] **Render it**: an isometric cube for a block (top lit, right shaded),
      the flat texture for an item.
- [x] **Bundle the three fallback icons** (release, snapshot, old launcher)
      rather than hot-linking the wiki.
- [x] **A new instance with no icon gets its version's icon.**
- [x] **The icon picker offers it too.**

### A blocks-and-items section in the icon picker
Asked for once the renderer existed anyway: *"expand it to its own section at the
icons too (list all the models and add a search bar. And also support different
block states etc) And support per instance modded / resourcepacked item/block
models aswell."*

- [x] **An asset layer that stacks sources the way the game does**: enabled
      resource packs first (in their own order), then mods, then the client jar,
      so a pack or mod that replaces a model wins.
- [x] **Index every model** in those sources — `models/block/*.json` and
      `models/item/*.json`, across namespaces, not just `minecraft`.
- [x] **A searchable grid** of them in the picker, rendered lazily: a jar holds
      thousands of models and they cannot all be rendered up front.
- [x] **Block states**: read `blockstates/*.json` so a block with variants
      (axis, half, facing, age…) can be picked in the state you want, with the
      variant's own `x`/`y` rotation and `uvlock` applied.
- [x] **Arbitrary models, not just cubes** — the renderer has to draw whatever
      `elements` the model declares, with per-face textures, UVs and rotations.

---

## Round 20 Appendix — version-based default instance icons

A manually created instance currently gets the generic launcher icon. Instead
its default should say which version it is.

**Where the mapping comes from.** `versions.json` at the root of this
repository, fetched at runtime so the list can be updated without shipping a
launcher build. It maps a version to a model path, with the kind in the prefix:

```json
{ "26.2": "block/sulfur", "1.21.11": "item/diamond_nautilus_armor", … }
```

Entries currently run from `1.3.1` up to `26.4`.

**Resolution rules.**
- A version listed in the JSON applies to **every later version** until another
  entry takes over. So if the JSON names `1.21.9` but not `1.21.10`, then
  `1.21.10` uses `1.21.9`'s icon.
- **Staleness guard:** if the newest applicable entry was released more than
  roughly half a year before the version being resolved, fall back to the plain
  release icon rather than showing something that is clearly from an older era.
- **Snapshots** get the snapshot icon, not a per-version block.
- **Old releases** (older than the first JSON entry) get the old launcher icon.

**Rendering the icon.** Produce an isometric render in the style of the wiki's
block renders (see <https://minecraft.wiki/w/Help:Isometric_renders>, e.g.
<https://minecraft.wiki/images/Sulfur_JE1_BE1.png>): a cube drawn in isometric
projection with the top face lit, the left face at base brightness, and the
right face shaded.
- **Blocks:** load the block model from the jar and render it — which means
  honouring custom models and walking `parent` chains, not assuming every block
  is a full cube with one texture on all six faces.
- **Items:** render the item texture / item model flat, with no isometric cube.
- **Texture source:** take textures from the version's own jar, except **below
  1.14**, where the 1.13 jar supplies the textures while the models still come
  from the version itself.

**Picker integration.** The resolved version icon should also be selectable from
the icon picker, like the panorama and server icons are.

---

## Round 19

- [x] **A pack's own panorama.** If an instance has resource packs or mods that
      replace the title-screen panorama, offer that one in the icon picker too.
- [x] **Re-hovering the same card still cuts the ease short.** Unhover then
      hover the same skin again and it snaps instead of carrying on.
- [x] **The cards should come back the same way the big render does** rather
      than with their own ease.
- [x] **The big render sometimes fails to settle facing forward**, ending up
      slightly turned.

---

## 0. Round 18

### Instances
- [x] **Grid view rows overlap.** Cards in the second row and below are cut off
      — the rows aren't given enough height.
- [x] **Play and folder should sit side by side** on a card, not stacked.
- [x] **Some places still show the old remote default icon**, e.g. the icon
      section in an instance's settings.

### Refreshing
- [x] **Rebuild in the background and swap in one go.** A refresh currently
      fades out, comes back empty, and then fills in — most visibly when
      tabbing away and back. Instance list, server list and both detail views.

### The player render
- [x] **Panorama icons aren't rendered as panoramas** and can't be spun.
- [x] **Hovering a second card cuts the first one's ease-out short** instead of
      letting it finish.
- [x] **Keep the figure vertically centred when spinning fast** — it should
      pull its own pitch back toward level rather than drifting up or down.
- [x] **The small card renders need the same treatment**: the spin physics, the
      arms going out, and the pitch stabilising — spinning freely first and
      only then settling.

---

## 0. Round 17

- [x] **The whole launcher freezes the first time skins load.** Building the
      default-skin set unzips a ~25 MB client jar with AdmZip, which is
      synchronous — on the main process that stops every window. Move it to a
      worker thread, and stop re-reading/re-parsing the cache file on every
      single head.
- [x] **The hat layer comes out the wrong size.** sharp applies `composite`
      AFTER `resize` whatever order you call them in, so the 8×8 overlay was
      pasted at native size into the corner of the resized face.
- [x] **Adding a friend empties the box and nothing appears in Outgoing.**
      The input is cleared whether or not it worked, and there is no visible
      sign of the request landing.
- [x] The head beside the username box should be the selected account's until
      you type something.

---

## 0. Round 16

- [x] **Import from Lunar Client.** Its accounts live in
      `.lunarclient/settings/game/accounts.json` (the same shape the Minecraft
      launcher uses), and the Minecraft versions it has downloaded are the
      folders under `.lunarclient/offline/`. Lunar keeps no local skin library,
      so there is nothing to import there.
- [x] **Build player heads ourselves** instead of pointing an `<img>` at
      minotar / mc-heads. Those answer a rate limit with HTTP 200 and a default
      Steve, so the lists quietly filled with the wrong faces. Composite the
      face at (8,8) with the hat layer at (40,8) from the skin Mojang is
      actually serving, and cache by texture hash.
- [x] Offline accounts get their calculated default out of the full modern set
      (Ari, Efe, Kai, Makena, Noor, Sunny, Zuri as well as Steve and Alex), by
      the same rule the skins page uses — not just one of the legacy two.
- [x] An offline account that has a skin in this launcher shows THAT skin's
      face everywhere a head appears, and the heads redraw when it changes.
- [x] Build the default skins once at startup rather than warming them lazily.
- [x] Offline accounts get the same skins page as premium ones — same library,
      same reset, same apply and undo — minus capes, cloud saving and syncing,
      none of which they can have.

---

## 0. Round 15

### The player render
- [x] **The cape sits inside the head while idling.** Fine during clips, wrong
      in the idle — so the reparenting onto the body is landing the cape at the
      wrong local offset somewhere the idle path goes through.
- [x] **The spin physics is far too forceful**, and the arms fly OUTWARD when
      they should be trailing: spinning one way should drag the hands the other
      way, like actually spinning on the spot. Cut the outward component right
      down and let the trail lead.
- [x] **Hovering a card preview starts in the wrong pose**, then slides back —
      the first frames read a huge turn rate, so the arms jump out and settle.

### Importing
- [x] Show imported skins as the skins page shows them: proper cards.

### Players page
- [x] The page still ends short, and now only re-fits when an account is added.
      Resizing or arriving on the page should re-fit it.
- [x] Offline accounts try to refresh and then report "sign-in expired" — they
      have nothing to refresh.
- [x] A strip above the sticky "Add New Player" bar still shows the rows
      scrolling behind it.

### Friends panel
- [x] A player head beside "Add by username", updating as the name is typed.
- [x] Adding a friend reloads the whole panel.
- [x] The username field should be the same height as the Add button.
- [x] A status filter dropdown after the "Friends" title.

---

## 0. Round 14 — player render feel, and the skins grid

- [x] **Clamp the skin render's vertical rotation.** The card previews (NOT the
      3D skin editor) can currently be spun right over the top and under the
      bottom. Limit the pitch to just past "you can see the top / bottom
      clearly" and no further. — 55° either side of level, on the big render
      and the card previews; the editor's viewer is untouched.
- [x] **Physics while spinning.** Rotating the model should throw the limbs
      around a little: arms trailing the rotation, the cape caught by the
      spinning air, the head lagging too.
- [x] **Parent the cape to the body** in the animation system, so a body
      stretch stretches the cape with it and a body move takes it along, rather
      than the cape being animated as a sibling.
- [x] **"Add skin" is wider than the grid.** It spans the full row while the
      skin cards stop short of it — it should end where they end.

---

## 0. Round 13

- [x] Panorama: download it from Mojang when it isn't on disk, and look in
      every instance's version folders, not just one named after the version
- [x] Modrinth App accounts and skins came back empty — app.db is in WAL mode,
      so copying app.db alone snapshots a database with no rows (and no schema)
      in it at all. Copy the `-wal`/`-shm` sidecars.
- [x] Find the Modrinth App by its database, not by a profiles folder that
      `settings.custom_dir` may have moved
- [x] Read saved skins from `custom_minecraft_skin_textures` (PNG blobs) and
      from the Minecraft launcher's `launcher_custom_skins.json` — no launcher
      keeps them as loose PNG files
- [x] Show accounts/skins that are already here rather than hiding them, so
      "none found" means none found
- [x] Skins page: put pixel-similar skins next to each other by default, so
      variations of the same skin group together

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
