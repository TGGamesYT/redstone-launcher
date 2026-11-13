# Launcher TODO

Everything asked for across the rounds of feedback so far, in one place. The
headings are kept even once done, so anything that turns out not to work can be
reopened against the right description.

`[x]` = shipped. `[~]` = shipped once but reported broken again. `[ ]` = not
started.

---

## 0. Round 61

- [x] **Don't use the skin mirrors.** — *Taken out again. For a player they
      have not already cached they answer with a default skin rather than an
      error, which would then be drawn and remembered as that player, and a
      launcher's worth of lookups is what gets them rate-limiting. What is
      left when Mojang will not answer is the truth rather than a copy of it:
      the skin this launcher already has on disk from the last time Mojang
      did answer, and the account's own profile asked with its own token. A
      test fails if any of the three mirror names comes back into the code.*
- [x] **The modified-pivot animation still turns about the old pivot.** —
      *Because the fix last time was in the wrong place. The pivot was only
      ever applied in playClip, by hanging the part off an extra group, and
      the skins page does not use playClip: it plays everything through the
      conductor, which evaluates a clip with evalClip and writes each part's
      pose directly. So the moved pivot did nothing where anybody could see
      it. It is part of the pose now -- turning about a point Q is turning
      about the origin and moving the origin by shift minus R times shift --
      so the conductor, its blends in and out, and playClip all get it and
      nothing is re-parented. Measured on the real viewer with idle.bored:
      the neck stays at 0,0,0 while the waist turns and the hips swing.*
- [ ] **Why is the Git tab first for mod project instances?** — *Asked, and
      answered in chat rather than changed: it was put first on purpose.
      Waiting on whether it should move.*
- [x] **The blocks, items and mobs picker shows nothing while it loads.** —
      *The first look at a version reads every block, item and mob out of
      the game's own files before anything can be listed, and during that
      the grid was an empty box -- which reads as "there is nothing here".
      The grid itself now shows a spinner while it is empty and loading, and
      after a few seconds says what it is doing and how long it has been at
      it.*
- [x] **Cloud syncing accounts makes duplicates.** — *An account's id is
      `Date.now()` on whichever computer it was added on, so the same
      Microsoft account has a different id on each computer -- and the merge
      matched accounts by id, so every synced account arrived as a second
      copy of itself. It matches by the Minecraft uuid now (an offline
      account by its name), keeps this computer's id for it, and folds
      together copies already made by earlier syncs -- moving the selected
      account and any offline skin over to the one that is kept.*
- [x] **The adjust-the-render dialog changes height as options appear.** —
      *Its sections come and go with the thing in it -- variants, block
      states, parts, a colour -- and it sized itself to them, so it grew and
      shrank as you used it. It has a set height now and only the scrolling
      part inside it changes.*

## 0. Round 60

- [x] **Mojang being down should mean a fallback, not Steve everywhere.** —
      *It answers with an HTML page titled "Service unavailable", sometimes
      with a 200, so a launcher that only asks Mojang has nothing and the
      obvious thing to draw is the default skin. Which is also exactly what
      an account with no custom skin looks like, so it says nothing is wrong
      while every premium account wears Steve.*

      *Four places to ask now, in order. What is already on this disk: the
      picture is kept forever under its texture's hash, so an old mapping
      plus a cached file IS the real skin. Then the account telling the
      launcher about itself -- api.minecraftservices.com is a different
      service on different machines from sessionserver, it is authoritative,
      and it works for exactly the accounts somebody notices going Steve.
      Then three mirrors, which are caches of Mojang and generally still
      hold what it said an hour ago. Then, and only then, a default.*

      *None of them is believed on its word. The launcher was moved off
      minotar and mc-heads once already because when they throttle they
      answer 200 with a stand-in skin, and a fallback that lies is worse
      than one that fails. So every answer must be a PNG of a skin's shape,
      and it is compared against what that mirror serves for a player who
      does not exist -- asked once per mirror and remembered, because a
      mirror's stand-in is its own file and matches neither the nine
      defaults nor the Steve and Alex in the client jar. A stand-in is still
      drawn, because it is the best picture there is, but it is never
      written down as what this player looks like and the real one is asked
      for again when Mojang comes back.*

      *Checked with Mojang made genuinely unreachable: a real player comes
      back as their own skin via minotar, and a uuid nobody has comes back
      as a default marked unsure.*
- [x] **A block's state should be one dropdown per property, not one list of
      every combination.** — *Oak stairs are forty combinations and a door
      sixty-four, offered as one list to find a row in. They are separate
      decisions -- which way it faces, which half, which shape -- so each is
      its own dropdown now, built from the combinations the block really has
      so nothing can be asked for that does not exist. Where a blockstate is
      not a full grid, changing one property lands on the state that has it
      and differs from where you were in as few other ways as possible. A
      property with only one value is not offered, and a blockstate whose
      variants are not property=value keeps the single list.*

## 0. Round 59

- [x] **`ipcNative` missing, and an empty page on the first open.** — *The
      first half is the launcher's own doing and is gone. A frame exists
      before its document does, and the main process sends every broadcast
      to every frame -- so while the first page was still loading, each
      broadcast went to an empty frame as well and the renderer printed
      "Attempted to get the 'ipcNative' object but it was missing". It is
      logged, not thrown, so no try/catch ever saw it. Frames with no
      document in them are skipped now, and the test stands up a window with
      an empty frame in it and fails if the line comes back.*

      *The empty page itself I could not reproduce, so this does not claim
      to know why it happened. What it does is notice: the shell IS the
      window -- the bars are its and everything else is the frame -- so a
      frame that fails to load is the whole launcher looking empty with
      nothing to click. If there is no page in it five seconds in, it is
      asked for again, once.*
- [x] **Every premium account's skin turned into a default.** — *The log
      said it four times: `profile 429`. That is Mojang saying "you asked too
      often", and it was being treated as an answer about the PLAYER -- so
      the launcher drew the default skin, which is also exactly what an
      account with no custom skin looks like, so nothing on screen could say
      which it was. Three things made it happen and all three are fixed.
      Every skin picture was already cached on disk by its texture hash, but
      the mapping from a player to that hash lived only in memory, so every
      start knew nothing and asked about every account at once -- it is
      written down now, and a restart begins knowing what it knew. Nothing
      stopped the same uuid being asked about twice at the same time, and
      the log shows one asked three times -- the same question in flight is
      now one request that everyone waits on, and separate players are
      spaced out instead of going off together. And a 429 keeps whatever was
      known rather than replacing it, waits a minute rather than ten, and
      if there was nothing known the account is remembered, asked about
      again once Mojang will answer, and every window told so the Steve
      turns back into the player.*
- [x] **NeoForge 26.3 logs four lines and then launches for ever.** — *The
      log ends on `[MCLC]: Parsed version from version manifest`, and that is
      precisely where it stops. mclc prints that line BEFORE parsing the
      version JSON, inside the HTTP callback, with nothing around it -- so
      when the parse throws (an empty body, a proxy's error page, a
      truncated response) the throw lands in nothing: the promise is never
      resolved and never REJECTED, and launch() waits on it until the
      launcher is closed. Reproduced against the real mclc here: after three
      seconds the promise has neither settled nor failed, and the last thing
      said is a claim that the thing which just failed had worked.*

      *So the fetch is done by the launcher instead -- with a timeout,
      checked for being JSON, checked for having the parts mclc will reach
      for -- and written where mclc looks first, so its own fragile path is
      never taken. Anything wrong throws with a reason, including the first
      line of whatever did come back. And a watchdog for the next one of
      these: everything in a launch reports as it goes, so four minutes of
      complete silence means something is waiting on something that is not
      coming, and it ends with a reason instead of saying "launching" for
      ever.*

## 0. Round 58

- [x] **A transparent app icon comes out black.** — *`removeAlpha` does not
      flatten a picture onto anything: it drops the alpha channel and leaves
      whatever RGB was under it, which in almost every PNG is 0,0,0. So a
      hole in the picture came out as black -- and opaque black, so nothing
      further down could rescue it. A fill is read as RGBA now and the two
      alphas multiply, so a hole shows through while the picture is still
      cut to the backing's shape.*
- [x] **"A picture" does not update the icon display when a picture is
      chosen.** — *The same fault as the two below: the preview is built by
      the path that failed whenever the mark is off, which for a picture is
      the default, so what the page showed was the icon from before. The
      preview and the icon that is actually written now go through one
      function, so the page cannot show an icon the launcher is not
      wearing -- they were two, and a picture with no mark over it is the
      WHOLE picture in one of them and cut to a circle in the other.*
- [x] **A theme should carry the icon configuration** — *It already saved the
      whole record -- kind, picture, whether it follows the background, the
      mark -- and the one part that did not survive was the framing. A crop
      records WHICH background it is a crop of, by the files in the stack,
      so that changing the background drops a crop of the old one; a theme
      carries its pictures as bytes and writes them out under fresh names,
      so that record never matched and the framing was thrown away by the
      very act of applying the theme it was saved in. It is re-pointed at
      where the theme's own background has just landed.*
- [x] **The crop modal's buttons are half off the bottom.** — *Measured in
      the running launcher: 757 pixels of content in a 676-pixel box, which
      put both buttons below the edge. Scrolling was the way to them in
      theory only -- the square in the middle fills most of the dialog and
      answers the wheel by zooming, so the wheel only worked over the few
      pixels of margin either side. Three things: the buttons are out of the
      scrolling part, the square may shrink instead of pushing them off, and
      every dialog is now bounded by the room it is centred in rather than
      by 85vh -- the overlay starts below the toolbar, so 85vh is taller
      than the space there is. Also the cropper was the one way in that
      never put the stylesheet on the page, so on the settings page it had
      no layout rules at all.*
- [x] **The chosen block's name does not update when a theme with a block
      background is applied.** — *The name, the tile size and the row of
      faces are written when a block is CHOSEN. A theme chooses one without
      anybody clicking, so they kept saying what the last block was, or
      "nothing chosen yet" over a wall that was plainly a block.*
- [x] **With an image background and the gem and cog turned off, the cog is
      still there.** — *Turning the mark off is done by not passing the gem's
      and the cog's files at all. Both were handed to sharp regardless, and
      sharp given `undefined` throws, so the icon was never built: the call
      failed, the old file stayed where it was, and the switch looked like it
      did nothing.*
- [x] **Same for "your colour": turning the gem and cog off does not remove
      them.** — *The same one fault, which is why it was reported twice.*
- [x] **The modified-pivot bbmodel exports still do not have the rotation
      pivot modified.** — *The export was never the problem. `idle.bored`
      carries its own pivots -- the waist at the neck instead of the hips,
      the legs at the floor instead of the hips -- and the difference from
      the baseline came out right: twelve up for the waist, twelve down for
      the legs. What went wrong was a frame later. A waist with a moved
      pivot hangs off the group that moves where it turns, so it is a
      GRANDCHILD of the skin rather than a child; `makeWaist` asked whether
      its parent was the skin, called it gone, and built a second waist --
      on every frame, because the spin layer resets the pose on every one.
      The head, body and arms were moved into each new waist in turn, while
      the first one hung off the pivot group with nothing under it. The rest
      pose is read once and still held that first one, so the clip went on
      writing sixteen keyframes of waist rotation to an orphan: the one bone
      whose pivot had been moved was the one bone that stopped moving at
      all. It asks by ancestry now.*
- [x] **A Git tab on a dev instance whose project folder is a repository.** —
      *First in the strip, not last: for somebody working on a mod, which
      branch they are on is the first thing about the instance. It shows the
      branch or the commit, what is uncommitted, how far ahead or behind,
      the recent commits and the remote; it can pull, fetch, switch branch,
      go back to a commit and change a remote's URL. What it deliberately
      cannot do is lose work -- there is no reset, no clean, no force, no
      commit and no push anywhere in the module, and the test fails the
      build if one appears. A pull is `--ff-only` for the same reason: a
      pull that cannot fast-forward wants a merge or a rebase, and both are
      decisions about somebody's work. A remote branch is checked out as a
      local one tracking it, because checking out `origin/thing` by name
      leaves a detached head that quietly loses anything committed on it.*
- [x] **Add a dev instance from a Git URL, by cloning it.** — *A second
      developer row in the creator. It takes a full address, an ssh one, or
      just `owner/name`; says where it will land before anything happens and
      lets that be changed; reports git's own progress while it runs; and
      ends in exactly the page picking a project off the disk ends in. The
      Git it uses is the one on the PATH by preference -- that is the
      person's own, with their keys, their name on their commits and their
      credential helper -- and on Windows it can fetch MinGit for itself if
      there is none, asked of git-for-windows rather than pinned to a URL
      that goes stale. On Linux and macOS it says to install one instead,
      because there is no portable build worth shipping and both have one a
      package manager away.*

      *Signing in: where the system Git has a credential helper nothing is
      needed and the launcher asks for nothing. Where it does not, it takes
      a GitHub token, kept for github.com alone and never synced -- and
      never on a command line, because argv is readable by anything on the
      machine, so it goes in the environment the way GitHub's own runner
      does it. A "Sign in with GitHub" button is the one thing here I could
      not build: the device flow needs an OAuth application registered to
      this launcher and there is not one. Register one and it is an
      afternoon's work.*
- [x] **And when any of that changes the loader or the Minecraft version, the
      launcher must notice and update what it shows.** — *Every operation
      that can move HEAD ends by reading the project again, and writes down
      what changed: the Minecraft version, the loader, the mod id and the
      run folder. The profile is saved, every window is told, and the tab
      says in words what the project has become rather than leaving somebody
      to find out at the next launch. Checked both ways in the running
      launcher on a repository whose two branches are Fabric 1.21.1 and
      NeoForge 1.20.1: clicking the branch changes the heading above the
      tabs there and then.*

      *One thing found on the way: the instance view clears its detail panel
      and then builds it with several awaits in between, and it is re-run
      from `profiles-updated`, which fires for all sorts of reasons. Two
      runs interleaving each cleared what the other was half-way through
      filling and then both appended their own -- two tab strips, two sets
      of contents. It was always possible; one more await made it happen
      every time. Each render takes a number now and stops if it is no
      longer the newest.*

## 0. Round 57

- [x] **A dev instance waited a long time without showing as launching, then
      said it was already launching.** — *The Gradle path never put anything
      in `launchWorkers`, which is the list `get-launching-instances` reads,
      so for the whole time it spent getting a JDK ready the launcher
      believed nothing was starting: the instance did not light up, and
      pressing Play again was taken as a second launch and answered with
      "This profile is already launching". A stand-in entry goes in before
      any of the slow work now, is swapped for the real child when Gradle
      spawns, and its `kill` cancels the launch rather than doing nothing.
      The wait itself is no longer silent either -- the JDK download reports
      through the same progress and log lines as everything else.*
- [x] **`'gradle.bat' is not recognized`, on a project that has a wrapper.** —
      *The project had `gradle/wrapper/gradle-wrapper.properties` and no
      `gradlew`, no `gradlew.bat` and no `gradle-wrapper.jar` -- which is
      extremely common, because several popular `.gitignore` templates drop
      all three. The launcher looked for the scripts, did not find them, and
      fell through to "gradle" on the PATH, which most people do not have.
      Four ways down now, in order: the wrapper JAR run directly (which is
      all `gradlew` itself does, and needs no shell and no batch file), the
      distribution the properties file NAMES -- downloaded to the launcher's
      own folder if it is not already there -- then the scripts, then a real
      Gradle on the PATH, checked for rather than hoped for. The new
      instance page says which of those will run it before you create it.*
- [x] **And it still gave the project Java 21 when it wanted 25.** — *Two
      separate causes. `javaForMinecraftVersion` compared "26.3" against the
      old version numbers digit by digit, so Minecraft's new numbering came
      out as 1.20-era and answered 21; there is a table for the new scheme
      now, and the version is asked of Mojang's own manifest when that is
      all the project names. And the project's own number was being looked
      for in the wrong files: only the root build script was read, so a
      multi-loader mod -- `common` plus a folder per loader, each with its
      own script -- was read at the one file that says nothing about Java.
      The subprojects are read too now (two levels, skipping `build`, `run`
      and the rest of what a build leaves lying about), a key only a
      subproject sets in `gradle.properties` is found, `JavaVersion.toVersion`
      is understood, and a number the script declares for itself and then
      uses in a way nothing here recognises counts as a last resort. Checked
      against the uploaded project and against the detection in the mod
      build workflow, which is where the subproject and
      `targetJavaVersion` cases came from.*
- [x] **A mod project's icon was not used for the instance or the mod.** —
      *`modProjectInfo` never read one. It reads the mod's own picture out of
      the project's resources now and the new instance page prefills it, so
      the instance wears the icon the mod will have once it is built.*
- [x] **Opening a dev instance's folder opened the launcher's folder.** —
      *Several places still spelled out `<data>/client/<id>` instead of
      asking where the instance's files actually are. There is one function
      that answers that, `instanceRoot`, 43 call sites were moved onto it,
      and a test now fails the build if a new one spells the path out.*
- [x] **Cloud syncing now syncs skins.** — *A switch of its own, next to the
      others. The library merges rather than replaces, so a skin only one
      computer has is kept, and a deletion is recorded as a deletion so it
      travels instead of the skin coming back on the next sync. The skins
      page redraws itself when a sync brings some in. Written down in
      PRIVACY.md, which a test now checks has a bullet for every kind that
      syncs.*
- [x] **The small skin renders teleported their arms when the pointer left.** —
      *The card eased the figure back to facing forward and swapped the still
      picture in the instant the ROTATION was home -- but the arms, legs,
      head and cape are springs hanging off that rotation, and measured in
      the running launcher the right arm was 0.87 radians, fifty degrees, out
      of place at that exact moment. The still picture is the rest pose, so
      the swap was the arms jumping there. The physics says whether it has
      settled now, on a threshold set to what is visible rather than to what
      is measurable, and the card waits for it: 1250ms rather than 2617ms,
      with a cap so nothing waits for ever.*

## 0. Round 56

- [x] **A mod project instance assumed Java 21 and a Gradle on the PATH.** —
      *Three things were wrong at once. The toolchain was only read in its
      literal form, so `JavaLanguageVersion.of(java_version)` -- which is how
      half the templates write it -- was missed and the fallback used
      instead. Nothing checked what the project's OWN Gradle can run on, and
      Gradle refuses a JDK newer than it knows, so a toolchain of 21 on a
      7.x wrapper was a build that stopped before it started. And a project
      that pins `org.gradle.java.home` had ours forced over it. All three
      now: the property is followed up, the answer is brought back to what
      the wrapper's Gradle can run, and a pinned JDK is left alone.*
- [x] **And on Windows it could not run the wrapper at all.** — *`gradlew.bat`
      is a batch file, which Node will not run without a shell -- and
      `shell: true` on Windows pastes the command and its arguments into one
      string and quotes nothing. A project under "My Mods" was a command
      cmd.exe could not find, and `--args=--username Some Name` was three
      arguments. cmd.exe is handed the file and the arguments separately
      now, which Node quotes properly.*
- [x] **A mod project's own icon is the instance's icon.** — *Every loader's
      metadata names one -- `icon` in fabric.mod.json, `logoFile` in the
      toml -- and the file is sitting in src/main/resources while the
      project is being worked on. The instance wears it from the moment it
      is made, and so does its card in the Mods tab.*
- [x] **Opening a dev instance's folder opened the launcher's.** — *Two
      "open folder" paths were still spelling `<data>/client/<id>` out for
      themselves, in the one shape a search for the first spelling does not
      find: `isClient ? 'client' : 'servers'`. The guard looks for that too
      now.*
- [x] **The block picker was a list, not a grid.** — *Its styles are the
      model picker's own and nothing had put them up: the icon picker calls
      `ensureStyle()` itself, and mounting the grid anywhere else got no
      styles at all. It puts its own up now.*
- [x] **And the thumbnails were isometric icons.** — *The picture a wall is
      made of is the one it will BE: straight on from the north, framed by
      the block. For a full cube that comes out as exactly its side texture,
      which is what the old list showed.*
- [x] **Drawn without lighting.** — *The shading table is about a block
      sitting in a world with the sun overhead. A wall of them with every
      top bright and every side at 60% reads as a pile of boxes rather than
      as the material.*
- [x] **The picker jumped in height on every refresh, and the switches sat
      above their words.** — *The grid had a maximum height rather than a
      height, so emptying it collapsed the dialog and refilling it grew it
      again. And the settings page styles checkboxes as switches, half of
      which was leaking into a plain one -- they are told to be plain
      checkboxes inside the picker.*
- [x] **The skin render resized about its own middle.** — *The rule said
      both limits were maxima and only the width was; with the height left
      at its full size, a canvas too big for its segment sat in the middle
      of a tall thin box instead of where the segment's alignment puts it.
      The drawing hugs the same edge the segment does now.*
- [x] **The app icon could not be the background alone, or a picture with the
      mark on it.** — *The section asked the wrong question: it was a choice
      between "the launcher's icon" and "a picture", with a toggle bolted on
      the side. It is two questions now -- what is behind it, and whether the
      gem and the cog are over that -- which is four icons rather than two,
      and four controls in a column rather than five in a row.*
- [x] **The bars' theme lagged behind the page.** — *The settings page paints
      itself as a colour is picked and the bars waited for the save to reach
      the main process and come back, which is a round trip and a 120ms
      settle. They are one frame up in the same process, so they are told
      directly, on the next animation frame.*
- [x] **A brightness slider for every theme.** — *It multiplies the theme's
      own colours rather than putting a filter over the window: a filter
      would dim the picture and the block wall behind the launcher too, and
      would make <html> a containing block, which the fixed bars and the
      fixed background are both built on. The text colour is left where it
      is. 0..100 with the middle meaning the theme as it was picked.*
- [x] **The automatic third colour did not follow a saved theme.** — *A theme
      carries whatever its third colour was when it was saved; while it is
      automatic it has to be worked out again from the pair that just
      arrived.*
- [x] **The icon showed a 4x4 grid of EVERY block.** — *Cutting the tile at
      the size the window draws it is right for a patch of randomly turned
      cells, which is what it was written for, and wrong for a plain tile:
      the backing is a circle a quarter of an inch wide and one block is a
      block. One block fills it unless the tile really is a patch.*
- [x] **A NeoForge 26.3 instance does not start.** — The log ends in a
      NullPointerException inside FML's own error display. *What that means
      is that NeoForge hit a fatal error before the window opened and its
      error window crashed while reporting it, so the reason never reached
      the launcher. Two things were in the way of seeing it: exit code 1 was
      treated as Minecraft's own "stop and restart" and reported nothing at
      all, and nothing read the game's own logs/latest.log, which is where
      FML had written it. Both fixed, with a note saying that
      -Dfml.earlyprogresswindow=false makes the next run print the reason in
      the console.*
      *And then the cause turned up, by reading NeoForge's own installer for
      that build rather than guessing: its version.json asks for six JVM
      arguments -- `-DlibraryDirectory=${library_directory}` among them --
      and the launch command had none of them. Without that one FML cannot
      find the libraries folder at all, which is a fatal error before the
      window opens, which is the error window crashing while reporting it.
      The loader's own JVM arguments are read out of the installer and
      passed now, with the placeholders this end can answer filled in and
      anything else left out rather than passed on with a `${...}` still in
      it. The game args, for the record, were right: NeoForge really does
      ask for `--fml.neoFormVersion 1` on 26.3.*

---

## 0. Round 55

- [x] **Undo and redo of a theme still refreshed the page.** — *The reload was
      how every control came to agree with what had been put back. The
      controls take it in place now, including the plain switches, the RAM
      sliders and the custom CSS box, which the list in `adoptSettings`
      names one by one.*
- [x] **A built-in theme should bring its background.** — *These ten are
      colours and nothing else, so what comes with one is the launcher's own
      panel. It used to leave whatever was behind the launcher exactly as it
      was, so a theme was only ever half applied. With "Match the background
      to the theme" ticked the mode is left alone, because that switch asks
      for the background to BE the theme's colours.*
- [x] **The colour and gradient options should follow the theme too.** —
      *Set to the theme's own shades as it is applied, so picking one of them
      afterwards is this theme rather than the last one's. Colours and
      background go in one save, so one step back takes the whole thing.*
- [x] **The only picture could not be removed.** — *`image` is the mirror of
      whatever is on top of the stack, and an empty list is read as a
      background saved before there were lists and rebuilt FROM that mirror,
      so removing the last one put it straight back.*
- [x] **A strip across the top behind a picture.** — *The launcher's own
      panel was under the stack, so that a fitted picture shows the launcher
      where it does not reach. The panel is the toolbar's colour across the
      top tenth of the window and the toolbar is 38 pixels tall, so the rest
      of that band came out from under the toolbar as a bright strip. The
      dark alone now, which is what every other mode shows.*
- [x] **Any block's any side, not just full blocks.** — *The list was flat
      face textures of full cubes, because a flat texture is all a cube
      needs; a stair or a fence has none, so they were not listed. Anything
      that is not a cube is drawn now, straight on from whichever of the six
      sides is picked, framed by the block rather than by the model in it so
      the pictures tile against each other.*
- [x] **Modded blocks, and resource packs.** — *The launcher's own model
      picker, with a dropdown for whose blocks to show: the game's, an
      instance's mods', or drawn with that instance's resource packs on top.*
- [x] **"Turn the tiles at random" was still a loop.** — *Four cells across,
      and a CSS background repeats -- so what you saw was a pile of four
      blocks tiled, which is what it was. Sixteen now: a thousand pixels of
      wall at the usual size, wider than the window.*
- [x] **The icon showed that pile, shrunken.** — *The whole patch was
      squeezed into 256 pixels, so every block came out a quarter of the size
      it is on the window. It is cut from the patch at the size the window
      draws it at, and tiled where the patch is smaller than the icon.*
- [x] **The blocks menu re-fetched the game's assets every so often.** —
      *The stack cache's ten-minute timeout, which is there so a pack enabled
      or a mod dropped into an instance shows up. A stack with no instance
      behind it is the version's own jar and cannot change, so it is kept --
      and indexing a jar read over the network does not happen again.*

---

## 0. Round 54

- [x] **A cloud sync applied the theme that was applied elsewhere.** — *The
      look went with the settings, so pulling from another computer repainted
      a launcher somebody was looking at without being asked -- and did it
      badly, since the settings arrive as a file written straight into the
      store: the page re-read them and the bars did not, and the desktop icon
      was left as the old theme's. The look is not a preference, it is a
      decision. Saved themes sync as themes; which one is worn is each
      computer's own. What does still arrive is announced, so every window
      takes it at once.*
- [x] **A theme with several pictures kept one.** — *`currentWallpaper()`
      read the top of the stack. It looked right until you moved to another
      theme and back: moving away prunes the copies nothing points at, so the
      pictures the theme had not carried were deleted off disk. Writing the
      test for it turned up a second fault in the same place: every copy was
      named after the millisecond it was written, which is unique when a
      person picks a picture and not at all when a theme writes a whole stack
      in a loop -- so all of them landed on one name and the theme came back
      as the same picture twice. Checked end to end in the running launcher:
      two pictures in, off to another theme, back, two pictures out.*
- [x] **The skin render disappears while the window is being resized.** —
      *skinview3d's setSize is not a cheap call: it resizes the renderer AND
      reallocates both post-processing render targets. Dragging a window's
      edge reports a new size every frame, so that was two full-size buffers
      thrown away and remade per frame. It is done once the size stops
      moving; CSS holds the canvas inside its segment meanwhile. Not
      reproducible here -- a container resizes in one jump -- so this is the
      mechanism removed rather than a fault watched to go away.*
- [x] **Undo after applying a theme only undid the secondary colour.** —
      *The undo stack is filled by save-settings going past and a theme is
      applied by the main process, so nothing went past: what landed on the
      stack was whatever the page saved while it was taking the theme on
      board. Applying a theme is one step now, the icon included.*

---

## 0. Round 53

- [x] **An instance made from a mod project.** — With developer mode on, a new
      instance can be a Gradle mod project: the project's own run folder is
      the instance's game folder, launching it runs the project's `runClient`,
      and the project shows up in the instance's mods. *Nothing here was
      broken; it did not exist. Two things had to be true for it to. The
      first is that an instance's files are somewhere else: forty-three
      places spelt `<data>/client/<id>` out for themselves, and every one of
      them would have read the wrong folder, so they all ask `instanceRoot()`
      now and a test fails the build if a forty-fourth appears. The second is
      that Gradle is the launcher for this kind of instance -- it compiles
      what has changed, works out the classpath and starts the game -- so
      there is no version to download, no loader to install and no Java of
      the game's to choose: the project says which Java it wants and that is
      the one Gradle gets. What the project says about itself (loader,
      Minecraft version, run folder, mod id, Java) is read off the files
      every mod template has, which is what fills the last page of the
      creator in. The account is handed to the game as `--username/--uuid/
      --accessToken` unless the project passes a username of its own, because
      Minecraft refuses an option given twice and would be gone before it
      drew anything. Stopping it kills the process GROUP: the game is
      Gradle's child, and signalling Gradle alone would leave the game
      running with nothing tracking it. A project whose run task will not
      take `--args`, which is how the account is handed over, says so in a
      line and is started again without it -- rather than stopping at
      Gradle's own "Unknown command-line option", which reads as the
      launcher being broken. Deleting the instance does not delete the
      folder, because that folder is somebody's project.*
- [x] **The theme of the main page content is reset by a cloud import** —
      and the left and top bars keep the old one, which is the odd part.
      *See Round 54: the look is not synced any more, and what is still
      synced is announced to every window rather than written into the store
      behind their backs.*
- [x] **The notch still blinks out, sometimes.** Reported again after
      Round 49. *It was drawn only while the SHELL was wearing a background,
      so the corner depended on the shell and the page agreeing that there
      is one -- and they do not always agree, because a page applies the
      background in its own head from what the last one cached while the
      shell applies it when the main process answers. In the gap the shell
      draws no wedge and the page's own background fills the corner. Drawn
      always now; over the launcher's own panel it is the same colour as the
      band <html> paints across the top anyway.*
- [x] **The app icon section does not update to what it is supposed to be.**
      *It set the preview from a field that does not exist: `icon:app` says
      WHICH icon is in use, not what it looks like, and one that follows the
      theme has no dataUrl on it. So every colour and background change left
      the section showing the icon from before it.*
- [x] **The desktop and taskbar icon updates before it is finished** — e.g.
      with the background showing through it. *A theme is a dozen settings
      and a picture landing one at a time, and each save re-tinted the icon a
      quarter of a second later -- so what reached the desktop was made of
      the new colours and the old background, or of a picture not yet placed.
      Nothing redraws it while an apply is in progress; the apply draws it
      once, at the end.*
- [x] **The Windows accent colour is sometimes not set** during a reload and
      theme sync. *It was set when the window is made and when a colour is
      SAVED, and applying a saved theme is neither: it writes the settings
      itself. The "sometimes" was "whenever the theme came from the list
      rather than from the pickers".*
- [x] **"Frame the picture…" only offers the top picture** of the stack.
      *The backing is the whole stack now, flattened the way the window
      paints it, and that is what the cropper is handed. A crop remembers the
      whole stack it was made of, so adding or reordering a picture drops it
      rather than leaving the icon wearing a frame of something else.*

---

## 0. Round 52

- [x] **Cloud syncing can keep itself in step.** — A toggle to sync when an
      update is detected rather than only when asked. *Added as
      `cloudAutoSync`, off by default: a five-minute check, the first one
      twenty seconds after start-up, and each instance is only mentioned once
      so a conflict does not become a notification every five minutes.*
- [x] **A clip from a rig with a moved pivot turns about that pivot.** —
      *The converter always said this was the point of taking a clip from a
      second rig, and nothing ever did it: the pivot was recorded and
      ignored, so a wave exported with the arm's pivot at the waist turned
      about the shoulder.*
- [x] **Two uploaded pictures, and the first one disappears on a page
      change.** — *`bg:pickImage` deleted every other wallpaper it found,
      which was right when there could only be one.*
- [x] **A saved theme with a picture does not set the picture properly.** —
      *The copy was put at the BOTTOM of the stack instead of the top, so
      whatever was already there covered it.*
- [x] **Applying a saved theme reloads the page to do it.** — *It called
      `location.reload()`, which in the shell is a page change, which is the
      loading screen. The settings page adopts the new settings in place
      now.*

---

## 0. Round 51

- [x] **Quick-play crashed the launcher the moment the game came up.** —
      *`launchViaWorker` read `quickPlay`, a parameter of `launchProfileCore`
      two functions away. The one line of the launch that runs only on
      success.*
- [x] **The sidebar's instance icons and the head icon stopped updating.** —
      *`webContents.send()` reaches the main frame, which since the shell
      refactor is the shell and not the page -- so the page heard everything
      and the shell heard nothing. `sendEverywhere()` walks the frames.*
- [x] **The skins page's console commands do nothing from the console.** —
      *The console is the shell's, and the skins page is a frame inside it.
      The shell mirrors the page's commands now.*
- [x] **The flip is the default, not something to ask for.** — *`--no-flip`
      turns it off; a turned rig negates X and Z, which is half a turn about
      Y. It used to negate Y and Z, which is neither.*
- [x] **The loading screen covers the change it is there to cover.** —
      *It faded IN over 0.18s, so you watched the page change through a
      half-transparent curtain.*

---

## 0. Round 50

- [x] **The admin panel re-verified the account on every tab.** — *Each
      request opened its own relay connection and did its own Mojang join.
      One session now, kept open.*
- [x] **`Attempted to get the 'ipcNative' object but it was missing`.** —
      *The news admin was an iframe with no Node in it, and the main process
      was sending IPC into it.*
- [x] **A server's detail page shows the "Servers" heading.** — *The
      instance's does not; now neither does it.*
- [x] **`CF_API_TOKEN` is Cloudflare's, not CurseForge's.** — *It was named
      `curseforgeToken` in the relay's config, which is simply wrong.*
- [x] **Per-instance cloud syncing, not everything at once.** — *"Save to
      cloud" and "Get from cloud" on an instance's menu, with a choice of
      worlds and of the files no public site knows about, and importing a
      cloud world into any instance.*

---

## 0. Round 49

- [x] **The skins page's render stopped settling back to the middle.** — *My
      doing, adding the render to the home page: a `returnAfter` that is not
      a number was made to mean "never come back", which is how the home
      page's "do not settle" is asked for -- but NOT MENTIONING it at all got
      swept into the same rule, and the skins page passes no options
      whatever. Not asking and asking for never are two different things now.*
- [x] **The notch still blinks out on a page change.** — *The shell's loading
      screen covers the content area, and the notch sits in the very corner
      of that area, so it was hidden for exactly as long as a page change
      took. It is part of the two bars, and they do not go away for a page
      change -- so it is drawn above the loading screen.*
- [x] **The accounts tab announces "Opening <player name>".** — *The loading
      screen took each page's name from the sidebar's tooltips, which was
      neat and wrong: the accounts button's tooltip is whoever is signed in.
      A page's name is a fixed thing and is written down as one.*
- [x] **Blocks, items and mobs say "No match." before anything is typed.** —
      *Only when picking an icon for the LAUNCHER. The catalogue is read out
      of a version's jar, an instance's version -- and the launcher belongs
      to no instance, so there was no version, no jar and nothing to list.
      It falls back to the newest version already on the machine, or to
      Mojang's current release.*
- [x] **A switched-off mod or pack is see-through rather than greyed.** —
      *An opacity on the card let whatever the launcher is wearing show
      straight through it, which over a picture is unreadable and over
      anything reads as the card fading out rather than as the mod being
      off. It is greyed with a filter now and stays as solid as every other
      card.*
- [x] **An instance's log is read straight off the background.** — *It had no
      background of its own at all, so the game's output sat on whatever
      picture the launcher is wearing -- which an outline around the text can
      make legible but never makes good. The same panel colour the server
      console already used, so the two consoles match.*
- [x] **A picture behind the icon is tinted like the backing.** — *Recolouring
      carries the layer's own light and shade onto the fill, which is what a
      layer being made a COLOUR wants. A block's texture, or the very picture
      the launcher is wearing, is not a colour: it has its own light and
      shade already. A texture is only cut to the shape of the layer now.*
- [x] **A cropping step for the launcher's icon when its back is a picture.**
      — Zoom, framing and rounding, the way an instance's icon is cropped.
      *The backing is a circle 256 pixels across and a wallpaper is a couple
      of thousand, so the whole of one squeezed into it is the picture seen
      from much too far away — whatever it is OF ends up a few pixels in the
      middle. "Frame the picture…" under the icon opens the same cropper an
      instance's icon gets (`IconPicker.__crop`), and what comes back is a
      finished 256-pixel square the backing wears as it is. It is remembered
      against the picture it was made from, so choosing another background
      drops it rather than leaving the icon wearing a crop of a wallpaper
      nobody has any more, and it is only offered when the backing really is
      a picture.*
- [x] **Several images stacked as the background.** — Each showing through
      where the one over it is transparent, and a fitted image showing the
      background where it does not reach. *A CSS background is already a
      list of layers, so what was missing was a list to put in it: the
      setting held one picture and `backgroundCss` built one layer. The
      setting holds `images` now, first on top, and the settings page lists
      them with their own Covered/Fitted/Stretched and buttons to move one
      forward or back. Under the whole stack goes the launcher's own panel
      rather than a flat slab, so the last fitted picture shows the launcher
      where it does not reach. A save with one `image` and no list reads as a
      list of one, so nothing made before this looks any different, and
      `image` is kept as the top of the list because that is what everything
      that cares about "the picture" — the theme's colours, the icon's
      backing — means by it.*
- [x] **The piston animation.** — A pushed-out piston draws its base as a
      whole block rather than the shorter body; its neck is the base texture
      rather than the shaft; and its head takes the front texture while it is
      moving. *Three faults, one cause: this is a view from the SIDE, where
      the only face of a piston that can be seen is `piston_side`. The wooden
      face and the inner plate are both end-on, so neither is ever visible,
      and drawing them anyway caused all three — the inner plate filled the
      four pixels the head had left with, so the body still read as a whole
      block; the arm was cut from a band ACROSS the texture instead of the
      strip along it, so it carried the body's pattern rather than the shaft;
      and the head wore the wooden face. Now drawn as the three pieces a
      piston is, all off `piston_side`: the twelve pixels that stay behind,
      a four-pixel arm, and the collar off the top of the texture. At rest
      the reach is nothing and the three reconstruct the whole texture, so
      there is no separate case for it. `tests/piston-test.mjs` reads the
      canvas back and pins the shape.*
- [x] **The piston's neck is still the base and the head next to each other,
      not a neck.** — *Two things, both in the same direction. The arm was
      the whole strip x4..8 of `piston_side` STRETCHED to whatever length it
      needed, and that strip is the head's tan collar for its first four rows
      and the body's grey for the rest — so the arm came out the colour of
      the head where it met the head and the colour of the body where it met
      the body, and there was nothing between them to read as a rod. The
      game's own arm is four across and twelve long, drawn at its own size
      and never stretched, off the SHAFT of the texture. It is now drawn one
      to one from row four down, tiled where the reach is longer than the
      twelve rows of shaft there are.*
- [x] **The neck uses the base block's grey, not what a piston's neck is
      made of.** — *Right, and it was my fix for the stretching that put it
      there. `piston_side` holds both: the top four rows are the WOOD the arm
      and the head's collar are both cut from, and the twelve below are the
      stone body. I moved the arm off the stretched whole strip and onto the
      body's rows, so it came out the colour of the block it comes out of —
      which is the same thing as not drawing an arm at all. It is the wood
      band now, columns 4 to 8 and rows 0 to 4, which is the rectangle the
      game's own piston head takes its arm from, at its own size and tiled
      along however far it reaches.*
- [x] **The arm is just the end of it looped four times, which is not what a
      piston head does.** — *No, and tiling was the wrong shape of answer
      altogether. The game's piston head is ONE object — a plate with a rod
      behind it — and extending slides the whole thing forward, so what
      changes is how much of the rod is out of the hole, not how many copies
      of it there are. The arm is one draw of columns 4 to 8 of
      `piston_side`, cut to exactly how far it has come out, one pixel per
      pixel: wood for its first four rows, which is the end the plate is on,
      and shaft behind that. Nothing has to be invented to fill any length,
      because the furthest a piston reaches is one block and the strip is one
      block long — which is why all three of the earlier answers (squash it,
      move it to the body's rows, repeat it) were solving a problem that was
      not there.*
- [x] **Check what a piston actually uses for the neck.** — *Done, against
      `block/template_piston_head` rather than from memory, and it settles
      all of it. The arm is `from [6,6,4] to [10,10,20]` — four across and
      SIXTEEN long, a whole block — with `"uv": [0,0,16,4]` on
      `piston_side`. So it is the top four ROWS of the texture, the wooden
      band the head's collar is cut from, with the uv running 0..16 across
      the texture against the arm's 16 length: the texture's X axis runs
      ALONG the arm and its four rows are the arm's thickness. A horizontal
      strip turned a quarter, not a vertical one. Every earlier attempt cut a
      vertical strip, which is why the arm kept coming out the body's grey
      (further down the texture is stone) and why four rows had to be
      squashed or repeated to reach any distance — turned the right way
      there is nothing to squash or repeat, sixteen pixels of texture for
      sixteen pixels of arm, and it has the metal bands along it because
      those are the grey squares in that row.*
- [x] **`Failed to refresh player: error.auth.minecraft.login`** — in
      Electron's log while signed in fine, with
      `[Relay] token refresh failed, trying existing token: undefined` after
      it. *Both lines are the same mistake. msmc does not throw Errors — it
      throws a plain object whose `ts` names the step that failed, with no
      message on it at all. So `err.message` was undefined, which the relay
      printed literally, and `String(err)` is `[object Object]`, so the other
      printed the raw object instead. Neither said which account it was about
      or what had gone wrong. And nothing had: `error.auth.minecraft.login`
      with `size: 0` is an empty answer from Minecraft's login, which is
      retried a moment later — it is not the signed-in account failing, and
      very often not even that account. The matching that decides whether a
      grant is dead or rate limited was looking at `err.message` too, so for
      an msmc error it was matching against nothing. There is a
      `describeAuthError` now, used by both, and the account is named.*
- [x] **The home page is still a rowed system.** — Resizing into another row
      moves that row down rather than sharing the space, and two segments
      still cannot sit side by side across what used to be two rows. The row
      is a container, which is the thing that has to go. *It has gone. A row
      was a BOX, and every remaining complaint came out of that one fact: a
      segment could not be taller than the box it was in, so dragging its
      bottom edge down made the box taller and shoved the next one down the
      page, and dragging its top edge up had nowhere to go; two segments
      beside each other were the same height whatever they said, because the
      box was as tall as the taller of them. Dividing a row up and down (`y`
      and `vh` out of twelve) only moved the problem inside the box. There is
      one grid for the whole page now and a segment is a rectangle in it: `x`
      and `w` across in hundredths, `y` and `h` down in rows of 22px. Its top
      and bottom edges are the same kind of thing as its left and right —
      each moves until it would run into something and stops, and NOTHING
      else on the page moves. No row merging, no compaction, no closing up:
      a gap is a gap because somebody left one. A drop goes where the pointer
      is at the size it already is, or trades places with what is there, or
      takes the nearest clear space; it never halves anybody. Old layouts
      come forward with each row as a band of grid rows as tall as its
      tallest segment was, so a page looks as it did.*

- [x] **The build overwrites the release's files on every commit.** — *It
      decided whether a version was already out with
      `while gh release view "$TAG" >/dev/null 2>&1`, on a step with no token
      on it. `gh` exits non-zero for "there is no such release" and equally
      for "I could not ask", so with no token it always took the second for
      the first: the loop body never ran once, the tag was always the bare
      version, and `action-gh-release` uploaded onto the release already
      there — which REPLACES its files. Every commit to main rebuilt three
      platforms and overwrote the released binaries under a version number
      that had not moved. (And had the loop worked it would have published
      `1.18.0(1)`, `1.18.0(2)`… one release per commit, which is no better —
      the absence of any such tag on the repo is how you can tell it never
      ran.) `scripts/released.mjs` asks once, reads the HTTP status, and
      treats only 200 and 404 as answers: anything else stops the run. It is
      a `check` job that everything else waits on, so "already released"
      costs ten seconds instead of three platforms' worth of build.*
- [x] **Snap releases have failed since the sidecar was added.** — *`npm run
      buildLinux` has a pre-step that builds the quiclime sidecar, which is
      Rust, and `scripts/build-sidecar.mjs` stops rather than quietly
      shipping a launcher that cannot use e4mc. The GitHub runner having Rust
      is no help: snapcraft builds in its own clean container with only what
      `snapcraft.yaml` asks for, and it asked for node and npm. It installs
      rustup now — not the archive's rustc, which on core22 is older than the
      1.75 the crate requires. The snap's version is taken from
      `package.json` too, so the two cannot drift, and the snap is gated on a
      new version like the GitHub release: it was pushing a revision to the
      stable channel on every commit as well.*

---

## 0. Round 48

- [x] **A segment cannot be resized up or down into another row.** — *Two
      rows are two separate grids, so a segment could never be made taller
      than the one it is in: dragging its bottom edge down only made its own
      row taller and pushed the next one further down the page, and dragging
      the top edge up had nowhere to go at all. Dragged past the end of its
      row into space in the next one, the two rows now become ONE row divided
      up and down -- which the layout can already describe -- with everything
      that was in each row keeping its own half and the segment being dragged
      spanning both. A row with something in the way in those columns is not
      space and is not taken in; the edge stops, and the readout says which.
      The drag carries on from there rather than ending, so the line between
      the halves can be moved in the same gesture.*
- [x] **The blue gem's lighter parts come out reddish or indigo.** — *Each
      pixel's own hue was being turned by the same amount, which sounds right
      and is not: the hue circle is not evenly divided between the colours
      anybody can name. Measured, the gem's body sits at hue 25 and its lit
      facets at 35 to 40 -- ten to fifteen degrees warmer, which in red reads
      as orange, the colour a lit red stone is. Carried round to blue, the
      body landed on 251, which is blue, and the facets on 266 to 271, which
      is indigo: the lightest parts of the gem came out a different colour
      from the rest of it. The hue is simply the one asked for now, flat, and
      the lightness and the colourfulness carry each pixel's own distance
      from the colour the layer was drawn for -- a highlight does not need a
      hue of its own to read as one. A gem turned blue now spans hue 255 to
      258 against the 256 asked for, and still has 0.42 of light across it
      and its facets' spread of colour.*
- [x] **A lighter, slightly orange part of the gem comes out as a flat dark
      blue.** — *The shifts were being measured in HSL, whose "lightness" is
      the midpoint of the largest and smallest channel -- which puts yellow
      and blue at the same L while yellow is plainly far brighter. So the
      numbers travelled and the shading did not: the gem's highlight is a
      lighter, slightly orange red, and in a blue theme it landed at the same
      L with its hue most of the way round the circle, still dark and no
      longer reading as a highlight. The recolouring is done in Oklab now, a
      space built so that equal steps look like equal steps. Measured: a gem
      turned blue keeps the artwork's range of light (0.415 against 0.400),
      where the same shift in HSL collapses it to 0.323. A colour that cannot
      be shown is brought back into range by lowering its chroma rather than
      by clipping the channels, so the hue and the lightness survive that
      too.*
- [x] **The recoloured icon is still lighter, and its colours run
      together.** — *The lightness was anchored but the hue and the
      saturation were still taken from the fill outright. The backing is
      drawn fully saturated and the base colour is 0.874, so every pixel lost
      a tenth of its colour -- and at a fixed lightness less saturation is
      nearer to grey, which reads as LIGHTER as well as flatter. The gem was
      worse: its facets differ from each other in saturation as much as in
      lightness, and one saturation between them is what made them run
      together. All three of hue, saturation and lightness are shifts from
      the colour the layer was drawn for now, applied to each pixel's own.
      Built in the launcher's own colours the result IS the artwork, pixel
      for pixel -- 11399 of 11399 backing pixels and 1245 of 1245 gem pixels,
      where before not one matched -- and the gem's spread of saturation
      comes out at the artwork's 0.136 rather than 0.004.*
- [x] **The icon's backing and gem are far too bright.** — *The recolouring
      re-centred each layer on the FILL colour's lightness: every pixel kept
      its distance from the layer's average, and the average became whatever
      the theme colour was. The backing is drawn at a lightness of 0.21 and
      the launcher's own base colour is 0.375, so painting it in the
      launcher's OWN colour came out nearly twice as light as the artwork --
      and every other theme was lifted by the same amount, which is why the
      backing and the gem always looked lit up. A fill is read as a
      DIFFERENCE from the colour the layer was drawn for now: the launcher's
      own colours reproduce the artwork exactly (0.206 against the artwork's
      0.206, where it used to be 0.369), a lighter theme lightens it by as
      much as it is lighter, a darker one darkens it. The special case that
      skipped generation for the default theme is gone -- there is one path
      for every theme now, which is also the only way a fault in it would be
      noticed.*
- [x] **Export only some of a rig's animations, and mix rigs.** — *One rig
      cannot be right for every animation: a wave wants the arm's pivot at
      the shoulder and a lean wants it at the waist, which is two models of
      the same player. `npm run anim -- --list rig.bbmodel` says what is in
      one; `npm run anim -- export rig.bbmodel wave point` takes only those
      and ADDS them to what is already there; `wave=wave_low` files it under
      another name, so the same animation can come from two rigs; `remove`
      takes one back out. Each clip records which rig it came from and how
      that rig was authored, so a set built out of several models can have
      one that mirrors Y/Z and one that does not -- the renderer reads it per
      clip now rather than once for the file.*

---

## 0. Round 47

- [x] **Two games of one instance must not get in each other's way.** —
      *Beyond the temp file: the natives folder was the one that really bit.
      A stale stamp had it thrown away and extracted again, and doing that to
      a game running out of it takes the DLLs out from under it -- and two
      launches started together both found the same stale stamp and both
      extracted into it at once. Only one launch at a time decides about that
      folder now (a lock that is taken over if whoever held it died), and a
      folder another launch is still using is left alone rather than rebuilt.
      Same for deleting the client jar when it is the wrong size. The shared
      checksum memo is merged with whatever the other launch wrote rather
      than overwritten, and written by renaming a new file over the old one
      so the other launch can never read half of it. Marks left by launches
      that have ended are swept by whoever finds them.
      tests/concurrency-test.mjs runs the launcher's own code against real
      processes: a file written in place IS caught half-written by another
      process (21958 of 32219 reads), one renamed over never is, three
      launches take the folder in turn, and a lock left by a dead one is
      taken over.*
- [x] **An npm command for the animations.** — *`npm run anim`, which reads
      `animations.bbmodel` from the repository root and writes
      `frontend/skin-clips.json`. `npm run anim -- --list` says what is in it
      without writing, and naming a file still works for a one-off.*
- [x] **"Border radius" is not just the borders.** — *It rounds the panels,
      the buttons, the cards, the modals, the corner where the two bars meet
      and the window itself, so it is "Corner rounding" now. Stored under the
      same name, so every saved theme keeps working. Its default is the
      roundest the slider goes rather than square -- square was only ever the
      default because zero is what a number defaults to -- including the
      value the stylesheets fall back to before the settings have loaded.*

---

## 0. Round 46

- [x] **Snapping on the main page, which can be turned off.** — *An edge
      dragged to a round number or level with the thing beside it was a
      percentage to watch and stop on by hand, and being one column out of
      line is invisible while dragging and very visible afterwards. An edge
      being resized, and a segment being moved, now pull to the lines worth
      landing on: the halves, thirds and quarters of the page, and every edge
      anything else in that row already has. Three columns of pull, and a
      button in the edit bar turns it off and remembers.*
- [x] **Snapping when cropping an icon, which can be turned off.** — *The
      picture pulls to the middle of the square and to each of its edges --
      ten pixels in 256 -- with a tick box under the frame. Lining a picture
      up by eye was a pixel-at-a-time job and one pixel out is visible in a
      32-pixel icon.*
- [~] **The missing assets are a race, not a failed download.** — *Taking the
      one mechanism in it that is real and checkable: `<name>.part` is the
      same path for every launch, and the assets folder is shared. Two
      instances starting at once -- or one starting while another is already
      running -- both decide the same asset needs fetching and both write to
      that one temp file, and whichever renames last puts two interleaved
      downloads into place under the hash the game trusts and never checks
      again. That is an asset that has been on the disk for a year reading as
      missing, with no download having failed and nothing in any log. Each
      download now has a temp name of its own, and a rename refused because
      something else has the file open is not a failure when what is already
      there is byte for byte what we were about to write. Whether that is THE
      cause is not claimed; it is a race that was really there.*

---

## 0. Round 45

- [x] **The loading screen.** — *Three things. It wore the theme's colours
      instead of the background the launcher is actually wearing, so it read
      as a flat panel dropped over the window rather than the launcher
      waiting; it paints the background now, with the scrim over it rather
      than instead of it. The pistons were drawn at the size of a spinner's
      ring, which is four grey smudges -- they get a hundred and forty-eight
      pixels, and the size no longer comes out wrong when the screen is
      measured while hidden, which is what the shell's one always is. And the
      animation jumped as it faded, because there were TWO loading screens:
      the shell's fading out over the page's own, which is inside a frame
      that may have a scrollbar and so is centred a few pixels off. A page in
      the shell does not draw one any more; it asks the shell to show the one
      there is.*
- [ ] **The 3221225477 crash is in the assets, not the pack merge.** — Not
      the server pack, not a jar hash, and not a failed download either: the
      files all arrive and the launch reports no trouble. Nothing further has
      been changed for it. I have guessed at this three times now and been
      wrong three times; the next attempt waits for a log of a launch that
      ends this way, with whatever the launcher printed before it.
- [x] **Two segments cannot share a line, one above the other.** — *A row was
      one line and nothing else: dropping a segment on another's top or
      bottom made a whole new row across the page. A row is divided up and
      down as well as across now -- `y` and `vh` beside `x` and `w` -- so
      dropping on the top or the bottom of a segment splits THAT segment's
      space and takes the half the pointer is on. The line between two
      stacked segments is dragged like any other edge. The one that is left
      when the other moves away takes the whole row back. It also had to stop
      being undone on the way to disk: two segments at the same x were read
      as fighting over the same columns, so the second was shoved sideways --
      they only compete when they are at the same height in the row.*
- [x] **"Where in its space", up and down, does nothing.** — *It was applied
      as the segment's place in its ROW, which does nothing unless something
      else in that row is taller -- so on a row of its own, which is where
      the player render usually is, there was nothing for it to do. The same
      setting now also places what is INSIDE the segment, which is what you
      see when the segment is as tall as its row. The render in particular
      had its box's two axes crossed: the across setting was driving
      justify-content, which on a column box is the up-and-down axis, so
      asking for it on the left put it at the top and the up-and-down setting
      had nothing left to drive.*
- [x] **A theme change does not reach the bars.** — *The settings page paints
      itself as you pick a colour and saves; nothing else was told. That did
      not matter while every page carried its own bars and the next page
      change rebuilt them -- the bars are the shell's now, and the shell is
      not the page the colour was picked on, so they kept the old theme until
      a restart. A save tells every window, and whoever is told repaints:
      the shell, the page in its frame, and any window of its own.
      (`settings-updated` already existed, for applying a saved theme, and
      nothing anywhere had ever listened for it.)*
- [x] **The icon is tinted under the launcher's own theme.** — *An icon of
      kind "theme" is always rebuilt from the flat layer fills, and the
      artwork is not flat, so rebuilding it in the default red does not give
      back the icon as it was drawn. With the default colours and nothing
      borrowed from the background there is nothing to recolour TO, so the
      drawn icon is used as it is.*
- [x] **No way back while editing the home page.** — *Every change took
      effect and was saved at once and there was no undo for any of it. The
      layout as it was is kept on a stack -- fifty deep -- and Ctrl+Z walks
      back up it, Ctrl+Shift+Z or Ctrl+Y forward again, with buttons for both
      in the edit bar since a shortcut nobody is told about is not an undo.*
- [x] **No way back while changing the theme or the settings.** — *Every
      control on the settings page takes effect and is saved the moment it is
      touched. Every one of those saves goes through one call, so that call
      is where the settings as they WERE are written down first -- only the
      keys being changed, so undoing a colour drags nothing else back with
      it, and the steps of one drag of a colour picker are one change to go
      back from rather than forty. Ctrl+Z puts them back and the page
      reloads, which is what applying a saved theme already does and the
      reason every control on it can be trusted to show what is stored. Not
      while typing in a text box, where Ctrl+Z is the box's own undo. Undo
      and redo buttons sit in the strip at the top.*
- [x] **Space below the home page that crops what is in it.** — *Forty pixels
      of the scroller was a transparent bottom border, which is room the page
      cannot draw in: a segment sized to the page ended at the top of it and
      was cut off there, with the rest reachable only by scrolling into
      blank. The room under the last row is that row's own bottom padding,
      which is inside the segment and cannot crop it.*

---

## 0. Round 44

- [x] **Resizing a segment's top edge into something grows the bottom
      instead.** — *The top edge had no limit at all. It is pinned by sitting
      the segment at the BOTTOM of its row, so a segment already as tall as
      its row has nothing above it to grow into -- and every pixel asked for
      past that made the ROW taller, which moved the bottom edge down while
      the top stayed exactly where it was. Dragging up grew the thing
      downwards. The edge now stops at the top of the row: the room there is
      is whatever the tallest OTHER segment in the row has and this one does
      not, and with nothing beside it there is none, so the edge does not
      move. The readout says so.*
- [x] **The notch between the bars belongs to the shell, and the page flashes
      black.** — *Both of them were the page's. The notch is drawn by
      `<html>`, and in the shell that is the framed page's `<html>`, so it
      went with the page: thrown away and built again every time, which is the
      blink. The shell draws it now and a framed page does not. The flash was
      the gap between the old page going and the new one painting -- a frame
      with no document in it yet has no background -- and the page's own
      loading screen could not cover it, since it does not exist until the
      page it is part of has parsed. The shell has a loading screen now: up
      the moment a change starts, down when the page says it is ready, which
      is the moment the page would have taken its own down. The two hand over
      and there is nothing to see between them.*
- [x] **A page change has no animation.** — *The loading screen fades in over
      the frame rather than appearing, stays up for at least a quarter of a
      second so a quick page does not make it blink, and says what it is
      opening -- in the sidebar's own words for that page, so there is not a
      second list of names to disagree with it. The lit marker down a button's
      leading edge is on every button now, not only the current one, so it can
      grow out of the edge as a page becomes current and shrink back as one
      stops being: with the sidebar surviving a page change, that is something
      that happens in front of you.*
- [x] **The current page's button does nothing on hover.** — *It moved the
      fill by a few per cent of one colour, and the lift every other button
      has is deliberately off for it, so it looked inert -- as though it had
      stopped being a button. It brightens, takes a ring in the text colour
      and stretches its edge bar now. Still unmistakably "you are here" rather
      than "this is where clicking goes", which is why it is not simply given
      the ordinary hover.*
- [x] **Only the icon in a sidebar button registers a click.** — *Three of
      them have the link INSIDE the `<li>` and around the icon alone, so 24
      pixels of a 50-pixel button did anything at all. A click anywhere in a
      sidebar button that holds a link now goes to that link -- in the shell,
      which is where the sidebar you can see lives, and in the instance
      shortcuts themselves for a page standing on its own.*
- [x] **The running instances, the instance list and the player icon still
      refresh on a page change.** — *The instance shortcuts. They are built
      from scratch whenever `profiles-updated` arrives -- every icon a new
      `<img>`, so every icon reloads -- and that is broadcast for all sorts of
      reasons a page load sets off, the auto-update check among them. It was
      invisible while the sidebar went away on a page change anyway. The list
      is left alone now unless something about it actually changed. (The
      running-instances pill already kept its rows across a refresh, and the
      player icon already skipped the work when the account had not changed,
      so those two were not rebuilding -- the list beside them was.)*
- [x] **Logs arrive late.** — *`webContents.send` reaches a window's MAIN
      frame and no other. That was the whole window until the launcher became
      a shell with the page in a frame beneath it, and from then on every
      broadcast the main process made stopped at the shell: a running game's
      log lines, a launch's progress, an instance crashing, a list changing --
      the page heard none of it. The log only kept moving because the page
      falls back to asking for it every two seconds when no line arrives, and
      that is the delay. Measured rather than guessed, and still measured:
      tests/ipcframes-test.mjs stands up a real window with a real frame and
      checks that a broadcast reaches the shell alone without the fix and both
      with it. A server's console was worse -- it was ASKED for, whole, once a
      second. Each line is sent as it is read now, with the poll kept as the
      first draw and as the way a server we did not start ourselves is read.*
- [x] **A server shows developer plugins without developer mode being on for
      that server.** — *The switch sat on the plugins tab and appeared
      whenever GLOBAL developer mode was on, so every server had "Dev plugins"
      on it whether or not that server had anything to do with the feature. An
      instance asks per instance, in its own settings, and nothing appears on
      its Mods tab until that instance has said yes. A server asks in its own
      menu now -- which is also where it can be asked of a server that has
      neither mods nor plugins, and so no tab to put it on -- and the tab
      carries nothing but the Manage button, once that server has said yes.*
- [~] **An instance can still crash with 3221225477.** — *The crash is
      inside native code during a resource reload and names nothing, so no
      culprit is invented for it. What the log names is the pack it was
      reading: `server/00000000/<uuid>` is the game's own name for the
      resource pack a server sent -- and that pack is one the launcher builds,
      by merging the server's list of packs into one zip. That merge had three
      ways of producing something the game cannot read, and all three show up
      as exactly this: a pack somebody zipped from its FOLDER went in one
      level down, so none of its files were where the game looks while the
      packs under it still pointed at them; anything else in the zip went in
      too; and the zip was built with the current time on every entry, so the
      same packs merged twice were two different files with two different
      SHA-1s -- and the game files what it downloads UNDER the hash the server
      gave and never checks it again. It is in backend/serverpack.js now,
      where tests/serverpack-test.mjs builds real zips for each of those and
      checks the result, including that the merge is byte-for-byte the same on
      another day. A pack built for another version of the game is flagged in
      the server's log, and the crash report says when the run was reading one.
      Whether the crash itself is gone wants a run on the owner's machine.*
- [x] **Relaunching an instance opens a second log tab.** — *A run is its own
      console so that two copies running AT THE SAME TIME can be told apart.
      One after the other is not that, and it left a row of tabs, one per
      launch, all but the last of them dead. A launch takes over the oldest
      finished console now and only ever opens a new one when something else
      is still using the one there is. What that console said before is kept,
      with the new session written under it.*
- [x] **Changing tab on the servers page is instant.** — *Going from the list
      into a server and back is a page change as far as anyone looking at it
      is concerned, and it happened with no sign that anything had happened:
      the whole middle of the window was simply something else. The instances
      page says so when it does the same thing -- the servers page was never
      given it. Same words, same loading screen.*
- [~] **Sharing from a server offers no relay choice and sets up no DNS.** —
      *The choice existed, in Settings, which is not where anybody is standing
      when they share something -- so an admin sharing a server was never
      offered it. It is in the share dialog now as well, same setting and same
      answer, shown to an admin and nobody else. The DNS half is not the
      launcher: it asks the relay to point the name, and the relay answers
      that it has no credentials to do it with, which is what that line is.
      The relay needs `CF_API_TOKEN` set (relay-server/README.md). Until it
      has one, sharing still works and hands out e4mc's own address -- which
      the banner now SAYS, instead of quietly handing over a different address
      than the one that was asked for and leaving the reason in a log.*
- [x] **No sidecar must mean the launcher's own relay.** — *"Whichever
      works" already did. Asking for e4mc outright in a copy with no helper
      built did not: it failed the share, which is a world nobody can join
      over a setting. Any setting falls back to our own relay when there is
      nothing to talk to e4mc with.*

---

## 0. Round 43

- [x] **"Where in its space" has no up and down.** — *It offered left, middle
      and right and nothing else, so a render could not be put at the bottom
      of a tall row. Every segment now has a place DOWN its row as well --
      fill it, top, middle or bottom -- beside the width and the height, since
      it is true of every type rather than of any one of them.*
- [x] **A segment's top edge cannot be resized.** — *The two are the same
      thing: until a segment could sit anywhere but the top of its row, there
      was no space above one for the top edge to move into, and I had made the
      top handles width-only for exactly that reason. Both edges change the
      height now, and the edge you are NOT dragging stays put -- which is the
      whole of what dragging an edge means. The pinning is the segment's place
      down its row, so the gesture sets it and the readout says which.*
- [x] **The player render came out tiny.** — *The height was being clamped to
      the box's measured height, and the box at that moment held one canvas
      that had not been sized yet, so it was a few pixels tall. The room is
      measured from the segment, less whatever else is in it, and a
      measurement of zero is read as "not laid out yet" rather than as "no
      room".*
- [x] **Resizing a segment taller makes the page scrollable with nothing to
      see.** — *Fifty-four pixels of it: the room above the first row and
      below the last was padding on the content, and padding inside a scroll
      container is part of what scrolls. It is a transparent border on the
      scroller now, which is outside the padding box and never scrolls, so a
      segment that fills the page fits it.*

---

## 0. Round 42

- [x] **Find marks nothing.** — *Selecting the match was not enough: a textarea
      only draws its selection while it is FOCUSED, and focus stays in the
      query box so Enter steps through the matches instead of being typed into
      the file. So nothing appeared at all. A copy of the text now sits behind
      the field with every match wrapped in a mark and the current one marked
      differently, the field goes see-through over it, and the two are kept in
      step -- same font, padding, wrapping and scroll position. Only while the
      bar is open.*
- [x] **The player render still stretches.** — *skinview3d writes the size onto
      the canvas as INLINE styles, so the stylesheet's `width:auto` never had a
      say: an inline height beats a rule, so capping the width squashed the
      width and left the height. The segment measures the room and tells the
      viewer instead -- which keeps it sharp as well, rather than scaling a
      canvas down in CSS -- and the canvas letterboxes what it draws so even
      mid-resize nothing is stretched.*
- [x] **The limbs go wild when the figure is flung.** — *The reactions are
      ADDED to the pose already on the model, which is only this frame's pose
      if something has put the rig back to a known one first. The conductor
      does; skinview3d's own animations do not, and neither does its update
      loop -- an idle writes the two parts it animates and leaves the head, the
      cape and the legs where last frame left them. So the spin was added to
      its own output over and over and a flick wound them up without bound.
      One reset per frame, and they behave exactly like the skins page's.*

---

## 0. Round 41

The newest batch, in the order it was given.

- [x] **The main page's player render has no limb physics.** — *The reactions
      live in the conductor, which only the skins page's clips go through.
      skinview3d's own animations went on the viewer raw, and standing still
      had no animation at all, so neither had them. Any of them carries them
      now.*
- [x] **Opening a server's Join tab lags the whole launcher.** — *It opened
      every mod jar of every instance -- thousands of central directories read
      and metadata parsed, in the process that answers every window. The
      verdict only compares mods when the loader fits, so the rest are not
      read; what is read is kept against the file's size and modified time.*
- [x] **A server's icon cannot be edited while it is running**, and a server
      does not take its version's icon by default. — *Editing was refused
      whatever was being changed; only swapping the jar out underneath it and
      renaming the folder it has open are refused now. And a server with no
      icon of its own gets its version's render, like an instance.*
- [x] **An event server's JSON script needs a real editor.** — *A panel per
      stage, questions and commands as cards that can be added, reordered and
      removed, the software and each piece of content as lists. The JSON is
      the other view of the same document. Built from the schema the main
      process already declares.*
- [x] **An event server should open "share over the internet" by itself**, and
      the player-join hook does not work. — *`autoShare`, beside `autoEula`
      and `autoStart`. The join hook was being handed stdout in CHUNKS rather
      than lines: a join split across two matched nothing, and two players
      joining together were one match between them.*
- [x] **`server.properties` needs a proper editor.** — *Name on the left,
      value on the right as the control it actually is. Comments, blank lines,
      order and separators all come back out as they went in.*
- [x] **No text editor has Ctrl+F.** — *One bar, every editor. The browser's
      own find does not look inside form fields, which is why there was none.*
- [x] **Browsing resource packs from a server is wrong.** — *The target's
      version was forced as a filter, which left only the packs whose authors
      had tagged that exact version. It is a filter for a mod and not for a
      pack or a shader, nothing is said about the version it was built for,
      and the "Server" tab stays hidden -- the provider toggle was re-showing
      it every time it ran.*
- [~] **It still crashes with 3221225477.** — *The crash itself is inside
      native code during a resource reload and names nothing, so no culprit is
      invented for it. What the log DID say is now acted on: the game caches a
      server's resource pack under its own SHA-1 and never checks it again, so
      a pack that arrived short is kept and loaded for ever -- which is the
      "mismatched hash" line and the blockstate flood. Those are checked
      against their own hashes before each launch and thrown away when they
      disagree, and the crash report says so rather than only showing a
      number.*
- [x] **Servers should keep running when the launcher is closed.** — *Spawned
      detached, pid written down, picked up on the next start. Its console
      comes from the log it writes itself and its commands over RCON, which
      the launcher switches on per server with a password of that server's own
      bound to the loopback. Off unless asked for.*

---

## 0. Round 40

The newest batch, in the order it was given.

### The resource pack tools
- [x] **What the totem's `pack.mcmeta` does now, and whether the pack shows up
      as an ordinary resource pack.** — *Answered rather than changed: it is
      the online tool's own file (description, `pack_format` 15, and both the
      `supported_formats` range and the `min_format`/`max_format` pair up to
      999), and the pack is written into the instance's `resourcepacks` folder,
      listed in the Resource Packs tab marked "(generated)", and switched on in
      `options.txt`. It is not hidden behind the tools.*
- [x] **Vanilla Tweaks refuses a snapshot.** — *The version was matched against
      `\d+.\d+` and anything else was turned away. A snapshot leads a release,
      so the line that covers it is worked out from Mojang's own manifest --
      the newest Vanilla Tweaks line not newer than the release it is heading
      for -- and the picker says which line it used.*
- [x] **Pinning a skin shows the sheets, not renders.** — *A 64x64 sheet is a
      scattered atlas of limbs. They are renders now, through a new
      `frontend/skinstill.js`: one offscreen viewer for any number of lists,
      renders queued through it, and skinview3d fetched only when a list of
      skins is first shown.*
- [x] **Vanilla Tweaks categories should be dropdowns.** — *A header per
      category that opens it, carrying how many of its packs are on. Closed
      categories are not in the layout at all, which is also what stops their
      previews being fetched.*

### Instances and their logs
- [x] **Two copies of one instance are one row in the status bar, and Stop
      stops both.** — *The rows were keyed by instance id, so the second copy
      had nowhere to go and the row's Stop belonged to whichever was written
      last. A row is a process now, numbered when there is more than one, and
      the instance page asks which copy to stop instead of killing the lot.
      The Logs tab's run strip also stops the copy you are reading.*
- [x] **Launching again after one ended opens another log view.** — *The
      console stayed on the run that had ended, so the live game's output went
      to a tab you had to find. It follows the live run unless an older one was
      clicked deliberately.*
- [ ] **It still crashes with 3221225477, across computers.**

### Elsewhere in the launcher
- [x] **A mod from an instance's list sometimes opens an empty page.** —
      *`formatNumber(undefined)`. The instance list only knows an id, a name
      and an icon, and the page was drawing a header out of that; it asks
      CurseForge for the rest now, and `formatNumber` no longer throws.*
- [ ] **Updating the desktop icon freezes the launcher.**
- [ ] **The admin panel is not on theme.**
- [ ] **The launcher news ignores the corner radius and shows raw Markdown.**

### The main page
- [ ] **The player render breaks when resized** — loses the render until a
      reload, doubles its animation speed, and stretches.
- [ ] **Grabbing the player render to move it rotates it.**
- [ ] **"Settle back to facing forward" does nothing, and settles when off.**
- [ ] **The segment settings are an ugly pile of options.**
- [ ] **Resizing into a neighbour should still shrink it** — just not when
      resizing away from it.
- [ ] **Changing a segment's height changes the whole row's, and resizing from
      the top resizes the bottom.**
- [ ] **Resizing upwards grows downwards.** Resizing one edge must never move
      the other.
- [ ] **The drop shade in an empty row sits under the segment instead of where
      it would land.**
- [ ] **Moving within a segment after the hold should slide, not wait again,
      and a segment should split top/bottom as well as left/right.**
- [ ] **"for the segments allow adding"** — the sentence stops there; waiting
      on the rest of it.

### Themes
- [x] **Exporting a theme fails with `relayClient.themeRelay is not a
      function`.** — *It was never in `relayClient.js`'s default export, which
      is how `main.js` reaches all of them.*
- [ ] **The applied theme is painted onto the Default theme's preview.**
- [ ] **Export should be able to include the main page layout and the
      background settings and image, chosen when saving rather than when
      exporting.**
- [ ] **Choosing a saved theme jumps back to the first settings tab.**
- [ ] **A saved theme's Delete is off-centre and there is no Export.**

### The relay
- [x] **The certificate is reloaded far too often, flooding the log.** — *The
      minute poll passed `force`, which skipped the fingerprint check as well
      as the throttle, so it rebuilt the context and logged a line every
      minute forever. Only the throttle is skipped now, and the directory
      watch settles before looking.*

### Closed by the owner
- [x] **A sign renders as a plain cube.** — *"signs dont even get drawn by
      code, they arent even full blocks they render fine so no need to do
      anything there". Nothing to do: a sign has no entity layer in the client
      jar at all, so there is no model to read.*

---

## 0. Round 39

The newest batch, in the order it was given.

### The resource pack tools
- [x] **A generated pack does not appear as an ordinary resource pack.** —
      *It was in the folder and in the launcher's list all along; the game
      was refusing it. See the `pack.mcmeta` item below — the same cause.*
- [x] **The totem pack shows no icon.** — *The tool now draws the totem it
      WOULD make the moment it opens, and redraws it when another skin is
      picked. It is not a picture of the result: it is the result, built the
      same way and not written anywhere.*
- [x] **The pack it writes uses the online tool's `pack.mcmeta`.** —
      *Exactly those values. `pack_format` was 1, which is the only key the
      game read before 1.20.2 and has to BE a format it knows, so every
      modern client filed the pack under "Incompatible"; and a ceiling of 100
      without min_format/max_format is the "missing mandatory fields" the
      game logs.*
- [x] **The Vanilla Tweaks one has no icon.** — *Their logo, and the packs
      already chosen shown as their own icons rather than only counted.*
- [x] **Picking Vanilla Tweaks packs looks like choosing a version.** — *A
      grid of cards carrying their own preview of each pack, animated where
      they say it is animated, with the pack's icon in the corner. Each
      picture is fetched only once its card comes into view: hundreds of
      packs at a few hundred kilobytes each. Their warnings are kept, and two
      packs they call incompatible are marked once both are on — marked, not
      refused.*

### Added mid-round
- [x] **A server can run a jar you choose.** — *"A jar of my own" in the Type
      list: the file is copied in as the server jar and nothing else about
      running it changes. Editing a server and handing over another jar
      replaces it.*
- [x] **The loader tiles wrap now.** — *Four across at most; anything past
      that goes onto another line, still filling the page. Six slivers is what
      happened as soon as a server's plugin kinds were offered.*
- [x] **The Vanilla Tweaks wording no longer implies they endorse it.** —
      *It says the packs come from their site, built by it, and that the
      launcher is not affiliated with them.*
- [x] **Install from a file, for every kind of content.** — *In every
      instance content tab and on a server, filtered to .jar for mods and
      plugins and .zip for the packs. Never written over something already
      there — a jar of the same name is usually a different build. A pack
      added to a server joins its merge order, and a data pack goes under the
      world where the game looks.*
- [x] **Dev mods for servers, including dev plugins.** — *A Paper-like
      server's dev jars go to its plugins folder, and a `plugin.yml` is enough
      to know what one is. A plugin server also has a content tab at all now:
      it had none, so there was no way to see what was installed.*

### The main page
- [x] **Adding or changing a segment no longer redraws the rest.** — *Saving
      was also sending the change back to the window that made it, so every
      resize rebuilt the page twice over. And a rebuild now MOVES the
      segments that have not changed rather than drawing them again — their
      clocks keep running and their rows of projects are not fetched afresh.*
- [x] **Segments treat their own edges the same way now.** — *The contents
      stay inside, the render included; the handles sit outside the part that
      clips, which is why they used to disappear.*
- [x] **The friends segment's tiles setting does something.** — *It drew a
      list whichever was chosen. Tiles are a face, a name and whether they
      are on; clicking one opens them, which it also did not do.*
- [x] **A segment can be dropped into empty space.** — *Rows are real, so
      empty space in one is somewhere to land.*
- [x] **A big segment dropped into a small space shrinks to fit.**
- [x] **Dragging a left edge moves the left edge.** — *An edge stops where
      its neighbour is and nowhere else: nothing is pushed and nothing is
      taken, so the space between two segments is simply a space.*
- [x] **Dropping onto a segment shares that segment's space**, half each,
      the side you are on deciding which half.
- [x] **The page has the same margin on both sides.** — *<body> insets it
      twenty pixels on the left and nothing on the right, and the scroller
      added twelve more on that side again.*
- [x] **The player render moves like the skins page's.** — *The same
      physics out of the same file: let go of mid-turn it keeps going and
      slows, and the figure leans and its arms swing with it. A toggle for
      settling back to facing forward when left alone, and how long to wait.
      "Doing" offers the skins page's own idle animations, which idle and
      every so often do something.*
- [x] **Done takes the handles off, listeners and all.**
- [x] **The inside size reaches the player render and the news.**
- [x] **The time played segment drew itself twice.** — *Redrawing one
      emptied its node, and an async segment still waiting on a fetch carried
      on and appended underneath the new contents. The node is replaced now.
      Its number follows the inside size too.*
- [x] **Changing anything keeps the scroll position.**
- [x] **Dropping onto the right-hand one of a split row shares that row.**
- [x] **The right edge is shared between rows.** — *Each row is its own
      hundred columns, so the last segment on one can be pulled out to the
      page's edge without anything else being dragged along.*
- [x] **The inside size no longer jumps.** — *A minmax(150px, 1fr) track
      grew the cards until another column fitted and then snapped them
      smaller. A fixed track means the size is the setting and nothing else.*
- [x] **Shrinking a row moves the next one up, not into it.** — *Rows were
      a consequence of the widths, so changing one re-flowed the wrapping.*

### The mod browser
- [x] **A Modrinth creator's page named the server type
      `MINECRAFT_JAVA_SERVER`.** — *No entry for that kind, so it fell
      through to Modrinth's own identifier. It also handed that identifier to
      the browser, which calls it "server".*

### The tab strips
- [x] **Hovering a tab lit it up.** — *The rule said only `opacity`, which
      left the page's blanket `button:hover` to paint the background, the
      border and the shadow underneath. Each is turned off by name.*

### Settings
- [x] **"Take the theme from the picture" and "from the block" now agree.** —
      *They were two separate settings. It is one preference shown in both
      panels, and switching between a picture and a block takes the theme
      from the new one.*
- [x] **Changing the background fades.** — *A background-image cannot be
      transitioned, so the one leaving is held on a layer of its own and
      faded out over the one arriving.*

### Making an instance
- [x] **NeoForge is back for the 26.x versions.** — *It numbers builds after
      the Minecraft version, and the mapping insisted on a leading "1." — so
      every 26.x version resolved to nothing and NeoForge stopped being
      offered after 1.21.11, the last of the old numbering.*
- [x] **One modal no longer fades out before the next comes up.** — *The
      step leaving was removed first, leaving a blurred empty screen for the
      whole of the incoming animation. They cross over now.*
- [x] **"More settings" left the blur behind.** — *closeAll took the card
      away and not the backdrop. So did making an instance.*

### The app's icon
- [x] **The icon was recoloured wrongly.** — *It worked on the finished logo
      and told the layers apart by colour, which is a guess. It is built from
      the three shipped layers now, and the cog comes out byte for byte as it
      was drawn whatever the theme.*
- [x] **"Show the background through it" does what it says.** — *It was
      painting the block INTO the cog instead of behind the icon, which is
      how the cog went green and stayed green. The backing now becomes the
      block, picture or gradient behind the launcher, with the icon over it.*
- [x] **The icon is built from its pieces.** — *Backing from the base colour
      (or the theme's gradient), gem from the second colour, cog untouched.
      Recolouring keeps each pixel's own light and shade, so a grey, white or
      black theme works as well as a red one. It is also rebuilt when the
      second colour or the background changes, not only the base colour.*

### Everywhere else
- [x] **"Scroll the wall with the page" does something now.** — *It could
      not have: the background is on <html>, whose background is the canvas's,
      and the canvas never scrolls here. It is painted on the containers that
      really do scroll, with `local`.*
- [x] **The example event server failed after "Ready to make the server".** —
      *PaperMC switched their old API off; it answers every request with
      `{"ok":false,"error":"sunset"}`, so asking for a version's builds gave
      an object with no builds in it. Moved to their new service.*
- [x] **Making a server is not making an instance.** — *A server is asked
      what KIND of server, and offered Paper, Purpur and Folia alongside the
      loaders; which loaders have a build for a version no longer takes those
      away with it. Its search looks for plugins on both sites, and whatever
      it started from is installed into the server once it exists.*
- [x] **Going through the creator now makes the server.** — *It reopened the
      old form filled in, which is not what Create says it does.*
- [x] **Making an instance left the blur behind too.** — *Same cause as
      "More settings": closeAll did not take the backdrop.*
- [x] **Installing a resource pack no longer demands the exact version.** —
      *They are textures; one built for an older version loads and works.
      Shaders too. The card says which version it was built for.*
- [x] **`genPacks is not defined`.** — *It is built inside the tab builder
      and the card function lives outside that scope, so reaching for it was
      a ReferenceError that took the whole content tab down. It is passed in.*
- [x] **The `incorrect data check` flood.** — *Downloads were written
      straight to their destination, so a dropped connection left a truncated
      file there looking finished — and a truncated zip gives exactly that,
      for every texture in it, forever. They go to a .part, are checked
      against the promised length, and are moved into place only when whole.
      Neither the response nor the file had an error listener either, so a
      reset mid-download was an uncaught exception in the main process.*
      *Whether the 3221225477 crash itself is gone wants a run with the
      corrupt packs re-downloaded; the hs_err log beside the game will name
      the library if it is not.*
- [x] **The graphics-driver line is gone.** — *It was a guess. The hs_err log
      names the library that actually fell over when there is one.*
- [x] **"Run again" put both copies' logs in one window.** — *A launch is a
      run of its own now, with its own lines and start time, and a strip above
      the log picks between them. Shown only when there is more than one.*
- [x] **Tidied the moved files.** — *`frontend/old/` was referenced by
      nothing. The loose icons are gone too, and everything that pointed at
      them — the build included — points at `frontend/assets/icon/`.*

---

## 0. Round 38

Corrections to Rounds 35–37, in the order given. Worked before Round 37
because most of these are things the last few rounds broke or left half done.

### The tab strips
- [x] **The settings tabs only half took the strip.** — *Its handler never
      marked the selected button at all, so the strip had nothing to put a
      highlight on.*
- [x] **That one should fill the width.** — *It switches the whole page
      rather than labelling a panel, so unlike the others it spans the width
      and shares it out between its tabs.*
- [x] **The selected one is not highlighted** there. — *Covered by the
      first: nothing was ever marked.*
- [x] **Take the hover colour off the tabs.** — *The only thing a tab's
      background says now is which one you are on.*

### The app icon
- [x] **The taskbar icon does not update straight away.** — *Setting the
      window icon, which IS the taskbar button, was queued behind writing an
      .ico and running PowerShell for the desktop shortcut. It happens first
      now and the shortcut follows.*
- [x] **Updating the desktop icon reloads every icon on the desktop.** —
      *It sent SHCNE_ASSOCCHANGED, which means "file associations have
      changed" — the shell answers that by throwing away its icon cache and
      rebuilding the lot. It names the one shortcut now (SHCNE_UPDATEITEM).*
- [x] **Changing the custom colours re-tints on every keystroke.** — *A
      colour picker reports every step of a drag, and each one was a full
      re-tint, an .ico and a PowerShell run — dozens a second. Only the colour
      it comes to rest on is drawn, and the preview waits too.*
- [x] **"Match the theme" is a toggle now.** — *Pressed once, it left the
      theme on the old block's colours as soon as you chose another. While the
      toggle is on they are re-taken whenever the block or picture changes.*
- [x] **The launcher's icon offers what an instance's offers.** — *The same
      picker: the bundled blocks, a rendered item, block or mob, a block's
      face, or a picture of your own. It was a file dialog and nothing else.*
- [x] **A toggle to merge the theme's block into the icon's uncoloured
      parts.** — *The re-tint turns what is RED in the icon and leaves the
      greys alone, because a grey has no hue to turn. This fills those greys
      with the block the background is made of, keeping each pixel's own light
      and shade so it still reads as an icon rather than a flat sticker. Redone
      when the block or the colour changes, and kept across switching to a
      picture of your own and back.*

### The home page
- [x] **Nothing can change how big the contents of a segment are.** — *Every
      segment has a content size now, as a percentage, and everything inside
      is sized from it.*
- [x] **The dashed outline is the theme colour.** — *It was the base colour
      at 70%, which on a red theme over a red panel is almost invisible. It is
      white, over a slight darkening, and does not depend on the theme.*
- [x] **And it is cut off at the corners.** — *It followed the segment's
      border radius while being offset outside it, which snipped the dashes.
      It is its own rectangle now.*
- [x] **The resize handles sometimes do not appear.** — *They hung outside
      the segment, and a segment with a set height has to clip its contents —
      so it clipped the handles away with them. They sit just inside now, and
      the contents scroll rather than the segment clipping.*
- [x] **Editing makes the page scroll sideways.** — *The outline was offset
      six pixels outside each segment, which pushed the right-hand column past
      the edge of the page.*
- [x] **Making one segment wider does not make its neighbour narrower.** —
      *It takes the room from whoever shares the row, largest first, so the row
      still adds up and nobody is pushed off it.*
- [x] **Nor does changing its height change an aligned neighbour's.** — *It
      does now: a row of different heights is not a row.*
- [x] **Width and height snap while dragging.** — *The page was twelve
      columns, so every drag jumped a twelfth of it. Widths are percentages
      now. They are laid out as a wrapping row rather than a grid, because a
      hundred-column grid would multiply its gap by ninety-nine and make the
      page several thousand pixels wide — the gutter is each segment's own
      padding instead.*
- [x] **A segment too small for its contents does not shrink them.** — *The
      content size above does that by hand, and a segment with a set height
      scrolls its contents rather than clipping them off.*
- [x] **The player render still has no physics.** — *skinview3d has none of
      its own: let go and it stops dead. It carries the speed you were turning
      it at, bleeds it off over about a second, and swings the arms and legs
      with that speed.*
- [x] **The friends segment cannot be tiles, and clicking does nothing.** —
      *Both: tiles are a choice, and a friend opens on the players page.*
- [x] **The move, settings and remove buttons are too small.** — *Holding
      the segment anywhere moves it, so the move button is gone and the other
      two are twice the size.*
- [x] **Holding over another segment can only place it beside.** — *Four
      answers now, from where over it the pointer is: near the left edge goes
      before, near the right edge after, over the lower part below on a row of
      its own, over the middle beside it sharing the row. Each is drawn before
      you let go — a line down the side it will go to, or the word "beside".*
- [x] **Editing, adding or changing one segment redraws them all.** — *Only
      what changed is drawn again: a resize touches nothing but the numbers, a
      settings change redraws that one segment, and entering edit mode only
      puts the handles on.*
- [x] **Clicking edit loses the scroll position.** — *It redrew the page;
      now it does not.*
- [x] **The Mojang patch-note link is wrong.** — *It was built as
      `minecraft-java-edition-<version>` for everything, which is right for a
      release and wrong for a snapshot. Built from the version rather than the
      feed's id, too, since that is a readable slug for the newest few entries
      and a sha256 for everything older.*
- [x] **The patch notes cannot be shown as a grid.** — *Both Mojang feeds
      take the same list-or-tiles choice as everything else.*
- [x] **A toggle for whether a tiled block background scrolls.** — *Added;
      it chooses between a wall that stays put behind the page and one that
      travels with it.*

### Elsewhere
- [x] **The skins page's player render is cut off as it turns.** — *The
      canvas was half the height it was tall, which fits a player facing
      forward and nothing more: turned 45 degrees one is about an eighth wider
      than face-on, and there was no room for it.*
- [x] **The "Edges" setting does nothing.** — *`-webkit-font-smoothing` is a
      macOS property; Chromium ignores it on Windows and Linux entirely, which
      is where the font looked soft. The levers that work there are Chromium's
      own switches, which have to be set before the app starts — so it takes a
      restart, and the setting says so.*
- [ ] **Make the launcher one page.** The sidebars and toolbar stay put and
      only the content changes, so moving between pages does not reload
      everything — with the sidebar highlight sliding, as the tabs do.
      *Held over to the next round at the owner's request.*

---

## 0. Round 37

### Joining a server
- [x] **A Join button on a server.** — *Beside the start and restart buttons
      in the list, because playing on a server is a different thing from
      running it and was not worth a tab's depth. It opens that server on the
      Join tab, and the tab is in the address, so Back comes back to it — the
      page was dropping the tab out of its own links.*
- [x] **That tab lists the instances that could join it**, or makes one. —
      *Every instance, in two lists: the ones that can get in, and the ones
      that would not, each with the reason named. "Incompatible" on its own
      says nothing about what to do next.*
- [x] **Only compatible instances are offered.** — *Worked out in
      `backend/server-join.js`, against what actually stops a join. A version
      gap is bridged by ViaVersion on the server for a newer client and
      ViaBackwards for an older one — which way round it is matters, and the
      launcher says which end is doing the work — or by ViaFabricPlus and the
      like in the instance. A modded server wants its loader (Quilt reads
      Fabric mods, so that one crosses; Forge and NeoForge do not), its
      version, and its mods, matched on the mod id out of the jar rather than
      the file name, since the same mod is named differently in every pack. A
      mod that says it is server-only is not asked of the client.*
- [x] **With a "join anyway" on every instance** regardless. — *All of this is
      read off file names and jar metadata, which can be wrong, so the
      launcher does not get the last word on what you may try. Where the
      reason is a fixable one — the server has mods you have not got — there
      is also a button that copies them across, off the server itself rather
      than downloading them again, which could land on a different build than
      the server runs.*
- [x] **An instance made for a modded server gets that loader, that version
      and exactly those mods.** — *Its loader build too, so it is pinned to
      what the mods were run against. Joining also starts the server if it is
      stopped and waits for it to say it is ready, rather than firing the game
      at a port nothing is listening on yet.*

### Event servers
- [x] **A described server that sets itself up.** — *All of it, in
      `backend/event-server.js`, which documents the corrected format in full.
      The shape given was not valid JSON — it used arrays where it meant
      objects and repeated keys, which an object cannot carry — so repeated
      things are lists of objects and conditions are a `when` field.*
- [x] **Running one asks each question in a modal.** — *One at a time, since
      a question can depend on an earlier answer; a version question offers
      the real version list rather than a blank box. Then it builds the
      server, saying what it is doing as it goes, and carries on through the
      stages — waiting for the server's own "Done" line rather than guessing
      at a delay, and watching for players joining.*
- [x] **And something to write them in.** — *The stages, question types,
      loaders and content kinds are offered as chips that drop into the file
      where the cursor is, each saying what it means and where it ends up, and
      the file is checked against the real parser as it is typed — it cannot
      be saved while it is wrong. A new one starts from a working example.*

---

## 0. Round 36

In the order it was given.

### The home page
- [x] **A segment's size is not editable.** — *The page is a twelve-column
      grid now and every segment carries its own span and an optional height.
      Both are in its settings, and both are on the segment itself as a handle
      in each corner — all four change the width, the bottom two the height as
      well, and the width snaps to the columns because that is what the layout
      is made of.*
- [x] **At the smallest window size the segments are cropped off the right.**
      — *A grid item's default minimum width is the width of its contents, so
      a row of cards refused to narrow and overflowed instead of fitting. With
      `min-width: 0` it lays out properly, and the spans collapse as the window
      shrinks: anything narrow becomes half width, then everything goes full.
      Checked at five widths down to 640px for overhang and sideways scroll.*
- [x] **No list-or-grid choice.** — *Continue playing is a list or tiles; a
      project row is a sideways row, tiles that wrap, or a list.*
- [x] **The title text is not a segment.** — *It was an `<h1>` in index.html
      with its own script, which made it the one thing on the home page nobody
      could move, reword or remove. It is a Greeting segment now, with its own
      wording, size and alignment; left blank it still picks one of the ten at
      random, as it did.*
- [x] **The first segment's buttons have their tops cut off.** — *They sat at
      `top: -10px`, outside the segment, so for the first row that was above
      the top of the scroller. They are inside it now.*
- [x] **Only the vertical order can be changed.** — *Covered by the grid
      above: anything can sit beside anything, and holding a dragged segment
      over another for half a second is the gesture that puts it there —
      splitting that row between the two rather than merely placing it next in
      the list and still a row each.*
- [x] **The segment picker is ugly.** — *It was a wall of icons each with a
      paragraph beside it. Tiles now — icon and name — with the explanation
      shown once for whichever one you are pointing at, and a box to narrow
      them down.*
- [x] **The snapshots segment should be the changelogs.** — *It listed bare
      version IDs out of the manifest, which says what came out and when and
      nothing about what is in it. It is Mojang's own patch notes now, with
      their pictures, opening on the article.*
- [x] **And a Minecraft news segment.** — *From their news feed, the same one
      the official launcher draws its front page from, filterable by category.
      Both feeds are fetched once an hour rather than on every visit.*
- [x] **The friends API is pinged every time the home page opens.** — *There
      was nothing between the page and Mojang at all: both the list and the
      presence report went out on every open. An answer is kept for a minute
      (thirty seconds for presence, which changes more), and a 429 now puts
      that endpoint to sleep for exactly as long as Mojang's `Retry-After`
      asks, serving the last good list meanwhile rather than a red message.
      Refresh and any change to your own status still go straight out — an
      "appear offline" answered out of a cache would not appear offline — and
      adding or removing somebody drops what is held.*
- [x] **The player segment wants settings.** — *What it is doing (standing,
      idling, walking, running, flying), whether it can be turned by dragging,
      whether it turns on its own, how tall, where in its space, and whether
      the name shows.*
- [x] **The mods/modpacks segment lost its "featured" ordering.** — *Back,
      and the default. Plain "most followed" is the same handful for months;
      random digs up abandoned things with four downloads. So a pool of sixty
      well-liked ones, the very top few skipped, shuffled with the day as the
      seed: the same selection all day, a different one tomorrow, always drawn
      from things that are actually popular.*
- [x] **The icons are different sizes.** — *`object-fit: cover` cropped
      non-square art so the icons read as different sizes. A fixed square box
      with the picture fitted inside it means every one matches.*
- [x] **The edit button should be the icon alone, at the bottom right.** —
      *It was "✎ Edit page" at the bottom left.*
- [x] **Replace the up/down buttons with dragging.** — *All three: the arrows
      are gone and a grip starts the drag, holding over another segment for
      half a second drops it beside that one instead of before it, and there is
      a handle in each corner. Only the grip starts a drag, so selecting text
      or pressing a button inside a segment still works.*
- [x] **"Continue playing" wants a choice of play button or info.** — *Play
      button, details, both or neither. The play button launches rather than
      merely opening the instance.*
- [x] **Discover's featured items, the same.** — *And the button does
      something now: it looks for an instance already made from that project
      and opens it, and where there is none it goes to the project with the
      install flow ready. Packs record which project they came from as they are
      installed, so the match is exact rather than by name — older instances,
      which have only the name, are still matched on that.*

### The mod browser
- [x] **Clicking a creator should open their profile.** — *A third kind of
      page in the browser, beside the search and a project: the avatar, name,
      handle and bio, how many projects they have, every download added up,
      when they joined, and their projects most-used first with a tab per kind
      they actually make. Reachable from the author on a project page and from
      the author in the search results, where the name is its own link so it
      does not open the project behind it.*
- [x] **A project's gallery images.** — *They were a column of `max-width:
      100%` pictures, so each came out whatever size its own file happened to
      be and none used the width that was there. A grid of tiles now, all one
      size whatever shape the picture is, filling the width available; and
      clicking one opens it full size with zoom (wheel, buttons or keys),
      dragging when it is bigger than the window, the rest of the gallery on
      the arrow keys, and Escape to close.*
- [x] **Installing should be able to make a new instance.** — *The only
      choice was an existing instance, so a mod needing a version or loader you
      had no instance for could not be installed from that page at all: the
      list simply came up empty. "Make a new instance for this" is offered
      first, and the version and loader steps are told what the project
      actually supports, so neither can offer a combination it cannot run on.
      The mod goes in as soon as the instance is saved, and it opens on it.*

### Everywhere
- [x] **Rework every tab strip to Modrinth's shape.** — *Each page had grown
      its own, all of them a row of separate buttons with the selected one
      filled in. One `.tabstrip` now: a single joined background, rounded at
      its ends, with the highlight a single element behind the buttons rather
      than a background on one of them — which is what lets it SLIDE from tab
      to tab instead of blinking out and in. tabstrip.js measures the selected
      tab and the CSS transition does the rest; a strip built later, or one
      whose tab is changed by script rather than by a click, is picked up the
      same way. Applied to the instance tabs, the add-instance modal, the mod
      browser's types, both project pages, the creator page, the server page
      and the settings switcher.*
- [x] **Highlight the current page in the left sidebar.** — *There was no way
      to tell which page you were on: every button looked the same. The link
      that points at the page we are already on is marked — sidebar.js has
      always worked that out, for in-page navigation. Not the hover look, which
      has to keep meaning "this is what clicking does": a filled button with a
      bar down its leading edge, and it does not lift.*
- [x] **The version text in Settings sits outside the panel.** — *It was
      pinned to the WINDOW's bottom-right, which is past the panel's right edge
      and out in the margin. Pinned to the panel now.*
- [x] **Sticky headers show the app background straight through.** — *A sticky
      strip has to be opaque or the rows scroll past behind it, and it was
      painted in the panel's own dark shade — a solid block over whatever the
      user chose as a background. It paints that background instead, lined up
      with the window's own (`background-attachment: fixed`), so the strip is a
      window through to the wallpaper rather than a lid over the cards. With no
      custom background there is nothing to see through to, so it falls back to
      the panel shade. The corner radius is gone: it was there to sit against a
      rounded panel, and a strip showing the background through it is not a
      panel edge. All three of them — the skins and capes headers, Add New
      Player, and the mod browser's install sections.*

### Instances
- [x] **Cancelling at the version step quits instance creation.** — *The
      comment above it said "Cancel on a step means not this one, which is the
      same as Back" and the line under it called `close`. ✕ and clicking away
      still mean the whole thing.*
- [x] **The line under the instance name is unreadable.** — *Loader, version
      and two full timestamps all ran together on one line, so the loader and
      version — which is what that line is for — could not be picked out of it.
      The line under the name is now what the instance IS and how long it has
      been played; the dates sit below it, quieter.*
- [x] **Servers tab: re-pinging blanks the MOTDs.** — *Every render set the
      line to "Pinging…" and only filled it back in when the ping came home, so
      returning to the app flashed the whole list. What each server last said
      is kept and drawn straight away, and the new answer replaces it in place
      — which nobody sees unless it actually changed. A ping that fails leaves
      what is on screen rather than replacing it with the address.*
- [x] **Servers and Worlds tabs: the play buttons are not disabled.** —
      *Joining a server and playing a world are both launches of the instance,
      so they are no more available than any other action there while the game
      is running. The Worlds tab did not even ask whether it was running.*
- [x] **A modpack whose name has a `:` in it fails to install.** — *An
      instance's folder was named with whatever the thing was called, and
      Windows cannot have a colon in a path at all. Names are made safe at the
      one place folders are created: the characters Windows forbids, trailing
      dots and spaces (which it drops silently, so the folder you make and the
      folder you look for stop matching), the device names, and a length cap.
      What the instance is CALLED keeps its colon — only the folder changes.*
- [x] **A Forge mod with only one compatible version still opens the version
      picker.** — *A question with one possible answer is not a question. Both
      that step and the loader step are skipped when the mod has already
      settled them, and Back skips them again on the way out — otherwise it
      would land on a page with one option, or bounce forward and appear to do
      nothing.*

---

## 0. Round 35

Corrections to Round 34, in the order they were given — plus the launch crash
that came in while they were being worked through, which goes first because
nothing else can be looked at until the app starts.

### Found while testing, not reported
- [x] **The launcher could crash outright during a download.** — *On any
      failure the download destroys the part-file it is writing to. A write
      already handed to the filesystem then comes back as
      `ERR_STREAM_DESTROYED` and is emitted as an `error` event — and with
      nothing listening, node turns that into an uncaught exception, which in
      the main process is the launcher simply gone, mid-download. The
      listeners around `drain` and `end` did not cover it, because a connection
      that drops mid-transfer reaches the handler with neither attached. So
      every ordinary bad connection was a chance of this, on top of the
      truncated file it was already causing. Found because the download suite
      kept "flaking" about one run in eight, which is what an intermittent
      uncaught exception looks like from the outside; it is now reproduced
      three times a run and checked for. The same pass stopped that loop
      leaking a dead listener per chunk.*

### The app would not start at all
- [x] **`ReferenceError: Cannot access 'dataDir' before initialization`.**
      Round 34's playtime counter put `const playtimePath = path.join(dataDir,
      "playtime.json")` at line 394, four hundred lines above `const dataDir`.
      A `const` read before its own declaration does not come out undefined —
      it throws, at import time, before a window exists, so the launcher died
      on the splash. — *`playtimePath` is a function now, worked out when it
      is asked for. Guarded by a new suite that parses each backend file and
      flags any top-level initializer naming a binding declared below it,
      because the order of ten thousand lines of declarations is not something
      to hold in your head.*

- [x] **The "follow the theme" button is still there, and the icon does not
      follow on its own.** — *The button is gone. Following the theme is not a
      choice to make, it is simply what the launcher's own icon does, so the
      only thing left to decide is whether a picture of your own is being used
      instead — and the second button now exists only to undo that, and is
      hidden until there is something to undo.*
- [x] **A block background cannot be changed once one is set.** — *One
      identifier. `model:blockTile` resolved the newest version into `v` and
      then asked `blockFaces` for `version` — the raw argument, which the
      window never sends. So every tile request read assets for `undefined`,
      came back "no assets for this version yet", and the pick was dropped.
      Its sibling `model:blockFace` had it right, which is why the face row
      filled in while the tile behind it never arrived. A pick is also only
      kept now if the tile really came back, so a block that cannot be read
      leaves the one in use alone instead of putting the new name against the
      old picture.*
- [x] **Nor can the picture, once an image background is set.** — *Every
      chosen file was copied in as `wallpaper<ext>`, so a second picture handed
      the window the identical `file://` URL — and a URL that has not changed
      is served out of the renderer's cache, so the old picture stayed on
      screen. Each one gets a name of its own now, and the older copies are
      swept away only after the new one is safely in place (deleting first is
      also how Windows could fail the copy outright, the old file still being
      open).*
- [x] **Suggestions still unreachable after the certificate was renewed.** —
      *Not the launcher: the relay. It read the certificate once at startup and
      built one secure context for the life of the process, so certbot renewing
      changed nothing — it carried on presenting the expired chain, and every
      launcher kept refusing it however many times you renewed and restarted.
      Only restarting the relay would have fixed it, which is not something a
      renewal does. It watches and polls the files now and rebuilds the context
      when they change, keeping the one in use if it catches a half-written
      file mid-renewal, and logs the expiry date it is serving. **The relay
      needs restarting once for this to take effect.** The message in the app
      no longer explains the situation to whoever runs the server; it says
      suggestions are unavailable and offers Try again.*
- [x] **Most text on the background has no outline.** — *The rule named its
      selectors by hand — `h1`–`h5` and anything tagged `.on-background` — so
      it covered almost nothing: labels, values, button captions, the home
      page's segment text. "Is there a panel behind me" is a question about
      every ancestor's computed background and cannot be asked in CSS at all,
      so it is measured instead: `frontend/outline.js` walks up from each run
      of text until it finds something that actually paints, and marks the text
      that reaches `<html>` without finding one. A tint you can see through
      does not count as cover. Nothing has to be tagged, and text added later
      is picked up by an observer.*
- [x] **Some settings text sits out the tab-change animation.** — *`transform`
      does nothing at all to a non-replaced inline element, so the inline
      children faded in without moving while the panel around them rose. They
      are promoted to `inline-block` for the 160ms the animation runs; each has
      a `<br>` either side of it so the layout is identical, and anything that
      sets its own display — the flex toggles — is left alone.*
- [x] **`background: colour` shades the sidebar's top-right** differently from
      `background: theme`. — *`--sidebar-bg` ran its gradient along
      `--gradient-angle`, which is the BACKGROUND's angle and has nothing to do
      with the sidebar. Without a custom background a separate rule overrode it
      with a fixed 180°; with one, the saved angle applied and tilted the
      shading across the corner. The sidebar runs straight down now whatever
      the background is, and the stale variable is gone.*
- [x] **The image background wants the "from theme" button too.** — *Added,
      as the block panel's one: it takes the theme's base and secondary from
      the picture's middling-dark and middling-bright. `model:blockColors`
      takes a file as well as a data URL now, and shrinks a photograph first —
      the answer does not need four million pixels, and shrinking averages away
      sensor noise and JPEG blocking.*
- [x] **The app-icon preview in Settings does not update with the theme**, and
      the desktop icon is not immediate. — *The preview: the preset-theme path
      set every colour and saved them and never told the preview; only the
      hand-picked colour path did. Both go through one `themeColorsChanged()`
      now, which also fixes the outline below. The desktop icon: both shells
      cache an icon against the file it came from, and the icon was rewritten
      to the same `app.ico` / `app.png` every time, so the old picture stayed
      until the cache happened to be rebuilt. Each write gets a name that has
      never been seen before, the older ones are swept afterwards, and Explorer
      is told the association changed rather than left to notice.*
- [x] **The instance-creation modal loses its scroll position**, and the
      backdrop blur drops out between steps. — *The blur was on each step, and
      each step replaces the one before it, so it left with the step going out
      and came back with the one arriving — the page behind visibly snapped
      sharp and then blurred again, both going forward and coming back. It is
      its own element now, kept for as long as any step is open, with only the
      card inside changing. The scroll position of each list is remembered and
      restored after the rows have been laid out.*
- [x] **The text outline must follow the text colour** as it is changed. —
      *The settings page sets `--text-color` itself rather than going through
      `applyTheme`, and left `--text-outline` where it was, so light text could
      keep a light edge. Both paths now go through `themeColorsChanged()`,
      which works the edge out from the text colour's luminance — the same sum
      `applyTheme` uses.*
- [x] **A font-smoothing setting on the Styles tab.** — *The launcher's font
      is drawn from square pixels and the browser's antialiasing smears every
      edge of it into a grey halo, which is what made it look soft. "Edges" on
      the Styles tab: Sharp (no smoothing, the default), Smooth, or whatever
      the system does. Applied before the first paint so text is never drawn
      smoothed and then redrawn sharp, and it travels with a saved theme.*

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
- [x] **An armadillo showed curled up and standing at the same time.** — *It
      is modelled both ways, and nothing in the assets says which the game
      draws when — the renderer decides it in Java. The rolled-up `cube` is
      off to begin with now, and still switchable back on. The names are
      checked against a real client so they cannot quietly stop matching.*
      Guessing which parts are alternatives broke far more than it fixed, so
      every part is drawn and each one is a switch in the adjust dialog.
      Doing it properly means reading `setupAnim` out of the model class.
- [x] **An elder guardian's side has a hole in it**, the way the ender dragon did.
- [x] **An evoker's hands were both together and held out at once.** — *Same
      cause: every illager carries its arms twice, crossed and held out for
      casting. The held-out pair is off to begin with. Evoker, illusioner,
      pillager and vindicator all had it.* Same as
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
