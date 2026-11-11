// A mod project as an instance.
//
// Two separate things are checked, and both of them are things the launcher
// gets wrong silently rather than loudly.
//
// 1. What a project says about itself. A dev instance is made out of the
//    answers -- the loader, the Minecraft version, the run folder, the Java
//    -- and a wrong answer does not fail here: it makes an instance that
//    says Fabric 1.20.1 and runs something else, or a Gradle run on the
//    wrong Java that fails with a toolchain error nobody asked for.
//
// 2. Where an instance's files are. Forty-odd places used to spell
//    <data>/client/<id> out for themselves, and a dev instance's files are
//    somewhere else entirely -- its project's run folder -- so a single one
//    of them left behind would read or write the wrong folder. The list of
//    places is checked too, because the next one somebody writes is the one
//    that breaks it.
//
// The real functions are sliced out of main.js rather than rewritten: a copy
// would pass while the launcher was broken.
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { liftModule } from "./lib/lift.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(ROOT, "backend", "main.js"), "utf8");

let bad = 0;
const check = (what, got, want, note) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${note ? "  — " + note : ""}`
    + (ok ? "" : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`));
};

// The real functions, lifted out of main.js by name -- see tests/lib/lift.mjs
// for why it is done that way.
const WANTED = [
  "GRADLE_MARKERS", "isGradleProject", "gradleRootFor",
  "MC_JAVA", "javaForMinecraftVersion",
  "gradleWrapperVersion", "GRADLE_JAVA_MAX", "cmpVersions", "javaRangeForGradle",
  "javaFromScripts", "projectOwnJavaHome", "requiredJavaForProject",
  "projectText", "projectScripts", "gradleProp",
  "PROJECT_META", "PROJECT_PLUGINS", "projectLoader",
  "projectVersion", "projectRunDir", "projectSetsUsername",
  "modProjectId", "modProjectIcon", "modProjectInfo",
  "gradleSpawnArgs",
  "_projectDirsAt", "_projectDirs", "projectDirs", "instanceRoot",
];
const mod = await liftModule(WANTED, {
  file: "modproject",
  // What main.js has around these: where the launcher keeps its data, and
  // the profiles file instanceRoot() reads.
  prelude: 'import fs from "fs";\nimport path from "path";\n'
    + "export let dataDir = null, profilesPath = null;\n"
    + "export const setPaths = (d, p) => { dataDir = d; profilesPath = p; };\n",
});

// ── A project tree, as a mod template leaves one ───────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "modproject-"));
const write = (rel, text) => {
  const f = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
  return f;
};

// A Fabric project, spelt the way the official template spells it.
const fabric = path.join(tmp, "fabric-example-mod");
write("fabric-example-mod/gradlew", "#!/bin/sh\n");
write("fabric-example-mod/settings.gradle", "pluginManagement { repositories { maven { url = 'https://maven.fabricmc.net/' } } }\n");
write("fabric-example-mod/build.gradle", [
  "plugins { id 'fabric-loom' version '1.7-SNAPSHOT' }",
  "dependencies {",
  "  minecraft \"com.mojang:minecraft:${project.minecraft_version}\"",
  "  modImplementation \"net.fabricmc:fabric-loader:${project.loader_version}\"",
  "}",
  "java { toolchain { languageVersion = JavaLanguageVersion.of(21) } }",
].join("\n"));
write("fabric-example-mod/gradle.properties", [
  "org.gradle.jvmargs=-Xmx1G",
  "minecraft_version=1.21.1",
  "yarn_mappings=1.21.1+build.3",
  "loader_version=0.16.5",
  "mod_version=1.0.0",
  "maven_group=com.example",
  "archives_base_name=modid",
  "mod_id=examplemod",
].join("\n"));
write("fabric-example-mod/src/main/resources/fabric.mod.json",
  JSON.stringify({ id: "examplemod", version: "1.0.0", icon: "assets/examplemod/icon.png" }));
// The picture the mod gives itself, where its own metadata says it is.
fs.mkdirSync(path.join(fabric, "src/main/resources/assets/examplemod"), { recursive: true });
fs.writeFileSync(path.join(fabric, "src/main/resources/assets/examplemod/icon.png"),
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));

{
  const info = mod.modProjectInfo(fabric);
  check("a Fabric project is read as one",
    [info.success, info.loader, info.knownLoader], [true, "fabric", true],
    "its own fabric.mod.json says so, whatever else is in the tree");
  check("and the version it builds against is the one in gradle.properties",
    info.version, "1.21.1");
  check("the game runs in the project's run folder",
    info.dir, path.join(fabric, "run"),
    "which is the default for Loom, ForgeGradle, NeoGradle and ModDevGradle alike");
  check("Gradle runs at the project root", info.root, fabric);
  check("on the Java the project asks for", info.java, 21,
    "the toolchain, which is the explicit statement of it -- not the game's Java");
  check("through the project's own wrapper", info.wrapper, true,
    "a project with a gradlew is built with that gradlew, not with whatever is on the PATH");
  check("the mod id is read for the instance's name", info.modId, "examplemod");
  check("and the mod's own picture is read for its icon",
    [String(info.icon || "").slice(0, 22), String(info.icon || "").length > 60],
    ["data:image/png;base64,", true],
    "the instance wears the icon the mod gives itself, which is what it would have once built");
  check("the task is the loaders' own", info.task, "runClient");
  check("and the project passes no username of its own", info.setsUsername, false,
    "which is what decides whether the launcher's account can be handed over");
}

// ── which Java its Gradle runs on ─────────────────────────────────────────
//
// Running Gradle on the project's own toolchain JDK is what makes that
// toolchain resolvable without Gradle having to go looking: the running JVM
// is always a candidate. But it has to be a JDK that Gradle can run on at
// all, and if the project has already pinned one, that is the answer.
{
  // The toolchain written as a property, which is how half the templates
  // write it -- reading only the literal form missed every one of them.
  const byProp = path.join(tmp, "prop-java");
  write("prop-java/gradlew", "#!/bin/sh\n");
  write("prop-java/build.gradle",
    "plugins { id 'fabric-loom' }\njava { toolchain { languageVersion = JavaLanguageVersion.of(java_version) } }\n");
  write("prop-java/gradle.properties", "java_version=21\nminecraft_version=1.21.1\n");
  write("prop-java/gradle/wrapper/gradle-wrapper.properties",
    "distributionUrl=https\\://services.gradle.org/distributions/gradle-8.10-bin.zip\n");
  check("a toolchain written as a property is followed up",
    mod.requiredJavaForProject(byProp), 21,
    "JavaLanguageVersion.of(java_version) is what the templates write");
  check("and the wrapper's own version is read",
    mod.gradleWrapperVersion(byProp), "8.10");

  // An old wrapper cannot run a new JDK: "Unsupported class file major
  // version" before anything is built.
  write("prop-java/gradle/wrapper/gradle-wrapper.properties",
    "distributionUrl=https\\://services.gradle.org/distributions/gradle-7.4-bin.zip\n");
  check("a toolchain newer than its Gradle can run is brought back to what it can",
    mod.requiredJavaForProject(byProp), 17,
    "Gradle 7.4 knows Java 17 and nothing above it, whatever the toolchain says");

  check("what each Gradle can run on",
    ["9.0", "8.10", "8.5", "7.6", "7.3", "6.9"].map(v => mod.javaRangeForGradle(v).max),
    [24, 23, 21, 19, 17, 15]);
  check("and Gradle 9 will not run on 8 at all",
    mod.javaRangeForGradle("9.0").min, 17);

  // A project that has said which JDK to use has already answered.
  const pinned = path.join(tmp, "pinned-java");
  write("pinned-java/gradlew", "#!/bin/sh\n");
  write("pinned-java/build.gradle", "plugins { id 'fabric-loom' }\n");
  const jdkHere = path.join(tmp, "some-jdk");
  fs.mkdirSync(jdkHere, { recursive: true });
  write("pinned-java/gradle.properties", `org.gradle.java.home=${jdkHere}\n`);
  check("a JDK the project pins is used as it is",
    mod.projectOwnJavaHome(pinned), jdkHere,
    "forcing ours over it is how a project that builds by hand stops building here");
  check("and one that points nowhere is not",
    mod.projectOwnJavaHome(path.join(tmp, "prop-java")), null);
}

// Picked from inside, which is what people have to hand: the build folder,
// or the libs folder a dev mod is usually registered by.
{
  write("fabric-example-mod/build/libs/modid-1.0.0.jar", "not really a jar");
  for (const inner of ["build", path.join("build", "libs")]) {
    const info = mod.modProjectInfo(path.join(fabric, inner));
    check(`picking ${inner} finds the project above it`,
      [info.success, info.root, info.dir], [true, fabric, path.join(fabric, "run")],
      "the project root is what Gradle runs in, wherever inside it was picked");
  }
}

// A NeoForge project, which says which loader it is for in a different file
// and its Minecraft version in a different way again.
{
  const neo = path.join(tmp, "neo-mod");
  write("neo-mod/gradlew", "#!/bin/sh\n");
  write("neo-mod/build.gradle", [
    "plugins { id 'net.neoforged.moddev' version '1.0.21' }",
    "neoForge { version = \"21.1.80\" }",
    "java { toolchain { languageVersion = JavaLanguageVersion.of(21) } }",
    "runs { client { client() } }",
  ].join("\n"));
  write("neo-mod/src/main/resources/META-INF/neoforge.mods.toml", "modLoader=\"javafml\"\n");
  const info = mod.modProjectInfo(neo);
  check("a NeoForge project is read as one",
    [info.loader, info.knownLoader], ["neoforge", true]);
  check("and its Minecraft version comes out of the NeoForge one",
    info.version, "1.21.1",
    "21.1.80 is NeoForge for 1.21.1; the project never writes the game's version down");
}

// A Forge project with the old MDK's run block: it moves the run folder and
// hands the game a username, and both of those have to be noticed.
{
  const forge = path.join(tmp, "forge-mod");
  write("forge-mod/gradlew", "#!/bin/sh\n");
  write("forge-mod/build.gradle", [
    "plugins { id 'net.minecraftforge.gradle' version '[6.0,6.2)' }",
    "minecraft { mappings channel: 'official', version: '1.20.1' }",
    "dependencies { minecraft 'net.minecraftforge:forge:1.20.1-47.2.0' }",
    "runs {",
    "  client {",
    "    workingDirectory project.file('testing')",
    "    args '--username', 'Dev'",
    "  }",
    "}",
    "java { sourceCompatibility = targetCompatibility = '17' }",
  ].join("\n"));
  write("forge-mod/src/main/resources/META-INF/mods.toml", "modLoader=\"javafml\"\n");
  const info = mod.modProjectInfo(forge);
  check("a Forge project is read as one", info.loader, "forge");
  check("its own working directory is where the game runs",
    info.dir, path.join(forge, "testing"),
    "a project that moved its run folder would otherwise be given an instance pointing at one that is never used");
  check("and it is left to sign the game in itself", info.setsUsername, true,
    "Minecraft refuses an option given twice, so two --username arguments is a game that is gone before it draws anything");
  check("on the Java its compatibility says", info.java, 17);
}

// Not a project at all.
{
  const plain = path.join(tmp, "just-a-folder");
  fs.mkdirSync(plain, { recursive: true });
  const info = mod.modProjectInfo(plain);
  check("a folder with no Gradle in it is refused, with the reason",
    [info.success, /Gradle/.test(info.error || "")], [false, true],
    "and not accepted as an instance that could never launch");
  check("and nothing is thrown for no folder at all",
    mod.modProjectInfo(null).success, false);
}

// ── running the wrapper on a computer whose paths have spaces ─────────────
//
// gradlew.bat is a batch file and Node will not run one without a shell, and
// `shell: true` on Windows pastes everything into one string and quotes
// nothing -- so a project under "My Mods" was a command cmd.exe could not
// find, and `--args=--username Some Name` was three arguments. Both look
// like the launcher simply not working.
{
  const bat = "C:\\Users\\me\\My Mods\\thing\\gradlew.bat";
  const args = ["runClient", "--args=--username Some Name"];
  const was = process.platform;
  check("a batch file is handed to cmd.exe as its own argument",
    (() => {
      // The real function, asked what it would do on Windows.
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      const r = mod.gradleSpawnArgs(bat, args);
      Object.defineProperty(process, "platform", { value: was, configurable: true });
      return [/cmd\.exe$/i.test(r.file), r.argv.slice(0, 4), r.shell];
    })(),
    [true, ["/d", "/s", "/c", bat], false],
    "Node quotes each argument it is given; a shell pastes them together and quotes nothing");
  check("and anywhere else it is simply run",
    (() => { const r = mod.gradleSpawnArgs("/home/me/My Mods/thing/gradlew", args); return [r.file, r.argv.length, r.shell]; })(),
    ["/home/me/My Mods/thing/gradlew", 2, false]);
}

// ── Where an instance's files are ──────────────────────────────────────────
{
  const data = path.join(tmp, "data");
  const profiles = path.join(data, "profiles.json");
  fs.mkdirSync(data, { recursive: true });
  mod.setPaths(data, profiles);
  fs.writeFileSync(profiles, JSON.stringify([
    { id: "Fabric 1.21.1", name: "Fabric 1.21.1", version: "1.21.1" },
    { id: "examplemod", name: "examplemod", project: { root: fabric, dir: path.join(fabric, "run"), task: "runClient" } },
  ]));

  check("an ordinary instance's files are the launcher's own folder for it",
    mod.instanceRoot("Fabric 1.21.1"), path.join(data, "client", "Fabric 1.21.1"));
  check("a dev instance's files are its project's run folder",
    mod.instanceRoot("examplemod"), path.join(fabric, "run"),
    "not a copy of it: the instance IS the folder the project runs in");
  check("an instance nobody has heard of still has somewhere to be",
    mod.instanceRoot("gone"), path.join(data, "client", "gone"),
    "this is called from code that cannot wait and cannot fail");

  // The cache has to notice the file changing, because adding a dev instance
  // changes the answer for an id that was asked about a moment earlier.
  fs.writeFileSync(profiles, JSON.stringify([
    { id: "late", name: "late", project: { root: fabric, dir: path.join(fabric, "elsewhere") } },
  ]));
  check("and an instance made since the last question is seen",
    mod.instanceRoot("late"), path.join(fabric, "elsewhere"),
    "the answer is cached against the profiles file's own modification time");
}

// Nobody is allowed to go back to spelling it out.
{
  const main = src.split(/\r?\n/);
  const offenders = [];
  main.forEach((line, i) => {
    // Spelt out directly, or through the "client or servers" the two
    // open-folder paths used -- which is the same thing written so that a
    // search for the first spelling does not find it.
    const spelt = /dataDir\s*,\s*['"]client['"]\s*,/.test(line)
      || /['"]client['"]\s*:\s*['"]servers?['"]/.test(line);
    if (!spelt) return;
    // The one place it is allowed: instanceRoot's own fallback, which is
    // what everywhere else now calls.
    if (/^\|\| path\.join\(dataDir, "client", String\(profileId\)\);$/.test(line.trim())) return;
    offenders.push({ line: i + 1, text: line.trim() });
  });
  check("every place that wants an instance's folder asks for it",
    offenders, [],
    "<data>/client/<id> spelt out anywhere else is a line that reads the wrong folder for a dev instance");
}

console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
