# Redstone Launcher

This is the source code of the unofficial Minecraft launcher, **Redstone Launcher**.

Redstone Launcher is an Electron-based application, meaning it runs on Node.js.

## Running Locally

To run the app, clone the repository, install its dependencies, and run the app command:

```bash
git clone https://github.com/tggamesyt/redstone-launcher.git
cd redstone-launcher
npm install
npm run app
```

## Building the App

To build the application for your operating system, make sure you have cloned the repo and installed the dependencies (`npm install`), then run the appropriate build command:

### Windows
```bash
npm run buildWin
```

### Linux
```bash
npm run buildLinux
```

### macOS
```bash
npm run buildMac
```

### Building Linux from Windows

To build the Linux version from Windows using Docker, run the following command in PowerShell:

```powershell
docker run --rm -ti -v "${PWD}:/project" -v "${PWD}/dist:/project/dist" electronuserland/builder:latest /bin/bash -c "npm install && npm run buildLinux"
```
