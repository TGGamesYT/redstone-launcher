# Launcher TODO

Everything asked for across the rounds of feedback so far, in one place. The
headings are kept even once done, so anything that turns out not to work can be
reopened against the right description.

`[x]` = shipped. `[~]` = shipped once but reported broken again. `[ ]` = not
started.

---

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
